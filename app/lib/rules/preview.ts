import { diffMembership } from "../sync/diff";
import { describeCondition } from "./conditions";
import type { Decision, RuleProduct } from "./evaluate";

/**
 * What saving and applying a rule set would do to a catalog: which products
 * would be added, removed or left alone, and why. Read-only; nothing here
 * changes Shopify.
 */

export interface PreviewProduct extends RuleProduct {
  title: string;
}

export interface PreviewRow {
  productId: string;
  title: string;
  status: string | null;
  reason: string;
  /** In the catalog, but a B2B buyer can't see it (not on the Online Store) */
  notVisible: boolean;
}

export interface Preview {
  inCatalog: number;
  toAdd: number;
  toRemove: number;
  unchanged: number;
  /** Products that would be in the catalog but not visible to B2B buyers */
  notVisible: number;
  /**
   * The catalog has no product list of its own, so today it shows every
   * product on the sales channel. Counts compare against the whole index.
   */
  currentFollowsChannel: boolean;
  addRows: PreviewRow[];
  removeRows: PreviewRow[];
  unchangedRows: PreviewRow[];
  /** Each list is cut to this many rows; the counts are complete */
  rowLimit: number;
}

export interface PreviewInput {
  products: PreviewProduct[];
  /** Products the rules put in the catalog */
  desired: string[];
  decisions: ReadonlyMap<string, Decision>;
  /** The catalog's includedProducts, or null if it has no publication yet */
  current: Iterable<string> | null;
  /** B2B catalogs: flag products that aren't on the Online Store (spike finding 6) */
  checkVisibility: boolean;
  /** Collection and category names for the reasons */
  nameFor?: (id: string) => string | undefined;
  rowLimit?: number;
}

export function buildPreview({
  products,
  desired,
  decisions,
  current,
  checkVisibility,
  nameFor,
  rowLimit = 100,
}: PreviewInput): Preview {
  const byId = new Map(products.map((product) => [product.productId, product]));
  const currentIds = current ?? products.map((product) => product.productId);
  const { toAdd, toRemove } = diffMembership(desired, currentIds);
  const removing = new Set(toRemove);
  const adding = new Set(toAdd);
  const unchangedIds = desired.filter((id) => !adding.has(id));

  const row = (productId: string): PreviewRow => {
    const product = byId.get(productId);
    const decision = decisions.get(productId);
    const inCatalog = !removing.has(productId);
    return {
      productId,
      title: product?.title ?? productId,
      status: product?.status ?? null,
      reason: decision
        ? describeDecision(decision, nameFor)
        : "Not in the product index (deleted from Shopify, or the index needs a rebuild)",
      notVisible:
        checkVisibility &&
        inCatalog &&
        product !== undefined &&
        !product.onlineStorePublished,
    };
  };

  const notVisible = checkVisibility
    ? desired.filter((id) => byId.get(id)?.onlineStorePublished === false)
        .length
    : 0;

  return {
    inCatalog: desired.length,
    toAdd: toAdd.length,
    toRemove: toRemove.length,
    unchanged: unchangedIds.length,
    notVisible,
    currentFollowsChannel: current === null,
    addRows: toAdd.slice(0, rowLimit).map(row),
    removeRows: toRemove.slice(0, rowLimit).map(row),
    unchangedRows: unchangedIds.slice(0, rowLimit).map(row),
    rowLimit,
  };
}

export function describeDecision(
  decision: Decision,
  nameFor?: (id: string) => string | undefined,
): string {
  const list = (conditions: Parameters<typeof describeCondition>[0][]) =>
    conditions
      .map((condition) => describeCondition(condition, nameFor))
      .join("; ");

  switch (decision.reason) {
    case "pinned":
      return "Pinned to this catalog";
    case "blocked":
      return "Blocked from this catalog";
    case "included":
      return `Matches: ${list(decision.matched)}`;
    case "excluded":
      return `Excluded: ${list(decision.matched)}`;
    case "not_included":
      return "Doesn't match the include conditions";
  }
}
