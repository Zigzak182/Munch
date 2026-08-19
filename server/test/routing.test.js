import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { issueToken } from '../src/token.js';
import { resetMemoryStore } from '../src/store.js';

const ORIGIN = 'https://www.what2food.com';
const SECRET = 'test-secret-long-enough-for-hmac';

const ENV = {
  GOOGLE_PLACES_KEY: 'server-side-key',
  TOKEN_SECRET: SECRET,
  ALLOWED_ORIGINS: `${ORIGIN},https://what2food.com`,
};

/** One Google place, in the REST shape (not the SDK's). */
const GOOGLE_PLACE = {
  id: 'p1',
  displayName: { text: 'Tonkatsu Ya' },
  formattedAddress: '12 Old St',
  location: { latitude: 51.5083, longitude: -0.1278 },
  types: ['japanese_restaurant'],
  primaryTypeDisplayName: { text: 'Japanese restaurant' },
  googleMapsUri: 'https://maps.google.com/?q=tonkatsu',
  rating: 4.6,
  userRatingCount: 1284,
  regularOpeningHours: { openNow: true },
  photos: [{ name: 'places/p1/photos/abc', authorAttributions: [{ displayName: 'A. Diner', uri: '#' }] }],
};

/** Records what reached Google, and answers for it. */
function stubGoogle({ places = [GOOGLE_PLACE] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('places:searchNearby')) {
      return { ok: true, status: 200, json: async () => ({ places }) };
    }
    if (String(url).includes('/media')) {
      return { ok: true, status: 200, json: async () => ({ photoUri: 'https://lh3.googleusercontent.com/x' }) };
    }
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  return calls;
}

const post = (path, body, { token, origin = ORIGIN } = {}) => new Request(
  `https://api.test${path}`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  },
);

const tokenFor = async (tier) => (await issueToken(
  { sub: `device-${tier}`, tier },
  { secret: SECRET, ttlSeconds: 3600 },
)).token;

test.beforeEach(() => resetMemoryStore());

// ---------------------------------------------------------------- sessions

test('a web session is issued, and it is free', async () => {
  stubGoogle();
  const response = await worker.fetch(post('/v1/session', { platform: 'web', deviceId: 'abc' }), ENV);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.tier, 'free');
  assert.deepEqual(body.courses, ['main']);
  assert.ok(body.token);
  assert.ok(body.expiresAt > Math.floor(Date.now() / 1000));
});

test('a session needs a device id', async () => {
  const response = await worker.fetch(post('/v1/session', { platform: 'web' }), ENV);
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------- paywall

test('a free session cannot search desserts', async () => {
  const calls = stubGoogle();
  const response = await worker.fetch(
    post('/v1/places', { lat: 51.5074, lon: -0.1278, cuisine: 'mexican', course: 'dessert' },
      { token: await tokenFor('free') }),
    ENV,
  );
  const body = await response.json();

  assert.equal(response.status, 402);
  assert.equal(body.error, 'upgrade_required');
  // And it cost nothing: the refusal happens before Google is called.
  assert.equal(calls.length, 0);
});

test('a plus session can', async () => {
  stubGoogle();
  const response = await worker.fetch(
    post('/v1/places', { lat: 51.5074, lon: -0.1278, cuisine: 'mexican', course: 'dessert' },
      { token: await tokenFor('plus') }),
    ENV,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).tier, 'plus');
});

test('the client cannot name its own venue types', async () => {
  // The request has no field for types — the server derives them — so asking
  // for bakeries on the main course simply searches restaurants.
  const calls = stubGoogle();
  await worker.fetch(
    post('/v1/places', {
      lat: 51.5074, lon: -0.1278, cuisine: 'mexican', course: 'main',
      types: ['bakery'], includedPrimaryTypes: ['bakery'], googleTypes: ['bakery'],
    }, { token: await tokenFor('free') }),
    ENV,
  );

  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.includedPrimaryTypes, ['mexican_restaurant']);
  assert.ok(!sent.includedPrimaryTypes.includes('bakery'));
});

