import prisma from "../../db.server";
import { backgroundAdmin } from "../product-index/index.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";
import { applyAssignments } from "./apply.server";
import { evaluateAssignmentRules } from "./evaluate";
import { listAssignmentLocations, type AssignmentLocation } from "./locations.server";
import { isUnassignedMatch } from "./preview";
import { loadAssignmentRules } from "./rules.server";

/**
 * Automatic assignment re-scan (Phase 2, step 5): re-applies every catalog's
 * saved assignment rules on a schedule (`app/lib/queue/queues.server.ts`),
 * since there's no webhook to react to (`company_locations/*` is
 * deliberately unused, protected customer data). Additive only, the same as
 * a manual apply: this only ever adds a location, never removes one.
 *
 * One BullMQ job for the whole scan, not one per catalog (unlike
 * catalog-sync): coarse for v1, so a catalog that keeps failing only shows up
 * as a logged error rather than its own retryable BullMQ job, until the next
 * sweep tries it again.
 */

export async function runAssignmentAutoScan(): Promise<void> {
  const catalogs = await prisma.catalog.findMany({
    where: { type: "COMPANY_LOCATION", ruleSets: { some: { kind: "ASSIGNMENT" } } },
    include: { shop: true },
  });

  // Grouped by shop: listAssignmentLocations reads every location on the
  // shop regardless of which catalog asks, so a shop with several
  // assignment-managed catalogs only pays for that read once per scan.
  const byShop = new Map<string, typeof catalogs>();
  for (const catalog of catalogs) {
    const shopCatalogs = byShop.get(catalog.shop.domain) ?? [];
    shopCatalogs.push(catalog);
    byShop.set(catalog.shop.domain, shopCatalogs);
  }

  for (const [shopDomain, shopCatalogs] of byShop) {
    try {
      await scanShop(shopDomain, shopCatalogs);
    } catch (error) {
      console.error(`Automatic assignment scan failed for ${shopDomain}`, error);
    }
  }
}

async function scanShop(
  shopDomain: string,
  catalogs: { id: string; shopifyCatalogId: string }[],
): Promise<void> {
  const admin = await backgroundAdmin(shopDomain);
  if (!admin) return;

  const locations = await listAssignmentLocations(admin);

  for (const catalog of catalogs) {
    try {
      await applyAssignmentRules(
        admin,
        shopDomain,
        catalog.id,
        catalog.shopifyCatalogId,
        locations,
      );
    } catch (error) {
      console.error(
        `Automatic assignment scan failed for catalog ${catalog.id} (${shopDomain})`,
        error,
      );
    }
  }
}

async function applyAssignmentRules(
  admin: AdminGraphqlClient,
  shopDomain: string,
  catalogRecordId: string,
  shopifyCatalogId: string,
  locations: AssignmentLocation[],
): Promise<void> {
  const savedRules = await loadAssignmentRules(catalogRecordId);
  if (!savedRules) return; // rules were deleted since the scan started

  const evaluation = evaluateAssignmentRules(savedRules, locations);
  if (!evaluation.ok) {
    console.error(
      `Automatic assignment scan: broken rules for catalog ${catalogRecordId}`,
      evaluation.errors,
    );
    return;
  }

  const toAdd = locations
    .filter((location) =>
      isUnassignedMatch(
        location,
        evaluation.decisions.get(location.locationId),
        shopifyCatalogId,
      ),
    )
    .map((location) => location.locationId);
  if (toAdd.length === 0) return;

  const result = await applyAssignments(admin, shopifyCatalogId, toAdd);
  if (result.error) {
    console.error(
      `Automatic assignment apply failed for ${shopifyCatalogId} (${shopDomain}): ${result.error}`,
    );
    return;
  }
  console.log(
    `Automatic assignment apply added ${result.added.length} location(s) to ${shopifyCatalogId} (${shopDomain})`,
  );
}
