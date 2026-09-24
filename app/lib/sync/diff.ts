/**
 * Membership diff between the products a catalog should contain (the rule
 * result) and the products it currently contains (the publication's
 * `includedProducts`, which includes drafts and archived products).
 *
 * Always diff against `includedProducts`, not `products`: `products` only
 * lists visible items, so diffing against it would keep re-adding drafts
 * (spike finding 12).
 */
export interface MembershipDiff {
  toAdd: string[];
  toRemove: string[];
}

export function diffMembership(
  desired: Iterable<string>,
  current: Iterable<string>,
): MembershipDiff {
  const desiredSet = new Set(desired);
  const currentSet = new Set(current);

  const toAdd: string[] = [];
  for (const id of desiredSet) {
    if (!currentSet.has(id)) toAdd.push(id);
  }

  const toRemove: string[] = [];
  for (const id of currentSet) {
    if (!desiredSet.has(id)) toRemove.push(id);
  }

  return { toAdd, toRemove };
}
