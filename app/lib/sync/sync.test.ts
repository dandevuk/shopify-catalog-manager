import { describe, expect, it } from "vitest";
import { diffMembership } from "./diff";
import { chunkPublicationUpdate, PUBLICATION_UPDATE_LIMIT } from "./chunk";

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `gid://shopify/Product/${prefix}${i}`);

describe("diffMembership", () => {
  it("returns products to add and remove", () => {
    const diff = diffMembership(["a", "b", "c"], ["b", "c", "d"]);
    expect(diff).toEqual({ toAdd: ["a"], toRemove: ["d"] });
  });

  it("returns nothing when desired and current match", () => {
    expect(diffMembership(["a", "b"], ["b", "a"])).toEqual({
      toAdd: [],
      toRemove: [],
    });
  });

  it("ignores duplicate IDs", () => {
    expect(diffMembership(["a", "a"], [])).toEqual({
      toAdd: ["a"],
      toRemove: [],
    });
  });
});

describe("chunkPublicationUpdate", () => {
  it("uses Shopify's limit of 50 per list by default", () => {
    expect(PUBLICATION_UPDATE_LIMIT).toBe(50);
  });

  it("returns no chunks for an empty diff", () => {
    expect(chunkPublicationUpdate({ toAdd: [], toRemove: [] })).toEqual([]);
  });

  it("keeps 50 adds in one call and splits 51 into two", () => {
    expect(
      chunkPublicationUpdate({ toAdd: ids("a", 50), toRemove: [] }),
    ).toHaveLength(1);

    const chunks = chunkPublicationUpdate({
      toAdd: ids("a", 51),
      toRemove: [],
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].add).toHaveLength(50);
    expect(chunks[1].add).toHaveLength(1);
  });

  it("pairs adds and removes in the same call", () => {
    const chunks = chunkPublicationUpdate({
      toAdd: ids("a", 30),
      toRemove: ids("r", 30),
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].add).toHaveLength(30);
    expect(chunks[0].remove).toHaveLength(30);
  });

  it("never exceeds the limit on either list and keeps every ID", () => {
    const toAdd = ids("a", 120);
    const toRemove = ids("r", 75);
    const chunks = chunkPublicationUpdate({ toAdd, toRemove });

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.add.length).toBeLessThanOrEqual(50);
      expect(chunk.remove.length).toBeLessThanOrEqual(50);
    }
    expect(chunks.flatMap((c) => c.add)).toEqual(toAdd);
    expect(chunks.flatMap((c) => c.remove)).toEqual(toRemove);
  });

  it("rejects an invalid limit", () => {
    expect(() =>
      chunkPublicationUpdate({ toAdd: [], toRemove: [] }, 0),
    ).toThrow();
  });
});
