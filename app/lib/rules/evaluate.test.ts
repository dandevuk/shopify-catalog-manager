import { describe, expect, it } from "vitest";
import type { RuleCondition } from "./conditions";
import {
  evaluateRuleSet,
  type Override,
  type RuleProduct,
  type RuleSetInput,
} from "./evaluate";

const COLLECTION = "gid://shopify/Collection/490802348206";
const SNOWBOARDS = "gid://shopify/TaxonomyCategory/sg-4-17-2-17";

const product = (
  id: number,
  extra: Partial<RuleProduct> = {},
): RuleProduct => ({
  productId: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  status: "ACTIVE",
  vendor: "Driftline",
  productType: "Snowboard",
  tags: [],
  categoryId: null,
  collectionIds: [],
  onlineStorePublished: true,
  ...extra,
});

const include = (
  field: string,
  operator: string,
  value: string | null,
): RuleCondition => ({
  group: "INCLUDE",
  field,
  operator,
  value,
});
const exclude = (
  field: string,
  operator: string,
  value: string | null,
): RuleCondition => ({
  ...include(field, operator, value),
  group: "EXCLUDE",
});

const ruleSet = (
  conditions: RuleCondition[],
  extra: Partial<RuleSetInput> = {},
): RuleSetInput => ({
  includeMatch: "ALL",
  excludeMatch: "ANY",
  conditions,
  ...extra,
});

/** Numeric IDs of the products in the catalog. */
function run(
  rules: RuleSetInput,
  products: RuleProduct[],
  overrides?: Map<string, Override>,
) {
  const result = evaluateRuleSet(rules, products, overrides);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.productIds.map((id) => Number(id.split("/").pop()));
}

/** Does one include condition match one product? */
const matches = (condition: RuleCondition, p: RuleProduct) =>
  run(ruleSet([condition]), [p]).length === 1;

describe("groups", () => {
  it("an empty include group matches nothing", () => {
    expect(run(ruleSet([]), [product(1), product(2)])).toEqual([]);
    expect(
      run(ruleSet([exclude("vendor", "equals", "Other")]), [product(1)]),
    ).toEqual([]);
  });

  it("an empty exclude group excludes nothing", () => {
    expect(
      run(ruleSet([include("vendor", "equals", "Driftline")]), [product(1)]),
    ).toEqual([1]);
  });

  it("ALL needs every include condition, ANY needs one", () => {
    const products = [
      product(1, { tags: ["trade"] }),
      product(2, { tags: ["trade"], vendor: "Alder & Co" }),
      product(3, { vendor: "Alder & Co" }),
    ];
    const conditions = [
      include("vendor", "equals", "Driftline"),
      include("tag", "equals", "trade"),
    ];

    expect(run(ruleSet(conditions, { includeMatch: "ALL" }), products)).toEqual(
      [1],
    );
    expect(run(ruleSet(conditions, { includeMatch: "ANY" }), products)).toEqual(
      [1, 2],
    );
  });

  it("exclude removes matching products, with ALL or ANY", () => {
    const products = [
      product(1, { tags: ["clearance"] }),
      product(2, { tags: ["clearance", "no-us"] }),
      product(3),
    ];
    const conditions = [
      include("vendor", "equals", "Driftline"),
      exclude("tag", "equals", "clearance"),
      exclude("tag", "equals", "no-us"),
    ];

    expect(run(ruleSet(conditions, { excludeMatch: "ANY" }), products)).toEqual(
      [3],
    );
    expect(run(ruleSet(conditions, { excludeMatch: "ALL" }), products)).toEqual(
      [1, 3],
    );
  });
});

