import prisma from "../../db.server";
import { evaluateRuleSet, type Decision } from "../rules/evaluate";
import { describeDecision } from "../rules/preview";
import {
  forgetCatalogMembership,
  getCatalogMembership,
  loadIndexProducts,
  loadOverrides,
  loadRules,
  ruleNames,
  type RuleCatalog,
} from "../rules/rules.server";
import { getShopDiagnostics } from "../shopify/diagnostics.server";
import {
  describeError,
  runGraphql,
  type AdminGraphqlClient,
} from "../shopify/graphql.server";
import { applyChunks } from "./apply.server";
import {
  checkAcknowledgement,
  planSync,
  type Acknowledgement,
  type SyncPlan,
} from "./plan";

/**
 * Managed mode (Phase 1, step 4): make a catalog's product list match its
 * rules.
 *
 *   previewSync  what Apply would do, and anything blocking it
 *   startSync    re-plans, checks the merchant's confirmation, then runs the
 *                sync in the background and returns its SyncJob
 *   runSync      creates the catalog's publication if missing (finding 3),
 *                turns autoPublish off (finding 5), applies the plan in
 *                publicationUpdate chunks and records the audit log
 *
 * The background run is in-process for now: a restart interrupts it (the job
 * is then marked failed after an hour). It moves to BullMQ in step 5, which
 * also adds automatic syncing. Until then catalogs change only on Apply.
 */

// ---------------------------------------------------------------------------
// Shopify operations
// ---------------------------------------------------------------------------

const CREATE_PUBLICATION = `#graphql
  mutation ManagedCreatePublication($catalogId: ID!) {
    publicationCreate(
      input: { catalogId: $catalogId, defaultState: ALL_PRODUCTS, autoPublish: false }
    ) {
      publication {
        id
        autoPublish
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const PUBLICATION_OPERATION = `#graphql
  query ManagedPublicationOperation($id: ID!) {
    publication(id: $id) {
      id
      operation {
        __typename
        ... on AddAllProductsOperation {
          id
          status
        }
        ... on PublicationResourceOperation {
          id
          status
        }
        ... on CatalogCsvOperation {
          id
          status
        }
      }
    }
  }
