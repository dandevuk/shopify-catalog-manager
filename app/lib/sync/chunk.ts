import type { MembershipDiff } from "./diff";

/**
 * `publicationUpdate` accepts at most 50 IDs in `publishablesToAdd` and 50 in
 * `publishablesToRemove` per call. The limits are separate, so one call can
 * make up to 100 changes. A call over the limit fails with
 * PUBLICATION_UPDATE_LIMIT_EXCEEDED and applies nothing (spike finding 1).
 */
export const PUBLICATION_UPDATE_LIMIT = 50;

export interface PublicationUpdateChunk {
  add: string[];
  remove: string[];
}

/**
 * Splits a diff into publicationUpdate-sized chunks, pairing adds and removes
 * in the same call to keep the number of calls down. Each chunk is atomic on
 * Shopify's side, so a failed chunk should be retried whole.
 */
export function chunkPublicationUpdate(
  diff: MembershipDiff,
  limit: number = PUBLICATION_UPDATE_LIMIT,
): PublicationUpdateChunk[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }

  const chunkCount = Math.ceil(
    Math.max(diff.toAdd.length, diff.toRemove.length) / limit,
  );

  const chunks: PublicationUpdateChunk[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      add: diff.toAdd.slice(i * limit, (i + 1) * limit),
      remove: diff.toRemove.slice(i * limit, (i + 1) * limit),
    });
  }
  return chunks;
}
