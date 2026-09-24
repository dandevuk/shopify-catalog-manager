import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * publications/delete.
 *
 * If a managed catalog's publication is deleted, the catalog falls back to
 * "follows the sales channel" and the app can no longer control it. Clear the
 * stored publication and drift values so the UI can ask the merchant what to do.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const publicationId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;

  console.log(`Received ${topic} webhook for ${shop}: ${publicationId ?? "unknown publication"}`);

  if (publicationId) {
    await db.catalog.updateMany({
      where: { publicationId, shop: { domain: shop } },
      data: {
        publicationId: null,
        lastOperationId: null,
        lastKnownCount: null,
        lastAutoPublish: null,
      },
    });
  }

  return new Response();
};
