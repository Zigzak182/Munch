import test from 'node:test';
import assert from 'node:assert/strict';

import { boundingBox, distanceMeters, formatDistance, walkingMinutes } from '../src/geo.js';

const LONDON = { lat: 51.5074, lon: -0.1278 };
const PARIS = { lat: 48.8566, lon: 2.3522 };

test('distance between London and Paris is ~343 km', () => {
  const km = distanceMeters(LONDON, PARIS) / 1000;
  assert.ok(Math.abs(km - 343.5) < 1, `got ${km} km`);
});

test('distance is zero for the same point and symmetric', () => {
  assert.equal(distanceMeters(LONDON, LONDON), 0);
  assert.equal(
    Math.round(distanceMeters(LONDON, PARIS)),
    Math.round(distanceMeters(PARIS, LONDON)),
  );
});

test('short distances are accurate', () => {
  // 0.001° of latitude is ~111 m anywhere on the globe.
  const meters = distanceMeters(LONDON, { lat: LONDON.lat + 0.001, lon: LONDON.lon });
  assert.ok(Math.abs(meters - 111) < 1, `got ${meters} m`);
});

test('formatDistance switches units at a kilometre', () => {
  assert.equal(formatDistance(84), '80 m');
  assert.equal(formatDistance(999), '1000 m');
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(4321), '4.3 km');
  assert.equal(formatDistance(Number.NaN), '');
});

test('formatDistance supports imperial output', () => {
  assert.equal(formatDistance(100, { unit: 'imperial' }), '330 ft');
  assert.equal(formatDistance(3000, { unit: 'imperial' }), '1.9 mi');
});

test('walking time is never below a minute', () => {
  assert.equal(walkingMinutes(10), 1);
  assert.equal(walkingMinutes(800), 10);
});

test('bounding box contains points at the requested radius', () => {
  const box = boundingBox(LONDON, 1000);
  const north = { lat: box.maxLat, lon: LONDON.lon };
  const east = { lat: LONDON.lat, lon: box.maxLon };

  assert.ok(distanceMeters(LONDON, north) >= 999);
  assert.ok(distanceMeters(LONDON, east) >= 999);
  assert.ok(box.minLat < LONDON.lat && box.minLon < LONDON.lon);
});
