import { Queue } from "bullmq";
import prisma from "../../db.server";
import { RECHECK_DELAYS_MS } from "../product-index/index.server";
import { redisConnection } from "./connection.server";

/**
 * The app's two BullMQ queues (Phase 1, step 5). Jobs only carry IDs; the
 * worker (`app/worker.ts`) re-reads everything it needs when it runs a job,
 * so a job is safe to run late or (for the recheck queue) skip if it's been
 * superseded.
 *
 *   product-index-recheck  the 30 s / 2 min / 10 min re-reads that catch
 *                          collection-condition membership Shopify applies
 *                          after a save (findings 15 to 17)
 *   catalog-sync           an automatic run of managed mode for one catalog,
 *                          debounced so a burst of product changes collapses
 *                          into one sync per catalog
 *
 * Queues (and Workers) each get their own Redis connection; see
 * connection.server.ts.
 */

export const RECHECK_QUEUE_NAME = "product-index-recheck";
export const CATALOG_SYNC_QUEUE_NAME = "catalog-sync";

export interface ProductRecheckJob {
  shopDomain: string;
  productId: string;
  attempt: number;
}

export interface CollectionRecheckJob {
  shopDomain: string;
  collectionId: string;
  attempt: number;
}

export interface CatalogSyncJob {
  shopDomain: string;
  catalogRecordId: string;
}

// One Queue instance per process is enough; BullMQ Queues don't block like
// Workers do, so sharing them across requests is fine.
let recheckQueue: Queue<ProductRecheckJob | CollectionRecheckJob> | undefined;
let catalogSyncQueue: Queue<CatalogSyncJob> | undefined;

function getRecheckQueue() {
  recheckQueue ??= new Queue(RECHECK_QUEUE_NAME, { connection: redisConnection() });
  return recheckQueue;
}

function getCatalogSyncQueue() {
  catalogSyncQueue ??= new Queue(CATALOG_SYNC_QUEUE_NAME, { connection: redisConnection() });
  return catalogSyncQueue;
}

/**
 * Job ids below join their parts with "|", not ":": BullMQ rejects a custom
 * id containing a colon unless it splits into exactly 3 parts (a legacy
 * compatibility rule for its own repeatable-job ids), and Shopify GIDs
 * (`gid://shopify/Product/123`) contain one, so a naive `:`-joined id
 * throws "Custom Id cannot contain :" the first time a real product or
 * collection is involved (caught testing this against real Redis).
 */

/**
 * Adds a delayed job under `jobId`, replacing any earlier one with the same
 * id: the standard BullMQ debounce pattern. A job already active (being
 * processed right now) can't be removed; in that rare case the reschedule is
 * skipped and the active run's own result stands, which is fine for both
 * queues here (a recheck or sync that's already running reads fresh data).
 */
// Queue is left untyped here (rather than generic over the job data): BullMQ's
// Queue<Data> resolves its NameType from Data via a conditional type that TS
// can't reduce for a still-generic Data, so the call below stays plain Queue
// and each caller keeps its own typed data object.
async function upsertDelayedJob(
  queue: Queue,
  jobId: string,
  name: string,
  data: object,
  delayMs: number,
): Promise<void> {
  try {
    await queue.remove(jobId);
  } catch {
    // Active job, or already gone: fall through and try to add anyway.
  }
  try {
    await queue.add(name, data, {
      jobId,
      delay: delayMs,
      attempts: 1,
      removeOnComplete: { age: 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  } catch (error) {
    // Most likely "job already exists" because an active job couldn't be
    // removed above. Its own re-read is still coming, so this is safe to drop.
    console.error(`Couldn't schedule ${name} ${jobId}`, error);
  }
}

/**
 * Re-reads a product at 30 s, 2 min and 10 min. A new event for the same
 * product restarts all three (product index tests 7, 7c: Shopify can take
 * over 30 s and under 2 min to apply collection conditions after a save).
 */
export function scheduleProductRecheck(shopDomain: string, productId: string): void {
  const queue = getRecheckQueue();
  RECHECK_DELAYS_MS.forEach((delayMs, attempt) => {
    const jobId = `${shopDomain}|product|${productId}|${attempt}`;
    void upsertDelayedJob(queue, jobId, "product", { shopDomain, productId, attempt }, delayMs);
  });
}

export function scheduleCollectionRecheck(shopDomain: string, collectionId: string): void {
  const queue = getRecheckQueue();
  RECHECK_DELAYS_MS.forEach((delayMs, attempt) => {
    const jobId = `${shopDomain}|collection|${collectionId}|${attempt}`;
    void upsertDelayedJob(
      queue,
      jobId,
      "collection",
      { shopDomain, collectionId, attempt },
      delayMs,
    );
  });
}

/** A burst of product changes for one catalog collapses into one sync. */
export const CATALOG_SYNC_DEBOUNCE_MS = 2 * 60_000;

export function scheduleCatalogSync(shopDomain: string, catalogRecordId: string): void {
  const jobId = `${shopDomain}|${catalogRecordId}`;
  void upsertDelayedJob(
    getCatalogSyncQueue(),
    jobId,
    "sync",
    { shopDomain, catalogRecordId },
    CATALOG_SYNC_DEBOUNCE_MS,
  );
}

/**
 * Queues a debounced sync for every catalog the shop manages. Called after a
 * product or collection webhook (or a recheck) changes the index. Coarse by
 * design for v1: it doesn't check whether the change could affect any given
 * catalog's rules, relying on a sync with nothing to do being cheap (~500 ms,
 * measured on the dev store) rather than filtering by which fields a
 * catalog's conditions use.
 */
export async function scheduleManagedCatalogSyncs(shopDomain: string): Promise<void> {
  const catalogs = await prisma.catalog.findMany({
    where: { managed: true, shop: { domain: shopDomain } },
    select: { id: true },
  });
  for (const catalog of catalogs) scheduleCatalogSync(shopDomain, catalog.id);
}
