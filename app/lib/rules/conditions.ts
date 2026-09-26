import {
  isSupportedMetafieldType,
  metafieldKind,
  type MetafieldKind,
} from "../product-index/metafields";

/**
 * Rule conditions: which fields a condition can test, which operators each
 * field allows, and how to check and describe a condition.
 *
 * Field and operator names are what the Condition table stores, so changing
 * one needs a data migration. The builder screen reads FIELDS for its menus.
 */

export type ConditionGroup = "INCLUDE" | "EXCLUDE";
export type MatchMode = "ALL" | "ANY";

export type ConditionField =
  | "tag"
  | "vendor"
  | "product_type"
  | "title"
  | "in_collection"
  | "status"
  | "online_store_published"
  | "category"
  /** A product metafield, named by `metafieldKey` (e.g. "custom.trade_tier") */
  | "metafield";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  /** Category only: the category itself or any category below it */
  | "within"
  /** Number metafields */
  | "greater_than"
  | "less_than"
  /** Metafields: has a value, or doesn't; these take no value */
  | "is_set"
  | "is_not_set";

/** A condition as stored (the Condition table), before it's checked. */
export interface RuleCondition {
  id?: string;
  group: ConditionGroup;
  field: string;
  operator: string;
  value: string | null;
  /** Metafield conditions only: "namespace.key" */
  metafieldKey?: string | null;
  /** Metafield conditions only: the definition's type, e.g. "number_integer" */
  metafieldType?: string | null;
}

/** How the builder screen asks for a value. */
export type ValueKind =
  | "text"
  /** One of the store's collections, stored as its GID */
  | "collection"
  /** One of `options` */
  | "choice"
  /** A taxonomy category, stored as its GID */
  | "category"
  /** Depends on the chosen metafield's type (see METAFIELD_OPERATORS) */
  | "metafield";

export interface FieldDefinition {
  label: string;
  operators: ConditionOperator[];
  valueKind: ValueKind;
  /** For "choice" values: stored value and label */
  options?: { value: string; label: string }[];
}

/** Operators per metafield kind; the first is the default. */
export const METAFIELD_OPERATORS: Record<MetafieldKind, ConditionOperator[]> = {
  text: [
    "equals",
    "not_equals",
    "contains",
    "starts_with",
    "is_set",
    "is_not_set",
  ],
  number: [
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "is_set",
    "is_not_set",
  ],
  boolean: ["equals", "is_set", "is_not_set"],
  list: ["contains", "not_contains", "is_set", "is_not_set"],
};

export const FIELDS: Record<ConditionField, FieldDefinition> = {
  tag: {
    label: "Tag",
    operators: ["equals", "starts_with"],
    valueKind: "text",
  },
  vendor: {
    label: "Vendor",
    operators: ["equals", "not_equals", "contains", "starts_with"],
    valueKind: "text",
  },
  product_type: {
    label: "Product type",
    operators: ["equals", "not_equals", "contains", "starts_with"],
    valueKind: "text",
  },
  title: {
    label: "Title",
    operators: [
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
      "equals",
    ],
    valueKind: "text",
  },
  in_collection: {
    label: "Collection",
    operators: ["equals", "not_equals"],
    valueKind: "collection",
  },
  status: {
    label: "Status",
    operators: ["equals", "not_equals"],
    valueKind: "choice",
    // ProductStatus values; the builder can add any others the schema lists.
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "DRAFT", label: "Draft" },
      { value: "ARCHIVED", label: "Archived" },
    ],
  },
  online_store_published: {
    label: "Online Store",
    operators: ["equals"],
    valueKind: "choice",
    options: [
      { value: "true", label: "Published" },
      { value: "false", label: "Not published" },
    ],
  },
  category: {
    label: "Category",
    operators: ["equals", "within"],
    valueKind: "category",
  },
  metafield: {
    label: "Metafield",
    // Narrowed by the metafield's type: see operatorsFor.
    operators: [
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "starts_with",
      "greater_than",
      "less_than",
      "is_set",
      "is_not_set",
    ],
    valueKind: "metafield",
  },
};

/** Operators a condition can use; for metafields, depends on the type. */
export function operatorsFor(
  field: ConditionField,
  metafieldType?: string | null,
): ConditionOperator[] {
  return field === "metafield"
    ? metafieldOperatorsFor(metafieldType)
    : FIELDS[field].operators;
}

/**
 * Operators a metafield condition can use, given its type. Shared with the
 * assignment evaluator's company/location metafield conditions
 * (`app/lib/assignment/conditions.ts`, Phase 2).
 */
