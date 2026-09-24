import prisma from "../../db.server";
import { createDelayedRunner } from "../delayed-runner";
import {
  describeError,
  runGraphql,
  type AdminGraphqlClient,
  type GraphqlResult,
} from "../shopify/graphql.server";
import {
  BulkProductAccumulator,
  buildBulkProductQuery,
  buildSingleProductQuery,
  findOnlineStorePublication,
  splitLines,
  toIndexedProduct,
  type ProductNode,
} from "./products";
import {
  countProducts,
  deleteProduct,
  removeCollection,
  removeProductsDeletedSince,
  removeProductsNotWrittenSince,
  setCollectionMembership,
  upsertProducts,
} from "./store.server";

/**
 * The product index: the app's own copy of the product fields rules use.
 *
 * Full rebuild (on install, or from Diagnostics):
 *   1. startProductIndexRebuild runs bulkOperationRunQuery. Shopify builds a
 *      JSONL file of every product in the background.
 *   2. Shopify sends bulk_operations/finish (webhooks.bulk_operations.finish.tsx),
 *      which calls finishProductIndexBuild to download the file and write it.
 *      Webhook delivery isn't guaranteed, so checkProductIndexBuild also polls
 *      the operation when the Diagnostics page loads.
 *
 * Between rebuilds, the products/* webhooks call refreshProduct and
 * removeProduct to keep single rows current. Adding a product to a manual
 * collection fires only collections/update (not products/update), so the
 * collections/* webhooks call refreshCollection and removeCollectionFromIndex.
 */

// ---------------------------------------------------------------------------
// Online Store publication
// ---------------------------------------------------------------------------

