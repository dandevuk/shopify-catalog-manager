import {
  describeMetafieldValue,
  metafieldOperatorsFor,
  validateMetafieldValue,
  type ConditionOperator,
} from "../rules/conditions";

/**
 * Conditions for B2B catalog assignment rules (Phase 2): which company
 * locations get access to a catalog. Metafield-only for v1 (CLAUDE.md
 * decision): companies and locations have no tags field, and there's no
 * customer segment or customer tag context to assign by.
 *
 * Every assignment condition is a metafield condition, so this reuses the
 * metafield validation, describing and operator rules built for product
 * conditions (`app/lib/rules/conditions.ts`) directly, rather than
 * reimplementing them for two owners (company, location) instead of one.
 */

export type AssignmentConditionField = "company_metafield" | "location_metafield";

const FIELD_LABELS: Record<AssignmentConditionField, string> = {
  company_metafield: "Company metafield",
  location_metafield: "Location metafield",
};

export function isAssignmentField(
  field: string,
): field is AssignmentConditionField {
  return field === "company_metafield" || field === "location_metafield";
}

/** A condition as stored (the Condition table, RuleSet.kind = ASSIGNMENT). */
export interface AssignmentCondition {
  id?: string;
  field: string;
  operator: string;
  value: string | null;
  /** "namespace.key" */
  metafieldKey?: string | null;
  /** The definition's type, e.g. "number_integer" */
  metafieldType?: string | null;
}

/** An AssignmentCondition that passed validateAssignmentCondition. */
export interface ValidAssignmentCondition extends AssignmentCondition {
  field: AssignmentConditionField;
  operator: ConditionOperator;
  /** Empty for is_set and is_not_set */
  value: string;
}

/** Operators an assignment condition can use, given its metafield's type. */
export const operatorsFor = metafieldOperatorsFor;

/** Returns why a condition can't be used, or null if it's fine. */
export function validateAssignmentCondition(
  condition: AssignmentCondition,
): string | null {
  if (!isAssignmentField(condition.field))
    return `Unknown field "${condition.field}".`;
  return validateMetafieldValue(condition, FIELD_LABELS[condition.field]);
}

/** Readable form of a condition, e.g. "Customer type is wholesale". */
export function describeAssignmentCondition(
  condition: ValidAssignmentCondition,
  /** Turns a metafield key into its definition name */
  nameFor: (key: string) => string | undefined = () => undefined,
): string {
  return describeMetafieldValue(condition, nameFor);
}
