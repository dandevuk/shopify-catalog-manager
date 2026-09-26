import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { findSearchableCatalogByTitle } from "../lib/sidekick/search.server";
import { describeCatalogRules } from "../lib/sidekick/search";
import { adminCatalogUrl } from "../lib/sidekick/admin-url";

/**
 * Backend for the Sidekick `describe_catalog_rules` tool
 * (`extensions/catalog-tools/tools.json`). See
 * `api.sidekick.search-catalogs.tsx` for why this route needs a `loader`
 * too: it's what lets `authenticate.admin` answer the browser's CORS
 * preflight OPTIONS request for this cross-origin extension call.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const body = (await request.json()) as { catalogTitle?: string };

  const catalog = await findSearchableCatalogByTitle(shop.id, body.catalogTitle ?? "");
  if (!catalog) {
    return cors(Response.json({ found: false as const }));
  }

  const description = describeCatalogRules(catalog);
  return cors(
    Response.json({
      found: true as const,
      title: description.title,
      type: description.type,
      url: adminCatalogUrl(session.shop, description.urlParam),
      includeRules: description.includeRules,
      excludeRules: description.excludeRules,
      assignmentRules: description.assignmentRules,
    }),
  );
};
