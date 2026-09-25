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
  | "category";

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  /** Category only: the category itself or any category below it */
  | "within";

/** A condition as stored (the Condition table), before it's checked. */
export interface RuleCondition {
  id?: string;
  group: ConditionGroup;
  field: string;
  operator: string;
  value: string | null;
}

/** How the builder screen asks for a value. */
export type ValueKind =
  | "text"
  /** One of the store's collections, stored as its GID */
  | "collection"
  /** One of `options` */
  | "choice"
  /** A taxonomy category, stored as its GID */
  | "category";

export interface FieldDefinition {
  label: string;
  operators: ConditionOperator[];
  valueKind: ValueKind;
  /** For "choice" values: stored value and label */
  options?: { value: string; label: string }[];
}

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
};

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
  value: string;
}

/** Returns why a condition can't be used, or null if it's fine. */
export function validateCondition(condition: RuleCondition): string | null {
  if (!isConditionField(condition.field))
    return `Unknown field "${condition.field}".`;
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
 * Text comparisons ignore case and surrounding spaces, like Shopify's own
 * collection conditions.
 */
export function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en");
}

/** Readable form of a condition, e.g. "Vendor is Driftline". */
export function describeCondition(
  condition: ValidCondition,
  /** Turns stored IDs (collections, categories) into names */
  nameFor: (id: string) => string | undefined = () => undefined,
): string {
  if (condition.field === "online_store_published") {
    return condition.value === "true"
      ? "On the Online Store"
      : "Not on the Online Store";
  }
  const definition = FIELDS[condition.field];
  const option = definition.options?.find((o) => o.value === condition.value);
  const value = option?.label ?? nameFor(condition.value) ?? condition.value;
  return `${definition.label} ${operatorLabel(condition.field, condition.operator)} ${value}`;
}
