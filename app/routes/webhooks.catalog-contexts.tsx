import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * markets/* and company_locations/*.
 *
 * Next step: refresh the stored catalog list (titles, contexts) when markets or
 * company locations change.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
