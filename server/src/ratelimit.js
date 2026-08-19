/**
 * Per-identity request ceilings.
 *
 * A fixed window rather than a sliding one: it costs a single read and a
 * single write, which matters when the store is eventually consistent and
 * every extra round trip is latency on a user-facing search.
 *
 * The tradeoff is that a burst spanning a window boundary can briefly reach
 * twice the limit, and that concurrent requests can under-count. Both are
 * acceptable here, because this is a cost ceiling rather than a security
 * control — the security boundary is the token signature. Anyone needing
 * exactness should move this to Durable Objects.
 */

/**
 * Count one request against a limit.
 *
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
 */
export async function consume(store, { identity, action, limit, windowSeconds, now = Date.now() }) {
  const seconds = Math.floor(now / 1000);
  const window = Math.floor(seconds / windowSeconds);
  const resetAt = (window + 1) * windowSeconds;
  const key = `rate:${action}:${identity}:${window}`;

  const used = Number(await store.get(key)) || 0;

  if (used >= limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  await store.put(key, used + 1, { ttlSeconds: windowSeconds * 2 });

  return { allowed: true, remaining: Math.max(0, limit - used - 1), resetAt };
}
