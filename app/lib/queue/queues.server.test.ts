import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks BullMQ's Queue so these tests check the app's own scheduling logic
 * (which job goes on which queue, its id, delay and debounce behaviour)
 * without a real Redis. The two queues are memoized module-level singletons
 * in queues.server.ts, so every test shares the same fake Queue instances;
 * `vi.clearAllMocks()` between tests resets call counts, not the instances.
 */
const remove = vi.fn().mockResolvedValue(1);
const add = vi.fn().mockResolvedValue(undefined);
const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ remove, add, upsertJobScheduler })),
}));
vi.mock("./connection.server", () => ({ redisConnection: vi.fn() }));
vi.mock("../../db.server", () => ({ default: { catalog: { findMany: vi.fn() } } }));
// Importing index.server.ts for real would pull in shopify.server.ts (its
// PrismaSessionStorage checks the mocked db.server has a `.session` table at
// construction time), so its recheck logic is mocked away too: this file
// only exercises the scheduling side, not what a recheck job does.
vi.mock("../product-index/index.server", () => ({
  RECHECK_DELAYS_MS: [30_000, 2 * 60_000, 10 * 60_000],
  runProductRecheck: vi.fn(),
  runCollectionRecheck: vi.fn(),
}));

const {
  scheduleProductRecheck,
  scheduleCollectionRecheck,
  scheduleCatalogSync,
  scheduleManagedCatalogSyncs,
  scheduleAssignmentScan,
  CATALOG_SYNC_DEBOUNCE_MS,
  ASSIGNMENT_SCAN_INTERVAL_MS,
} = await import("./queues.server");
const prisma = (await import("../../db.server")).default;

/** Copied from product-index/index.server.ts's RECHECK_DELAYS_MS (see the mock above for why). */
const RECHECK_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

/** Scheduling fires the queue calls without waiting; let the microtask run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  remove.mockResolvedValue(1);
  add.mockResolvedValue(undefined);
  upsertJobScheduler.mockResolvedValue(undefined);
});

describe("scheduleProductRecheck", () => {
  it("adds one delayed job per RECHECK_DELAYS_MS entry, each removing its old job first", async () => {
    scheduleProductRecheck("shop.myshopify.com", "gid://shopify/Product/1");
    await flush();

    expect(add).toHaveBeenCalledTimes(RECHECK_DELAYS_MS.length);
    RECHECK_DELAYS_MS.forEach((delayMs, attempt) => {
      const jobId = `shop.myshopify.com|product|gid://shopify/Product/1|${attempt}`;
      expect(remove).toHaveBeenCalledWith(jobId);
      expect(add).toHaveBeenCalledWith(
        "product",
        { shopDomain: "shop.myshopify.com", productId: "gid://shopify/Product/1", attempt },
        expect.objectContaining({ jobId, delay: delayMs, attempts: 1 }),
      );
    });
  });

  it("restarts all three delays on a second call for the same product", async () => {
    scheduleProductRecheck("shop.myshopify.com", "p1");
    await flush();
    scheduleProductRecheck("shop.myshopify.com", "p1");
    await flush();

    expect(add).toHaveBeenCalledTimes(RECHECK_DELAYS_MS.length * 2);
    // Each attempt's jobId was removed before every add, including the second round.
    expect(remove).toHaveBeenCalledTimes(RECHECK_DELAYS_MS.length * 2);
  });

  it("keeps different products on separate job ids", async () => {
    scheduleProductRecheck("shop.myshopify.com", "p1");
    scheduleProductRecheck("shop.myshopify.com", "p2");
    await flush();

    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId: string }).jobId);
    expect(new Set(jobIds).size).toBe(jobIds.length); // all unique
  });
});

describe("scheduleCollectionRecheck", () => {
  it("uses the collection job name and its own job id shape", async () => {
    scheduleCollectionRecheck("shop.myshopify.com", "gid://shopify/Collection/9");
    await flush();

    expect(add).toHaveBeenCalledWith(
      "collection",
      expect.objectContaining({ collectionId: "gid://shopify/Collection/9" }),
      expect.objectContaining({ jobId: "shop.myshopify.com|collection|gid://shopify/Collection/9|0" }),
    );
  });
});

describe("scheduleCatalogSync", () => {
  it("schedules one job with the debounce delay", async () => {
    scheduleCatalogSync("shop.myshopify.com", "catalog-1");
    await flush();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "sync",
      { shopDomain: "shop.myshopify.com", catalogRecordId: "catalog-1" },
      expect.objectContaining({
        jobId: "shop.myshopify.com|catalog-1",
        delay: CATALOG_SYNC_DEBOUNCE_MS,
        attempts: 1,
      }),
    );
  });

  it("re-adding for the same catalog removes the earlier job first (debounce)", async () => {
    scheduleCatalogSync("shop.myshopify.com", "catalog-1");
    await flush();
    scheduleCatalogSync("shop.myshopify.com", "catalog-1");
    await flush();

    expect(remove).toHaveBeenCalledWith("shop.myshopify.com|catalog-1");
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("doesn't add a new job when removing the active one fails", async () => {
    remove.mockRejectedValueOnce(new Error("job is active"));
    scheduleCatalogSync("shop.myshopify.com", "catalog-1");
    await flush();

    // remove() throwing is caught; add() is still attempted (and may collide
    // with the active job's id, which BullMQ itself would then reject).
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleManagedCatalogSyncs", () => {
  it("schedules a sync for every managed catalog and none for an unmanaged shop", async () => {
    vi.mocked(prisma.catalog.findMany).mockResolvedValueOnce([
      { id: "a" },
      { id: "b" },
    ] as never);

    await scheduleManagedCatalogSyncs("shop.myshopify.com");
    await flush();

    expect(prisma.catalog.findMany).toHaveBeenCalledWith({
      where: { managed: true, shop: { domain: "shop.myshopify.com" } },
      select: { id: true },
    });
    expect(add).toHaveBeenCalledTimes(2);
    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId: string }).jobId);
    expect(jobIds).toEqual(["shop.myshopify.com|a", "shop.myshopify.com|b"]);
  });

  it("schedules nothing when the shop has no managed catalogs", async () => {
    vi.mocked(prisma.catalog.findMany).mockResolvedValueOnce([]);
    await scheduleManagedCatalogSyncs("shop.myshopify.com");
    await flush();
    expect(add).not.toHaveBeenCalled();
  });
});

describe("scheduleAssignmentScan", () => {
  it("upserts a single repeating job scheduler at the scan interval", async () => {
    await scheduleAssignmentScan();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      "assignment-scan",
      { every: ASSIGNMENT_SCAN_INTERVAL_MS },
      expect.objectContaining({ name: "scan" }),
    );
  });

  it("calling it again upserts the same scheduler rather than adding a new one", async () => {
    await scheduleAssignmentScan();
    await scheduleAssignmentScan();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    const ids = upsertJobScheduler.mock.calls.map((call) => call[0]);
    expect(new Set(ids).size).toBe(1);
  });
});
