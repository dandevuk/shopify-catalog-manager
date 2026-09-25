import {
  GraphqlRequestError,
  runGraphql,
  type AdminGraphqlClient,
  type QueryCost,
} from "../shopify/graphql.server";
import type { PublicationUpdateChunk } from "./chunk";

/**
 * Sends a sync plan's chunks to Shopify with publicationUpdate.
 *
 * Each call is all or nothing (spike finding 1). If Shopify rejects a chunk,
 * it's split in half and each half is tried again, down to single products,
 * so one bad product (e.g. a pinned product that has since been deleted)
 * doesn't block the rest. Throttling is waited out and retried.
 */

const PUBLICATION_UPDATE = `#graphql
  mutation ManagedApplyChunk($id: ID!, $add: [ID!], $remove: [ID!]) {
    publicationUpdate(id: $id, input: { publishablesToAdd: $add, publishablesToRemove: $remove }) {
      publication {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface PublicationUpdateResult {
  publicationUpdate: {
    publication: { id: string } | null;
    userErrors: {
      field: string[] | null;
      message: string;
      code: string | null;
    }[];
  };
}

export interface FailedChange {
  productId: string;
  action: "ADD" | "REMOVE";
  error: string;
}

export interface ApplyResult {
  added: string[];
  removed: string[];
  failed: FailedChange[];
}

export interface ApplyOptions {
  /** Called after every successful call, e.g. to record progress and audit entries */
  onApplied?: (change: { added: string[]; removed: string[] }) => Promise<void>;
  /** Injected in tests so they don't wait */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per call when Shopify throttles or the request fails */
  maxAttempts?: number;
  /**
   * Rejected calls allowed per sync before giving up. Isolating one bad
   * product takes about 8 rejected calls, but an error that isn't about a
   * product (e.g. the publication is gone) fails every half, so without a
   * limit it would cost about two calls per product.
   */
  maxRejectedCalls?: number;
}

/** Below this many query cost points left, wait for the bucket to refill. */
const MIN_AVAILABLE_COST = 200;

export async function applyChunks(
  admin: AdminGraphqlClient,
  publicationId: string,
  chunks: PublicationUpdateChunk[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { added: [], removed: [], failed: [] };
  const budget = { rejectedCallsLeft: options.maxRejectedCalls ?? 40 };
  for (const chunk of chunks) {
    await applyChunk(admin, publicationId, chunk, result, options, budget);
  }
  return result;
}

async function applyChunk(
  admin: AdminGraphqlClient,
  publicationId: string,
  chunk: PublicationUpdateChunk,
  result: ApplyResult,
  options: ApplyOptions,
  budget: { rejectedCallsLeft: number },
): Promise<void> {
  if (chunk.add.length === 0 && chunk.remove.length === 0) return;

  const userErrors = await sendWithRetry(admin, publicationId, chunk, options);
  if (userErrors.length === 0) {
    result.added.push(...chunk.add);
    result.removed.push(...chunk.remove);
    await options.onApplied?.({ added: chunk.add, removed: chunk.remove });
    return;
  }

  // Rejected. Stop if Shopify keeps rejecting: the problem isn't one product.
  budget.rejectedCallsLeft--;
  if (budget.rejectedCallsLeft < 0) {
    throw new Error(
      `Shopify kept rejecting changes, so the sync stopped: ${userErrors
        .map((e) => `${e.code ?? "ERROR"}: ${e.message}`)
        .join("; ")}`,
    );
  }

  // A single change can't be split further: record it as failed.
  const size = chunk.add.length + chunk.remove.length;
  if (size === 1) {
    const error = userErrors
      .map((e) => `${e.code ?? "ERROR"}: ${e.message}`)
      .join("; ");
    if (chunk.add.length === 1)
      result.failed.push({ productId: chunk.add[0], action: "ADD", error });
    else
      result.failed.push({
        productId: chunk.remove[0],
        action: "REMOVE",
        error,
      });
    return;
  }

  // Otherwise try each half, to isolate the change Shopify won't accept.
  for (const half of splitChunk(chunk)) {
    await applyChunk(admin, publicationId, half, result, options, budget);
  }
}

/** Splits a chunk into two smaller ones with roughly half the changes each. */
export function splitChunk(
  chunk: PublicationUpdateChunk,
): PublicationUpdateChunk[] {
  const all = [
    ...chunk.add.map((id) => ({ id, add: true })),
    ...chunk.remove.map((id) => ({ id, add: false })),
  ];
  const middle = Math.ceil(all.length / 2);
  return [all.slice(0, middle), all.slice(middle)]
    .filter((part) => part.length > 0)
    .map((part) => ({
      add: part.filter((c) => c.add).map((c) => c.id),
      remove: part.filter((c) => !c.add).map((c) => c.id),
    }));
}

async function sendWithRetry(
  admin: AdminGraphqlClient,
  publicationId: string,
  chunk: PublicationUpdateChunk,
  options: ApplyOptions,
): Promise<PublicationUpdateResult["publicationUpdate"]["userErrors"]> {
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 5;

  for (let attempt = 1; ; attempt++) {
    try {
      const { data, cost } = await runGraphql<PublicationUpdateResult>(
        admin,
        PUBLICATION_UPDATE,
        {
          id: publicationId,
          add: chunk.add,
          remove: chunk.remove,
        },
      );
      await sleep(waitForCost(cost));
      return data.publicationUpdate.userErrors;
    } catch (error) {
      // Retry throttling and failed requests with growing waits: 1 s, 2 s, 4 s...
      // Anything that keeps failing stops the sync.
      if (!(error instanceof GraphqlRequestError) || attempt >= maxAttempts)
        throw error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

/**
 * How long to wait so the next call doesn't get throttled. Non-Plus shops
 * have a much smaller bucket than the 20,000 points on the Plus dev store.
 */
export function waitForCost(cost: QueryCost | null): number {
  const throttle = cost?.throttleStatus;
  if (throttle?.currentlyAvailable === undefined || !throttle.restoreRate)
    return 0;
  if (throttle.currentlyAvailable >= MIN_AVAILABLE_COST) return 0;
  const missing = MIN_AVAILABLE_COST - throttle.currentlyAvailable;
  return Math.ceil((missing / throttle.restoreRate) * 1000);
}
