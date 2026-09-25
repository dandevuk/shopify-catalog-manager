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
  if (!url) throw new Error("REDIS_URL isn't set.");
  return new IORedis(url, { maxRetriesPerRequest: null });
}
