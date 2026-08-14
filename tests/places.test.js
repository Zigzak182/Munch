import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOverpassQuery, normalizeElement, rankPlaces } from '../src/places.js';

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
  assert.match(query, /out center tags \d+;$/);
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
  assert.equal(place.takeaway, true);
  assert.equal(place.vegetarian, false);
});

test('normalizeElement drops unnamed or unpositioned elements', () => {
  assert.equal(normalizeElement({ type: 'node', id: 1, tags: { amenity: 'cafe' } }), null);
  assert.equal(normalizeElement({ type: 'node', id: 2, lat: 51.5, lon: -0.1, tags: {} }), null);
});

test('ranking puts cuisine matches first, then name hints, then distance', () => {
  const places = [
    { id: 'a', name: 'Far Sushi Co', lat: 51.5164, lon: -0.1278, cuisine: 'sushi', amenity: 'restaurant' },
    { id: 'b', name: 'Corner Cafe', lat: 51.5075, lon: -0.1278, cuisine: 'coffee_shop', amenity: 'cafe' },
    { id: 'c', name: 'Ramen Spot', lat: 51.5095, lon: -0.1278, cuisine: '', amenity: 'restaurant' },
    { id: 'd', name: 'Near Izakaya', lat: 51.5084, lon: -0.1278, cuisine: 'japanese;bar', amenity: 'bar' },
  ];

  const ranked = rankPlaces(places, ORIGIN, {
    cuisineTags: ['japanese', 'sushi'],
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
    { id: 'a', name: 'Pan Asian', lat: 51.5075, lon: -0.1278, cuisine: 'asian', amenity: 'restaurant' },
  ];
  const [ranked] = rankPlaces(places, ORIGIN, { cuisineTags: ['japanese'], nameTerms: [] });
  assert.equal(ranked.cuisineMatch, false);
  assert.equal(ranked.tier, 2);
});
