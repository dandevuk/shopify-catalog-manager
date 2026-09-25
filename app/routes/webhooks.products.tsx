import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refreshProduct, removeProduct } from "../lib/product-index/index.server";
import {
  scheduleManagedCatalogSyncs,
  scheduleProductRecheck,
} from "../lib/queue/queues.server";
import { payloadGid } from "../lib/shopify/webhook-payload";

/**
 * products/create, products/update and products/delete keep the product index
 * current between full rebuilds.
 *
 * Create and update re-read the product with GraphQL rather than trusting the
 * payload, which lacks collections and channel publication, then queue a
 * delayed re-read (30 s, 2 min, 10 min) to catch collection membership
 * changes (from collection conditions) that Shopify applies after the save.
 * Every branch also queues a debounced automatic sync for the shop's managed
 * catalogs (Phase 1, step 5): coarse by design, since a sync with nothing to
 * do is cheap. An error returns a 500 so Shopify retries the delivery.
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
    scheduleProductRecheck(shop, productId);
  }
  // No admin client means there's no session: the app has been uninstalled.

  await scheduleManagedCatalogSyncs(shop);
  return new Response();
};
