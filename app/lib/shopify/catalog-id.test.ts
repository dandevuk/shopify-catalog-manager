import { describe, expect, it } from "vitest";
import { fromCatalogParam, toCatalogParam } from "./catalog-id";

describe("catalog URL params", () => {
  it("round-trips Market and B2B catalog GIDs", () => {
    for (const gid of [
      "gid://shopify/MarketCatalog/123",
      "gid://shopify/CompanyLocationCatalog/456",
    ]) {
      const param = toCatalogParam(gid);
      expect(param).not.toBeNull();
      expect(fromCatalogParam(param!)).toBe(gid);
    }
    expect(toCatalogParam("gid://shopify/MarketCatalog/123")).toBe(
      "MarketCatalog-123",
    );
  });

  it("rejects sales channel catalogs and anything else", () => {
    expect(toCatalogParam("gid://shopify/AppCatalog/1")).toBeNull();
    expect(fromCatalogParam("AppCatalog-1")).toBeNull();
    expect(fromCatalogParam("MarketCatalog-abc")).toBeNull();
    expect(fromCatalogParam("MarketCatalog-1/../x")).toBeNull();
    expect(fromCatalogParam(undefined)).toBeNull();
  });
});
