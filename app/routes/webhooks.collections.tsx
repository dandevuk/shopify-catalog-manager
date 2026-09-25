import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  describeCollectionResult,
  refreshCollection,
  removeCollectionFromIndex,
} from "../lib/product-index/index.server";
import {
  scheduleCollectionRecheck,
  scheduleManagedCatalogSyncs,
} from "../lib/queue/queues.server";
import { payloadGid } from "../lib/shopify/webhook-payload";

/**
 * collections/create, collections/update and collections/delete keep
 * `collectionIds` in the product index current.
 *
 * Adding a product to a collection by hand fires collections/update but not
 * reliably products/update, and the payload doesn't list the products, so the
 * handler re-reads the collection's product list. When a collection's
 * conditions are created or changed, Shopify applies them a little later, so
 * the list is read again after 30 seconds, 2 minutes and 10 minutes (a
 * BullMQ delayed job). Every branch also queues a debounced automatic sync
 * for the shop's managed catalogs (Phase 1, step 5). An error returns a 500
 * so Shopify retries the delivery.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const collectionId = payloadGid(payload, "Collection");

  if (!collectionId) {
    console.warn(`${topic} webhook for ${shop} had no collection ID`);
    return new Response();
  }
  console.log(`Received ${topic} webhook for ${shop}: ${collectionId}`);

  if (topic === "COLLECTIONS_DELETE") {
    await removeCollectionFromIndex(shop, collectionId);
  } else if (admin) {
    const result = await refreshCollection(admin, shop, collectionId);
    console.log(`Collection ${collectionId}: ${describeCollectionResult(result)}`);
    if (result !== "deleted") scheduleCollectionRecheck(shop, collectionId);
  }
  // No admin client means there's no session: the app has been uninstalled.

  await scheduleManagedCatalogSyncs(shop);
  return new Response();
};
