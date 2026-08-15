/**
 * Geometry and geolocation helpers. Pure functions plus one thin Promise
 * wrapper around the browser Geolocation API.
 */

const EARTH_RADIUS_M = 6371008.8;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two {lat, lon} points. */
export function distanceMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Human-readable distance: metres up to 1 km, then kilometres. */
export function formatDistance(meters, { unit = 'metric' } = {}) {
  if (!Number.isFinite(meters)) return '';

  if (unit === 'imperial') {
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
    return `${(meters / 1609.344).toFixed(1)} mi`;
  }

  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Rough walking time, at a deliberately pessimistic 80 m/min. */
export function walkingMinutes(meters) {
  return Math.max(1, Math.round(meters / 80));
}

/**
 * A latitude/longitude box that comfortably contains `radiusMeters` around
 * `center`. Used to clamp results when a provider ignores the radius.
 */
export function boundingBox(center, radiusMeters) {
  const latDelta = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const lonDelta = latDelta / Math.max(0.01, Math.cos(toRadians(center.lat)));
  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLon: center.lon - lonDelta,
    maxLon: center.lon + lonDelta,
  };
}

/** Error thrown when we cannot establish the user's position. */
export class LocationError extends Error {
  constructor(message, { code = 'unknown' } = {}) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
  }
}

/**
 * Ask the browser where we are.
 *
 * Geolocation only works in a secure context (https, or localhost during
 * development); the resulting failure is surfaced as a `LocationError` with a
 * message the UI can show verbatim.
 *
 * The `timeout` option only covers *acquiring* a fix — browsers do not count
 * time spent waiting on the permission prompt against it, so an ignored or
 * silently blocked prompt means neither callback ever fires. `watchdog` is our
 * own deadline for that case, so the UI is never left waiting forever.
 *
 * @returns {Promise<{lat: number, lon: number, accuracy: number}>}
 */
export function currentPosition({ timeout = 12000, maximumAge = 60000, watchdog = 14000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new LocationError('This browser has no location support.', { code: 'unsupported' }));
      return;
    }

    // Geolocation is gated on a secure context, and browsers report the
    // refusal as PERMISSION_DENIED — the same code as the user tapping
    // "Block". Checking first is the only way to tell those apart, and the
    // difference matters: one is fixed by the site, the other by the user.
    if (typeof globalThis.isSecureContext === 'boolean' && !globalThis.isSecureContext) {
      reject(new LocationError(
        'Location needs a secure connection. This page was loaded over http — '
        + 'open it with https:// instead, or enter a place name below.',
        { code: 'insecure' },
      ));
      return;
    }

    let settled = false;
    const done = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      fn(value);
    };

    const succeed = done((position) => resolve({
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy,
    }));

    const fail = done((error) => {
      const messages = {
        1: 'Location permission was denied. Enter a place name instead.',
        2: 'Your position is unavailable right now. Try a place name.',
        3: 'Locating took too long. Try again or enter a place name.',
      };
      const codes = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };
      reject(new LocationError(
        messages[error.code] ?? 'Could not read your location.',
        { code: codes[error.code] ?? 'unknown' },
      ));
    });

    const watchdogTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LocationError(
        'No answer to the location request — allow location access and tap “Use my location”, or type a place below.',
        { code: 'no-response' },
      ));
    }, watchdog);

    navigator.geolocation.getCurrentPosition(succeed, fail, {
      enableHighAccuracy: true,
      timeout,
      maximumAge,
    });
  });
}