const PUBLICATIONS_QUERY = `#graphql
  query OnlineStorePublication($cursor: String) {
    publications(first: 50, after: $cursor, catalogType: APP) {
      nodes {
        id
        catalog {
          title
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface PublicationsPage {
  publications: {
    nodes: { id: string; catalog: { title: string } | null }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function lookupOnlineStorePublicationId(
  admin: AdminGraphqlClient,
): Promise<string | null> {
  let cursor: string | null = null;
  // Sales channels per shop are few; 5 pages of 50 is plenty.
  for (let page = 0; page < 5; page++) {
    const { data }: { data: PublicationsPage } = await runGraphql<PublicationsPage>(
      admin,
      PUBLICATIONS_QUERY,
      { cursor },
    );
    const found = findOnlineStorePublication(data.publications.nodes);
    if (found) return found;
    if (!data.publications.pageInfo.hasNextPage) break;
    cursor = data.publications.pageInfo.endCursor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full rebuild
// ---------------------------------------------------------------------------

const BULK_RUN_MUTATION = `#graphql
  mutation ProductIndexBulkRun($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation {
        id
        status
        createdAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface BulkRunResult {
  bulkOperationRunQuery: {
    bulkOperation: { id: string; status: string; createdAt: string } | null;
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
}

const BULK_STATUS_QUERY = `#graphql
  query ProductIndexBulkStatus($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      objectCount
      rootObjectCount
      url
      partialDataUrl
      createdAt
      completedAt
    }
  }
`;

interface BulkOperationInfo {
  id: string;
  /** CREATED, RUNNING, COMPLETED, CANCELING, CANCELED, FAILED or EXPIRED */
  status: string;
  errorCode: string | null;
  /** UnsignedInt64 values arrive as strings */
  objectCount: string;
  rootObjectCount: string;
  url: string | null;
  partialDataUrl: string | null;
  createdAt: string;
  completedAt: string | null;
}

const UNFINISHED_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);

async function getBulkOperation(
  admin: AdminGraphqlClient,
  id: string,
): Promise<BulkOperationInfo | null> {
  const { data } = await runGraphql<{ bulkOperation: BulkOperationInfo | null }>(
    admin,
    BULK_STATUS_QUERY,
    { id },
  );
  return data.bulkOperation;
}

export type StartRebuildResult = { started: true } | { started: false; reason: string };

export async function startProductIndexRebuild(
  admin: AdminGraphqlClient,
  shopDomain: string,
): Promise<StartRebuildResult> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return { started: false, reason: "Shop not found." };

  if (shop.productIndexStatus === "RUNNING") {
    // Make sure it really is still running (the finish webhook may have been lost).
    const progress = await checkProductIndexBuild(admin, shopDomain);
    if (progress?.running) {
      return { started: false, reason: "A rebuild is already running." };
    }
  }

  // Recorded before the operation starts, so every row the operation writes
  // is newer than this. That's what removeProductsNotWrittenSince relies on.
  const startedAt = new Date();

  try {
    const onlineStorePublicationId = await lookupOnlineStorePublicationId(admin);
    const { data } = await runGraphql<BulkRunResult>(admin, BULK_RUN_MUTATION, {
      query: buildBulkProductQuery(onlineStorePublicationId),
    });
    const { bulkOperation, userErrors } = data.bulkOperationRunQuery;

    if (userErrors.length > 0 || !bulkOperation) {
      const reason =
        userErrors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`).join("; ") ||
        "Shopify didn't return a bulk operation.";
      await markFailed(shop.id, reason);
      return { started: false, reason };
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        onlineStorePublicationId,
        productIndexOperationId: bulkOperation.id,
        productIndexStatus: "RUNNING",
        productIndexStartedAt: startedAt,
        productIndexError: null,
      },
    });
    return { started: true };
  } catch (error) {
    const reason = describeError(error);
    await markFailed(shop.id, reason);
    return { started: false, reason };
  }
}

/**
 * Builds the index the first time the app is installed. Called from the
 * afterAuth hook, which also runs on later re-authentications, so it does
 * nothing once the index has been built or while a rebuild is running.
 */
export async function ensureProductIndex(
  admin: AdminGraphqlClient,
  shopDomain: string,
): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop || shop.productIndexRebuiltAt || shop.productIndexStatus === "RUNNING") return;

  const result = await startProductIndexRebuild(admin, shopDomain);
  if (!result.started) {
    console.error(`Product index rebuild for ${shopDomain} didn't start: ${result.reason}`);
  }
}

/**
 * Downloads a finished bulk operation's output and writes it to the index.
 *
 * Safe to call more than once for the same operation (the webhook can be
 * delivered twice, and the Diagnostics poll can overlap with it): writes are
 * upserts, and an operation that's no longer the shop's running rebuild is
 * ignored.
 */
export async function finishProductIndexBuild(
  admin: AdminGraphqlClient,
  shopDomain: string,
  operationId: string,
): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (
    !shop ||
    shop.productIndexOperationId !== operationId ||
    shop.productIndexStatus !== "RUNNING" ||
    !shop.productIndexStartedAt
  ) {
    return;
  }

  const startedAt = shop.productIndexStartedAt;
  try {
    const operation = await getBulkOperation(admin, operationId);
    if (!operation) {
      await markFailed(shop.id, "Shopify no longer has this bulk operation.", operationId);
      return;
    }
    if (UNFINISHED_STATUSES.has(operation.status)) return;
    if (operation.status !== "COMPLETED") {
      await markFailed(
        shop.id,
        `Bulk operation ${operation.status.toLowerCase()}` +
          (operation.errorCode ? ` (${operation.errorCode})` : ""),
        operationId,
      );
      return;
    }

    // url is null when the query matched nothing, i.e. a shop with no products.
    const accumulator = new BulkProductAccumulator();
    if (operation.url) {
      await readJsonl(operation.url, (line) => accumulator.addLine(line));
    }

    await upsertProducts(shop.id, accumulator.products(), { collectionsReadAt: startedAt });
    const deleted = await removeProductsDeletedSince(shop.id, startedAt);
    const removed = await removeProductsNotWrittenSince(shop.id, startedAt);

    // Only if this is still the shop's current rebuild: a newer one may have
    // started while this one was writing, and must not be marked finished.
    const { count } = await prisma.shop.updateMany({
      where: { id: shop.id, productIndexOperationId: operationId, productIndexStatus: "RUNNING" },
      data: {
        productIndexStatus: "COMPLETED",
        productIndexRebuiltAt: new Date(),
        productIndexError: null,
      },
    });
    console.log(
      `Product index for ${shopDomain}: ${accumulator.productCount} products written, ` +
        `${removed + deleted} removed` +
        (count === 0 ? " (a newer rebuild has started since)" : ""),
    );
  } catch (error) {
    await markFailed(shop.id, describeError(error), operationId);
  }
}

/** Streams a JSONL file line by line, so a large shop's file isn't held as one string. */
async function readJsonl(url: string, onLine: (line: string) => void): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Downloading the bulk operation result failed: HTTP ${response.status}`);
  }
  const text = response.body.pipeThrough(new TextDecoderStream());
  for await (const line of splitLines(readChunks(text))) onLine(line);
}

async function* readChunks(stream: ReadableStream<string>): AsyncGenerator<string> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface BuildProgress {
  running: boolean;
  /** Products Shopify has processed so far */
  productCount: number;
}

/**
 * If the shop's latest rebuild is marked as running, asks Shopify how it's
 * doing and finishes it if it has ended. This is the fallback for a lost
 * bulk_operations/finish webhook.
 */
export async function checkProductIndexBuild(
  admin: AdminGraphqlClient,
  shopDomain: string,
): Promise<BuildProgress | null> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop?.productIndexOperationId || shop.productIndexStatus !== "RUNNING") return null;

  const operation = await getBulkOperation(admin, shop.productIndexOperationId);
  if (operation && UNFINISHED_STATUSES.has(operation.status)) {
    return { running: true, productCount: Number(operation.rootObjectCount) };
  }

  await finishProductIndexBuild(admin, shopDomain, shop.productIndexOperationId);
  return { running: false, productCount: Number(operation?.rootObjectCount ?? 0) };
}

/**
 * With an operation ID, only marks the rebuild failed if it's still the
 * shop's current, running one, so a stale rebuild can't hide a newer one.
 */
async function markFailed(shopId: string, error: string, operationId?: string): Promise<void> {
  await prisma.shop.updateMany({
    where: operationId
      ? { id: shopId, productIndexOperationId: operationId, productIndexStatus: "RUNNING" }
      : { id: shopId },
    data: { productIndexStatus: "FAILED", productIndexError: error },
  });
}

// ---------------------------------------------------------------------------
// Single products (webhooks)
// ---------------------------------------------------------------------------

interface SingleProductResult {
  product:
    | (ProductNode & {
        collections: {
          nodes: { id: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      })
    | null;
}

/**
 * Re-reads one product from Shopify and writes it to the index. The webhook
 * payload isn't used for the fields: it's in REST format and has neither
 * collections nor channel publication.
 */
export async function refreshProduct(
  admin: AdminGraphqlClient,
  shopDomain: string,
  productId: string,
): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  let onlineStorePublicationId = shop.onlineStorePublicationId;
  if (!onlineStorePublicationId) {
    onlineStorePublicationId = await lookupOnlineStorePublicationId(admin);
    if (onlineStorePublicationId) {
      await prisma.shop.update({ where: { id: shop.id }, data: { onlineStorePublicationId } });
    }
  }

  const query = buildSingleProductQuery(onlineStorePublicationId);
  // Taken before the read, so it's never later than the data it describes.
  const readAt = new Date();
  const collectionIds: string[] = [];
  let product: SingleProductResult["product"] = null;
  let collectionsAfter: string | null = null;

  // A product is rarely in more than 250 collections, but page through if so.
  for (let page = 0; page < 20; page++) {
    const result: GraphqlResult<SingleProductResult> = await runGraphql<SingleProductResult>(
      admin,
      query,
      { id: productId, collectionsAfter },
    );
    const page: SingleProductResult["product"] = result.data.product;
    if (!page) break;
    product = page;
    collectionIds.push(...page.collections.nodes.map((collection) => collection.id));
    if (!page.collections.pageInfo.hasNextPage || !page.collections.pageInfo.endCursor) break;
    collectionsAfter = page.collections.pageInfo.endCursor;
  }

  if (!product) {
    // Deleted between the webhook being sent and now.
    await deleteProduct(shop.id, productId);
    return;
  }
  await upsertProducts(shop.id, [toIndexedProduct(product, collectionIds)], {
    collectionsReadAt: readAt,
  });
}

/**
 * When a product starts or stops matching a collection's conditions, Shopify
 * updates the membership some time after the product is saved, and sends no
 * webhook when it does, so the read in refreshProduct can miss it. Product
 * index tests 7 and 7c: a read 2 seconds after the save missed an addition,
 * and a read 30 seconds after missed a removal; both had happened a few
 * minutes later. The same applies when a collection with conditions is
 * created or its conditions change. Each product and collection webhook
 * therefore schedules several more reads, further apart. Moves to delayed
 * BullMQ jobs in Phase 1, step 5; the nightly rebuild catches anything slower.
 */
export const RECHECK_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
const rechecks = createDelayedRunner();

function scheduleRechecks(key: string, run: (attempt: number) => Promise<void>): void {
  RECHECK_DELAYS_MS.forEach((delayMs, attempt) => {
    // One key per attempt, so a new event for the same resource restarts all of them.
    rechecks.schedule(`${key} ${attempt}`, delayMs, () => run(attempt));
  });
}

function recheckLabel(attempt: number): string {
  return `Recheck ${attempt + 1} of ${RECHECK_DELAYS_MS.length} (${describeDelay(RECHECK_DELAYS_MS[attempt])})`;
}

export function scheduleProductRecheck(
  admin: AdminGraphqlClient,
  shopDomain: string,
  productId: string,
): void {
  scheduleRechecks(`${shopDomain} ${productId}`, (attempt) =>
    recheckProduct(admin, shopDomain, productId, attempt),
  );
}

export function scheduleCollectionRecheck(
  admin: AdminGraphqlClient,
  shopDomain: string,
  collectionId: string,
): void {
  scheduleRechecks(`${shopDomain} ${collectionId}`, async (attempt) => {
    const result = await refreshCollection(admin, shopDomain, collectionId);
    console.log(`${recheckLabel(attempt)} for ${collectionId}: ${describeCollectionResult(result)}`);
  });
}

async function recheckProduct(
  admin: AdminGraphqlClient,
  shopDomain: string,
  productId: string,
  attempt: number,
): Promise<void> {
  const before = await collectionIdsFor(shopDomain, productId);
  await refreshProduct(admin, shopDomain, productId);
  const after = await collectionIdsFor(shopDomain, productId);

  // Logged so we can learn how long Shopify takes to apply collection conditions.
  const changed = before?.slice().sort().join() !== after?.slice().sort().join();
  console.log(
    `${recheckLabel(attempt)} for ${productId}: ` +
      (changed
        ? `collections changed (${before?.length ?? 0} -> ${after?.length ?? 0})`
        : "no collection change"),
  );
}

function describeDelay(ms: number): string {
  return ms < 60_000 ? `${ms / 1000}s` : `${ms / 60_000} min`;
}

async function collectionIdsFor(shopDomain: string, productId: string): Promise<string[] | null> {
  const row = await prisma.productIndex.findFirst({
    where: { productId, shop: { domain: shopDomain } },
    select: { collectionIds: true },
  });
  return row?.collectionIds ?? null;
}

export async function removeProduct(shopDomain: string, productId: string): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (shop) await deleteProduct(shop.id, productId);
}

// ---------------------------------------------------------------------------
// Collections (webhooks)
// ---------------------------------------------------------------------------

const COLLECTION_MEMBERS_QUERY = `#graphql
  query ProductIndexCollectionMembers($id: ID!, $after: String) {
    collection(id: $id) {
      id
      products(first: 250, after: $after) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

interface CollectionMembersResult {
  collection: {
    id: string;
    products: {
      nodes: { id: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

/**
 * Re-reads a collection's full product list and updates `collectionIds` to
 * match. Reads the final membership, so it doesn't matter how the collection
 * gets its products: since 2026-07 one collection can combine conditions,
 * manually added products and exclusions.
 *
 * A very large collection takes one request per 250 products, which can
 * outlast Shopify's webhook timeout; this moves to the job queue with BullMQ
 * (Phase 1, step 5). A retried delivery is harmless.
 *
 * Returns how many rows changed, `"deleted"` if the collection no longer
 * exists, or null if the shop is unknown.
 */
export type CollectionRefreshResult = { added: number; removed: number } | "deleted" | null;

export async function refreshCollection(
  admin: AdminGraphqlClient,
  shopDomain: string,
  collectionId: string,
): Promise<CollectionRefreshResult> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return null;

  // Taken before the read, so it's never later than the data it describes.
  const readAt = new Date();
  const productIds: string[] = [];
  let after: string | null = null;
  for (;;) {
    const result: GraphqlResult<CollectionMembersResult> =
      await runGraphql<CollectionMembersResult>(admin, COLLECTION_MEMBERS_QUERY, {
        id: collectionId,
        after,
      });
    const collection: CollectionMembersResult["collection"] = result.data.collection;
    if (!collection) {
      // Deleted between the webhook being sent and now.
      await removeCollection(shop.id, collectionId, readAt);
      return "deleted";
    }
    productIds.push(...collection.products.nodes.map((product) => product.id));
    const { hasNextPage, endCursor } = collection.products.pageInfo;
    if (!hasNextPage || !endCursor) break;
    after = endCursor;
  }

  return setCollectionMembership(shop.id, collectionId, productIds, readAt);
}

export function describeCollectionResult(result: CollectionRefreshResult): string {
  if (result === null) return "shop not found";
  if (result === "deleted") return "collection no longer exists, removed from the index";
  if (!result.added && !result.removed) return "no change";
  return `added to ${result.added} products, removed from ${result.removed}`;
}

export async function removeCollectionFromIndex(
  shopDomain: string,
  collectionId: string,
): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (shop) await removeCollection(shop.id, collectionId);
}

// ---------------------------------------------------------------------------
// Summary for pages
// ---------------------------------------------------------------------------

export interface ProductIndexSummary {
  productCount: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | null;
  error: string | null;
  startedAt: string | null;
  rebuiltAt: string | null;
  onlineStorePublicationId: string | null;
}

export async function getProductIndexSummary(shopDomain: string): Promise<ProductIndexSummary> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  return {
    productCount: shop ? await countProducts(shop.id) : 0,
    status: shop?.productIndexStatus ?? null,
    error: shop?.productIndexError ?? null,
    startedAt: shop?.productIndexStartedAt?.toISOString() ?? null,
    rebuiltAt: shop?.productIndexRebuiltAt?.toISOString() ?? null,
    onlineStorePublicationId: shop?.onlineStorePublicationId ?? null,
  };
}
