import { describe, expect, it } from "vitest";
import {
  describeCatalogRules,
  searchCatalogs,
  type SearchableCatalog,
} from "./search";

function catalog(overrides: Partial<SearchableCatalog> = {}): SearchableCatalog {
  return {
    shopifyCatalogId: "gid://shopify/MarketCatalog/1",
    type: "MARKET",
    title: "Untitled catalog",
    includeMatch: "ALL",
    excludeMatch: "ANY",
    conditions: [],
    assignmentIncludeMatch: "ALL",
    assignmentConditions: [],
    ...overrides,
  };
}

describe("searchCatalogs", () => {
  it("matches by catalog title", () => {
    const catalogs = [catalog({ title: "VIP customers" })];
    const [result] = searchCatalogs(catalogs, "vip");
    expect(result.title).toBe("VIP customers");
    expect(result.reasons).toEqual(["Matched by catalog name"]);
  });

  it("matches by a condition's value and describes why", () => {
    const catalogs = [
      catalog({
        title: "Wholesale",
        conditions: [
          {
            group: "INCLUDE",
            field: "tag",
            operator: "equals",
            value: "wholesale",
            metafieldKey: null,
            metafieldType: null,
          },
        ],
      }),
    ];
    const [result] = searchCatalogs(catalogs, "wholesale");
    expect(result.reasons).toEqual(["Tag is wholesale"]);
  });

  it("matches by a metafield key even when the value doesn't match", () => {
    const catalogs = [
      catalog({
        assignmentConditions: [
          {
            field: "company_metafield",
            operator: "equals",
            value: "vip",
            metafieldKey: "custom.customer_type",
            metafieldType: "single_line_text_field",
          },
        ],
      }),
    ];
    const [result] = searchCatalogs(catalogs, "customer_type");
    expect(result.reasons).toEqual(["custom.customer_type is vip"]);
  });

  it("returns nothing for an empty query", () => {
    const catalogs = [catalog({ title: "VIP customers" })];
    expect(searchCatalogs(catalogs, "")).toEqual([]);
    expect(searchCatalogs(catalogs, "   ")).toEqual([]);
  });

  it("filters by catalogType", () => {
    const catalogs = [
      catalog({ title: "VIP market catalog", type: "MARKET" }),
      catalog({ title: "VIP B2B catalog", type: "COMPANY_LOCATION" }),
    ];
    const results = searchCatalogs(catalogs, "vip", "COMPANY_LOCATION");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("VIP B2B catalog");
  });

  it("ranks catalogs with more matching conditions first", () => {
    const catalogs = [
      catalog({
        title: "One match",
        conditions: [
          {
            group: "INCLUDE",
            field: "tag",
            operator: "equals",
            value: "vip",
            metafieldKey: null,
            metafieldType: null,
          },
        ],
      }),
      catalog({
        title: "Two matches",
        conditions: [
          {
            group: "INCLUDE",
            field: "tag",
            operator: "equals",
            value: "vip",
            metafieldKey: null,
            metafieldType: null,
          },
          {
            group: "INCLUDE",
            field: "vendor",
            operator: "equals",
            value: "vip vendor",
            metafieldKey: null,
            metafieldType: null,
          },
        ],
      }),
    ];
    const results = searchCatalogs(catalogs, "vip");
    expect(results.map((r) => r.title)).toEqual(["Two matches", "One match"]);
  });

  it("caps results at the given limit", () => {
    const catalogs = Array.from({ length: 8 }, (_, i) =>
      catalog({
        title: `VIP catalog ${i}`,
        shopifyCatalogId: `gid://shopify/MarketCatalog/${i}`,
      }),
    );
    expect(searchCatalogs(catalogs, "vip", undefined, 3)).toHaveLength(3);
  });

  it("skips conditions with an unknown field rather than throwing", () => {
    const catalogs = [
      catalog({
        title: "Broken",
        conditions: [
          {
            group: "INCLUDE",
            field: "not_a_real_field",
            operator: "equals",
            value: "vip",
            metafieldKey: null,
            metafieldType: null,
          },
        ],
      }),
    ];
    const [result] = searchCatalogs(catalogs, "vip");
    expect(result.reasons).toEqual([]);
  });
});

describe("describeCatalogRules", () => {
  it("joins include conditions with the include match mode", () => {
    const result = describeCatalogRules(
      catalog({
        includeMatch: "ANY",
        conditions: [
          {
            group: "INCLUDE",
            field: "tag",
            operator: "equals",
            value: "vip",
            metafieldKey: null,
            metafieldType: null,
          },
          {
            group: "INCLUDE",
            field: "vendor",
            operator: "equals",
            value: "Acme",
            metafieldKey: null,
            metafieldType: null,
          },
        ],
      }),
    );
    expect(result.includeRules).toBe("Tag is vip or Vendor is Acme");
    expect(result.excludeRules).toBeNull();
    expect(result.assignmentRules).toBeNull();
  });

  it("describes exclude conditions separately from include conditions", () => {
    const result = describeCatalogRules(
      catalog({
        excludeMatch: "ALL",
        conditions: [
          {
            group: "INCLUDE",
            field: "tag",
            operator: "equals",
            value: "vip",
            metafieldKey: null,
            metafieldType: null,
          },
          {
            group: "EXCLUDE",
            field: "status",
            operator: "equals",
            value: "DRAFT",
            metafieldKey: null,
            metafieldType: null,
          },
        ],
      }),
    );
    expect(result.includeRules).toBe("Tag is vip");
    expect(result.excludeRules).toBe("Status is Draft");
  });

  it("describes assignment conditions for B2B catalogs", () => {
    const result = describeCatalogRules(
      catalog({
        type: "COMPANY_LOCATION",
        assignmentIncludeMatch: "ALL",
        assignmentConditions: [
          {
            field: "company_metafield",
            operator: "equals",
            value: "wholesale",
            metafieldKey: "custom.customer_type",
            metafieldType: "single_line_text_field",
          },
        ],
      }),
    );
    expect(result.assignmentRules).toBe("custom.customer_type is wholesale");
  });

  it("returns null for rule groups with no conditions", () => {
    const result = describeCatalogRules(catalog());
    expect(result.includeRules).toBeNull();
    expect(result.excludeRules).toBeNull();
    expect(result.assignmentRules).toBeNull();
  });
});