export function metafieldOperatorsFor(
  metafieldType?: string | null,
): ConditionOperator[] {
  const kind = metafieldKind(metafieldType ?? "");
  return kind ? METAFIELD_OPERATORS[kind] : [];
}

/** Operators that don't take a value. */
export function operatorTakesValue(operator: ConditionOperator): boolean {
  return operator !== "is_set" && operator !== "is_not_set";
}

/**
 * Operator wording. Some read differently per field: a product is "in" a
 * collection but a vendor "is" a value.
 */
const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  ends_with: "ends with",
  within: "is in or below",
  greater_than: "is greater than",
  less_than: "is less than",
  is_set: "is set",
  is_not_set: "is not set",
};

export function operatorLabel(
  field: ConditionField,
  operator: ConditionOperator,
): string {
  if (field === "in_collection")
    return operator === "equals" ? "is in" : "is not in";
  if (field === "online_store_published") return "is";
  return OPERATOR_LABELS[operator];
}

export function isConditionField(field: string): field is ConditionField {
  return Object.prototype.hasOwnProperty.call(FIELDS, field);
}

/** A condition that passed validateCondition. */
export interface ValidCondition extends RuleCondition {
  field: ConditionField;
  operator: ConditionOperator;
  /** Empty for is_set and is_not_set */
  value: string;
}

/** "namespace.key": letters, digits, _ and -, with an optional app prefix. */
const METAFIELD_KEY = /^(\$app:)?[\w-]+\.[\w-]+$/;

/** Returns why a condition can't be used, or null if it's fine. */
export function validateCondition(condition: RuleCondition): string | null {
  if (!isConditionField(condition.field))
    return `Unknown field "${condition.field}".`;
  if (condition.field === "metafield") return validateMetafieldValue(condition);
  const definition = FIELDS[condition.field];

  if (!definition.operators.includes(condition.operator as ConditionOperator)) {
    return `${definition.label} can't use "${condition.operator}".`;
  }

  const value = condition.value?.trim() ?? "";
  if (!value) return `${definition.label} needs a value.`;
  if (
    definition.options &&
    condition.field !== "status" &&
    !definition.options.some((option) => option.value === value)
  ) {
    return `${definition.label} can't be "${value}".`;
  }
  return null;
}

/**
 * Validates a metafield condition, whatever it's a condition on: a product
 * metafield here, or a company/location metafield in the assignment
 * evaluator (`app/lib/assignment/conditions.ts`, Phase 2), which passes its
 * own field label ("Company metafield") in place of the default.
 */
export function validateMetafieldValue(
  condition: Pick<
    RuleCondition,
    "operator" | "value" | "metafieldKey" | "metafieldType"
  >,
  label = "Metafield",
): string | null {
  const key = condition.metafieldKey?.trim() ?? "";
  if (!key) return `Choose a ${label.toLowerCase()}.`;
  if (!METAFIELD_KEY.test(key)) return `"${key}" isn't a metafield key.`;
  if (!isSupportedMetafieldType(condition.metafieldType ?? "")) {
    return `${label} ${key} has a type rules can't use (${condition.metafieldType ?? "unknown"}).`;
  }

  const operators = metafieldOperatorsFor(condition.metafieldType);
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

/**
 * Text comparisons ignore case and surrounding spaces, like Shopify's own
 * collection conditions.
 */
export function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en");
}

/** Readable form of a condition, e.g. "Vendor is Driftline". */
export function describeCondition(
  condition: ValidCondition,
  /** Turns stored IDs (collections, categories) and metafield keys into names */
  nameFor: (id: string) => string | undefined = () => undefined,
): string {
  if (condition.field === "online_store_published") {
    return condition.value === "true"
      ? "On the Online Store"
      : "Not on the Online Store";
  }
  if (condition.field === "metafield") return describeMetafieldValue(condition, nameFor);
  const definition = FIELDS[condition.field];
  const option = definition.options?.find((o) => o.value === condition.value);
  const value = option?.label ?? nameFor(condition.value) ?? condition.value;
  return `${definition.label} ${operatorLabel(condition.field, condition.operator)} ${value}`;
}

/**
 * Readable form of a metafield condition, e.g. "Trade tier is gold". Shared
 * with the assignment evaluator's company/location metafield conditions
 * (`app/lib/assignment/conditions.ts`, Phase 2).
 */
export function describeMetafieldValue(
  condition: Pick<
    ValidCondition,
    "operator" | "value" | "metafieldKey" | "metafieldType"
  >,
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
