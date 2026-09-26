import prisma from "../../db.server";
import { normalise } from "../rules/conditions";
import type { SearchableCatalog } from "./search";

/**
 * Prisma side of the Sidekick tools (`extensions/catalog-tools`): everything
 * a search or description needs is already in the app's own database (the
 * saved rules), so unlike the rule builder this needs no Shopify Admin API
 * call at all.
 */

const CATALOG_WITH_RULES = {
  ruleSets: {
    include: { conditions: { orderBy: { position: "asc" as const } } },
  },
} as const;

type CatalogWithRules = Awaited<
  ReturnType<typeof prisma.catalog.findMany<{ where: { shopId: string }; include: typeof CATALOG_WITH_RULES }>>
>[number];

function toSearchable(catalog: CatalogWithRules): SearchableCatalog {
  const catalogRuleSet = catalog.ruleSets.find((rs) => rs.kind === "CATALOG");
  const assignmentRuleSet = catalog.ruleSets.find((rs) => rs.kind === "ASSIGNMENT");
  return {
    shopifyCatalogId: catalog.shopifyCatalogId,
    type: catalog.type,
    title: catalog.title,
    includeMatch: catalogRuleSet?.includeMatch ?? "ALL",
    excludeMatch: catalogRuleSet?.excludeMatch ?? "ANY",
    conditions: (catalogRuleSet?.conditions ?? []).map((c) => ({
      group: c.group,
      field: c.field,
      operator: c.operator,
      value: c.value,
      metafieldKey: c.metafieldKey,
      metafieldType: c.metafieldType,
    })),
    assignmentIncludeMatch: assignmentRuleSet?.includeMatch ?? "ALL",
    assignmentConditions: (assignmentRuleSet?.conditions ?? []).map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value,
      metafieldKey: c.metafieldKey,
      metafieldType: c.metafieldType,
    })),
  };
}

/** Every catalog the shop has saved rules for (or none: still searchable by title). */
export async function loadSearchableCatalogs(shopId: string): Promise<SearchableCatalog[]> {
  const catalogs = await prisma.catalog.findMany({
    where: { shopId },
    include: CATALOG_WITH_RULES,
  });
  return catalogs.map(toSearchable);
}

/**
 * Finds one catalog by title for `describe_catalog_rules`: an exact
 * case-insensitive match if there is one, otherwise the first substring
 * match (titles aren't unique, so this is best effort, matching how a
 * merchant would refer to a catalog by name in conversation).
 */
export async function findSearchableCatalogByTitle(
  shopId: string,
  title: string,
): Promise<SearchableCatalog | null> {
  const catalogs = await loadSearchableCatalogs(shopId);
  const needle = normalise(title);
  if (!needle) return null;
  const exact = catalogs.find((c) => normalise(c.title) === needle);
  if (exact) return exact;
  return catalogs.find((c) => normalise(c.title).includes(needle)) ?? null;
}
