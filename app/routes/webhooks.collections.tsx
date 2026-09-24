import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  describeCollectionResult,
  refreshCollection,
  removeCollectionFromIndex,
  scheduleCollectionRecheck,
} from "../lib/product-index/index.server";
import { payloadGid } from "../lib/shopify/webhook-payload";

/**
 * collections/create, collections/update and collections/delete keep
 * `collectionIds` in the product index current.
 *
 * Adding a product to a collection by hand fires collections/update but not
 * reliably products/update, and the payload doesn't list the products, so the
 * handler re-reads the collection's product list. When a collection's
 * conditions are created or changed, Shopify applies them a little later, so
 * the list is read again after 30 seconds, 2 minutes and 10 minutes. An error returns a 500 so
 * Shopify retries the delivery.
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
    if (result !== "deleted") scheduleCollectionRecheck(admin, shop, collectionId);
  }
  // No admin client means there's no session: the app has been uninstalled.

  return new Response();
};
