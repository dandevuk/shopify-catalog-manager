import prisma from "../../db.server";
import { backgroundAdmin } from "../product-index/index.server";
import { applyAssignments } from "./apply.server";
import { evaluateAssignmentRules } from "./evaluate";
import { listAssignmentLocations } from "./locations.server";
import { isUnassignedMatch } from "./preview";
import { loadAssignmentRules } from "./rules.server";

/**
 * Automatic assignment re-scan (Phase 2, step 5): re-applies every catalog's
 * saved assignment rules on a schedule (`app/lib/queue/queues.server.ts`),
 * since there's no webhook to react to (`company_locations/*` is
 * deliberately unused, protected customer data). Additive only, the same as
 * a manual apply: this only ever adds a location, never removes one.
 */

export async function runAssignmentAutoScan(): Promise<void> {
  const catalogs = await prisma.catalog.findMany({
    where: { type: "COMPANY_LOCATION", ruleSets: { some: { kind: "ASSIGNMENT" } } },
    include: { shop: true },
  });
  for (const catalog of catalogs) {
    try {
      await applyAssignmentRules(catalog.shop.domain, catalog.id);
    } catch (error) {
      console.error(`Automatic assignment scan failed for catalog ${catalog.id}`, error);
    }
  }
}

async function applyAssignmentRules(
  shopDomain: string,
  catalogRecordId: string,
): Promise<void> {
  const savedRules = await loadAssignmentRules(catalogRecordId);
  if (!savedRules) return; // rules were deleted since the scan started

  const catalog = await prisma.catalog.findUnique({ where: { id: catalogRecordId } });
  if (!catalog) return;

  const admin = await backgroundAdmin(shopDomain);
  if (!admin) return;

  const locations = await listAssignmentLocations(admin);
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
        catalog.shopifyCatalogId,
      ),
    )
    .map((location) => location.locationId);
  if (toAdd.length === 0) return;

  const result = await applyAssignments(admin, catalog.shopifyCatalogId, toAdd);
  if (result.error) {
    console.error(
      `Automatic assignment apply failed for ${catalog.shopifyCatalogId} (${shopDomain}): ${result.error}`,
    );
    return;
  }
  console.log(
    `Automatic assignment apply added ${result.added.length} location(s) to ${catalog.shopifyCatalogId} (${shopDomain})`,
  );
}
