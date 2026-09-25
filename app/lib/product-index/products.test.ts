import { describe, expect, it } from "vitest";
import {
  BulkProductAccumulator,
  buildBulkProductQuery,
  buildSingleProductQuery,
  findOnlineStorePublication,
  splitLines,
  toIndexedProduct,
  type ProductNode,
} from "./products";

const node = (id: number, extra: Partial<ProductNode> = {}): ProductNode => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  handle: `product-${id}`,
  status: "ACTIVE",
  vendor: "Driftline",
  productType: "Snowboard",
  tags: ["spike-seed"],
  updatedAt: "2026-09-24T10:00:00Z",
  category: { id: "gid://shopify/TaxonomyCategory/sg-4-17-2-17" },
  publishedOnPublication: true,
  ...extra,
});

const jsonl = (...objects: object[]) =>
  objects.map((o) => JSON.stringify(o)).join("\n");

async function* chunksOf(...chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

async function collect(lines: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

describe("toIndexedProduct", () => {
  it("maps the Shopify fields to an index row", () => {
    expect(toIndexedProduct(node(1), ["gid://shopify/Collection/9"])).toEqual({
      productId: "gid://shopify/Product/1",
      title: "Product 1",
      handle: "product-1",
      status: "ACTIVE",
      vendor: "Driftline",
      productType: "Snowboard",
      tags: ["spike-seed"],
      categoryId: "gid://shopify/TaxonomyCategory/sg-4-17-2-17",
      collectionIds: ["gid://shopify/Collection/9"],
      onlineStorePublished: true,
      shopifyUpdatedAt: new Date("2026-09-24T10:00:00Z"),
    });
  });

  it("stores empty vendor and product type as null, and no category as null", () => {
    const row = toIndexedProduct(
      node(1, { vendor: "", productType: "", category: null }),
      [],
    );
    expect(row.vendor).toBeNull();
    expect(row.productType).toBeNull();
    expect(row.categoryId).toBeNull();
  });

  it("treats a missing Online Store flag as not published", () => {
    const withoutFlag = node(1);
    delete withoutFlag.publishedOnPublication;
    expect(toIndexedProduct(withoutFlag, []).onlineStorePublished).toBe(false);
  });

  it("removes duplicate collection IDs", () => {
    const row = toIndexedProduct(node(1), [
      "gid://shopify/Collection/9",
      "gid://shopify/Collection/9",
    ]);
    expect(row.collectionIds).toEqual(["gid://shopify/Collection/9"]);
  });
});

describe("BulkProductAccumulator", () => {
  it("joins collection lines to their product", () => {
    const acc = new BulkProductAccumulator();
    const text = jsonl(
      node(1),
      {
        id: "gid://shopify/Collection/9",
        __parentId: "gid://shopify/Product/1",
      },
      {
        id: "gid://shopify/Collection/10",
        __parentId: "gid://shopify/Product/1",
      },
      node(2),
    );
    text.split("\n").forEach((line) => acc.addLine(line));

    const rows = acc.products();
    expect(acc.productCount).toBe(2);
    expect(rows.find((r) => r.productId.endsWith("/1"))?.collectionIds).toEqual(
      ["gid://shopify/Collection/9", "gid://shopify/Collection/10"],
    );
    expect(rows.find((r) => r.productId.endsWith("/2"))?.collectionIds).toEqual(
      [],
    );
  });

  it("handles a child line that arrives before its product", () => {
    const acc = new BulkProductAccumulator();
    acc.addObject({
      id: "gid://shopify/Collection/9",
      __parentId: "gid://shopify/Product/1",
    });
    acc.addObject(node(1) as unknown as Record<string, unknown>);
    expect(acc.products()[0].collectionIds).toEqual([
      "gid://shopify/Collection/9",
    ]);
  });

  it("ignores blank lines and objects it doesn't know", () => {
    const acc = new BulkProductAccumulator();
    acc.addLine("");
    acc.addLine("   ");
    acc.addObject({
      id: "gid://shopify/ProductVariant/5",
      __parentId: "gid://shopify/Product/1",
    });
    acc.addObject({ id: "gid://shopify/Collection/5" });
    acc.addObject({ title: "no id" });
    expect(acc.products()).toEqual([]);
  });

  it("throws on a line that isn't JSON", () => {
    expect(() => new BulkProductAccumulator().addLine("{not json")).toThrow();
  });
});

describe("splitLines", () => {
  it("splits lines that cross chunk boundaries", async () => {
    expect(
      await collect(
        splitLines(chunksOf('{"a":', '1}\n{"b"', ":2}\n", '{"c":3}')),
      ),
    ).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("doesn't yield an empty line for a trailing newline", async () => {
    expect(await collect(splitLines(chunksOf("x\n")))).toEqual(["x"]);
  });
});

describe("query builders", () => {
  const publicationId = "gid://shopify/Publication/123";

  it("asks for the Online Store flag only when the publication is known", () => {
    expect(buildBulkProductQuery(publicationId)).toContain(
      `publishedOnPublication(publicationId: "${publicationId}")`,
    );
    expect(buildBulkProductQuery(null)).not.toContain("publishedOnPublication");
    expect(buildSingleProductQuery(null)).not.toContain(
      "publishedOnPublication",
    );
  });

  it("rejects anything that isn't a publication GID", () => {
    expect(() =>
      buildBulkProductQuery('gid://shopify/Publication/1") { id } #'),
    ).toThrow();
  });
});

describe("findOnlineStorePublication", () => {
  it("finds the Online Store by catalog title", () => {
    expect(
      findOnlineStorePublication([
        {
          id: "gid://shopify/Publication/1",
          catalog: { title: "Point of Sale" },
        },
        {
          id: "gid://shopify/Publication/2",
          catalog: { title: "Online Store" },
        },
      ]),
    ).toBe("gid://shopify/Publication/2");
  });

  it("matches the channel catalog title format seen on 2026-07", () => {
    expect(
      findOnlineStorePublication([
        {
          id: "gid://shopify/Publication/225112817838",
          catalog: { title: "Channel Catalog 225112817838 for Point of Sale" },
        },
        {
          id: "gid://shopify/Publication/225112850606",
          catalog: { title: "Channel Catalog 225112850606 for Shop" },
        },
        {
          id: "gid://shopify/Publication/225112752302",
          catalog: { title: "Channel Catalog 225112752302 for Online Store" },
        },
      ]),
    ).toBe("gid://shopify/Publication/225112752302");
  });

  it("doesn't match a channel that only mentions the Online Store", () => {
    expect(
      findOnlineStorePublication([
        {
          id: "gid://shopify/Publication/1",
          catalog: { title: "Online Store Helper" },
        },
      ]),
    ).toBeNull();
  });

  it("returns null when the shop has no Online Store channel", () => {
    expect(
      findOnlineStorePublication([
        { id: "gid://shopify/Publication/1", catalog: null },
      ]),
    ).toBeNull();
  });
});
