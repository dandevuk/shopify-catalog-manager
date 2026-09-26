import { describe, expect, it } from "vitest";
import type { AssignmentCondition } from "./conditions";
import {
  evaluateAssignmentRules,
  type AssignmentRuleSetInput,
  type RuleLocation,
} from "./evaluate";

const location = (
  id: number,
  extra: Partial<RuleLocation> = {},
): RuleLocation => ({
  locationId: `gid://shopify/CompanyLocation/${id}`,
  name: `Location ${id}`,
  companyId: `gid://shopify/Company/${id}`,
  companyName: `Company ${id}`,
  companyMetafields: null,
  locationMetafields: null,
  ...extra,
});

const condition = (
  field: "company_metafield" | "location_metafield",
  operator: string,
  value: string | null,
  metafieldKey = "custom.customer_type",
  metafieldType = "single_line_text_field",
): AssignmentCondition => ({ field, operator, value, metafieldKey, metafieldType });

const ruleSet = (
  conditions: AssignmentCondition[],
  extra: Partial<AssignmentRuleSetInput> = {},
): AssignmentRuleSetInput => ({
  includeMatch: "ALL",
  conditions,
  ...extra,
});

/** Numeric IDs of the locations the rule set assigns. */
function run(rules: AssignmentRuleSetInput, locations: RuleLocation[]) {
  const result = evaluateAssignmentRules(rules, locations);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.locationIds.map((id) => Number(id.split("/").pop()));
}

describe("evaluateAssignmentRules", () => {
  it("an empty rule set assigns nothing", () => {
    expect(run(ruleSet([]), [location(1), location(2)])).toEqual([]);
  });

  it("matches a company metafield", () => {
    const wholesale = location(1, {
      companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "wholesale" } },
    });
    const retail = location(2, {
      companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "retail" } },
    });
    expect(
      run(ruleSet([condition("company_metafield", "equals", "wholesale")]), [
        wholesale,
        retail,
      ]),
    ).toEqual([1]);
  });

  it("matches a location metafield independently of the company's", () => {
    const vip = location(1, {
      locationMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "vip" } },
      companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "retail" } },
    });
    expect(
      run(ruleSet([condition("location_metafield", "equals", "vip")]), [vip]),
    ).toEqual([1]);
    expect(
      run(ruleSet([condition("company_metafield", "equals", "vip")]), [vip]),
    ).toEqual([]);
  });

  it("ALL needs every condition, ANY needs one", () => {
    const locations = [
      location(1, {
        companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "wholesale" } },
      }),
      location(2, {
        companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "wholesale" } },
        locationMetafields: { "custom.region": { type: "single_line_text_field", value: "ca" } },
      }),
    ];
    const conditions = [
      condition("company_metafield", "equals", "wholesale"),
      condition("location_metafield", "equals", "ca", "custom.region"),
    ];
    expect(run(ruleSet(conditions, { includeMatch: "ALL" }), locations)).toEqual([2]);
    expect(run(ruleSet(conditions, { includeMatch: "ANY" }), locations)).toEqual([1, 2]);
  });

  it("a location can match more than one rule set (evaluated independently, catalog by catalog)", () => {
    const both = location(1, {
      companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "wholesale" } },
      locationMetafields: { "custom.region": { type: "single_line_text_field", value: "ca" } },
    });
    const wholesaleCatalog = ruleSet([condition("company_metafield", "equals", "wholesale")]);
    const caCatalog = ruleSet([condition("location_metafield", "equals", "ca", "custom.region")]);
    expect(run(wholesaleCatalog, [both])).toEqual([1]);
    expect(run(caCatalog, [both])).toEqual([1]);
  });

  it("refuses to evaluate a broken condition", () => {
    const result = evaluateAssignmentRules(ruleSet([condition("company_metafield", "equals", null)]), [
      location(1),
    ]);
    expect(result.ok).toBe(false);
  });

  it("reports the matched conditions on the decision", () => {
    const matching = condition("company_metafield", "equals", "wholesale");
    const wholesale = location(1, {
      companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "wholesale" } },
    });
    const result = evaluateAssignmentRules(ruleSet([matching]), [wholesale]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.decisions.get(wholesale.locationId)).toEqual({
      assigned: true,
      matched: [{ ...matching, value: "wholesale" }],
    });
  });
});
