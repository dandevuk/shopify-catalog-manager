import { describe, expect, it, vi } from "vitest";
import { applyChunks, splitChunk, waitForCost } from "./apply.server";

type Vars = { id: string; add: string[]; remove: string[] };

/**
 * A fake Admin API client for publicationUpdate. Rejects any call that
 * contains a product in `rejected`, and throws (like a throttled request) for
 * the first `failFirst` calls.
 */
function fakeAdmin({
  rejected = [] as string[],
  failFirst = 0,
  available = 20000,
} = {}) {
  const calls: Vars[] = [];
  let failures = 0;
  const admin = {
    graphql: vi.fn(
      async (
        _query: string,
        options?: { variables?: Record<string, unknown> },
      ) => {
        if (failures < failFirst) {
          failures++;
          throw new Error("Throttled");
        }
        const vars = options?.variables as Vars;
        calls.push(vars);
        const bad = [...vars.add, ...vars.remove].filter((id) =>
          rejected.includes(id),
        );
        return new Response(
          JSON.stringify({
            data: {
              publicationUpdate: {
                publication: bad.length ? null : { id: vars.id },
                userErrors: bad.map((id) => ({
                  field: ["id"],
                  message: `${id} not found`,
                  code: "NOT_FOUND",
                })),
              },
            },
            extensions: {
              cost: {
                throttleStatus: {
                  maximumAvailable: 20000,
                  currentlyAvailable: available,
                  restoreRate: 100,
                },
              },
            },
          }),
        );
      },
    ),
  };
  return { admin, calls };
}

const noWait = vi.fn(async () => {});

describe("applyChunks", () => {
  it("sends each chunk once and reports progress", async () => {
    const { admin, calls } = fakeAdmin();
    const onApplied = vi.fn(async () => {});
    const result = await applyChunks(
      admin,
      "gid://shopify/Publication/1",
      [
        { add: ["a1", "a2"], remove: ["r1"] },
        { add: ["a3"], remove: [] },
      ],
      { onApplied, sleep: noWait },
    );

    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      added: ["a1", "a2", "a3"],
      removed: ["r1"],
      failed: [],
    });
    expect(onApplied).toHaveBeenCalledWith({
      added: ["a1", "a2"],
      removed: ["r1"],
    });
  });

  it("isolates a product Shopify rejects and applies the rest", async () => {
    const { admin, calls } = fakeAdmin({ rejected: ["bad"] });
    const result = await applyChunks(
      admin,
      "gid://shopify/Publication/1",
      [{ add: ["a1", "bad", "a2"], remove: ["r1"] }],
      { sleep: noWait },
    );

    expect(result.added.sort()).toEqual(["a1", "a2"]);
    expect(result.removed).toEqual(["r1"]);
    expect(result.failed).toEqual([
      { productId: "bad", action: "ADD", error: "NOT_FOUND: bad not found" },
    ]);
    // 1 rejected call of 4, then halves [a1, bad] (rejected) and [a2, r1],
    // then [a1] and [bad]: 5 calls rather than one per product.
    expect(calls).toHaveLength(5);
  });

  it("retries a throttled call after waiting", async () => {
    const { admin, calls } = fakeAdmin({ failFirst: 2 });
    const sleep = vi.fn(async () => {});
    const result = await applyChunks(
      admin,
      "gid://shopify/Publication/1",
      [{ add: ["a1"], remove: [] }],
      {
        sleep,
      },
    );

    expect(result.added).toEqual(["a1"]);
    expect(calls).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after the last attempt, so the sync stops", async () => {
    const { admin } = fakeAdmin({ failFirst: 10 });
    await expect(
      applyChunks(
        admin,
        "gid://shopify/Publication/1",
        [{ add: ["a1"], remove: [] }],
        {
          sleep: noWait,
          maxAttempts: 3,
        },
      ),
    ).rejects.toThrow(/Throttled/);
  });

  it("slows down when the rate limit bucket runs low", async () => {
    const { admin } = fakeAdmin({ available: 50 });
    const sleep = vi.fn(async () => {});
    await applyChunks(
      admin,
      "gid://shopify/Publication/1",
      [{ add: ["a1"], remove: [] }],
      { sleep },
    );
    // (200 - 50) points at 100 per second: 1.5 s.
    expect(sleep).toHaveBeenCalledWith(1500);
  });
});

describe("rejected-call limit", () => {
  it("stops a sync whose calls Shopify keeps rejecting, instead of splitting forever", async () => {
    // Every product rejected, as when the publication itself is gone.
    const add = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const { admin, calls } = fakeAdmin({ rejected: add });
    await expect(
      applyChunks(admin, "gid://shopify/Publication/1", [{ add, remove: [] }], {
        sleep: noWait,
        maxRejectedCalls: 10,
      }),
    ).rejects.toThrow(/Shopify kept rejecting changes/);
    // The limit plus the call that went over it, not about 100 calls.
    expect(calls.length).toBe(11);
  });

  it("still isolates a few bad products within the limit", async () => {
    const add = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const { admin } = fakeAdmin({ rejected: ["p3", "p40"] });
    const result = await applyChunks(
      admin,
      "gid://shopify/Publication/1",
      [{ add, remove: [] }],
      { sleep: noWait },
    );
    expect(result.failed.map((f) => f.productId).sort()).toEqual(["p3", "p40"]);
    expect(result.added).toHaveLength(48);
  });
});

describe("splitChunk", () => {
  it("halves the changes, keeping adds and removes apart", () => {
    expect(splitChunk({ add: ["a1", "a2", "a3"], remove: ["r1"] })).toEqual([
      { add: ["a1", "a2"], remove: [] },
      { add: ["a3"], remove: ["r1"] },
    ]);
  });
});

describe("waitForCost", () => {
  it("doesn't wait while plenty is left or the cost is unknown", () => {
    expect(waitForCost(null)).toBe(0);
    expect(
      waitForCost({
        throttleStatus: {
          currentlyAvailable: 5000,
          maximumAvailable: 20000,
          restoreRate: 1000,
        },
      }),
    ).toBe(0);
  });
});
