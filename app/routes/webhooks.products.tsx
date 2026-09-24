import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  refreshProduct,
  removeProduct,
  scheduleProductRecheck,
} from "../lib/product-index/index.server";
import { payloadGid } from "../lib/shopify/webhook-payload";

/**
 * products/create, products/update and products/delete keep the product index
 * current between full rebuilds.
 *
 * Create and update re-read the product with GraphQL rather than trusting the
 * payload, which lacks collections and channel publication, then read it
 * again after 30 seconds, 2 minutes and 10 minutes to catch collection
 * membership changes (from collection conditions) that Shopify applies after
 * the save. An error returns a 500 so Shopify retries the delivery.
 *
 * Next step in Phase 1: queue a debounced rule evaluation for the catalogs
 * whose rules touch the changed fields. products/create matters most: new
 * products never reach a catalog that has its own publication unless
 * something adds them.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const productId = payloadGid(payload, "Product");

  if (!productId) {
    console.warn(`${topic} webhook for ${shop} had no product ID`);
    return new Response();
  }
  console.log(`Received ${topic} webhook for ${shop}: ${productId}`);

  if (topic === "PRODUCTS_DELETE") {
    await removeProduct(shop, productId);
  } else if (admin) {
    await refreshProduct(admin, shop, productId);
    scheduleProductRecheck(admin, shop, productId);
  }
  // No admin client means there's no session: the app has been uninstalled.

  return new Response();
};
