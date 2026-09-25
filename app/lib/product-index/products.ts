/**
 * Pure helpers for the product index: the GraphQL documents, turning Shopify
 * product nodes into index rows, and reading bulk operation JSONL output.
 *
 * No database or network access here, so it's all unit tested
 * (products.test.ts).
 */

/** One row of the index, as the app stores it (see ProductIndex in the Prisma schema). */
export interface IndexedProduct {
  productId: string;
  title: string;
  handle: string | null;
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  categoryId: string | null;
  collectionIds: string[];
  onlineStorePublished: boolean;
  shopifyUpdatedAt: Date;
}

/** Product fields as the bulk query and the single product query return them. */
export interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  updatedAt: string;
  category: { id: string } | null;
  /** Absent when the shop has no Online Store publication */
  publishedOnPublication?: boolean;
}

const PRODUCT_GID = "gid://shopify/Product/";
const COLLECTION_GID = "gid://shopify/Collection/";

/**
 * Scalar product fields shared by the bulk query and the single product query.
 * `publishedOnPublication` is only asked for when the Online Store publication
 * is known. GIDs come from Shopify, but check the format anyway because the
 * value is written into the query text.
 */
function productFields(onlineStorePublicationId: string | null): string {
  if (
    onlineStorePublicationId &&
    !/^gid:\/\/shopify\/Publication\/\d+$/.test(onlineStorePublicationId)
  ) {
    throw new Error(`Not a publication ID: ${onlineStorePublicationId}`);
  }
  return `
        id
        title
        handle
        status
        vendor
        productType
        tags
        updatedAt
        category {
          id
        }${
          onlineStorePublicationId
            ? `
        publishedOnPublication(publicationId: "${onlineStorePublicationId}")`
            : ""
        }`;
}

/**
 * The query the bulk operation runs. Bulk queries don't take `first`: Shopify
 * pages through every product itself. The nested `collections` connection
 * comes back as separate JSONL lines with a `__parentId` (see
 * BulkProductAccumulator).
 */
export function buildBulkProductQuery(
  onlineStorePublicationId: string | null,
): string {
  return `{
  products {
    edges {
      node {${productFields(onlineStorePublicationId)}
        collections {
          edges {
            node {
              id
            }
          }
        }
      }
    }
  }
}`;
}

/** One product, used by the products/create and products/update webhooks. */
export function buildSingleProductQuery(
  onlineStorePublicationId: string | null,
): string {
  return `#graphql
  query ProductIndexProduct($id: ID!, $collectionsAfter: String) {
    product(id: $id) {${productFields(onlineStorePublicationId)}
      collections(first: 250, after: $collectionsAfter) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`;
}

/** Shopify returns "" for an unset vendor or product type; store null instead. */
function blankToNull(value: string | null | undefined): string | null {
  return value ? value : null;
}

export function toIndexedProduct(
  node: ProductNode,
  collectionIds: string[],
): IndexedProduct {
  return {
    productId: node.id,
    title: node.title,
    handle: blankToNull(node.handle),
    status: node.status,
    vendor: blankToNull(node.vendor),
    productType: blankToNull(node.productType),
    tags: node.tags ?? [],
    categoryId: node.category?.id ?? null,
    collectionIds: [...new Set(collectionIds)],
    onlineStorePublished: node.publishedOnPublication ?? false,
    shopifyUpdatedAt: new Date(node.updatedAt),
  };
}

/**
 * Collects the lines of a bulk operation's JSONL output into index rows.
 *
 * With `groupObjects: false` every object is its own line, and a nested
 * connection's objects carry `__parentId` pointing at their product:
 *
 *   {"id":"gid://shopify/Product/1","title":"Board",...}
 *   {"id":"gid://shopify/Collection/9","__parentId":"gid://shopify/Product/1"}
 *
 * Children aren't guaranteed to follow their parent directly, so collection
 * IDs are gathered separately and joined up in `products()`.
 */
export class BulkProductAccumulator {
  private readonly nodes = new Map<string, ProductNode>();
  private readonly collections = new Map<string, string[]>();

  addLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.addObject(JSON.parse(trimmed) as Record<string, unknown>);
  }

  addObject(object: Record<string, unknown>): void {
    const id = typeof object.id === "string" ? object.id : null;
    if (!id) return;

    const parentId =
      typeof object.__parentId === "string" ? object.__parentId : null;
    if (parentId) {
      if (id.startsWith(COLLECTION_GID)) {
        const list = this.collections.get(parentId) ?? [];
        list.push(id);
        this.collections.set(parentId, list);
      }
      return;
    }

    if (id.startsWith(PRODUCT_GID)) {
      this.nodes.set(id, object as unknown as ProductNode);
    }
  }

  get productCount(): number {
    return this.nodes.size;
  }

  products(): IndexedProduct[] {
    return [...this.nodes.values()].map((node) =>
      toIndexedProduct(node, this.collections.get(node.id) ?? []),
    );
  }
}

/**
 * Splits a stream of text chunks into lines. Chunks from a download can end
 * part way through a line, so the unfinished tail is carried over.
 */
export async function* splitLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer) yield buffer;
}

/**
 * Picks the Online Store's publication from the shop's sales channel
 * publications. It matches on the catalog title because identifying the
 * channel by app handle (`AppCatalog.apps`) needs the read_product_listings
 * scope, which the app doesn't request.
 *
 * On 2026-07 the title reads "Channel Catalog 225112752302 for Online Store"
 * (seen on the dev store); plain "Online Store" is accepted too.
 */
const ONLINE_STORE_TITLE = /^(?:.* for )?online store$/i;

export function findOnlineStorePublication(
  publications: { id: string; catalog: { title: string } | null }[],
): string | null {
  const match = publications.find((publication) =>
    ONLINE_STORE_TITLE.test(publication.catalog?.title.trim() ?? ""),
  );
  return match?.id ?? null;
}
