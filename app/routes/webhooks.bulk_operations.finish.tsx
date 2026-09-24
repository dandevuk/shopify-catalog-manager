import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { finishProductIndexBuild } from "../lib/product-index/index.server";

/**
 * bulk_operations/finish: Shopify sends this when any of the app's bulk
 * operations completes, fails or is cancelled. The payload only has the ID
 * and status; finishProductIndexBuild fetches the download URL itself and
 * ignores operations that aren't the shop's current index rebuild.
 *
 * The work runs inline for now. Very large shops may need longer than
 * Shopify's webhook timeout, so this moves to the job queue with BullMQ
 * (Phase 1, step 5). A retried delivery is harmless because the write is
 * idempotent.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  const operationId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;

  if (operationId && admin) {
    await finishProductIndexBuild(admin, shop, operationId);
  }

  return new Response();
};