describe("pins and blocks", () => {
  const rules = ruleSet([include("vendor", "equals", "Driftline")]);
  const products = [product(1), product(2, { vendor: "Alder & Co" })];

  it("a pinned product is in even when the rules leave it out", () => {
    expect(
      run(rules, products, new Map([["gid://shopify/Product/2", "PIN"]])),
    ).toEqual([1, 2]);
  });

  it("a blocked product is out even when the rules include it", () => {
    expect(
      run(rules, products, new Map([["gid://shopify/Product/1", "BLOCK"]])),
    ).toEqual([]);
  });

  it("a pinned product not in the index is still in the catalog", () => {
    const pinnedElsewhere = "gid://shopify/Product/77";
    const result = evaluateRuleSet(
      rules,
      products,
      new Map<string, Override>([
        [pinnedElsewhere, "PIN"],
        ["gid://shopify/Product/78", "BLOCK"],
      ]),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.productIds).toEqual([
      "gid://shopify/Product/1",
      pinnedElsewhere,
    ]);
    expect(result.decisions.get(pinnedElsewhere)).toEqual({
      inCatalog: true,
      reason: "pinned",
    });
    // A block for a product that isn't in the index changes nothing.
    expect(result.decisions.has("gid://shopify/Product/78")).toBe(false);
  });

  it("a pin beats an exclude condition", () => {
    const withExclude = ruleSet([
      include("vendor", "equals", "Driftline"),
      exclude("tag", "equals", "clearance"),
    ]);
    const clearance = product(1, { tags: ["clearance"] });
    expect(
      run(withExclude, [clearance], new Map([[clearance.productId, "PIN"]])),
    ).toEqual([1]);
  });
});

describe("decisions", () => {
  it("records why each product is in or out", () => {
    const vendor = include("vendor", "equals", "Driftline");
    const clearance = exclude("tag", "equals", "clearance");
    const result = evaluateRuleSet(
      ruleSet([vendor, clearance]),
      [
        product(1),
        product(2, { tags: ["clearance"] }),
        product(3, { vendor: "Other" }),
        product(4),
        product(5),
      ],
      new Map<string, Override>([
        ["gid://shopify/Product/4", "BLOCK"],
        ["gid://shopify/Product/5", "PIN"],
      ]),
    );
    if (!result.ok) throw new Error("expected ok");

    const reason = (id: number) =>
      result.decisions.get(`gid://shopify/Product/${id}`);
    expect(reason(1)).toEqual({
      inCatalog: true,
      reason: "included",
      matched: [vendor],
    });
    expect(reason(2)).toEqual({
      inCatalog: false,
      reason: "excluded",
      matched: [clearance],
    });
    expect(reason(3)).toEqual({ inCatalog: false, reason: "not_included" });
    expect(reason(4)).toEqual({ inCatalog: false, reason: "blocked" });
    expect(reason(5)).toEqual({ inCatalog: true, reason: "pinned" });
  });

  it("with ANY, lists only the include conditions that matched", () => {
    const vendor = include("vendor", "equals", "Driftline");
    const tag = include("tag", "equals", "trade");
    const result = evaluateRuleSet(
      ruleSet([vendor, tag], { includeMatch: "ANY" }),
      [product(1)],
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.decisions.get("gid://shopify/Product/1")).toEqual({
      inCatalog: true,
      reason: "included",
      matched: [vendor],
    });
  });
});

describe("validation", () => {
  it("refuses to evaluate a rule set with a broken condition", () => {
    const broken = [
      include("vendor", "equals", "Driftline"),
      include("price", "equals", "10"),
      include("tag", "contains", "x"),
      exclude("title", "contains", "  "),
      include("online_store_published", "equals", "maybe"),
    ];
    const result = evaluateRuleSet(ruleSet(broken), [product(1)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.error)).toEqual([
      'Unknown field "price".',
      'Tag can\'t use "contains".',
      "Title needs a value.",
      'Online Store can\'t be "maybe".',
    ]);
  });
});

