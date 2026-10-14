import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers runAutomaticSync's handling of a catalog that no longer exists in
 * Shopify. managed.server.ts reaches Prisma, the Admin API and the rule
 * loaders, so those are mocked here: this file is about the decision, not the
 * sync itself.
 */
const shopFindUnique = vi.fn();
const catalogFindUnique = vi.fn();
const catalogUpdate = vi.fn();
vi.mock("../../db.server", () => ({
  default: {
    shop: { findUnique: shopFindUnique },
    catalog: { findUnique: catalogFindUnique, update: catalogUpdate },
  },
}));

const loadRuleCatalog = vi.fn();
vi.mock("../rules/rules.server", () => ({
  loadRuleCatalog,
  forgetCatalogMembership: vi.fn(),
  getCatalogMembership: vi.fn(),
  loadIndexProducts: vi.fn(),
  loadOverrides: vi.fn(),
  loadRules: vi.fn(),
  ruleNames: vi.fn(),
}));

// Importing this for real would pull in shopify.server.ts and its session
// storage; runAutomaticSync only needs it to hand back an admin client.
const backgroundAdmin = vi.fn();
vi.mock("../product-index/index.server", () => ({ backgroundAdmin }));

const { runAutomaticSync } = await import("./managed.server");

const SHOP = "shop.myshopify.com";
const row = {
  id: "catalog-record-1",
  shopId: "shop-1",
  shopifyCatalogId: "gid://shopify/CompanyLocationCatalog/125381345454",
  managed: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  shopFindUnique.mockResolvedValue({ id: "shop-1", domain: SHOP });
  catalogFindUnique.mockResolvedValue(row);
  catalogUpdate.mockResolvedValue({ ...row, managed: false });
  backgroundAdmin.mockResolvedValue({ graphql: vi.fn() });
});

describe("runAutomaticSync, catalog deleted in Shopify", () => {
  it("stops managing the row instead of logging on every future sweep", async () => {
    loadRuleCatalog.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAutomaticSync(SHOP, row.id);

    expect(catalogUpdate).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { managed: false },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("no longer exists in Shopify");

    warn.mockRestore();
  });

  it("leaves a catalog that still exists alone", async () => {
    // Returning a catalog takes the sync path, which the mocked rule loaders
    // can't complete. All this asserts is that the row isn't unmanaged on the
    // way through, which is the regression that would matter.
    loadRuleCatalog.mockResolvedValue({
      recordId: row.id,
      shopifyCatalogId: row.shopifyCatalogId,
      type: "COMPANY_LOCATION",
      title: "Still here",
      status: "ACTIVE",
      publicationId: "gid://shopify/Publication/1",
      autoPublish: false,
    });

    await runAutomaticSync(SHOP, row.id).catch(() => {});

    expect(catalogUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { managed: false } }),
    );
  });

  it("does nothing when the row stopped being managed before the job ran", async () => {
    catalogFindUnique.mockResolvedValue({ ...row, managed: false });

    await runAutomaticSync(SHOP, row.id);

    expect(loadRuleCatalog).not.toHaveBeenCalled();
    expect(catalogUpdate).not.toHaveBeenCalled();
  });
});
