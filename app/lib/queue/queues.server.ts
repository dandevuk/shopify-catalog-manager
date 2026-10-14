import { Queue } from "bullmq";
import prisma from "../../db.server";
import { RECHECK_DELAYS_MS } from "../product-index/index.server";
import { redisConnection } from "./connection.server";

/**
 * The app's BullMQ queues. Jobs only carry IDs; the worker (`app/worker.ts`)
 * re-reads everything it needs when it runs a job, so a job is safe to run
 * late or (for the recheck queue) skip if it's been superseded.
 *
 *   product-index-recheck  the 30 s / 2 min / 10 min re-reads that catch
 *                          collection-condition membership Shopify applies
 *                          after a save (findings 15 to 17). Phase 1, step 5.
 *   catalog-sync           an automatic run of managed mode for one catalog,
 *                          debounced so a burst of product changes collapses
 *                          into one sync per catalog. Phase 1, step 5.
 *   assignment-scan        a repeating scan (Phase 2, step 5) that re-applies
 *                          every catalog's saved B2B assignment rules: there's
 *                          no webhook to react to (company_locations/* is
 *                          deliberately unused, protected customer data), so
 *                          this is the only way a newly matching location
 *                          gets picked up automatically.
 *
 * Queues (and Workers) each get their own Redis connection; see
 * connection.server.ts.
 */

export const RECHECK_QUEUE_NAME = "product-index-recheck";
export const CATALOG_SYNC_QUEUE_NAME = "catalog-sync";
export const ASSIGNMENT_SCAN_QUEUE_NAME = "assignment-scan";

export interface ProductRecheckJob {
  shopDomain: string;
  productId: string;
  attempt: number;
}

export interface CollectionRecheckJob {
  shopDomain: string;
  collectionId: string;
  attempt: number;
}

export interface CatalogSyncJob {
  shopDomain: string;
  catalogRecordId: string;
}

// One Queue instance per process is enough; BullMQ Queues don't block like
// Workers do, so sharing them across requests is fine.
let recheckQueue: Queue<ProductRecheckJob | CollectionRecheckJob> | undefined;
let catalogSyncQueue: Queue<CatalogSyncJob> | undefined;
let assignmentScanQueue: Queue | undefined;

function getRecheckQueue() {
  recheckQueue ??= new Queue(RECHECK_QUEUE_NAME, { connection: redisConnection() });
  return recheckQueue;
}

function getCatalogSyncQueue() {
  catalogSyncQueue ??= new Queue(CATALOG_SYNC_QUEUE_NAME, { connection: redisConnection() });
  return catalogSyncQueue;
}

function getAssignmentScanQueue() {
  assignmentScanQueue ??= new Queue(ASSIGNMENT_SCAN_QUEUE_NAME, {
    connection: redisConnection(),
  });
  return assignmentScanQueue;
}

/**
 * Whether background jobs can't be queued at all, because there's no Redis.
 *
 * Redis is optional in development. Only the product and collection webhook
 * routes reach a queue from the web process, so with no REDIS_URL the app
 * still serves every page and every merchant-facing action: the rule builder,
 * the live preview, Save, Review changes, Apply to Shopify and index
 * rebuilds. Scheduling then no-ops with one warning per process instead of
 * throwing, which keeps `npm run dev` working with no local Redis (and so no
 * Docker, when DATABASE_URL points at a hosted Postgres).
 *
 * What's lost while it's unset: the delayed re-reads that catch
 * collection-condition membership (findings 15 to 17) and automatic syncs of
 * managed catalogs. Manual "Sync now" still works, so the gap is visible and
 * recoverable rather than silent.
 *
 * The worker is deliberately the opposite: it exists only to run jobs, so it
 * fails loudly on a missing REDIS_URL (`redisConnection` throws). Production
 * sets REDIS_URL on both services, so neither path applies there.
 */
let warnedNoRedis = false;
function queueingUnavailable(): boolean {
  if (process.env.REDIS_URL) return false;
  if (!warnedNoRedis) {
    warnedNoRedis = true;
    console.warn(
      "REDIS_URL isn't set, so background jobs are off: no delayed product index " +
        "re-reads and no automatic catalog syncs. Manual syncing still works. Set " +
        "REDIS_URL (`npm run db:up` starts a local Redis) to turn them back on.",
    );
  }
  return true;
}

/**
 * Job ids below join their parts with "|", not ":": BullMQ rejects a custom
 * id containing a colon unless it splits into exactly 3 parts (a legacy
 * compatibility rule for its own repeatable-job ids, `Job.addJob` in
 * bullmq/dist/cjs/classes/job.js).
 *
 * Changing the separator is only half of it, though, and that half-fix
 * shipped broken from Sep 2026 until 14 Oct 2026: a Shopify GID contains a
 * colon of its own in "gid://", so `shop|product|gid://shopify/Product/1|0`
 * still split into 2 parts and still threw "Custom Id cannot contain :".
 * Every product and collection recheck therefore failed to schedule, and
 * `upsertDelayedJob`'s catch logged it as "Couldn't schedule ..." and
 * carried on, so nothing surfaced. The queue tests mock BullMQ, so they
 * couldn't see a rule BullMQ enforces; `jobIds never contain a colon` below
 * is the regression guard that works under the mock.
 *
 * Hence `gidTail`: job ids carry the trailing numeric id instead of the whole
 * GID. The shop domain and the resource kind are already in the id, so that
 * stays unique, and the full GID still travels in the job's data.
 */
