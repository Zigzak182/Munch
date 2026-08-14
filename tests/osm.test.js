import test from 'node:test';
import assert from 'node:assert/strict';

import { SEARCH_RADIUS, WIDE_RADIUS, rankPlaces } from '../src/places-shared.js';
import { buildOverpassQuery, findNearbyPlaces, normalizeElement } from '../src/providers/osm.js';

const ORIGIN = { lat: 51.5074, lon: -0.1278 };

test('query includes a cuisine clause, a name clause and the radius', () => {
  const query = buildOverpassQuery(ORIGIN, {
    cuisineTags: ['japanese', 'sushi'],
    nameTerms: ['ramen'],
    radius: 1500,
  });

  assert.match(query, /\[out:json\]/);
  assert.match(query, /"cuisine"~"japanese\|sushi",i/);
  assert.match(query, /"name"~"ramen",i/);
  assert.match(query, /\(around:1500,51\.507400,-0\.127800\)/);
  assert.match(query, /out center \d+;$/);
});

test('the out statement keeps coordinates', () => {
  // Regression: `out center tags` uses the `tags` verbosity, which returns
  // ids and tags but *no* coordinates. Venues mapped as nodes — the majority
  // of them — then arrive without lat/lon and get dropped as unusable.
  const query = buildOverpassQuery(ORIGIN, { cuisineTags: ['japanese'], radius: 1500 });

  assert.doesNotMatch(query, /out[^;]*\btags\b/);
  assert.match(query, /\bout center\b/);
});

test('a node carrying only tags and no position is unusable', () => {
  // What the `tags` verbosity actually returned, and why nothing showed up.
  assert.equal(normalizeElement({
    type: 'node',
    id: 1,
    tags: { name: 'Ramen Bar', amenity: 'restaurant', cuisine: 'japanese' },
  }), null);
});

test('query falls back to any eatery when no terms are supplied', () => {
  const query = buildOverpassQuery(ORIGIN, { radius: 900 });
  assert.doesNotMatch(query, /cuisine/);
  assert.match(query, /amenity/);
});

test('regex metacharacters in terms cannot break out of the query', () => {
  const query = buildOverpassQuery(ORIGIN, { nameTerms: ['b.b(q)'], radius: 500 });
  assert.match(query, /b\\\.b\\\(q\\\)/);
});

test('normalizeElement flattens tags and resolves way centres', () => {
  const place = normalizeElement({
    type: 'way',
    id: 42,
    center: { lat: 51.51, lon: -0.13 },
    tags: {
      name: 'Ramen Bar',
      amenity: 'restaurant',
      cuisine: 'ramen;japanese',
      'addr:housenumber': '12',
      'addr:street': 'Old Street',
      'addr:city': 'London',
      opening_hours: 'Mo-Su 11:00-22:00',
      'contact:website': 'https://example.com',
      takeaway: 'yes',
    },
  });

  assert.equal(place.id, 'way/42');
  assert.equal(place.name, 'Ramen Bar');
  assert.equal(place.lat, 51.51);
  assert.equal(place.address, '12 Old Street, London');
  assert.equal(place.website, 'https://example.com');
  assert.deepEqual(place.types, ['ramen', 'japanese']);
  assert.equal(place.hoursText, 'Mo-Su 11:00-22:00');
  assert.equal(place.source, 'osm');
  assert.equal(place.takeaway, true);
  assert.equal(place.vegetarian, false);
});

test('normalizeElement drops unnamed or unpositioned elements', () => {
  assert.equal(normalizeElement({ type: 'node', id: 1, tags: { amenity: 'cafe' } }), null);
  assert.equal(normalizeElement({ type: 'node', id: 2, lat: 51.5, lon: -0.1, tags: {} }), null);
});

test('ranking puts cuisine matches first, then name hints, then distance', () => {
  const places = [
    { id: 'a', name: 'Far Sushi Co', lat: 51.5164, lon: -0.1278, types: ['sushi'] },
    { id: 'b', name: 'Corner Cafe', lat: 51.5075, lon: -0.1278, types: ['coffee_shop'] },
    { id: 'c', name: 'Ramen Spot', lat: 51.5095, lon: -0.1278, types: [] },
    { id: 'd', name: 'Near Izakaya', lat: 51.5084, lon: -0.1278, types: ['japanese', 'bar'] },
  ];

  const ranked = rankPlaces(places, ORIGIN, {
    matchTypes: ['japanese', 'sushi'],
    nameTerms: ['ramen'],
  });

  assert.deepEqual(ranked.map((place) => place.id), ['d', 'a', 'c', 'b']);
  assert.equal(ranked[0].tier, 0);
  assert.equal(ranked[2].tier, 1);
  assert.equal(ranked[3].tier, 2);
  assert.ok(ranked[0].distance < ranked[1].distance);
});

test('cuisine matching is exact per tag, not a substring', () => {
  const places = [
    { id: 'a', name: 'Pan Asian', lat: 51.5075, lon: -0.1278, types: ['asian'] },
  ];
  const [ranked] = rankPlaces(places, ORIGIN, { matchTypes: ['japanese'], nameTerms: [] });
  assert.equal(ranked.cuisineMatch, false);
  assert.equal(ranked.tier, 2);
});

test('one pass is enough when the first radius finds something', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(decodeURIComponent(String(options.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        elements: [{
          type: 'node',
          id: 1,
          lat: 51.5075,
          lon: -0.1278,
          tags: { name: 'Ramen Bar', amenity: 'restaurant', cuisine: 'japanese' },
        }],
      }),
    };
  };

  try {
    const { places, radius } = await findNearbyPlaces(ORIGIN, { cuisineTags: ['japanese'] });
    assert.equal(calls.length, 1, `made ${calls.length} requests`);
    assert.equal(radius, SEARCH_RADIUS);
    assert.equal(places.length, 1);
    assert.equal(places[0].name, 'Ramen Bar');
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty first pass widens exactly once', async () => {
  const radii = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    radii.push(Number(/around:(\d+)/.exec(decodeURIComponent(String(options.body)))[1]));
    return { ok: true, status: 200, json: async () => ({ elements: [] }) };
  };

  try {
    const { places } = await findNearbyPlaces(ORIGIN, { cuisineTags: ['japanese'] });
    assert.deepEqual(radii, [SEARCH_RADIUS, WIDE_RADIUS]);
    assert.equal(places.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failing mirror falls through to the next one', async () => {
  const tried = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    tried.push(String(url));
    if (tried.length === 1) throw Object.assign(new Error('boom'), { name: 'TypeError' });
    return { ok: true, status: 200, json: async () => ({ elements: [] }) };
  };

  try {
    await findNearbyPlaces(ORIGIN, { cuisineTags: ['japanese'] });
    assert.ok(tried.length >= 2, 'never tried a second mirror');
    assert.notEqual(tried[0], tried[1]);
  } finally {
    globalThis.fetch = original;
  }
});
