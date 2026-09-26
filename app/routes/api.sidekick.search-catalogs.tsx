import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { loadSearchableCatalogs } from "../lib/sidekick/search.server";
import { searchCatalogs } from "../lib/sidekick/search";
import { adminCatalogUrl } from "../lib/sidekick/admin-url";

/**
 * Backend for the Sidekick `search_catalogs` tool
 * (`extensions/catalog-tools/tools.json`), called from the extension's
 * `src/index.js` via an authenticated fetch. Read-only: matches the shop's
 * saved rules against a free-text query, no Shopify Admin API call needed.
 *
 * The extension's fetch is cross-origin (a different sandbox origin), so the
 * browser sends a CORS preflight OPTIONS request first. React Router only
 * routes OPTIONS to a route's `loader`, never its `action`; without a loader
 * here, the preflight 400s before the real POST is ever sent, and to
 * Sidekick that looks like it can't reach the app at all. authenticate.admin
 * already replies to an OPTIONS request itself (respondToOptionsRequest), so
 * the loader just needs to call it; `cors` adds the required
 * Access-Control-Allow-* headers to the action's actual JSON response.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const body = (await request.json()) as {
    query?: string;
    catalogType?: "MARKET" | "COMPANY_LOCATION";
  };

  const catalogs = await loadSearchableCatalogs(shop.id);
  const results = searchCatalogs(catalogs, body.query ?? "", body.catalogType).map(
    (result) => ({
      id: result.id,
      type: result.type,
      title: result.title,
      description: result.reasons.join("; ") || "Matched this search",
      url: adminCatalogUrl(session.shop, result.urlParam),
    }),
  );

  return cors(Response.json({ results }));
};
