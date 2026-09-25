import { describe, expect, it } from "vitest";
import {
  MAX_METAFIELD_VALUE_LENGTH,
  listItems,
  metafieldKind,
  pickMetafields,
} from "./metafields";

describe("pickMetafields", () => {
  it("keeps the types rules can test, keyed by namespace.key", () => {
    expect(
      pickMetafields([
        {
          namespace: "custom",
          key: "trade_tier",
          type: "single_line_text_field",
          value: "gold",
        },
        {
          namespace: "custom",
          key: "min_qty",
          type: "number_integer",
          value: "10",
        },
        {
          namespace: "custom",
          key: "trade_only",
          type: "boolean",
          value: "true",
        },
        {
          namespace: "custom",
          key: "regions",
          type: "list.single_line_text_field",
          value: '["uk","eu"]',
        },
      ]),
    ).toEqual({
      "custom.trade_tier": { type: "single_line_text_field", value: "gold" },
      "custom.min_qty": { type: "number_integer", value: "10" },
      "custom.trade_only": { type: "boolean", value: "true" },
      "custom.regions": {
        type: "list.single_line_text_field",
        value: '["uk","eu"]',
      },
    });
  });

  it("drops other types, empty values and long values", () => {
    expect(
      pickMetafields([
        { namespace: "custom", key: "spec", type: "json", value: "{}" },
        {
          namespace: "custom",
          key: "body",
          type: "rich_text_field",
          value: "{}",
        },
        {
          namespace: "custom",
          key: "gone",
          type: "single_line_text_field",
          value: null,
        },
        {
          namespace: "custom",
          key: "essay",
          type: "multi_line_text_field",
          value: "x".repeat(MAX_METAFIELD_VALUE_LENGTH + 1),
        },
      ]),
    ).toEqual({});
  });
});

describe("listItems", () => {
  it("reads a JSON list of text", () => {
    expect(listItems('["uk","eu"]')).toEqual(["uk", "eu"]);
  });

  it("returns nothing for anything else", () => {
    expect(listItems("uk")).toEqual([]);
    expect(listItems('{"a":1}')).toEqual([]);
    expect(listItems("[1,2]")).toEqual([]);
  });
});

describe("metafieldKind", () => {
  it("groups types by how they compare", () => {
    expect(metafieldKind("single_line_text_field")).toBe("text");
    expect(metafieldKind("number_decimal")).toBe("number");
    expect(metafieldKind("boolean")).toBe("boolean");
    expect(metafieldKind("list.single_line_text_field")).toBe("list");
    expect(metafieldKind("json")).toBeNull();
  });
});
