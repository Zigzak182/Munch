import test from 'node:test';
import assert from 'node:assert/strict';

import { cacheKey, clear, coarse, read, stats, write } from '../src/cache.js';

/** A minimal sessionStorage, so the persistence path is exercised too. */
function stubStorage({ failOnSet = false } = {}) {
  const map = new Map();
  const storage = {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (failOnSet) throw new DOMException('QuotaExceededError');
      map.set(key, value);
    },
    removeItem: (key) => map.delete(key),
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage, configurable: true, writable: true,
  });
  return { storage, map };
}

function dropStorage() {
  delete globalThis.sessionStorage;
}

test('a key ignores argument order and array order', () => {
  const a = cacheKey('places', { types: ['b', 'a'], origin: '1,2' });
  const b = cacheKey('places', { origin: '1,2', types: ['a', 'b'] });

  assert.equal(a, b);
});

test('different inputs produce different keys', () => {
  const base = { origin: '51.507,-0.128', types: ['bakery'] };

  assert.notEqual(cacheKey('places', base), cacheKey('places', { ...base, types: ['cafe'] }));
  assert.notEqual(cacheKey('places', base), cacheKey('geocode', base));
  assert.notEqual(
    cacheKey('places', base),
    cacheKey('places', { ...base, origin: '51.600,-0.128' }),
  );
});

test('coordinates are rounded so GPS jitter still hits', () => {
  // ~1 m apart: the same search by any reasonable definition.
  assert.equal(
    coarse({ lat: 51.507412, lon: -0.127812 }),
    coarse({ lat: 51.507401, lon: -0.127799 }),
  );
  // ~1 km apart: not the same search.
  assert.notEqual(coarse({ lat: 51.5074, lon: -0.1278 }), coarse({ lat: 51.5174, lon: -0.1278 }));
});

test('a written value reads back, and expires on schedule', () => {
  clear();
  const key = cacheKey('places', { origin: 'x' });

  write(key, { places: [1, 2], radius: 5000 }, { now: 1000 });

  assert.deepEqual(read(key, { ttlMs: 500, now: 1200 }), { places: [1, 2], radius: 5000 });
  assert.equal(read(key, { ttlMs: 500, now: 1600 }), null, 'should have expired');
  // Expiry evicts, so the entry is gone even if the clock rolls back.
  assert.equal(read(key, { ttlMs: 5000, now: 1200 }), null);
});

test('a miss on an unknown key is just null', () => {
  clear();
  assert.equal(read(cacheKey('places', { origin: 'nothing here' }), { ttlMs: 1000 }), null);
});

test('hits and misses are counted, so the saving is measurable', () => {
  clear();
  const key = cacheKey('places', { origin: 'counted' });

  read(key, { ttlMs: 1000 });          // miss
  write(key, { places: [] });
  read(key, { ttlMs: 1000 });          // hit
  read(key, { ttlMs: 1000 });          // hit

  assert.deepEqual(stats(), { hits: 2, misses: 1 });
});

test('a write is persisted, not just held in memory', () => {
  const { map } = stubStorage();
  try {
    clear();
    const key = cacheKey('places', { origin: 'persisted' });
    write(key, { places: ['kept'], radius: 1000 }, { now: 100 });

    assert.equal(map.size, 1);
    assert.deepEqual(JSON.parse(map.get(key)), { at: 100, value: { places: ['kept'], radius: 1000 } });
  } finally {
    dropStorage();
  }
});

test('a reload reads back out of storage with nothing in memory', () => {
  const { map } = stubStorage();
  try {
    clear();
    const key = cacheKey('places', { origin: 'from-storage' });

    // Populated directly, so nothing is in the in-memory map — which is the
    // state a fresh page load starts in.
    map.set(key, JSON.stringify({ at: 100, value: { places: ['kept'], radius: 1000 } }));

    assert.deepEqual(read(key, { ttlMs: 60000, now: 200 }), { places: ['kept'], radius: 1000 });
    // ...and an entry that aged out while the tab was closed is not served.
    assert.equal(read(key, { ttlMs: 10, now: 5000 }), null);
  } finally {
    dropStorage();
  }
});

test('a storage that refuses writes still caches in memory', () => {
  stubStorage({ failOnSet: true });
  try {
    clear();
    const key = cacheKey('places', { origin: 'quota' });

    assert.doesNotThrow(() => write(key, { places: ['memory'] }, { now: 0 }));
    assert.deepEqual(read(key, { ttlMs: 1000, now: 10 }), { places: ['memory'] });
  } finally {
    dropStorage();
  }
});

test('corrupt stored JSON is discarded rather than thrown', () => {
  const { map } = stubStorage();
  try {
    clear();
    const key = cacheKey('places', { origin: 'corrupt' });
    map.set(key, '{not json');

    assert.equal(read(key, { ttlMs: 1000 }), null);
    assert.equal(map.has(key), false, 'the bad entry should have been removed');
  } finally {
    dropStorage();
  }
});

test('clear empties both layers', () => {
  const { map } = stubStorage();
  try {
    const key = cacheKey('places', { origin: 'cleared' });
    write(key, { places: [1] });
    clear();

    assert.equal(map.size, 0);
    assert.equal(read(key, { ttlMs: 60000 }), null);
  } finally {
    dropStorage();
  }
});