describe("text fields", () => {
  it("ignore case and surrounding spaces", () => {
    expect(
      matches(include("vendor", "equals", "  driftLINE "), product(1)),
    ).toBe(true);
    expect(matches(include("title", "contains", "PRODUCT"), product(1))).toBe(
      true,
    );
    expect(
      matches(include("tag", "equals", "SALE"), product(1, { tags: ["Sale"] })),
    ).toBe(true);
  });

  it("support every operator", () => {
    const p = product(1, { title: "Driftline Echo Boots" });
    expect(matches(include("title", "equals", "driftline echo boots"), p)).toBe(
      true,
    );
    expect(matches(include("title", "contains", "echo"), p)).toBe(true);
    expect(matches(include("title", "not_contains", "helmet"), p)).toBe(true);
    expect(matches(include("title", "not_contains", "echo"), p)).toBe(false);
    expect(matches(include("title", "starts_with", "driftline"), p)).toBe(true);
    expect(matches(include("title", "ends_with", "boots"), p)).toBe(true);
    expect(matches(include("title", "ends_with", "echo"), p)).toBe(false);
    expect(matches(include("vendor", "not_equals", "Alder & Co"), p)).toBe(
      true,
    );
    expect(matches(include("vendor", "not_equals", "driftline"), p)).toBe(
      false,
    );
    expect(matches(include("product_type", "starts_with", "snow"), p)).toBe(
      true,
    );
  });

  it("treat a missing vendor or product type as empty", () => {
    const p = product(1, { vendor: null, productType: null });
    expect(matches(include("vendor", "equals", "Driftline"), p)).toBe(false);
    expect(matches(include("vendor", "not_equals", "Driftline"), p)).toBe(true);
    expect(matches(include("product_type", "contains", "board"), p)).toBe(
      false,
    );
  });
});

describe("tags", () => {
  it("match when any one tag matches", () => {
    const p = product(1, { tags: ["spike-seed", "market:uk"] });
    expect(matches(include("tag", "equals", "market:uk"), p)).toBe(true);
    expect(matches(include("tag", "starts_with", "market:"), p)).toBe(true);
    expect(matches(include("tag", "equals", "market"), p)).toBe(false);
  });

  it("never match a product with no tags", () => {
    expect(matches(include("tag", "starts_with", "a"), product(1))).toBe(false);
  });
});

describe("collections, status, Online Store and category", () => {
  it("collection is in and is not in", () => {
    const inside = product(1, { collectionIds: [COLLECTION] });
    expect(
      matches(include("in_collection", "equals", COLLECTION), inside),
    ).toBe(true);
    expect(
      matches(include("in_collection", "equals", COLLECTION), product(2)),
    ).toBe(false);
    expect(
      matches(include("in_collection", "not_equals", COLLECTION), product(2)),
    ).toBe(true);
  });

  it("status ignores case", () => {
    expect(matches(include("status", "equals", "active"), product(1))).toBe(
      true,
    );
    expect(matches(include("status", "not_equals", "DRAFT"), product(1))).toBe(
      true,
    );
    expect(matches(include("status", "equals", "DRAFT"), product(1))).toBe(
      false,
    );
  });

  it("Online Store published or not", () => {
    expect(
      matches(include("online_store_published", "equals", "true"), product(1)),
    ).toBe(true);
    const hidden = product(2, { onlineStorePublished: false });
    expect(
      matches(include("online_store_published", "equals", "false"), hidden),
    ).toBe(true);
    expect(
      matches(include("online_store_published", "equals", "true"), hidden),
    ).toBe(false);
  });

  it("category is, and is in or below", () => {
    const board = product(1, { categoryId: SNOWBOARDS });
    const parent = "gid://shopify/TaxonomyCategory/sg-4-17";
    expect(matches(include("category", "equals", SNOWBOARDS), board)).toBe(
      true,
    );
    expect(matches(include("category", "equals", parent), board)).toBe(false);
    expect(matches(include("category", "within", parent), board)).toBe(true);
    expect(matches(include("category", "within", SNOWBOARDS), board)).toBe(
      true,
    );
    // sg-4-1 is not a parent of sg-4-17-2-17, even though the text starts the same.
    expect(
      matches(
        include("category", "within", "gid://shopify/TaxonomyCategory/sg-4-1"),
        board,
      ),
    ).toBe(false);
    expect(matches(include("category", "within", parent), product(2))).toBe(
      false,
    );
  });
});

