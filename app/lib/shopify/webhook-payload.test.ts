import { describe, expect, it } from "vitest";
import { payloadGid } from "./webhook-payload";

describe("payloadGid", () => {
  it("uses admin_graphql_api_id when present", () => {
    expect(
      payloadGid({ id: 1, admin_graphql_api_id: "gid://shopify/Collection/490801332398" }, "Collection"),
    ).toBe("gid://shopify/Collection/490801332398");
  });

  it("builds the GID from the numeric id (delete payloads)", () => {
    expect(payloadGid({ id: 10321611292846 }, "Product")).toBe(
      "gid://shopify/Product/10321611292846",
    );
  });

  it("ignores a GID for a different resource type", () => {
    expect(payloadGid({ admin_graphql_api_id: "gid://shopify/Product/1" }, "Collection")).toBeNull();
  });

  it("returns null when there's no usable ID", () => {
    expect(payloadGid({}, "Product")).toBeNull();
    expect(payloadGid(null, "Product")).toBeNull();
    expect(payloadGid({ id: "abc" }, "Product")).toBeNull();
  });
});
