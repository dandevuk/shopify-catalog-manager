import { describe, expect, it } from "vitest";
import type { RuleCondition } from "./conditions";
import { evaluateRuleSet } from "./evaluate";
import { buildPreview, describeDecision, type PreviewProduct } from "./preview";

const gid = (n: number) => `gid://shopify/Product/${n}`;
const product = (
  n: number,
  extra: Partial<PreviewProduct> = {},
): PreviewProduct => ({
  productId: gid(n),
  title: `Product ${n}`,
  status: "ACTIVE",
  vendor: "Driftline",
  productType: "Boots",
  tags: [],
  categoryId: null,
  collectionIds: [],
  onlineStorePublished: true,
  ...extra,
});

const driftline: RuleCondition = {
  group: "INCLUDE",
  field: "vendor",
  operator: "equals",
  value: "Driftline",
};

function preview(
  products: PreviewProduct[],
  current: string[] | null,
  checkVisibility = false,
) {
  const result = evaluateRuleSet(
    { includeMatch: "ALL", excludeMatch: "ANY", conditions: [driftline] },
    products,
  );
  if (!result.ok) throw new Error("rules");
  return buildPreview({
    products,
    desired: result.productIds,
    decisions: result.decisions,
    current,
    checkVisibility,
  });
}

describe("buildPreview", () => {
  const products = [
    product(1),
    product(2),
    product(3, { vendor: "Alder & Co" }),
    product(4, { vendor: "Alder & Co" }),
  ];

  it("counts what would be added, removed and left alone", () => {
    // In the catalog now: 2 (stays), 3 (goes), 99 (not in the index, goes).
    const result = preview(products, [gid(2), gid(3), gid(99)]);
    expect(result).toMatchObject({
      inCatalog: 2,
      toAdd: 1,
      toRemove: 2,
      unchanged: 1,
    });
    expect(result.addRows.map((r) => r.productId)).toEqual([gid(1)]);
    expect(result.unchangedRows.map((r) => r.productId)).toEqual([gid(2)]);
    expect(result.removeRows.map((r) => r.productId)).toEqual([
      gid(3),
      gid(99),
    ]);
  });

  it("gives a reason for every row", () => {
    const result = preview(products, [gid(3), gid(99)]);
    expect(result.addRows[0].reason).toBe("Matches: Vendor is Driftline");
    expect(result.removeRows[0].reason).toBe(
      "Doesn't match the include conditions",
    );
    expect(result.removeRows[1]).toMatchObject({
      title: gid(99),
      status: null,
    });
    expect(result.removeRows[1].reason).toMatch(/^Not in the product index/);
  });

  it("compares against every product when the catalog has no product list yet", () => {
    const result = preview(products, null);
    expect(result).toMatchObject({
      currentFollowsChannel: true,
      toAdd: 0,
      toRemove: 2,
      unchanged: 2,
    });
  });

  it("flags products B2B buyers couldn't see, only when asked to", () => {
    const hidden = [product(1, { onlineStorePublished: false }), product(2)];
    const b2b = preview(hidden, [], true);
    expect(b2b.notVisible).toBe(1);
    expect(b2b.addRows.find((r) => r.productId === gid(1))?.notVisible).toBe(
      true,
    );
    expect(b2b.addRows.find((r) => r.productId === gid(2))?.notVisible).toBe(
      false,
    );

    const market = preview(hidden, [], false);
    expect(market.notVisible).toBe(0);
    expect(market.addRows.every((r) => !r.notVisible)).toBe(true);
  });

  it("doesn't flag products that are being removed", () => {
    const result = preview(
      [product(1, { vendor: "Other", onlineStorePublished: false })],
      [gid(1)],
      true,
    );
    expect(result.removeRows[0].notVisible).toBe(false);
  });

  it("cuts long lists but keeps full counts", () => {
    const many = Array.from({ length: 150 }, (_, i) => product(i + 1));
    const result = preview(many, []);
    expect(result.toAdd).toBe(150);
    expect(result.addRows).toHaveLength(100);
  });
});

describe("describeDecision", () => {
  it("words pins, blocks and exclusions", () => {
    expect(describeDecision({ inCatalog: true, reason: "pinned" })).toBe(
      "Pinned to this catalog",
    );
    expect(describeDecision({ inCatalog: false, reason: "blocked" })).toBe(
      "Blocked from this catalog",
    );
    expect(
      describeDecision({
        inCatalog: false,
        reason: "excluded",
        matched: [
          {
            group: "EXCLUDE",
            field: "tag",
            operator: "equals",
            value: "clearance",
          },
        ],
      }),
    ).toBe("Excluded: Tag is clearance");
  });
});