describe("metafields", () => {
  const mf = (
    operator: string,
    value: string | null,
    metafieldType = "single_line_text_field",
    metafieldKey = "custom.trade_tier",
  ): RuleCondition => ({
    ...include("metafield", operator, value),
    metafieldKey,
    metafieldType,
  });
  const withMetafield = (
    type: string,
    value: string,
    key = "custom.trade_tier",
  ) => product(1, { metafields: { [key]: { type, value } } });

  it("compares text ignoring case", () => {
    const gold = withMetafield("single_line_text_field", "Gold");
    expect(matches(mf("equals", "gold"), gold)).toBe(true);
    expect(matches(mf("starts_with", "go"), gold)).toBe(true);
    expect(matches(mf("not_equals", "silver"), gold)).toBe(true);
    expect(matches(mf("contains", "silver"), gold)).toBe(false);
  });

  it("compares numbers as numbers", () => {
    const qty = withMetafield("number_integer", "10", "custom.min_qty");
    const cond = (op: string, v: string) =>
      mf(op, v, "number_integer", "custom.min_qty");
    expect(matches(cond("greater_than", "9"), qty)).toBe(true);
    expect(matches(cond("greater_than", "10"), qty)).toBe(false);
    expect(matches(cond("less_than", "10.5"), qty)).toBe(true);
    // "10" and "10.0" are the same number, though not the same text.
    expect(matches(cond("equals", "10.0"), qty)).toBe(true);
  });

  it("compares booleans", () => {
    const tradeOnly = withMetafield("boolean", "true", "custom.trade_only");
    const cond = (v: string) => mf("equals", v, "boolean", "custom.trade_only");
    expect(matches(cond("true"), tradeOnly)).toBe(true);
    expect(matches(cond("false"), tradeOnly)).toBe(false);
  });

  it("checks list items one by one", () => {
    const regions = withMetafield(
      "list.single_line_text_field",
      '["UK","EU"]',
      "custom.regions",
    );
    const cond = (op: string, v: string) =>
      mf(op, v, "list.single_line_text_field", "custom.regions");
    expect(matches(cond("contains", "uk"), regions)).toBe(true);
    // A list item has to match whole, not just contain the text.
    expect(matches(cond("contains", "U"), regions)).toBe(false);
    expect(matches(cond("not_contains", "us"), regions)).toBe(true);
  });

  it("treats a missing or empty metafield as not set", () => {
    const none = product(1);
    const emptyList = withMetafield("list.single_line_text_field", "[]");
    expect(matches(mf("is_not_set", null), none)).toBe(true);
    expect(matches(mf("is_set", null), none)).toBe(false);
    expect(
      matches(mf("is_set", null, "list.single_line_text_field"), emptyList),
    ).toBe(false);
    expect(
      matches(
        mf("is_set", null),
        withMetafield("single_line_text_field", "gold"),
      ),
    ).toBe(true);
    // Like a missing vendor: "is not" matches, value comparisons don't.
    expect(matches(mf("not_equals", "gold"), none)).toBe(true);
    expect(matches(mf("equals", "gold"), none)).toBe(false);
    expect(matches(mf("greater_than", "1", "number_integer"), none)).toBe(
      false,
    );
  });

  it("works on index rows written before metafields were indexed", () => {
    const old = product(1, { metafields: null });
    expect(matches(mf("is_not_set", null), old)).toBe(true);
    expect(matches(mf("equals", "gold"), old)).toBe(false);
  });
});
