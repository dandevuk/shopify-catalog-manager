import { describe, expect, it, vi } from "vitest";
import { applyAssignments } from "./apply.server";

type Vars = { catalogId: string; companyLocationIds: string[] };

/** A fake Admin API client for catalogContextUpdate. */
function fakeAdmin({ rejected = false } = {}) {
  const calls: Vars[] = [];
  const admin = {
    graphql: vi.fn(
      async (_query: string, options?: { variables?: Record<string, unknown> }) => {
        const vars = options?.variables as Vars;
        calls.push(vars);
        return new Response(
          JSON.stringify({
            data: {
              catalogContextUpdate: {
                catalog: rejected ? null : { id: vars.catalogId },
                userErrors: rejected
                  ? [{ field: ["contextsToAdd"], message: "Location not found" }]
                  : [],
              },
            },
          }),
        );
      },
    ),
  };
  return { admin, calls };
}

const CATALOG = "gid://shopify/CompanyLocationCatalog/1";
const LOCATION_1 = "gid://shopify/CompanyLocation/1";
const LOCATION_2 = "gid://shopify/CompanyLocation/2";

describe("applyAssignments", () => {
  it("does nothing and makes no call for an empty list", async () => {
    const { admin, calls } = fakeAdmin();
    const result = await applyAssignments(admin, CATALOG, []);
    expect(result).toEqual({ added: [], error: null });
    expect(calls).toHaveLength(0);
  });

  it("adds every requested location in one call", async () => {
    const { admin, calls } = fakeAdmin();
    const result = await applyAssignments(admin, CATALOG, [LOCATION_1, LOCATION_2]);
    expect(result).toEqual({ added: [LOCATION_1, LOCATION_2], error: null });
    expect(calls).toEqual([
      { catalogId: CATALOG, companyLocationIds: [LOCATION_1, LOCATION_2] },
    ]);
  });

  it("reports a Shopify userError as a failure, adding nothing", async () => {
    const { admin } = fakeAdmin({ rejected: true });
    const result = await applyAssignments(admin, CATALOG, [LOCATION_1]);
    expect(result.added).toEqual([]);
    expect(result.error).toBe("Location not found");
  });
});
