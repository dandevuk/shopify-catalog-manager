import { chunkPublicationUpdate, type PublicationUpdateChunk } from "./chunk";
import { diffMembership } from "./diff";

/**
 * The sync planner: given what a catalog should contain (the rule result) and
 * what it contains now, works out the changes, the publicationUpdate calls
 * and which confirmations the merchant has to give first. Pure, so every
 * safety rule is unit tested (plan.test.ts).
 */

/** Removals needing a second confirmation: more than 25% of the catalog, or more than 100 products. */
export const LARGE_REMOVAL_FRACTION = 0.25;
export const LARGE_REMOVAL_COUNT = 100;

export type Confirmation =
  /** Would remove a large part of the catalog */
  | { kind: "large_removal"; removing: number; currentCount: number }
  /** Would leave the catalog with no products */
  | { kind: "empty_result"; currentCount: number };

export interface SyncPlan {
  toAdd: string[];
  toRemove: string[];
  chunks: PublicationUpdateChunk[];
  /** Must all be acknowledged before the plan is applied */
  confirmations: Confirmation[];
}

export function planSync(
  desired: Iterable<string>,
  current: Iterable<string>,
): SyncPlan {
  const currentIds = [...new Set(current)];
  const diff = diffMembership(desired, currentIds);
  const resultCount =
    currentIds.length - diff.toRemove.length + diff.toAdd.length;

  const confirmations: Confirmation[] = [];
  const removing = diff.toRemove.length;
  if (
    removing > LARGE_REMOVAL_COUNT ||
    (currentIds.length > 0 &&
      removing / currentIds.length > LARGE_REMOVAL_FRACTION)
  ) {
    confirmations.push({
      kind: "large_removal",
      removing,
      currentCount: currentIds.length,
    });
  }
  // Emptying a catalog is almost always a mistake (broken rules, an empty
  // index), so it always needs its own confirmation. An already empty
  // catalog that stays empty changes nothing.
  if (resultCount === 0 && currentIds.length > 0) {
    confirmations.push({
      kind: "empty_result",
      currentCount: currentIds.length,
    });
  }

  return {
    toAdd: diff.toAdd,
    toRemove: diff.toRemove,
    chunks: chunkPublicationUpdate(diff),
    confirmations,
  };
}

/** What the merchant saw and agreed to on the confirm step. */
export interface Acknowledgement {
  toAdd: number;
  toRemove: number;
  /** Confirmation kinds the merchant ticked */
  confirmed: Confirmation["kind"][];
}

/**
 * Why a plan can't go ahead on this acknowledgement, or null if it can. The
 * server re-plans on confirm; if the numbers moved since the merchant looked,
 * they must look again rather than approve something they didn't see.
 */
export function checkAcknowledgement(
  plan: SyncPlan,
  ack: Acknowledgement,
): string | null {
  if (
    plan.toAdd.length !== ack.toAdd ||
    plan.toRemove.length !== ack.toRemove
  ) {
    return (
      `The changes are now ${plan.toAdd.length} to add and ${plan.toRemove.length} to remove ` +
      `(you confirmed ${ack.toAdd} and ${ack.toRemove}). Check them and confirm again.`
    );
  }
  const missing = plan.confirmations.filter(
    (c) => !ack.confirmed.includes(c.kind),
  );
  if (missing.length > 0)
    return `Please confirm: ${missing.map(describeConfirmation).join(" ")}`;
  return null;
}

export function describeConfirmation(confirmation: Confirmation): string {
  switch (confirmation.kind) {
    case "large_removal":
      return `This removes ${confirmation.removing} of the catalog's ${confirmation.currentCount} products.`;
    case "empty_result":
      return `This leaves the catalog with no products (it has ${confirmation.currentCount} now).`;
  }
}
