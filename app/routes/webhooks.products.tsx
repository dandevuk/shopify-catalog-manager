import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * products/create, products/update and products/delete.
 *
 * Next step in Phase 1: update the product index and queue a debounced rule
 * evaluation for the catalogs whose rules touch the changed fields.
 * products/create matters most: new products never reach a catalog that has
 * its own publication unless something adds them.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const productId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;

  console.log(`Received ${topic} webhook for ${shop}: ${productId ?? "unknown product"}`);

  return new Response();
};
