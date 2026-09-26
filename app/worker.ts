import "@shopify/shopify-app-react-router/adapters/node";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "./lib/queue/connection.server";
import {
  ASSIGNMENT_SCAN_QUEUE_NAME,
  CATALOG_SYNC_QUEUE_NAME,
  RECHECK_QUEUE_NAME,
  scheduleAssignmentScan,
  type CatalogSyncJob,
  type CollectionRecheckJob,
  type ProductRecheckJob,
} from "./lib/queue/queues.server";
import { runCollectionRecheck, runProductRecheck } from "./lib/product-index/index.server";
import { runAutomaticSync } from "./lib/sync/managed.server";
import { runAssignmentAutoScan } from "./lib/assignment/auto-scan.server";

/**
 * The background worker process: run alongside `npm run dev` with `npm run
 * worker`. Processes every queue defined in `app/lib/queue/queues.server.ts`:
 *
 *   product-index-recheck  the delayed re-reads that catch collection
 *                          membership Shopify applies after a product save
 *                          (Phase 1, step 5)
 *   catalog-sync           automatic managed-mode syncs (Phase 1, step 5)
 *   assignment-scan        the repeating B2B assignment re-scan (Phase 2,
 *                          step 5); this process schedules the repeatable
 *                          job itself on startup
 *
 * Needs SHOPIFY_API_KEY and SHOPIFY_API_SECRET in .env, which `shopify app
 * dev` only injects into its own child process; run `npm run env` (`shopify
 * app env pull`) once to write them to .env for this process to read.
 */

async function processRecheck(job: Job<ProductRecheckJob | CollectionRecheckJob>): Promise<void> {
  if (job.name === "product") {
    const { shopDomain, productId, attempt } = job.data as ProductRecheckJob;
    await runProductRecheck(shopDomain, productId, attempt);
  } else if (job.name === "collection") {
    const { shopDomain, collectionId, attempt } = job.data as CollectionRecheckJob;
    await runCollectionRecheck(shopDomain, collectionId, attempt);
  } else {
    console.warn(`Unknown ${RECHECK_QUEUE_NAME} job name: ${job.name}`);
  }
}

async function processCatalogSync(job: Job<CatalogSyncJob>): Promise<void> {
  await runAutomaticSync(job.data.shopDomain, job.data.catalogRecordId);
}

async function processAssignmentScan(): Promise<void> {
  await runAssignmentAutoScan();
}

const recheckWorker = new Worker(RECHECK_QUEUE_NAME, processRecheck, {
  connection: redisConnection(),
  concurrency: 5,
});

const catalogSyncWorker = new Worker(CATALOG_SYNC_QUEUE_NAME, processCatalogSync, {
  connection: redisConnection(),
  // Managed mode is development-stores-only for now (CLAUDE.md), so shops
  // syncing at once are few; a low concurrency keeps this gentle on Shopify's
  // rate limit regardless.
  concurrency: 2,
});

const assignmentScanWorker = new Worker(ASSIGNMENT_SCAN_QUEUE_NAME, processAssignmentScan, {
  connection: redisConnection(),
  // One scan at a time: it already loops over every catalog with assignment
  // rules itself, so there's never more than one job queued anyway.
  concurrency: 1,
});

for (const worker of [recheckWorker, catalogSyncWorker, assignmentScanWorker]) {
  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id} (${worker.name}, ${job?.name}) failed`, error);
  });
  worker.on("error", (error) => {
    // Connection-level errors (e.g. Redis briefly unreachable); BullMQ retries itself.
    console.error(`Worker error (${worker.name})`, error);
  });
}

void scheduleAssignmentScan().catch((error) => {
  console.error("Couldn't schedule the assignment scan", error);
});

console.log(
  `Smart Catalogs worker ready: watching "${RECHECK_QUEUE_NAME}", "${CATALOG_SYNC_QUEUE_NAME}" and "${ASSIGNMENT_SCAN_QUEUE_NAME}".`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, closing workers...`);
  await Promise.all([
    recheckWorker.close(),
    catalogSyncWorker.close(),
    assignmentScanWorker.close(),
  ]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
