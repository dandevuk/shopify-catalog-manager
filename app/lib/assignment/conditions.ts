import {
  isSupportedMetafieldType,
  metafieldKind,
} from "../product-index/metafields";
import {
  METAFIELD_OPERATORS,
  OPERATOR_LABELS,
  operatorTakesValue,
  type ConditionOperator,
} from "../rules/conditions";

/**
 * Conditions for B2B catalog assignment rules (Phase 2): which company
 * locations get access to a catalog. Metafield-only for v1 (CLAUDE.md
 * decision): companies and locations have no tags field, and there's no
 * customer segment or customer tag context to assign by.
 *
 * Reuses the metafield validation and matching rules already built for
 * product conditions (`app/lib/rules/conditions.ts`), scoped to two owners
 * instead of one.
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
export function operatorsFor(metafieldType?: string | null): ConditionOperator[] {
  const kind = metafieldKind(metafieldType ?? "");
  return kind ? METAFIELD_OPERATORS[kind] : [];
}

/** "namespace.key": letters, digits, _ and -, with an optional app prefix. */
const METAFIELD_KEY = /^(\$app:)?[\w-]+\.[\w-]+$/;

/** Returns why a condition can't be used, or null if it's fine. */
export function validateAssignmentCondition(
  condition: AssignmentCondition,
): string | null {
  if (!isAssignmentField(condition.field))
    return `Unknown field "${condition.field}".`;
  const label = FIELD_LABELS[condition.field];

  const key = condition.metafieldKey?.trim() ?? "";
  if (!key) return `Choose a ${label.toLowerCase()}.`;
  if (!METAFIELD_KEY.test(key)) return `"${key}" isn't a metafield key.`;
  if (!isSupportedMetafieldType(condition.metafieldType ?? "")) {
    return `${label} ${key} has a type rules can't use (${condition.metafieldType ?? "unknown"}).`;
  }

  const operators = operatorsFor(condition.metafieldType);
  const operator = condition.operator as ConditionOperator;
  if (!operators.includes(operator))
    return `${label} ${key} can't use "${condition.operator}".`;
  if (!operatorTakesValue(operator)) return null;

  const value = condition.value?.trim() ?? "";
  if (!value) return `${label} ${key} needs a value.`;
  const kind = metafieldKind(condition.metafieldType ?? "");
  if (kind === "number" && !Number.isFinite(Number(value))) {
    return `${label} ${key} needs a number.`;
  }
  if (kind === "boolean" && value !== "true" && value !== "false") {
    return `${label} ${key} must be true or false.`;
  }
  return null;
}

/** Readable form of a condition, e.g. "Customer type is wholesale". */
export function describeAssignmentCondition(
  condition: ValidAssignmentCondition,
  /** Turns a metafield key into its definition name */
  nameFor: (key: string) => string | undefined = () => undefined,
): string {
  const key = condition.metafieldKey ?? "";
  const name = nameFor(key) ?? key;
  const operator = OPERATOR_LABELS[condition.operator];
  if (!operatorTakesValue(condition.operator)) return `${name} ${operator}`;
  const value =
    metafieldKind(condition.metafieldType ?? "") === "boolean"
      ? condition.value === "true"
        ? "true"
        : "false"
      : condition.value;
  return `${name} ${operator} ${value}`;
}
