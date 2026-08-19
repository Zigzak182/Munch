/**
 * The Munch API provider — venues via our own backend rather than direct.
 *
 * Used when `apiBase` is configured. The difference that matters is not
 * technical but commercial: this path holds no API key, so the key cannot be
 * scraped from the page, and the paywall is enforced by something the browser
 * cannot edit.
 *
 * Note what is *not* sent: venue types. The server derives those from the
 * course and cuisine using the same data module the quiz uses, so a client
 * cannot ask for dessert venues by crafting a request — there is no field for
 * it. That is the whole point.
 */

import { apiBase } from '../config.js';
import { MAX_RESULTS, PlacesError, rankPlaces } from '../places-shared.js';

/** Key for the device id we send so the server can meter per device. */
const DEVICE_KEY = 'munch:device';
const SESSION_KEY = 'munch:session';

/** Rebuild the session this far before it actually expires. */
const REFRESH_MARGIN_SECONDS = 300;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A stable id for this browser.
 *
 * Spoofable by design — it spreads the rate limit across devices and nothing
 * more. Entitlement comes from the store's answer, never from this.
 */
export function deviceId() {
  const store = storage();
  const existing = store?.getItem(DEVICE_KEY);
  if (existing) return existing;

  const id = globalThis.crypto?.randomUUID?.()
    ?? `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    store?.setItem(DEVICE_KEY, id);
  } catch {
    /* private mode: a per-load id still works */
  }
  return id;
}

let sessionPromise = null;

function cachedSession() {
  try {
    const raw = storage()?.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const expiresIn = session.expiresAt - Math.floor(Date.now() / 1000);
    return expiresIn > REFRESH_MARGIN_SECONDS ? session : null;
  } catch {
    return null;
  }
}

async function request(path, { method = 'POST', body, token, signal } = {}) {
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new PlacesError('Could not reach Munch. Check your connection.',
      { code: 'network', cause: error });
  }

  if (response.ok) return response.json();

  const detail = await response.json().catch(() => ({}));

  if (response.status === 402) {
    throw new PlacesError(detail.message ?? 'That is a Munch+ feature.', { code: 'upgrade' });
  }
  if (response.status === 401) {
    throw new PlacesError('Session expired. Try again.', { code: 'session' });
  }
  if (response.status === 429) {
    throw new PlacesError(detail.message ?? 'Too many searches. Try again shortly.',
      { code: 'rate' });
  }
  throw new PlacesError(detail.message ?? 'Munch could not complete that.', { code: 'provider' });
}

/**
 * The current session, starting one if needed.
 *
 * Concurrent callers share one in-flight request rather than each opening a
 * session of their own.
 */
export function session({ purchase } = {}) {
  const cached = !purchase && cachedSession();
  if (cached) return Promise.resolve(cached);

  if (!sessionPromise || purchase) {
    sessionPromise = request('/v1/session', {
      body: { platform: 'web', deviceId: deviceId(), ...purchase },
    }).then((result) => {
      try {
        storage()?.setItem(SESSION_KEY, JSON.stringify(result));
      } catch {
        /* memory-only session is fine */
      }
      return result;
    }).finally(() => {
      sessionPromise = null;
    });
  }

  return sessionPromise;
}

/** What this session may do — the app asks before offering Munch+ features. */
export async function entitlement() {
  const { tier, courses, label } = await session();
  return { tier, courses, label };
}

/**
 * Find venues.
 *
 * The server ranks by distance already, but ranking is repeated here so the
 * shape matches the other providers exactly — including `tier` and `distance`
 * on every place, which the list rendering relies on.
 */
export async function findNearbyPlaces(origin, { course = 'main', cuisine, nameTerms = [], signal } = {}) {
  const { token } = await session();

  const result = await request('/v1/places', {
    body: { lat: origin.lat, lon: origin.lon, course, cuisine, terms: nameTerms },
    token,
    signal,
  });

  const places = (result.places ?? []).slice(0, MAX_RESULTS).map((place) => ({
    ...place,
    // Photos come back as opaque names; the URL is built against our own
    // endpoint so the key stays on the server.
    photoUrl: place.photoName ? photoUrlFor(place.photoName, { token }) : '',
  }));

  return { places: rankPlaces(places, origin, { nameTerms }), radius: result.radius };
}

/**
 * A URL on our own service that redirects to the real image.
 *
 * The token rides in the query string because an `<img>` cannot send an
 * Authorization header. The server answers with `Referrer-Policy: no-referrer`
 * so the URL does not travel onward to Google.
 */
export function photoUrlFor(name, { width = 720, token = '' } = {}) {
  const query = new URLSearchParams({ name, w: String(width) });
  if (token) query.set('t', token);
  return `${apiBase()}/v1/photo?${query}`;
}

/** Resolve a typed place name. */
export async function geocode(query, { signal } = {}) {
  const { token } = await session();
  return request('/v1/geocode', { body: { query }, token, signal });
}
