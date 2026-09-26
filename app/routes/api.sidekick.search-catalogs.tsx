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
 * itself throws the OPTIONS response (respondToOptionsRequest, with the
 * required Access-Control-Allow-* headers already attached) before it ever
 * returns, so for a genuine preflight this loader's own body never runs; it
 * only exists so a preflight has a loader to be routed to at all. The
 * `return cors(...)` below is a harmless fallback for the (untaken in
 * practice) case of a real, authenticated non-OPTIONS request reaching this
 * loader.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(new Response(null, { status: 204 }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  // Everything after this point must go through `cors`, including errors:
  // an uncors'd response to this cross-origin caller is indistinguishable
  // from an unreachable app (the same failure mode the loader above exists
  // to avoid for the OPTIONS preflight).
  try {
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
  } catch (error) {
    console.error("search_catalogs failed", error);
    return cors(Response.json({ results: [] }, { status: 500 }));
  }
};
