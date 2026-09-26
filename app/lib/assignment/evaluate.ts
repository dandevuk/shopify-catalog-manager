import type { IndexedMetafields } from "../product-index/metafields";
import type { MatchMode } from "../rules/conditions";
import { matchesMetafieldCondition } from "../rules/evaluate";
import {
  validateAssignmentCondition,
  type AssignmentCondition,
  type ValidAssignmentCondition,
} from "./conditions";

/**
 * The B2B catalog assignment evaluator (Phase 2): decides which company
 * locations get access to a catalog.
 *
 *   Assigned = the include conditions match (ALL or ANY)
 *
 * Unlike product rules, there's no exclude group and no pin/block overrides
 * for v1 (CLAUDE.md decision): applying assignment rules only ever adds a
 * location to a catalog, never removes one, so there's nothing to exclude
 * from. A location can match more than one catalog's rules; each catalog's
 * assignment rule set is evaluated independently, so a location can end up
 * assigned to several catalogs.
 *
 * Pure: runs over company/location data read live from Shopify (companies
 * and locations are far fewer than products, so v1 doesn't index them).
 */

/** The fields an assignment rule can test, for one company location. */
export interface RuleLocation {
  locationId: string;
  name: string;
  companyId: string;
  companyName: string;
  companyMetafields: IndexedMetafields | null;
  locationMetafields: IndexedMetafields | null;
}

export interface AssignmentRuleSetInput {
  includeMatch: MatchMode;
  conditions: AssignmentCondition[];
}

export type AssignmentDecision =
  /** `matched`: the conditions the location met */
  | { assigned: true; matched: ValidAssignmentCondition[] }
  | { assigned: false };

export type AssignmentEvaluationResult =
  | {
      ok: true;
      /** Locations to assign, in input order */
      locationIds: string[];
      decisions: Map<string, AssignmentDecision>;
    }
  /** The rule set has conditions that can't be used; nothing was evaluated. */
  | { ok: false; errors: { condition: AssignmentCondition; error: string }[] };

export function evaluateAssignmentRules(
  ruleSet: AssignmentRuleSetInput,
  locations: RuleLocation[],
): AssignmentEvaluationResult {
  // Refuse to evaluate a rule set with a broken condition rather than guess:
  // skipping it could assign far more (or fewer) locations than intended.
  const errors = ruleSet.conditions.flatMap((condition) => {
    const error = validateAssignmentCondition(condition);
    return error ? [{ condition, error }] : [];
  });
  if (errors.length > 0) return { ok: false, errors };

  // "is set" and "is not set" have no value; ValidAssignmentCondition promises text.
  const conditions = ruleSet.conditions.map(
    (condition) =>
      ({ ...condition, value: condition.value ?? "" }) as ValidAssignmentCondition,
  );

  const locationIds: string[] = [];
  const decisions = new Map<string, AssignmentDecision>();
  for (const location of locations) {
    const matched = groupMatches(location, conditions, ruleSet.includeMatch);
    const decision: AssignmentDecision = matched
      ? { assigned: true, matched }
      : { assigned: false };
    decisions.set(location.locationId, decision);
    if (decision.assigned) locationIds.push(location.locationId);
  }
  return { ok: true, locationIds, decisions };
}

/**
 * The conditions that made the group match, or null if it didn't. An empty
 * group never matches, so a half-built rule set can never assign every
 * location to a catalog.
 */
function groupMatches(
  location: RuleLocation,
  conditions: ValidAssignmentCondition[],
  mode: MatchMode,
): ValidAssignmentCondition[] | null {
  if (conditions.length === 0) return null;
  const met = conditions.filter((condition) =>
    matchesCondition(location, condition),
  );
  if (mode === "ALL") return met.length === conditions.length ? met : null;
  return met.length > 0 ? met : null;
}

function matchesCondition(
  location: RuleLocation,
  condition: ValidAssignmentCondition,
): boolean {
  const metafields =
    condition.field === "company_metafield"
      ? location.companyMetafields
      : location.locationMetafields;
  return matchesMetafieldCondition(metafields, condition);
}
