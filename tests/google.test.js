import test from 'node:test';
import assert from 'node:assert/strict';

import { CUISINES } from '../src/data.js';
import { formatPriceLevel, normalizePlace } from '../src/providers/google.js';
import { rankPlaces } from '../src/places-shared.js';

/** A Place as the Maps JS SDK hands it over: `location` exposes methods. */
const sdkPlace = (overrides = {}) => ({
  id: 'ChIJ123',
  displayName: 'Tonkatsu Ya',
  formattedAddress: '12 Old Street, London',
  location: { lat: () => 51.51, lng: () => -0.13 },
  primaryTypeDisplayName: 'Japanese restaurant',
  types: ['japanese_restaurant', 'restaurant', 'food'],
  googleMapsURI: 'https://maps.google.com/?cid=1',
  rating: 4.6,
  userRatingCount: 1284,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  websiteURI: 'https://example.com',
  nationalPhoneNumber: '020 7946 0000',
  ...overrides,
});

test('every cuisine declares Google Places types', () => {
  for (const cuisine of CUISINES) {
    assert.ok(Array.isArray(cuisine.googleTypes), `${cuisine.id} has no googleTypes`);
    assert.ok(cuisine.googleTypes.length > 0, `${cuisine.id} has an empty googleTypes`);
    cuisine.googleTypes.forEach((type) => {
      assert.match(type, /^[a-z_]+$/, `${cuisine.id} has a malformed type: ${type}`);
    });
  }
});

test('normalizePlace flattens the SDK shape', () => {
  const place = normalizePlace(sdkPlace());

  assert.equal(place.id, 'ChIJ123');
  assert.equal(place.name, 'Tonkatsu Ya');
  assert.equal(place.lat, 51.51);
  assert.equal(place.lon, -0.13);
  assert.equal(place.typeLabel, 'Japanese restaurant');
  assert.equal(place.rating, 4.6);
  assert.equal(place.ratingCount, 1284);
  assert.equal(place.priceLevel, '$$');
  assert.equal(place.website, 'https://example.com');
  assert.equal(place.source, 'google');
});

test('normalizePlace accepts plain numeric coordinates too', () => {
  // The REST shape, and what fixtures tend to look like.
  const place = normalizePlace(sdkPlace({ location: { lat: 1.5, lng: 2.5 } }));
  assert.equal(place.lat, 1.5);
  assert.equal(place.lon, 2.5);
});

test('a place with no usable position or name is dropped', () => {
  assert.equal(normalizePlace(sdkPlace({ location: undefined })), null);
  assert.equal(normalizePlace(sdkPlace({ displayName: '' })), null);
});

test('missing optional fields degrade to nulls rather than throwing', () => {
  const place = normalizePlace({
    id: 'x',
    displayName: 'Bare Minimum',
    location: { lat: () => 1, lng: () => 2 },
  });

  assert.equal(place.rating, null);
  assert.equal(place.ratingCount, null);
  assert.equal(place.priceLevel, '');
  assert.equal(place.openNow, null);
  assert.equal(place.hoursText, '');
  assert.deepEqual(place.types, []);
});

test('open-now is read from opening hours when present', () => {
  const open = normalizePlace(sdkPlace({ regularOpeningHours: { openNow: true } }));
  const shut = normalizePlace(sdkPlace({ regularOpeningHours: { openNow: false } }));

  assert.equal(open.openNow, true);
  assert.equal(shut.openNow, false);
});

test("today's hours drop the weekday prefix the card already implies", () => {
  const place = normalizePlace(sdkPlace({
    regularOpeningHours: {
      weekdayDescriptions: [
        'Monday: 11:00 – 22:00', 'Tuesday: 11:00 – 22:00', 'Wednesday: 11:00 – 22:00',
        'Thursday: 11:00 – 22:00', 'Friday: 11:00 – 23:00', 'Saturday: 12:00 – 23:00',
        'Sunday: Closed',
      ],
    },
  }));

  assert.doesNotMatch(place.hoursText, /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day:/);
  assert.ok(place.hoursText.length > 0);
});

test('price levels map onto printable symbols', () => {
  assert.equal(formatPriceLevel('PRICE_LEVEL_INEXPENSIVE'), '$');
  assert.equal(formatPriceLevel('PRICE_LEVEL_VERY_EXPENSIVE'), '$$$$');
  assert.equal(formatPriceLevel('SOMETHING_NEW'), '');
  assert.equal(formatPriceLevel(undefined), '');
});

test('Google places rank by type match then distance, like OSM ones', () => {
  const origin = { lat: 51.5074, lon: -0.1278 };
  const places = [
    normalizePlace(sdkPlace({ id: 'far', displayName: 'Far Sushi', location: { lat: 51.5164, lng: -0.1278 }, types: ['sushi_restaurant'] })),
    normalizePlace(sdkPlace({ id: 'other', displayName: 'Corner Cafe', location: { lat: 51.5075, lng: -0.1278 }, types: ['cafe'] })),
    normalizePlace(sdkPlace({ id: 'near', displayName: 'Near Ramen', location: { lat: 51.5084, lng: -0.1278 }, types: ['ramen_restaurant'] })),
  ];

  const ranked = rankPlaces(places, origin, {
    matchTypes: ['japanese_restaurant', 'sushi_restaurant', 'ramen_restaurant'],
    nameTerms: ['ramen'],
  });

  assert.deepEqual(ranked.map((place) => place.id), ['near', 'far', 'other']);
  assert.equal(ranked[0].tier, 0);
  assert.equal(ranked[2].tier, 2);
});
