import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { IndexedProduct } from "./products";

/**
 * Database writes for the product index.
 *
 * Webhooks and a rebuild can run at the same time, and webhooks can arrive
 * out of order. Every write therefore carries Shopify's Product.updatedAt and
 * only replaces a row holding the same or older data. Prisma's upsert can't
 * express "update only if", so this uses INSERT ... ON CONFLICT directly.
 */

/** 500 rows x 13 values stays well under Postgres's 65,535 parameter limit. */
const BATCH_SIZE = 500;

/**
 * Prisma reads TIMESTAMP(3) columns as UTC. Convert explicitly so raw writes
 * match, whatever the database session's time zone is.
 */
function utc(date: Date) {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

export async function upsertProducts(
  shopId: string,
  products: IndexedProduct[],
  writtenAt: Date = new Date(),
): Promise<void> {
  for (let start = 0; start < products.length; start += BATCH_SIZE) {
    const batch = products.slice(start, start + BATCH_SIZE);
    const rows = batch.map(
      (p) => Prisma.sql`(
        ${shopId}, ${p.productId}, ${p.title}, ${p.handle}::text, ${p.status},
        ${p.vendor}::text, ${p.productType}::text, ${p.tags}::text[], ${p.categoryId}::text,
        ${p.collectionIds}::text[], ${p.onlineStorePublished}, ${utc(p.shopifyUpdatedAt)},
        ${utc(writtenAt)}
      )`,
    );

    await prisma.$executeRaw`
      INSERT INTO "ProductIndex" (
        "shopId", "productId", "title", "handle", "status",
        "vendor", "productType", "tags", "categoryId",
        "collectionIds", "onlineStorePublished", "shopifyUpdatedAt",
        "updatedAt"
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
        "collectionIds" = EXCLUDED."collectionIds",
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
 * Makes `collectionIds` agree with a collection's full product list: adds the
 * collection to products in the list and removes it from products that
 * aren't. Products not in the index yet are skipped (products/create adds
 * them with their collections).
 *
 * `updatedAt` is left alone: the rebuild uses it to mean "product data
 * confirmed at this time", and a collection change doesn't confirm that.
 */
export async function setCollectionMembership(
  shopId: string,
  collectionId: string,
  productIds: string[],
): Promise<{ added: number; removed: number }> {
  const [added, removed] = await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "ProductIndex"
      SET "collectionIds" = array_append("collectionIds", ${collectionId}::text)
      WHERE "shopId" = ${shopId}
        AND "productId" = ANY(${productIds}::text[])
        AND NOT (${collectionId}::text = ANY("collectionIds"))
    `,
    prisma.$executeRaw`
      UPDATE "ProductIndex"
      SET "collectionIds" = array_remove("collectionIds", ${collectionId}::text)
      WHERE "shopId" = ${shopId}
        AND ${collectionId}::text = ANY("collectionIds")
        AND NOT ("productId" = ANY(${productIds}::text[]))
    `,
  ]);
  return { added, removed };
}

/** A deleted collection has no products. */
export async function removeCollection(shopId: string, collectionId: string): Promise<number> {
  const { removed } = await setCollectionMembership(shopId, collectionId, []);
  return removed;
}

export async function deleteProduct(shopId: string, productId: string): Promise<void> {
  await prisma.productIndex.deleteMany({ where: { shopId, productId } });
}

export async function countProducts(shopId: string): Promise<number> {
  return prisma.productIndex.count({ where: { shopId } });
}
