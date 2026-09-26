import { toCatalogParam } from "../shopify/catalog-id";
import {
  describeCondition,
  isConditionField,
  normalise,
  type ValidCondition,
} from "../rules/conditions";
import {
  describeAssignmentCondition,
  isAssignmentField,
  type ValidAssignmentCondition,
} from "../assignment/conditions";

/**
 * Pure matching and description logic for the Sidekick "search_catalogs" and
 * "describe_catalog_rules" tools (`extensions/catalog-tools`). Kept separate
 * from the Prisma read (`search.server.ts`) the same way
 * `app/lib/rules/{conditions,preview}.ts` are pure and `rules.server.ts` does
 * the I/O.
 *
 * v1 doesn't resolve collection, category or metafield-definition names (that
 * needs a Shopify Admin API call per condition): matches and descriptions use
 * the raw stored value and metafield key. Good enough for text conditions
 * (tag, vendor, metafield values), which is what merchants are most likely to
 * describe a catalog by.
 */

export interface StoredCondition {
  group: "INCLUDE" | "EXCLUDE";
  field: string;
  operator: string;
  value: string | null;
  metafieldKey: string | null;
  metafieldType: string | null;
}

export interface StoredAssignmentCondition {
  field: string;
  operator: string;
  value: string | null;
  metafieldKey: string | null;
  metafieldType: string | null;
}

export interface SearchableCatalog {
  shopifyCatalogId: string;
  type: "MARKET" | "COMPANY_LOCATION";
  title: string;
  includeMatch: "ALL" | "ANY";
  excludeMatch: "ALL" | "ANY";
  /** Product membership rules (RuleSetKind.CATALOG), if any are saved */
  conditions: StoredCondition[];
  /** B2B assignment rules (RuleSetKind.ASSIGNMENT); COMPANY_LOCATION only.
   *  Assignment rules have no exclude group (Phase 2: additive only). */
  assignmentIncludeMatch: "ALL" | "ANY";
  assignmentConditions: StoredAssignmentCondition[];
}

export interface CatalogSearchResult {
  id: string;
  type: string;
  title: string;
  /** Why this catalog matched, as plain-English condition descriptions */
  reasons: string[];
  urlParam: string | null;
}

/** Text a condition contributes to both matching and its own description. */
function conditionSearchText(condition: StoredCondition | StoredAssignmentCondition): string[] {
  return [condition.value, condition.metafieldKey].filter(
    (part): part is string => Boolean(part),
  );
}

function describeStoredCondition(condition: StoredCondition): string | null {
  if (!isConditionField(condition.field)) return null;
  return describeCondition(condition as ValidCondition);
}

function describeStoredAssignmentCondition(
  condition: StoredAssignmentCondition,
): string | null {
  if (!isAssignmentField(condition.field)) return null;
  return describeAssignmentCondition(condition as ValidAssignmentCondition);
}

/**
 * Finds catalogs whose title or saved rule conditions loosely match a
 * free-text query (case-insensitive substring match against each condition's
 * value and metafield key). Ranked by number of matching conditions, title
 * matches counting as one extra match.
 */
export function searchCatalogs(
  catalogs: SearchableCatalog[],
  query: string,
  catalogType?: "MARKET" | "COMPANY_LOCATION",
  limit = 5,
): CatalogSearchResult[] {
  const needle = normalise(query);
  if (!needle) return [];

  const scored = catalogs
    .filter((catalog) => !catalogType || catalog.type === catalogType)
    .map((catalog) => {
      const titleMatches = normalise(catalog.title).includes(needle) ? 1 : 0;
      const matchingConditions = catalog.conditions.filter((condition) =>
        conditionSearchText(condition).some((text) =>
          normalise(text).includes(needle),
        ),
      );
      const matchingAssignmentConditions = catalog.assignmentConditions.filter(
        (condition) =>
          conditionSearchText(condition).some((text) =>
            normalise(text).includes(needle),
          ),
      );
      const score =
        titleMatches +
        matchingConditions.length +
        matchingAssignmentConditions.length;
      const reasons = [
        ...matchingConditions.map(describeStoredCondition),
        ...matchingAssignmentConditions.map(describeStoredAssignmentCondition),
      ].filter((reason): reason is string => Boolean(reason));
      return { catalog, score, reasons, titleMatches };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ catalog, reasons, titleMatches }) => ({
    id: catalog.shopifyCatalogId,
    type: catalog.type,
    title: catalog.title,
    reasons:
      reasons.length > 0
        ? reasons
        : titleMatches
          ? ["Matched by catalog name"]
          : [],
    urlParam: toCatalogParam(catalog.shopifyCatalogId),
  }));
}

export interface CatalogRulesDescription {
  title: string;
  type: string;
  urlParam: string | null;
  /** Null when the catalog has no saved include conditions */
  includeRules: string | null;
  /** Null when the catalog has no saved exclude conditions */
  excludeRules: string | null;
  /** Null when the catalog has no saved assignment rules, or isn't B2B */
  assignmentRules: string | null;
}

function joinDescriptions(
  descriptions: string[],
  matchMode: "ALL" | "ANY",
): string | null {
  if (descriptions.length === 0) return null;
  return descriptions.join(matchMode === "ALL" ? " and " : " or ");
}

/** Explains a single catalog's saved rules in plain language. */
export function describeCatalogRules(
  catalog: SearchableCatalog,
): CatalogRulesDescription {
  const byGroup = (group: "INCLUDE" | "EXCLUDE") =>
    catalog.conditions
      .filter((condition) => condition.group === group)
      .map(describeStoredCondition)
      .filter((d): d is string => Boolean(d));

  const assignmentRules = joinDescriptions(
    catalog.assignmentConditions
      .map(describeStoredAssignmentCondition)
      .filter((d): d is string => Boolean(d)),
    catalog.assignmentIncludeMatch,
  );
  return {
    title: catalog.title,
    type: catalog.type,
    urlParam: toCatalogParam(catalog.shopifyCatalogId),
    includeRules: joinDescriptions(byGroup("INCLUDE"), catalog.includeMatch),
    excludeRules: joinDescriptions(byGroup("EXCLUDE"), catalog.excludeMatch),
    assignmentRules,
  };
}
