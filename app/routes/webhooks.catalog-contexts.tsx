import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * markets/create, markets/update and markets/delete.
 *
 * company_locations/* topics are not subscribed: Shopify treats them as
 * protected customer data, and the app avoids holding customer data.
 *
 * Next step: refresh the stored catalog list (titles, contexts) when markets
 * change.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
