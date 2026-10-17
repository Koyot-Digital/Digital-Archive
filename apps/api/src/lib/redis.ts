import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Redis carries rate-limit counters, the ingress replay window and a few hot
 * read caches. Every call site treats it as best-effort: if Redis is down the
 * archive must still serve reads, so helpers below swallow errors and the
 * rate limiter is configured to fail open rather than lock the archive out.
 */
export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

let warned = false;
redis.on("error", (err) => {
  // ioredis retries forever; log the first failure loudly, then stay quiet so
  // a dead Redis cannot flood the disk.
  if (!warned) {
    warned = true;
    logger.error({ err: err.message }, "redis unavailable — degrading to no-cache mode");
  }
});
redis.on("ready", () => {
  if (warned) logger.info("redis recovered");
  warned = false;
});

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

/** Read-through cache. On any Redis failure the loader simply runs. */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    /* cache miss by failure */
  }
  const value = await loader();
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* non-fatal */
  }
  return value;
}

export async function invalidate(...patterns: string[]): Promise<void> {
  for (const pattern of patterns) {
    try {
      if (!pattern.includes("*")) {
        await redis.del(pattern);
        continue;
      }
      // SCAN rather than KEYS: never block the server on a large keyspace.
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== "0");
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Claim a one-shot key. Returns false when the key already existed, which is
 * how the ingress endpoint detects a replayed batch.
 */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const res = await redis.set(key, "1", "EX", ttlSeconds, "NX");
    return res === "OK";
  } catch {
    // Redis down: let the durable ingress_batches table be the guard.
    return true;
  }
}
