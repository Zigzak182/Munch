import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocationError, WALKABLE_METERS, boundingBox, currentPosition, distanceMeters,
  drivingMinutes, formatDistance, travelTime, walkingMinutes,
} from '../src/geo.js';

/** Install a fake Geolocation API for one test. */
function stubGeolocation(getCurrentPosition) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { geolocation: { getCurrentPosition } },
    configurable: true,
    writable: true,
  });
}

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

test('driving time is never below a minute', () => {
  assert.equal(drivingMinutes(50), 1);
  assert.equal(drivingMinutes(5000), 10);
});

test('travel switches from walking to driving once a walk stops being plausible', () => {
  // Quoting "~40 min walk" for somewhere 3km away is not help.
  assert.equal(travelTime(400).mode, 'walk');
  assert.equal(travelTime(WALKABLE_METERS).mode, 'walk');
  assert.equal(travelTime(WALKABLE_METERS + 1).mode, 'drive');
  assert.equal(travelTime(9000).mode, 'drive');
});

test('the travel label names the mode it used', () => {
  assert.equal(travelTime(400).label, '~5 min walk');
  assert.equal(travelTime(6000).label, '~12 min drive');
  assert.equal(travelTime(Number.NaN).label, '');
});

test('currentPosition resolves with flattened coordinates', async () => {
  stubGeolocation((success) => success({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8 } }));

  assert.deepEqual(await currentPosition(), { lat: 51.5, lon: -0.12, accuracy: 8 });
});

test('an insecure page is reported as such, not as a denied permission', async () => {
  // Browsers refuse geolocation on http and report PERMISSION_DENIED, so
  // without this check the user is told they blocked something they did not.
  stubGeolocation((success, failure) => failure({ code: 1 }));
  globalThis.isSecureContext = false;

  try {
    await assert.rejects(currentPosition(), (error) => {
      assert.equal(error.code, 'insecure');
      assert.match(error.message, /secure connection/i);
      assert.doesNotMatch(error.message, /denied/i);
      return true;
    });
  } finally {
    delete globalThis.isSecureContext;
  }
});

test('a real denial on a secure page still reads as denied', async () => {
  stubGeolocation((success, failure) => failure({ code: 1 }));
  globalThis.isSecureContext = true;

  try {
    await assert.rejects(currentPosition(), { code: 'denied' });
  } finally {
    delete globalThis.isSecureContext;
  }
});

test('currentPosition maps a denial to a LocationError the UI can show', async () => {
  stubGeolocation((success, failure) => failure({ code: 1 }));

  await assert.rejects(currentPosition(), (error) => {
    assert.ok(error instanceof LocationError);
    assert.equal(error.code, 'denied');
    assert.match(error.message, /permission was denied/i);
    return true;
  });
});

test('a permission prompt that is never answered rejects instead of hanging', async () => {
  // Browsers do not count time spent on the permission prompt against the
  // `timeout` option, so neither callback ever fires here. Without our own
  // watchdog the UI would wait forever.
  stubGeolocation(() => {});

  await assert.rejects(currentPosition({ watchdog: 40 }), (error) => {
    assert.equal(error.code, 'no-response');
    return true;
  });
});

test('a late callback cannot settle the promise twice', async () => {
  let succeed;
  stubGeolocation((success) => { succeed = success; });

  await assert.rejects(currentPosition({ watchdog: 20 }), { code: 'no-response' });

  // Arrives after the watchdog gave up; must not throw.
  assert.doesNotThrow(() => succeed({ coords: { latitude: 1, longitude: 2, accuracy: 3 } }));
});

test('bounding box contains points at the requested radius', () => {
  const box = boundingBox(LONDON, 1000);
  const north = { lat: box.maxLat, lon: LONDON.lon };
  const east = { lat: LONDON.lat, lon: box.maxLon };

  assert.ok(distanceMeters(LONDON, north) >= 999);
  assert.ok(distanceMeters(LONDON, east) >= 999);
  assert.ok(box.minLat < LONDON.lat && box.minLon < LONDON.lon);
});
