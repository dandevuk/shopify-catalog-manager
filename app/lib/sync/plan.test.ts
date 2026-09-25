import { describe, expect, it } from "vitest";
import { checkAcknowledgement, describeConfirmation, planSync } from "./plan";

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `gid://shopify/Product/${prefix}${i}`);

describe("planSync", () => {
  it("works out additions, removals and publicationUpdate chunks", () => {
    // 10 in the catalog; 1 goes (10%, under the threshold), 1 arrives.
    const current = ids("c", 10);
    const plan = planSync(["new", ...current.slice(1)], current);
    expect(plan.toAdd).toEqual(["new"]);
    expect(plan.toRemove).toEqual([current[0]]);
    expect(plan.chunks).toEqual([{ add: ["new"], remove: [current[0]] }]);
    expect(plan.confirmations).toEqual([]);
  });

  it("has nothing to do when the catalog already matches", () => {
    const plan = planSync(["a", "b"], ["b", "a"]);
    expect(plan.chunks).toEqual([]);
    expect(plan.confirmations).toEqual([]);
  });

  it("keeps each chunk within 50 adds and 50 removes", () => {
    const plan = planSync(ids("a", 120), ids("r", 30));
    expect(plan.chunks).toHaveLength(3);
    for (const chunk of plan.chunks) {
      expect(chunk.add.length).toBeLessThanOrEqual(50);
      expect(chunk.remove.length).toBeLessThanOrEqual(50);
    }
  });

  describe("large removals", () => {
    it("asks when more than 25% of the catalog would go", () => {
      // 100 in the catalog, 26 removed.
      const current = ids("c", 100);
      const plan = planSync(current.slice(26), current);
      expect(plan.confirmations).toEqual([
        { kind: "large_removal", removing: 26, currentCount: 100 },
      ]);
    });

    it("doesn't ask at exactly 25%", () => {
      const current = ids("c", 100);
      expect(planSync(current.slice(25), current).confirmations).toEqual([]);
    });

    it("asks when more than 100 products would go, whatever the share", () => {
      // 1,000 in the catalog, 101 removed (about 10%).
      const current = ids("c", 1000);
      const plan = planSync(current.slice(101), current);
      expect(plan.confirmations.map((c) => c.kind)).toEqual(["large_removal"]);
    });

    it("doesn't count additions against the threshold", () => {
      const plan = planSync(
        [...ids("c", 10), ...ids("new", 500)],
        ids("c", 10),
      );
      expect(plan.confirmations).toEqual([]);
    });
  });

  describe("empty result", () => {
    it("asks when the catalog would end up empty", () => {
      const plan = planSync([], ids("c", 3));
      expect(plan.confirmations.map((c) => c.kind)).toEqual([
        "large_removal",
        "empty_result",
      ]);
    });

    it("doesn't ask when an empty catalog stays empty", () => {
      expect(planSync([], []).confirmations).toEqual([]);
    });
  });
});

describe("checkAcknowledgement", () => {
  const current = ids("c", 10);
  const plan = planSync(current.slice(5), current); // remove 5 of 10: large

  it("accepts matching numbers with every confirmation ticked", () => {
    expect(
      checkAcknowledgement(plan, {
        toAdd: 0,
        toRemove: 5,
        confirmed: ["large_removal"],
      }),
    ).toBeNull();
  });

  it("refuses when the numbers changed since the merchant looked", () => {
    expect(
      checkAcknowledgement(plan, {
        toAdd: 0,
        toRemove: 4,
        confirmed: ["large_removal"],
      }),
    ).toMatch(/^The changes are now 0 to add and 5 to remove/);
  });

  it("refuses when a confirmation wasn't ticked", () => {
    expect(
      checkAcknowledgement(plan, { toAdd: 0, toRemove: 5, confirmed: [] }),
    ).toBe("Please confirm: This removes 5 of the catalog's 10 products.");
  });
});

describe("describeConfirmation", () => {
  it("words the empty result", () => {
    expect(
      describeConfirmation({ kind: "empty_result", currentCount: 3 }),
    ).toBe("This leaves the catalog with no products (it has 3 now).");
  });
});
