import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fromCatalogParam } from "../lib/shopify/catalog-id";
import { getSyncStatus } from "../lib/sync/managed.server";

/**
 * Sync progress for the rules page to poll while a sync runs. Reads only the
 * app's database: the full page loader also queries Shopify, which would use
 * up the rate limit the sync itself needs.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const catalogId = fromCatalogParam(params.catalogId);
  if (!catalogId)
    throw new Response("Not a Market or B2B catalog", { status: 404 });

  const catalog = await prisma.catalog.findFirst({
    where: { shopifyCatalogId: catalogId, shop: { domain: session.shop } },
    select: { id: true },
  });
  if (!catalog) throw new Response("Catalog not found", { status: 404 });
  return getSyncStatus(catalog.id);
};