`;

const AUTO_PUBLISH_OFF = `#graphql
  mutation ManagedAutoPublishOff($id: ID!) {
    publicationUpdate(id: $id, input: { autoPublish: false }) {
      publication {
        id
        autoPublish
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const CATALOG_STATE = `#graphql
  query ManagedCatalogState($id: ID!) {
    catalog(id: $id) {
      id
      operations {
        __typename
        id
        status
      }
      publication {
        id
        autoPublish
        includedProductsCount {
          count
          precision
        }
      }
    }
  }
`;

type UserErrors = {
  field: string[] | null;
  message: string;
  code: string | null;
}[];

function userErrorText(errors: UserErrors): string {
  return errors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface SyncPreview {
  /** Reasons Apply can't run now; empty when it can */
  blockers: string[];
  toAdd: number;
  toRemove: number;
  currentCount: number;
  resultCount: number;
  confirmations: SyncPlan["confirmations"];
  /** The catalog has no product list yet; Apply creates one */
  createsPublication: boolean;
  /** autoPublish is on; Apply turns it off */
  turnsOffAutoPublish: boolean;
}

interface PlannedSync {
  plan: SyncPlan;
  decisions: ReadonlyMap<string, Decision>;
  names: Map<string, string>;
  currentCount: number;
}

/**
 * The rule result compared with the catalog. Uses the saved rules (not the
 * editor) and a fresh read of the catalog's products. Without a publication,
 * the catalog shows every product, which is also what publicationCreate with
 * ALL_PRODUCTS starts from, so "current" is every indexed product.
 */
async function planFromSavedRules(
  admin: AdminGraphqlClient,
  shopId: string,
  catalog: RuleCatalog,
): Promise<PlannedSync | { error: string }> {
  const rules = await loadRules(catalog.recordId);
  if (!rules) {
    return {
      error:
        "This catalog has no saved rules yet. Add conditions and save them first.",
    };
  }

  const [products, overrides, current, names] = await Promise.all([
    loadIndexProducts(shopId),
    loadOverrides(catalog.recordId),
    catalog.publicationId
      ? getCatalogMembership(admin, catalog.publicationId, { fresh: true })
      : null,
    ruleNames(admin, rules.conditions),
  ]);
  const evaluation = evaluateRuleSet(rules, products, overrides);
  if (!evaluation.ok) {
    return {
      error: `The saved rules have a problem: ${evaluation.errors.map((e) => e.error).join(" ")}`,
    };
  }

  if (catalog.publicationId && current === null) {
    // The publication was deleted or swapped since the page loaded. Never
    // read that as "every product": the plan would be wrong, and every update
    // would go to a publication that no longer exists.
    return {
      error:
        "This catalog's product list changed in Shopify (it was removed or replaced). Reload the page and review again.",
    };
  }
  const currentIds = current ?? products.map((p) => p.productId);
  return {
    plan: planSync(evaluation.productIds, currentIds),
    decisions: evaluation.decisions,
    names,
    currentCount: new Set(currentIds).size,
  };
}

async function blockersFor(
  admin: AdminGraphqlClient,
  shopDomain: string,
  catalog: RuleCatalog,
): Promise<string[]> {
  const blockers: string[] = [];
  const [shopInfo, shop, running, state] = await Promise.all([
    getShopDiagnostics(admin),
    prisma.shop.findUnique({ where: { domain: shopDomain } }),
    runningJob(catalog.recordId),
    runGraphql<{
      catalog: { operations: { status: string }[] } | null;
    }>(admin, CATALOG_STATE, { id: catalog.shopifyCatalogId }),
  ]);
  // While Shopify is still changing the catalog's products (e.g. filling a
  // newly created catalog, seen on the dev store), its product list is
  // incomplete, and a sync would work out the wrong changes.
  const busy = state.data.catalog?.operations.some(
    (operation) =>
      operation.status === "CREATED" || operation.status === "ACTIVE",
  );
  if (busy) {
    blockers.push(
      "Shopify is still updating this catalog's products. Try again in a minute.",
    );
  }
  // Agreed for Phase 1: only development stores until automatic syncing is tested.
  if (!shopInfo.isDevelopmentStore) {
    blockers.push("Managed mode only runs on development stores for now.");
  }
  if (!shop?.productIndexRebuiltAt) {
    blockers.push(
      "The product index hasn't been built yet. Rebuild it from Diagnostics.",
    );
  } else if (shop.productIndexStatus === "RUNNING") {
    blockers.push(
      "The product index is being rebuilt. Try again when it has finished.",
    );
  }
  if (running) blockers.push("A sync is already running for this catalog.");
  return blockers;
}

export async function previewSync(
  admin: AdminGraphqlClient,
  shopId: string,
  shopDomain: string,
  catalog: RuleCatalog,
): Promise<SyncPreview> {
  const [blockers, planned] = await Promise.all([
    blockersFor(admin, shopDomain, catalog),
    planFromSavedRules(admin, shopId, catalog),
  ]);
  const empty = {
    toAdd: 0,
    toRemove: 0,
    currentCount: 0,
    resultCount: 0,
    confirmations: [],
  };
  const flags = {
    createsPublication: catalog.publicationId === null,
    turnsOffAutoPublish: catalog.autoPublish === true,
  };
  if ("error" in planned)
    return { blockers: [...blockers, planned.error], ...empty, ...flags };

  const { plan, currentCount } = planned;
  return {
    blockers,
    toAdd: plan.toAdd.length,
    toRemove: plan.toRemove.length,
    currentCount,
    resultCount: currentCount - plan.toRemove.length + plan.toAdd.length,
    confirmations: plan.confirmations,
    ...flags,
  };
}

// ---------------------------------------------------------------------------
// Start and run
// ---------------------------------------------------------------------------

export type StartSyncResult =
  { ok: true; jobId: string } | { ok: false; error: string };

export async function startSync(
  admin: AdminGraphqlClient,
  shopId: string,
  shopDomain: string,
  catalog: RuleCatalog,
  acknowledgement: Acknowledgement,
): Promise<StartSyncResult> {
  const [blockers, planned] = await Promise.all([
    blockersFor(admin, shopDomain, catalog),
    planFromSavedRules(admin, shopId, catalog),
  ]);
  if (blockers.length > 0) return { ok: false, error: blockers.join(" ") };
  if ("error" in planned) return { ok: false, error: planned.error };
  const problem = checkAcknowledgement(planned.plan, acknowledgement);
  if (problem) return { ok: false, error: problem };

  const job = await claimCatalog(catalog.recordId);
  if (!job)
    return { ok: false, error: "A sync is already running for this catalog." };

  // Runs after the response; the page polls the job for progress.
  activeJobs.add(job.id);
  void runSync(admin, shopId, catalog, job.id, acknowledgement)
    .catch(async (error) => {
      try {
        await finishJob(job.id, "FAILED", describeError(error));
      } catch (recordError) {
        // Nothing left to tell; don't let this crash the server.
        console.error(
          `Couldn't record sync ${job.id} as failed`,
          error,
          recordError,
        );
      }
    })
    .finally(() => activeJobs.delete(job.id));
  return { ok: true, jobId: job.id };
}

/**
 * Creates a running SyncJob for the catalog, or returns null if one is
 * already running: only one sync per catalog at a time. Locking the
 * catalog's row makes two starts at the same moment queue up here, so the
 * second one sees the first one's job.
 */
export async function claimCatalog(catalogRecordId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Catalog" WHERE "id" = ${catalogRecordId} FOR UPDATE`;
    const busy = await tx.syncJob.findFirst({
      where: {
        catalogId: catalogRecordId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
    });
    if (busy) return null;
    return tx.syncJob.create({
      data: {
        catalogId: catalogRecordId,
        cause: "MANUAL",
        status: "RUNNING",
        startedAt: new Date(),
      },
    });
  });
}

async function runSync(
  admin: AdminGraphqlClient,
  shopId: string,
  catalog: RuleCatalog,
  jobId: string,
  acknowledgement: Acknowledgement,
): Promise<void> {
  // 1. The catalog needs its own product list (finding 3).
  let publicationId = catalog.publicationId;
  if (!publicationId) {
    publicationId = await createPublication(admin, catalog.shopifyCatalogId);
    await prisma.catalog.update({
      where: { id: catalog.recordId },
      data: { publicationId },
    });
  }

  // 2. autoPublish would add every new product regardless of the rules (finding 5).
  if (catalog.autoPublish !== false) {
    const { data } = await runGraphql<{
      publicationUpdate: { userErrors: UserErrors };
    }>(admin, AUTO_PUBLISH_OFF, { id: publicationId });
    if (data.publicationUpdate.userErrors.length > 0) {
      throw new Error(
        `Turning off auto-publish failed: ${userErrorText(data.publicationUpdate.userErrors)}`,
      );
    }
  }

  // 3. Plan again against the catalog as it is now. If it moved since the
  // merchant confirmed, stop and let them look again.
  const planned = await planFromSavedRules(admin, shopId, {
    ...catalog,
    publicationId,
  });
  if ("error" in planned) {
    await finishJob(jobId, "FAILED", planned.error);
    return;
  }
  const problem = checkAcknowledgement(planned.plan, acknowledgement);
  if (problem) {
    await finishJob(jobId, "PAUSED", problem);
    return;
  }

  // 4. Apply, recording progress and every change as it lands.
  const reason = (productId: string) => {
    const decision = planned.decisions.get(productId);
    return decision
      ? describeDecision(decision, (id) => planned.names.get(id))
      : "Not in the product index";
  };
  const result = await applyChunks(admin, publicationId, planned.plan.chunks, {
    onApplied: async ({ added, removed }) => {
      await prisma.$transaction([
        prisma.syncJob.update({
          where: { id: jobId },
          data: {
            adds: { increment: added.length },
            removes: { increment: removed.length },
          },
        }),
        prisma.auditLogEntry.createMany({
          data: [
            ...added.map((productId) => ({
              productId,
              action: "ADD" as const,
            })),
            ...removed.map((productId) => ({
              productId,
              action: "REMOVE" as const,
            })),
          ].map((entry) => ({
            ...entry,
            catalogId: catalog.recordId,
            cause: "MANUAL" as const,
            ruleSummary: reason(entry.productId),
            syncJobId: jobId,
          })),
        }),
      ]);
    },
  });
  forgetCatalogMembership(publicationId);

  // 5. Record the state Shopify reports after the sync as the baseline for
  // spotting admin edits later (finding 2). The catalog only counts as
  // managed and synced if Shopify accepted every change; otherwise the job
  // fails and the merchant can review and try again.
  const state = await runGraphql<{
    catalog: {
      operations: { id: string }[];
      publication: {
        autoPublish: boolean;
        includedProductsCount: { count: number } | null;
      } | null;
    } | null;
  }>(admin, CATALOG_STATE, { id: catalog.shopifyCatalogId });
  const clean = result.failed.length === 0;
  await prisma.catalog.update({
    where: { id: catalog.recordId },
    data: {
      ...(clean ? { managed: true, lastSyncedAt: new Date() } : {}),
      lastOperationId: state.data.catalog?.operations[0]?.id ?? null,
      lastKnownCount:
        state.data.catalog?.publication?.includedProductsCount?.count ?? null,
      lastAutoPublish: state.data.catalog?.publication?.autoPublish ?? null,
    },
  });

  if (clean) {
    await finishJob(jobId, "SUCCEEDED", null);
    return;
  }
  const failures = result.failed.map(
    (f) => `${f.action} ${f.productId}: ${f.error}`,
  );
  const applied = result.added.length + result.removed.length;
  await finishJob(
    jobId,
    "FAILED",
    `${applied} changes applied, ${failures.length} rejected by Shopify: ${failures.join(" | ")}`,
  );
}

/**
 * Creates the catalog's publication with every product (the state the
 * catalog was effectively in) and autoPublish off, then waits for Shopify to
 * finish adding the products (up to 10 minutes).
 */
async function createPublication(
  admin: AdminGraphqlClient,
  catalogId: string,
): Promise<string> {
  const { data } = await runGraphql<{
    publicationCreate: {
      publication: { id: string } | null;
      userErrors: UserErrors;
    };
  }>(admin, CREATE_PUBLICATION, { catalogId });
  const publication = data.publicationCreate.publication;
  if (!publication) {
    throw new Error(
      `Creating the catalog's product list failed: ${userErrorText(data.publicationCreate.userErrors)}`,
    );
  }

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const { data: state } = await runGraphql<{
      publication: {
        operation: { __typename: string; status?: string } | null;
      } | null;
    }>(admin, PUBLICATION_OPERATION, { id: publication.id });
    const status = state.publication?.operation?.status;
    if (!status || status === "COMPLETE") return publication.id;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    "Shopify took more than 10 minutes to fill the new product list. Try again later.",
  );
}

export async function finishJob(
  jobId: string,
  status: "SUCCEEDED" | "FAILED" | "PAUSED",
  error: string | null,
): Promise<void> {
  // Only a job that's still going: a finished one keeps its outcome.
  await prisma.syncJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status, error, finishedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Status and stopping
// ---------------------------------------------------------------------------

/**
 * A job still "running" after this long, that this process isn't running,
 * was interrupted (e.g. by a restart).
 */
const STALE_JOB_MS = 60 * 60_000;

/** Syncs running in this process. In-process until the queue (step 5). */
const activeJobs = new Set<string>();

async function runningJob(catalogRecordId: string) {
  const job = await prisma.syncJob.findFirst({
    where: {
      catalogId: catalogRecordId,
      status: { in: ["QUEUED", "RUNNING"] },
    },
  });
  if (
    job &&
    !activeJobs.has(job.id) &&
    Date.now() - (job.startedAt ?? job.createdAt).getTime() > STALE_JOB_MS
  ) {
    await finishJob(
      job.id,
      "FAILED",
      "The sync was interrupted (the app restarted). Run it again.",
    );
    return null;
  }
  return job;
}

export interface SyncStatus {
  managed: boolean;
  lastSyncedAt: string | null;
  latestJob: {
    status: string;
    adds: number;
    removes: number;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
}

export async function getSyncStatus(
  catalogRecordId: string,
): Promise<SyncStatus> {
  await runningJob(catalogRecordId); // marks a stale job as failed
  const [catalog, job] = await Promise.all([
    prisma.catalog.findUniqueOrThrow({ where: { id: catalogRecordId } }),
    prisma.syncJob.findFirst({
      where: { catalogId: catalogRecordId },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return {
    managed: catalog.managed,
    lastSyncedAt: catalog.lastSyncedAt?.toISOString() ?? null,
    latestJob: job
      ? {
          status: job.status,
          adds: job.adds,
          removes: job.removes,
          error: job.error,
          startedAt: job.startedAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * Stops the app syncing this catalog. Its products stay as they are, and
 * autoPublish stays off: the merchant decides whether to turn it back on.
 */
export async function stopManaging(catalogRecordId: string): Promise<void> {
  await prisma.catalog.update({
    where: { id: catalogRecordId },
    data: { managed: false },
  });
}