function gidTail(gid: string): string {
  return gid.split("/").pop() || gid;
}


/**
 * Adds a delayed job under `jobId`, replacing any earlier one with the same
 * id: the standard BullMQ debounce pattern. A job already active (being
 * processed right now) can't be removed; in that rare case the reschedule is
 * skipped and the active run's own result stands, which is fine for both
 * queues here (a recheck or sync that's already running reads fresh data).
 */
// Queue is left untyped here (rather than generic over the job data): BullMQ's
// Queue<Data> resolves its NameType from Data via a conditional type that TS
// can't reduce for a still-generic Data, so the call below stays plain Queue
// and each caller keeps its own typed data object.
async function upsertDelayedJob(
  queue: Queue,
  jobId: string,
  name: string,
  data: object,
  delayMs: number,
): Promise<void> {
  try {
    await queue.remove(jobId);
  } catch {
    // Active job, or already gone: fall through and try to add anyway.
  }
  try {
    await queue.add(name, data, {
      jobId,
      delay: delayMs,
      attempts: 1,
      removeOnComplete: { age: 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  } catch (error) {
    // Most likely "job already exists" because an active job couldn't be
    // removed above. Its own re-read is still coming, so this is safe to drop.
    console.error(`Couldn't schedule ${name} ${jobId}`, error);
  }
}

/**
 * Re-reads a product at 30 s, 2 min and 10 min. A new event for the same
 * product restarts all three (product index tests 7, 7c: Shopify can take
 * over 30 s and under 2 min to apply collection conditions after a save).
 */
export function scheduleProductRecheck(shopDomain: string, productId: string): void {
  if (queueingUnavailable()) return;
  const queue = getRecheckQueue();
  RECHECK_DELAYS_MS.forEach((delayMs, attempt) => {
    const jobId = `${shopDomain}|product|${gidTail(productId)}|${attempt}`;
    void upsertDelayedJob(queue, jobId, "product", { shopDomain, productId, attempt }, delayMs);
  });
}

export function scheduleCollectionRecheck(shopDomain: string, collectionId: string): void {
  if (queueingUnavailable()) return;
  const queue = getRecheckQueue();
  RECHECK_DELAYS_MS.forEach((delayMs, attempt) => {
    const jobId = `${shopDomain}|collection|${gidTail(collectionId)}|${attempt}`;
    void upsertDelayedJob(
      queue,
      jobId,
      "collection",
      { shopDomain, collectionId, attempt },
      delayMs,
    );
  });
}

/** A burst of product changes for one catalog collapses into one sync. */
export const CATALOG_SYNC_DEBOUNCE_MS = 2 * 60_000;

export function scheduleCatalogSync(shopDomain: string, catalogRecordId: string): void {
  if (queueingUnavailable()) return;
  const jobId = `${shopDomain}|${catalogRecordId}`;
  void upsertDelayedJob(
    getCatalogSyncQueue(),
    jobId,
    "sync",
    { shopDomain, catalogRecordId },
    CATALOG_SYNC_DEBOUNCE_MS,
  );
}

/**
 * Queues a debounced sync for every catalog the shop manages. Called after a
 * product or collection webhook (or a recheck) changes the index. Coarse by
 * design for v1: it doesn't check whether the change could affect any given
 * catalog's rules, relying on a sync with nothing to do being cheap (~500 ms,
 * measured on the dev store) rather than filtering by which fields a
 * catalog's conditions use.
 */
export async function scheduleManagedCatalogSyncs(shopDomain: string): Promise<void> {
  // Checked before the query: with no Redis there's nothing to do with the result.
  if (queueingUnavailable()) return;
  const catalogs = await prisma.catalog.findMany({
    where: { managed: true, shop: { domain: shopDomain } },
    select: { id: true },
  });
  for (const catalog of catalogs) scheduleCatalogSync(shopDomain, catalog.id);
}

/**
 * How often the automatic assignment scan runs (Phase 2, step 5). Coarse for
 * v1: not tied to any event, so this is a flat interval rather than a
 * per-catalog debounce.
 */
export const ASSIGNMENT_SCAN_INTERVAL_MS = 15 * 60_000;

/**
 * Schedules the repeating assignment scan job. Safe to call on every worker
 * startup: `upsertJobScheduler` replaces any existing scheduler under the
 * same id rather than adding a duplicate.
 */
export async function scheduleAssignmentScan(): Promise<void> {
  await getAssignmentScanQueue().upsertJobScheduler(
    "assignment-scan",
    { every: ASSIGNMENT_SCAN_INTERVAL_MS },
    {
      name: "scan",
      opts: {
        removeOnComplete: { age: 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    },
  );
}
