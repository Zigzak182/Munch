/**
 * A small TTL cache for billed provider responses.
 *
 * Every Nearby Search and every geocode is a charged request, and the same
 * one repeats more often than it looks: a reload, a shared link opened twice,
 * tapping "Use my location" again after the first prompt was dismissed,
 * flipping to a runner-up cuisine and back. None of those are new information,
 * and none of them should cost anything.
 *
 * Backed by sessionStorage so a reload is a hit, with an in-memory map in
 * front of it — and behind it, for private-mode browsers and for tests, where
 * sessionStorage may not exist at all. Scoped to the tab, so a cached answer
 * cannot outlive the visit by much even if the TTL is generous.
 */

/** Bumped when the cached shape changes, so old entries are ignored. */
const VERSION = 1;
const PREFIX = `munch:v${VERSION}:`;

/**
 * Coordinate precision used in cache keys. Three decimals is about 110 m —
 * close enough that the same search would return the same venues, far enough
 * that GPS jitter on a stationary phone does not miss the cache every time.
 */
const COORD_PRECISION = 3;

const memory = new Map();

let hits = 0;
let misses = 0;

/** sessionStorage, or null where it is unavailable or blocked. */
function store() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Access itself throws in some privacy modes.
    return null;
  }
}

/** Stable string for a value, so key building does not depend on key order. */
function stable(value) {
  if (Array.isArray(value)) return `[${[...value].map(String).sort().join(',')}]`;
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Build a cache key from the things that actually change the answer.
 *
 * The origin is rounded, arrays are sorted, and anything not affecting the
 * response — an AbortSignal, most obviously — is simply not passed in.
 */
export function cacheKey(kind, parts = {}) {
  const entries = Object.keys(parts)
    .sort()
    .map((name) => `${name}=${stable(parts[name])}`);
  return `${PREFIX}${kind}:${entries.join('&')}`;
}

/** Round a coordinate pair for use in a key. */
export function coarse({ lat, lon }) {
  return `${lat.toFixed(COORD_PRECISION)},${lon.toFixed(COORD_PRECISION)}`;
}

/**
 * Read a live entry, or null when missing or expired.
 *
 * An expired entry is deleted on the way past, so a tab left open overnight
 * does not accumulate dead weight.
 */
export function read(key, { ttlMs, now = Date.now() } = {}) {
  let entry = memory.get(key);

  if (!entry) {
    const raw = store()?.getItem(key);
    if (!raw) {
      misses += 1;
      return null;
    }
    try {
      entry = JSON.parse(raw);
    } catch {
      remove(key);
      misses += 1;
      return null;
    }
    memory.set(key, entry);
  }

  if (!entry || typeof entry.at !== 'number' || now - entry.at > ttlMs) {
    remove(key);
    misses += 1;
    return null;
  }

  hits += 1;
  return entry.value;
}

/** Store a value against a key. Failure to persist is never fatal. */
export function write(key, value, { now = Date.now() } = {}) {
  const entry = { at: now, value };
  memory.set(key, entry);

  const storage = store();
  if (!storage) return;

  try {
    storage.setItem(key, JSON.stringify(entry));
  } catch {
    // Out of quota, or a value that will not serialise. Prune our own entries
    // and try once more; if it still fails the memory copy is enough.
    prune(storage);
    try {
      storage.setItem(key, JSON.stringify(entry));
    } catch {
      /* memory-only from here */
    }
  }
}

function remove(key) {
  memory.delete(key);
  try {
    store()?.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/** Drop the oldest half of our entries, leaving other tenants alone. */
function prune(storage) {
  const ours = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      ours.push({ key, at: JSON.parse(storage.getItem(key)).at ?? 0 });
    } catch {
      ours.push({ key, at: 0 });
    }
  }

  ours.sort((a, b) => a.at - b.at);
  for (const { key } of ours.slice(0, Math.ceil(ours.length / 2))) remove(key);
}

/** Forget everything. Used by tests and by the "start over" control. */
export function clear() {
  memory.clear();
  hits = 0;
  misses = 0;

  const storage = store();
  if (!storage) return;

  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  keys.forEach((key) => {
    try {
      storage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  });
}

/** Hit/miss counters — how many billed calls the cache actually avoided. */
export const stats = () => ({ hits, misses });
