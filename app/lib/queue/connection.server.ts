import IORedis from "ioredis";

/**
 * A Redis connection for BullMQ. Each Queue and each Worker gets its own
 * (BullMQ's own recommendation: a Worker blocks on Redis commands while
 * waiting for jobs, so it shouldn't share a connection with anything that
 * needs to run at the same time). `maxRetriesPerRequest: null` is required
 * by BullMQ's blocking commands.
 */
export function redisConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) {
    // The web process never gets here: its scheduling helpers check for
    // REDIS_URL first and no-op (see queueingUnavailable in queues.server.ts).
    // So this only fires in the worker, which has nothing to do without Redis.
    throw new Error(
      "REDIS_URL isn't set, so the worker has no queue to read. Start Redis " +
        "(`npm run db:up`) or point REDIS_URL at a hosted one.",
    );
  }
  return new IORedis(url, { maxRetriesPerRequest: null });
}
