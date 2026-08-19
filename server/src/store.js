/**
 * Key/value storage: Cloudflare KV when bound, memory when not.
 *
 * The memory fallback keeps local development and the test suite working
 * without a KV namespace. It is per-instance, so on a real deployment it would
 * mean a cache that rarely hits and counters that reset — fine to develop
 * against, not something to run on.
 */

const memory = new Map();

function memoryGet(key, now) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * @param {object|null} kv a Cloudflare KV namespace, or null
 */
export function createStore(kv) {
  if (kv) {
    return {
      backend: 'kv',
      async get(key) {
        return kv.get(key, 'json');
      },
      async put(key, value, { ttlSeconds }) {
        // KV rejects a TTL under 60s, which is shorter than anything we set,
        // but clamping keeps a small configured value from failing the write.
        await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
      },
    };
  }

  return {
    backend: 'memory',
    async get(key) {
      return memoryGet(key, Date.now());
    },
    async put(key, value, { ttlSeconds }) {
      memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
  };
}

/** Test hook. */
export const resetMemoryStore = () => memory.clear();