// ------------------------------------------------------------------ access

test('no token, a forged token and an expired token are all refused', async () => {
  stubGoogle();
  const search = { lat: 51.5074, lon: -0.1278, cuisine: 'mexican', course: 'main' };

  const none = await worker.fetch(post('/v1/places', search), ENV);
  assert.equal(none.status, 401);

  const forged = (await issueToken({ sub: 'd', tier: 'plus' },
    { secret: 'not-the-real-secret', ttlSeconds: 3600 })).token;
  const bad = await worker.fetch(post('/v1/places', search, { token: forged }), ENV);
  assert.equal(bad.status, 401);

  const stale = (await issueToken({ sub: 'd', tier: 'plus' },
    { secret: SECRET, ttlSeconds: 1, now: Date.now() - 60_000 })).token;
  const expired = await worker.fetch(post('/v1/places', search, { token: stale }), ENV);
  assert.equal(expired.status, 401);
});

test('an unknown origin is refused and gets no CORS headers', async () => {
  stubGoogle();
  const response = await worker.fetch(
    post('/v1/session', { platform: 'web', deviceId: 'a' }, { origin: 'https://evil.example' }),
    ENV,
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('an allowed origin gets CORS headers back', async () => {
  stubGoogle();
  const response = await worker.fetch(post('/v1/session', { platform: 'web', deviceId: 'a' }), ENV);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('without configuration the service refuses rather than half-works', async () => {
  const response = await worker.fetch(post('/v1/session', { platform: 'web', deviceId: 'a' }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'not_configured');
});

test('health reports what is missing', async () => {
  const bad = await worker.fetch(new Request('https://api.test/v1/health'), {});
  assert.equal(bad.status, 503);
  assert.deepEqual((await bad.json()).missing,
    ['GOOGLE_PLACES_KEY', 'TOKEN_SECRET', 'ALLOWED_ORIGINS']);

  const good = await worker.fetch(new Request('https://api.test/v1/health'), ENV);
  assert.equal(good.status, 200);
});

// ------------------------------------------------------------------ search

test('a search returns normalised, ranked places and never the key', async () => {
  stubGoogle();
  const response = await worker.fetch(
    post('/v1/places', { lat: 51.5074, lon: -0.1278, cuisine: 'asian', course: 'main', terms: ['katsu'] },
      { token: await tokenFor('free') }),
    ENV,
  );
  const body = await response.json();
  const [place] = body.places;

  assert.equal(place.name, 'Tonkatsu Ya');
  assert.equal(place.rating, 4.6);
  assert.ok(place.distance > 0, 'ranking adds a distance');
  assert.equal(place.photoName, 'places/p1/photos/abc');

  // Nothing in the response may carry the key, in any field.
  assert.ok(!JSON.stringify(body).includes('server-side-key'));
  assert.equal(place.photoUrl, undefined, 'photo URLs would need the key');
});

test('an identical search is served from cache, not billed twice', async () => {
  const calls = stubGoogle();
  const search = { lat: 51.5074, lon: -0.1278, cuisine: 'asian', course: 'main' };

  await worker.fetch(post('/v1/places', search, { token: await tokenFor('free') }), ENV);
  assert.equal(calls.length, 1);

  // A different caller entirely — the cache is shared, not per-session.
  await worker.fetch(post('/v1/places', search, { token: await tokenFor('plus') }), ENV);
  assert.equal(calls.length, 1, 'the second search should not reach Google');
});

test('an empty result is not cached, so a retry still tries', async () => {
  const calls = stubGoogle({ places: [] });
  const search = { lat: 51.5074, lon: -0.1278, cuisine: 'asian', course: 'main' };

  await worker.fetch(post('/v1/places', search, { token: await tokenFor('free') }), ENV);
  const afterFirst = calls.length;

  await worker.fetch(post('/v1/places', search, { token: await tokenFor('free') }), ENV);
  assert.ok(calls.length > afterFirst, 'a retry must reach Google again');
});

test('coordinates and cuisine are validated', async () => {
  stubGoogle();
  const token = await tokenFor('free');
  const bad = [
    { lat: 999, lon: 0, cuisine: 'asian', course: 'main' },
    { lat: 0, lon: 'east', cuisine: 'asian', course: 'main' },
    { lat: 0, lon: 0, cuisine: 'klingon', course: 'main' },
    { lat: 0, lon: 0, cuisine: 'asian', course: 'brunch' },
  ];

  for (const body of bad) {
    const response = await worker.fetch(post('/v1/places', body, { token }), ENV);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

// ------------------------------------------------------------------- photo

test('a photo redirects, and the key stays behind', async () => {
  stubGoogle();
  const token = await tokenFor('free');
  const request = new Request('https://api.test/v1/photo?name=places/p1/photos/abc&w=720', {
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
  });

  const response = await worker.fetch(request, ENV);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://lh3.googleusercontent.com/x');
  assert.ok(!response.headers.get('Location').includes('server-side-key'));
});

test('the photo endpoint is not an open relay', async () => {
  stubGoogle();
  const token = await tokenFor('free');

  for (const name of ['../../secret', 'https://evil.example/x', 'places/p1', '']) {
    const request = new Request(`https://api.test/v1/photo?name=${encodeURIComponent(name)}`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const response = await worker.fetch(request, ENV);
    assert.equal(response.status, 400, `should refuse ${name}`);
  }
});

// -------------------------------------------------------------------- misc

test('rate limits stop a runaway caller', async () => {
  stubGoogle();
  const token = await tokenFor('free');
  let limited = 0;

  // Vary the location so every request is a cache miss and counts.
  for (let index = 0; index < 35; index += 1) {
    const response = await worker.fetch(
      post('/v1/places', { lat: 51 + index / 100, lon: -0.1, cuisine: 'asian', course: 'main' },
        { token }),
      ENV,
    );
    if (response.status === 429) limited += 1;
  }

  assert.ok(limited > 0, 'the free tier should be capped within an hour');
});

test('preflight and unknown routes behave', async () => {
  const preflight = await worker.fetch(new Request('https://api.test/v1/places', {
    method: 'OPTIONS', headers: { Origin: ORIGIN },
  }), ENV);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const missing = await worker.fetch(post('/v1/nope', {}), ENV);
  assert.equal(missing.status, 404);
});

test('a dessert search needs no cuisine, a main-course one does', async () => {
  // Dessert is a course, not a kitchen: it brings its own venue types. Every
  // other course takes them from the cuisine, so a missing one there would
  // quietly search every restaurant in range.
  const calls = stubGoogle();

  const dessert = await worker.fetch(
    post('/v1/places', { lat: 51.5074, lon: -0.1278, course: 'dessert' },
      { token: await tokenFor('plus') }),
    ENV,
  );
  assert.equal(dessert.status, 200);
  assert.ok(JSON.parse(calls[0].init.body).includedPrimaryTypes.includes('bakery'));

  const main = await worker.fetch(
    post('/v1/places', { lat: 51.5074, lon: -0.1278, course: 'main' },
      { token: await tokenFor('plus') }),
    ENV,
  );
  assert.equal(main.status, 400);
  assert.equal((await main.json()).message, 'Unknown cuisine.');
});

test('a free session still cannot reach desserts without a cuisine', async () => {
  // The cuisine being optional must not have opened a way around the gate.
  const calls = stubGoogle();
  const response = await worker.fetch(
    post('/v1/places', { lat: 51.5074, lon: -0.1278, course: 'dessert' },
      { token: await tokenFor('free') }),
    ENV,
  );

  assert.equal(response.status, 402);
  assert.equal(calls.length, 0);
});
