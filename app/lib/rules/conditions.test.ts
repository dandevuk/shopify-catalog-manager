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
