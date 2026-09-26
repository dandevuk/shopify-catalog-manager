import type { ActionFunctionArgs } from "react-router";
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
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  return { results };
};
