import {
  normalise,
  validateCondition,
  type MatchMode,
  type RuleCondition,
  type ValidCondition,
} from "./conditions";

/**
 * The rule evaluator: decides which products belong in a catalog.
 *
 *   In catalog = (Include AND NOT Exclude AND NOT Blocked) OR Pinned
 *
 * Each group matches ALL or ANY of its conditions. An empty include group
 * matches nothing, so a half-built rule set can never put the whole store in
 * a catalog; an empty exclude group excludes nothing.
 *
 * Pure: it runs over product index rows in memory, and every decision comes
 * with a reason for the preview and the audit log.
 */

/** The index fields rules can test (a subset of a ProductIndex row). */
export interface RuleProduct {
  productId: string;
  title: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  categoryId: string | null;
  collectionIds: string[];
  onlineStorePublished: boolean;
}

export interface RuleSetInput {
  includeMatch: MatchMode;
  excludeMatch: MatchMode;
  conditions: RuleCondition[];
}

export type Override = "PIN" | "BLOCK";

export type Decision =
  | { inCatalog: true; reason: "pinned" }
  /** `matched`: the include conditions the product met */
  | { inCatalog: true; reason: "included"; matched: ValidCondition[] }
  | { inCatalog: false; reason: "blocked" }
  /** `matched`: the exclude conditions the product met */
  | { inCatalog: false; reason: "excluded"; matched: ValidCondition[] }
  | { inCatalog: false; reason: "not_included" };

export type EvaluationResult =
  | {
      ok: true;
      /** Products in the catalog, in index order */
      productIds: string[];
      decisions: Map<string, Decision>;
    }
  /** The rule set has conditions that can't be used; nothing was evaluated. */
  | { ok: false; errors: { condition: RuleCondition; error: string }[] };

export function evaluateRuleSet(
  ruleSet: RuleSetInput,
  products: RuleProduct[],
  overrides: ReadonlyMap<string, Override> = new Map(),
): EvaluationResult {
  // Refuse to evaluate a rule set with a broken condition rather than guess:
  // skipping it could put far more (or fewer) products in a live catalog.
  const errors = ruleSet.conditions.flatMap((condition) => {
    const error = validateCondition(condition);
    return error ? [{ condition, error }] : [];
  });
  if (errors.length > 0) return { ok: false, errors };

  const conditions = ruleSet.conditions as ValidCondition[];
  const include = conditions.filter((c) => c.group === "INCLUDE");
  const exclude = conditions.filter((c) => c.group === "EXCLUDE");

  const productIds: string[] = [];
  const decisions = new Map<string, Decision>();
  for (const product of products) {
    const decision = decide(
      product,
      include,
      ruleSet.includeMatch,
      exclude,
      ruleSet.excludeMatch,
      overrides.get(product.productId),
    );
    decisions.set(product.productId, decision);
    if (decision.inCatalog) productIds.push(product.productId);
  }
  return { ok: true, productIds, decisions };
}

function decide(
  product: RuleProduct,
  include: ValidCondition[],
  includeMatch: MatchMode,
  exclude: ValidCondition[],
  excludeMatch: MatchMode,
  override: Override | undefined,
): Decision {
  if (override === "PIN") return { inCatalog: true, reason: "pinned" };
  if (override === "BLOCK") return { inCatalog: false, reason: "blocked" };

  const included = groupMatches(product, include, includeMatch);
  if (!included) return { inCatalog: false, reason: "not_included" };

  const excluded = groupMatches(product, exclude, excludeMatch);
  if (excluded)
    return { inCatalog: false, reason: "excluded", matched: excluded };

  return { inCatalog: true, reason: "included", matched: included };
}

/**
 * The conditions that made the group match, or null if it didn't. An empty
 * group never matches.
 */
function groupMatches(
  product: RuleProduct,
  conditions: ValidCondition[],
  mode: MatchMode,
): ValidCondition[] | null {
  if (conditions.length === 0) return null;
  const met = conditions.filter((condition) =>
    matchesCondition(product, condition),
  );
  if (mode === "ALL") return met.length === conditions.length ? met : null;
  return met.length > 0 ? met : null;
}

export function matchesCondition(
  product: RuleProduct,
  condition: ValidCondition,
): boolean {
  const value = condition.value.trim();

  switch (condition.field) {
    case "tag":
      // A product matches if any one of its tags does.
      return product.tags.some((tag) =>
        compareText(tag, condition.operator, value),
      );
    case "vendor":
      return compareText(product.vendor, condition.operator, value);
    case "product_type":
      return compareText(product.productType, condition.operator, value);
    case "title":
      return compareText(product.title, condition.operator, value);
    case "status":
      return compareText(product.status, condition.operator, value);
    case "in_collection": {
      const inCollection = product.collectionIds.includes(value);
      return condition.operator === "equals" ? inCollection : !inCollection;
    }
    case "online_store_published":
      return product.onlineStorePublished === (value === "true");
    case "category": {
      if (!product.categoryId) return false;
      if (condition.operator === "equals") return product.categoryId === value;
      // Taxonomy IDs nest by suffix: .../sg-4-17 contains .../sg-4-17-2.
      return (
        product.categoryId === value ||
        product.categoryId.startsWith(`${value}-`)
      );
    }
  }
}

function compareText(
  actual: string | null,
  operator: ValidCondition["operator"],
  expected: string,
): boolean {
  const a = normalise(actual);
  const e = normalise(expected);
  switch (operator) {
    case "equals":
      return a === e;
    case "not_equals":
      return a !== e;
    case "contains":
      return a.includes(e);
    case "not_contains":
      return !a.includes(e);
    case "starts_with":
      return a.startsWith(e);
    case "ends_with":
      return a.endsWith(e);
    case "within":
      return false;
  }
}
