import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  refreshCollection,
  removeCollectionFromIndex,
} from "../lib/product-index/index.server";
import { payloadGid } from "../lib/shopify/webhook-payload";

/**
 * collections/create, collections/update and collections/delete keep
 * `collectionIds` in the product index current.
 *
 * Adding a product to a manual collection fires collections/update but not
 * products/update, and the payload doesn't list the products, so the handler
 * re-reads the collection's product list. An error returns a 500 so Shopify
 * retries the delivery.
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
    await refreshCollection(admin, shop, collectionId);
  }
  // No admin client means there's no session: the app has been uninstalled.

  return new Response();
};
