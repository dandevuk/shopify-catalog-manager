import { describe, expect, it } from "vitest";
import type { AssignmentCondition } from "./conditions";
import { evaluateAssignmentRules } from "./evaluate";
import type { AssignmentLocation } from "./locations.server";
import { buildAssignmentPreview } from "./preview";

const CATALOG = "gid://shopify/CompanyLocationCatalog/1";

const location = (
  n: number,
  extra: Partial<AssignmentLocation> = {},
): AssignmentLocation => ({
  locationId: `gid://shopify/CompanyLocation/${n}`,
  name: `Location ${n}`,
  companyId: `gid://shopify/Company/${n}`,
  companyName: `Company ${n}`,
  companyMetafields: null,
  locationMetafields: null,
  currentCatalogIds: [],
  ...extra,
});

const wholesale: AssignmentCondition = {
  field: "company_metafield",
  operator: "equals",
  value: "wholesale",
  metafieldKey: "custom.customer_type",
  metafieldType: "single_line_text_field",
};

function preview(locations: AssignmentLocation[], shopifyCatalogId = CATALOG) {
  const result = evaluateAssignmentRules(
    { includeMatch: "ALL", conditions: [wholesale] },
    locations,
  );
  if (!result.ok) throw new Error("rules");
  return buildAssignmentPreview({
    locations,
    shopifyCatalogId,
    decisions: result.decisions,
  });
}

describe("buildAssignmentPreview", () => {
  const matching = (companyMetafields = { "custom.customer_type": { type: "single_line_text_field", value: "wholesale" } }) =>
    companyMetafields;

  it("sorts locations into add, already assigned and not matched", () => {
    const locations = [
      location(1, { companyMetafields: matching() }), // matches, not yet assigned
      location(2, { companyMetafields: matching(), currentCatalogIds: [CATALOG] }), // matches, already assigned
      location(3, { companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "retail" } } }), // doesn't match
    ];
    const result = preview(locations);
    expect(result).toMatchObject({ toAdd: 1, alreadyAssigned: 1, notMatched: 1 });
    expect(result.addRows.map((r) => r.locationId)).toEqual([locations[0].locationId]);
    expect(result.alreadyAssignedRows.map((r) => r.locationId)).toEqual([locations[1].locationId]);
    expect(result.notMatchedRows.map((r) => r.locationId)).toEqual([locations[2].locationId]);
  });

  it("gives a reason for matched and unmatched rows", () => {
    const locations = [
      location(1, { companyMetafields: matching() }),
      location(2),
    ];
    const result = preview(locations);
    expect(result.addRows[0].reason).toBe("Matches: custom.customer_type is wholesale");
    expect(result.notMatchedRows[0].reason).toBe("Doesn't match the rules");
  });

  it("never proposes removing a location assigned to a different catalog than it currently matches", () => {
    // A location that no longer matches, but has some OTHER catalog's context,
    // still only shows as "not matched" for this catalog: nothing to remove.
    const locations = [
      location(1, {
        companyMetafields: { "custom.customer_type": { type: "single_line_text_field", value: "retail" } },
        currentCatalogIds: ["gid://shopify/CompanyLocationCatalog/999"],
      }),
    ];
    const result = preview(locations);
    expect(result).toMatchObject({ toAdd: 0, alreadyAssigned: 0, notMatched: 1 });
  });
});
