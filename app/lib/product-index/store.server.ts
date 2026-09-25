import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { IndexedProduct } from "./products";

/**
 * Database writes for the product index.
 *
 * Webhooks and a rebuild can run at the same time, and webhooks can arrive
 * out of order. Every write therefore carries Shopify's Product.updatedAt and
 * only replaces a row holding the same or older data. Collection changes
 * don't move Product.updatedAt, so collectionIds has a second guard,
 * collectionsReadAt: the time its data was read from Shopify. Prisma's upsert
 * can't express "update only if", so this uses INSERT ... ON CONFLICT directly.
 */

/** 500 rows x 14 values stays well under Postgres's 65,535 parameter limit. */
const BATCH_SIZE = 500;

/**
 * Prisma reads TIMESTAMP(3) columns as UTC. Convert explicitly so raw writes
 * match, whatever the database session's time zone is.
 */
function utc(date: Date) {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

export interface UpsertOptions {
  /**
   * When the products' collections were read from Shopify. For a rebuild,
   * use the time it started: its snapshot is at least that fresh.
   */
  collectionsReadAt: Date;
  /** When the app writes the rows (tests pass a fixed time) */
  writtenAt?: Date;
}

export async function upsertProducts(
  shopId: string,
  products: IndexedProduct[],
  { collectionsReadAt, writtenAt = new Date() }: UpsertOptions,
): Promise<void> {
  for (let start = 0; start < products.length; start += BATCH_SIZE) {
    const batch = products.slice(start, start + BATCH_SIZE);
    const rows = batch.map(
      (p) => Prisma.sql`(
        ${shopId}, ${p.productId}, ${p.title}, ${p.handle}::text, ${p.status},
        ${p.vendor}::text, ${p.productType}::text, ${p.tags}::text[], ${p.categoryId}::text,
        ${p.collectionIds}::text[], ${utc(collectionsReadAt)}, ${p.onlineStorePublished},
        ${utc(p.shopifyUpdatedAt)}, ${utc(writtenAt)}
      )`,
    );

    await prisma.$executeRaw`
      INSERT INTO "ProductIndex" (
        "shopId", "productId", "title", "handle", "status",
        "vendor", "productType", "tags", "categoryId",
        "collectionIds", "collectionsReadAt", "onlineStorePublished",
        "shopifyUpdatedAt", "updatedAt"
      )
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("shopId", "productId") DO UPDATE SET
        "title" = EXCLUDED."title",
        "handle" = EXCLUDED."handle",
        "status" = EXCLUDED."status",
        "vendor" = EXCLUDED."vendor",
        "productType" = EXCLUDED."productType",
        "tags" = EXCLUDED."tags",
        "categoryId" = EXCLUDED."categoryId",
        -- Keep collections that a newer read has already written, e.g. a
        -- collections webhook that arrived while a rebuild was running.
        "collectionIds" = CASE
          WHEN "ProductIndex"."collectionsReadAt" > EXCLUDED."collectionsReadAt"
            THEN "ProductIndex"."collectionIds"
          ELSE EXCLUDED."collectionIds"
        END,
        "collectionsReadAt" = GREATEST("ProductIndex"."collectionsReadAt", EXCLUDED."collectionsReadAt"),
        "onlineStorePublished" = EXCLUDED."onlineStorePublished",
        "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "ProductIndex"."shopifyUpdatedAt" IS NULL
         OR "ProductIndex"."shopifyUpdatedAt" <= EXCLUDED."shopifyUpdatedAt"
    `;
  }
}

/**
 * After a rebuild has written every product, removes rows the rebuild didn't
 * touch. Those are products deleted from Shopify while the app wasn't
 * listening. Rows written after `startedAt` are kept: either the rebuild wrote
 * them, or a webhook did while the rebuild was running.
 */
export async function removeProductsNotWrittenSince(
  shopId: string,
  startedAt: Date,
): Promise<number> {
  const { count } = await prisma.productIndex.deleteMany({
    where: { shopId, updatedAt: { lt: startedAt } },
  });
  return count;
}

/**
 * Makes `collectionIds` agree with a collection's full product list, read
 * from Shopify at `readAt`: adds the collection to products in the list and
 * removes it from products that aren't. Skipped: products not in the index
 * yet (products/create adds them with their collections), and rows whose
 * collections were read more recently than this list.
 *
 * `updatedAt` is left alone: the rebuild uses it to mean "product data
 * confirmed at this time", and a collection change doesn't confirm that.
 */
export async function setCollectionMembership(
  shopId: string,
  collectionId: string,
  productIds: string[],
  readAt: Date,
): Promise<{ added: number; removed: number }> {
  const [added, removed] = await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "ProductIndex"
      SET "collectionIds" = array_append("collectionIds", ${collectionId}::text),
          "collectionsReadAt" = GREATEST("collectionsReadAt", ${utc(readAt)})
      WHERE "shopId" = ${shopId}
        AND "productId" = ANY(${productIds}::text[])
        AND NOT (${collectionId}::text = ANY("collectionIds"))
        AND ("collectionsReadAt" IS NULL OR "collectionsReadAt" <= ${utc(readAt)})
    `,
    prisma.$executeRaw`
      UPDATE "ProductIndex"
      SET "collectionIds" = array_remove("collectionIds", ${collectionId}::text),
          "collectionsReadAt" = GREATEST("collectionsReadAt", ${utc(readAt)})
      WHERE "shopId" = ${shopId}
        AND ${collectionId}::text = ANY("collectionIds")
        AND NOT ("productId" = ANY(${productIds}::text[]))
        AND ("collectionsReadAt" IS NULL OR "collectionsReadAt" <= ${utc(readAt)})
    `,
  ]);
  return { added, removed };
}

/** A deleted collection has no products. */
export async function removeCollection(
  shopId: string,
  collectionId: string,
  readAt: Date = new Date(),
): Promise<number> {
  const { removed } = await setCollectionMembership(
    shopId,
    collectionId,
    [],
    readAt,
  );
  return removed;
}

/**
 * Removes a product and its pins and blocks, and records the deletion, so a
 * rebuild that was already running can't write the product back from its
 * older snapshot (see removeProductsDeletedSince).
 */
export async function deleteProduct(
  shopId: string,
  productId: string,
  deletedAt: Date = new Date(),
): Promise<void> {
  await prisma.$transaction([
    prisma.productIndex.deleteMany({ where: { shopId, productId } }),
    // Pins and blocks for a deleted product are meaningless, and a leftover
    // pin would make the rules try to publish a product that doesn't exist.
    prisma.override.deleteMany({ where: { productId, catalog: { shopId } } }),
    prisma.productIndexDeletion.upsert({
      where: { shopId_productId: { shopId, productId } },
      create: { shopId, productId, deletedAt },
      update: { deletedAt },
    }),
  ]);
}

/**
 * Run by a finishing rebuild after it has written its snapshot: removes
 * products deleted since the rebuild started (the snapshot may still have
 * had them), then forgets deletions from before that, which no running
 * rebuild can bring back any more.
 */
export async function removeProductsDeletedSince(
  shopId: string,
  startedAt: Date,
): Promise<number> {
  const deleted = await prisma.productIndexDeletion.findMany({
    where: { shopId, deletedAt: { gte: startedAt } },
    select: { productId: true },
  });
  const [{ count }] = await prisma.$transaction([
    prisma.productIndex.deleteMany({
      where: { shopId, productId: { in: deleted.map((d) => d.productId) } },
    }),
    prisma.productIndexDeletion.deleteMany({
      where: { shopId, deletedAt: { lt: startedAt } },
    }),
  ]);
  return count;
}

export async function countProducts(shopId: string): Promise<number> {
  return prisma.productIndex.count({ where: { shopId } });
}
