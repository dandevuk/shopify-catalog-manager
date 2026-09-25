import { describe, expect, it } from "vitest";
import {
  FIELDS,
  describeCondition,
  operatorLabel,
  validateCondition,
  type ConditionField,
  type ValidCondition,
} from "./conditions";

const condition = (field: string, operator: string, value: string | null) => ({
  group: "INCLUDE" as const,
  field,
  operator,
  value,
});

describe("validateCondition", () => {
  it("accepts every operator each field lists", () => {
    for (const [field, definition] of Object.entries(FIELDS)) {
      if (field === "metafield") continue; // operators depend on the type; tested below
      const value = definition.options?.[0].value ?? "x";
      for (const operator of definition.operators) {
        expect(validateCondition(condition(field, operator, value))).toBeNull();
      }
    }
  });

  it("rejects unknown fields and operators, and missing values", () => {
    expect(validateCondition(condition("price", "equals", "1"))).toBe(
      'Unknown field "price".',
    );
    expect(validateCondition(condition("vendor", "within", "x"))).toBe(
      'Vendor can\'t use "within".',
    );
    expect(validateCondition(condition("vendor", "equals", null))).toBe(
      "Vendor needs a value.",
    );
    expect(validateCondition(condition("vendor", "equals", " "))).toBe(
      "Vendor needs a value.",
    );
  });

  it("allows status values beyond the listed ones", () => {
    expect(
      validateCondition(condition("status", "equals", "UNLISTED")),
    ).toBeNull();
  });
});

describe("describeCondition", () => {
  const valid = (field: ConditionField, operator: string, value: string) =>
    condition(field, operator, value) as ValidCondition;

  it("reads naturally", () => {
    expect(describeCondition(valid("vendor", "equals", "Driftline"))).toBe(
      "Vendor is Driftline",
    );
    expect(describeCondition(valid("tag", "starts_with", "market:"))).toBe(
      "Tag starts with market:",
    );
    expect(describeCondition(valid("status", "equals", "ACTIVE"))).toBe(
      "Status is Active",
    );
    expect(
      describeCondition(valid("online_store_published", "equals", "false")),
    ).toBe("Not on the Online Store");
    expect(
      describeCondition(valid("online_store_published", "equals", "true")),
    ).toBe("On the Online Store");
  });

  it("uses names for collection and category IDs when given them", () => {
    const names = new Map([["gid://shopify/Collection/1", "Home page"]]);
    const inHome = valid(
      "in_collection",
      "equals",
      "gid://shopify/Collection/1",
    );
    expect(describeCondition(inHome, (id) => names.get(id))).toBe(
      "Collection is in Home page",
    );
    expect(describeCondition(inHome)).toBe(
      "Collection is in gid://shopify/Collection/1",
    );
  });
});

describe("operatorLabel", () => {
  it("words collection operators as membership", () => {
    expect(operatorLabel("in_collection", "not_equals")).toBe("is not in");
    expect(operatorLabel("vendor", "not_equals")).toBe("is not");
  });
});

describe("metafield conditions", () => {
  const metafield = (
    operator: string,
    value: string | null,
    metafieldType: string | null = "single_line_text_field",
    metafieldKey: string | null = "custom.trade_tier",
  ) => ({
    ...condition("metafield", operator, value),
    metafieldKey,
    metafieldType,
  });

  it("accepts the operators each type allows", () => {
    expect(validateCondition(metafield("equals", "gold"))).toBeNull();
    expect(
      validateCondition(metafield("greater_than", "5", "number_integer")),
    ).toBeNull();
    expect(
      validateCondition(metafield("equals", "true", "boolean")),
    ).toBeNull();
    expect(
      validateCondition(
        metafield("contains", "uk", "list.single_line_text_field"),
      ),
    ).toBeNull();
  });

  it("needs a metafield with a supported type", () => {
    expect(validateCondition(metafield("equals", "gold", null, null))).toBe(
      "Choose a metafield.",
    );
    expect(
      validateCondition(
        metafield("equals", "gold", "single_line_text_field", "trade_tier"),
      ),
    ).toBe('"trade_tier" isn\'t a metafield key.');
    expect(validateCondition(metafield("equals", "{}", "json"))).toMatch(
      /type rules can't use/,
    );
  });

  it("rejects operators the type doesn't allow", () => {
    expect(validateCondition(metafield("greater_than", "5"))).toBe(
      'Metafield custom.trade_tier can\'t use "greater_than".',
    );
    expect(
      validateCondition(metafield("starts_with", "t", "boolean")),
    ).not.toBeNull();
  });

  it("checks values against the type", () => {
    expect(
      validateCondition(metafield("equals", "ten", "number_decimal")),
    ).toBe("Metafield custom.trade_tier needs a number.");
    expect(validateCondition(metafield("equals", "yes", "boolean"))).toBe(
      "Metafield custom.trade_tier must be true or false.",
    );
    expect(validateCondition(metafield("equals", ""))).toBe(
      "Metafield custom.trade_tier needs a value.",
    );
  });

  it("needs no value for is set and is not set", () => {
    expect(validateCondition(metafield("is_set", null))).toBeNull();
    expect(validateCondition(metafield("is_not_set", ""))).toBeNull();
  });

  it("describes itself with the definition's name when given it", () => {
    const tier = metafield("equals", "gold") as ValidCondition;
    const names = (id: string) =>
      id === "custom.trade_tier" ? "Trade tier" : undefined;
    expect(describeCondition(tier, names)).toBe("Trade tier is gold");
    expect(describeCondition(tier)).toBe("custom.trade_tier is gold");
    expect(
      describeCondition({ ...tier, operator: "is_not_set", value: "" }, names),
    ).toBe("Trade tier is not set");
  });
});
