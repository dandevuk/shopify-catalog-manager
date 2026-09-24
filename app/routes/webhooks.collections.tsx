import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * collections/update and collections/delete.
 *
 * Next step: refresh collection membership in the product index for catalogs
 * that use "In collection" rules.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const collectionId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;

  console.log(`Received ${topic} webhook for ${shop}: ${collectionId ?? "unknown collection"}`);

  return new Response();
};
