import { describe, expect, it } from "vitest";
import {
  describeAssignmentCondition,
  validateAssignmentCondition,
  type ValidAssignmentCondition,
} from "./conditions";

const metafield = (
  field: "company_metafield" | "location_metafield",
  operator: string,
  value: string | null,
  metafieldType: string | null = "single_line_text_field",
  metafieldKey: string | null = "custom.customer_type",
) => ({ field, operator, value, metafieldKey, metafieldType });

describe("validateAssignmentCondition", () => {
  it("accepts the operators each type allows, for both field kinds", () => {
    expect(
      validateAssignmentCondition(metafield("company_metafield", "equals", "wholesale")),
    ).toBeNull();
    expect(
      validateAssignmentCondition(
        metafield("location_metafield", "greater_than", "5", "number_integer"),
      ),
    ).toBeNull();
    expect(
      validateAssignmentCondition(
        metafield("company_metafield", "equals", "true", "boolean"),
      ),
    ).toBeNull();
  });

  it("rejects unknown fields", () => {
    expect(
      validateAssignmentCondition({
        field: "tag",
        operator: "equals",
        value: "vip",
      }),
    ).toBe('Unknown field "tag".');
  });

  it("needs a metafield with a supported type", () => {
    expect(
      validateAssignmentCondition(
        metafield("company_metafield", "equals", "wholesale", null, null),
      ),
    ).toBe("Choose a company metafield.");
    expect(
      validateAssignmentCondition(
        metafield(
          "location_metafield",
          "equals",
          "wholesale",
          "single_line_text_field",
          "customer_type",
        ),
      ),
    ).toBe('"customer_type" isn\'t a metafield key.');
    expect(
      validateAssignmentCondition(
        metafield("company_metafield", "equals", "{}", "json"),
      ),
    ).toMatch(/type rules can't use/);
  });

  it("rejects operators the type doesn't allow", () => {
    expect(
      validateAssignmentCondition(
        metafield("company_metafield", "greater_than", "5"),
      ),
    ).toBe('Company metafield custom.customer_type can\'t use "greater_than".');
  });

  it("checks values against the type", () => {
    expect(
      validateAssignmentCondition(
        metafield("location_metafield", "equals", "yes", "boolean"),
      ),
    ).toBe("Location metafield custom.customer_type must be true or false.");
    expect(
      validateAssignmentCondition(metafield("company_metafield", "equals", "")),
    ).toBe("Company metafield custom.customer_type needs a value.");
  });

  it("needs no value for is set and is not set", () => {
    expect(
      validateAssignmentCondition(metafield("company_metafield", "is_set", null)),
    ).toBeNull();
    expect(
      validateAssignmentCondition(
        metafield("location_metafield", "is_not_set", ""),
      ),
    ).toBeNull();
  });
});

describe("describeAssignmentCondition", () => {
  it("reads naturally, with the definition's name when given it", () => {
    const condition = metafield(
      "company_metafield",
      "equals",
      "wholesale",
    ) as ValidAssignmentCondition;
    const names = (id: string) =>
      id === "custom.customer_type" ? "Customer type" : undefined;
    expect(describeAssignmentCondition(condition, names)).toBe(
      "Customer type is wholesale",
    );
    expect(describeAssignmentCondition(condition)).toBe(
      "custom.customer_type is wholesale",
    );
    expect(
      describeAssignmentCondition({ ...condition, operator: "is_not_set", value: "" }),
    ).toBe("custom.customer_type is not set");
  });

  it("reads booleans as true/false", () => {
    const condition = metafield(
      "location_metafield",
      "equals",
      "true",
      "boolean",
    ) as ValidAssignmentCondition;
    expect(describeAssignmentCondition(condition)).toBe(
      "custom.customer_type is true",
    );
  });
});
