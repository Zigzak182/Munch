/**
 * Reads the deployment config that `munch.config.js` puts on `window`.
 *
 * Kept behind functions rather than captured at import time so tests (and the
 * setup notice) can react to a key being absent without reloading modules.
 */

const DEMO_MAP_ID = 'DEMO_MAP_ID';

/** Photos on the first few cards only — see `photoLimit`. */
const DEFAULT_PHOTO_LIMIT = 3;

/** How long a billed provider response stays reusable. */
const DEFAULT_CACHE_MINUTES = 30;

const FIELD_TIERS = ['essentials', 'pro', 'enterprise'];
const PROVIDERS = ['auto', 'google', 'osm'];

const config = () => (typeof window === 'undefined' ? {} : window.MUNCH_CONFIG ?? {});

/** The Google Maps Platform key, or '' when the app should run without it. */
export function googleApiKey() {
  const key = config().googleMapsApiKey;
  return typeof key === 'string' ? key.trim() : '';
}

/** True when a Google key is configured at all. */
export const hasGoogle = () => googleApiKey().length > 0;

/**
 * Base URL of the Munch API, if one is deployed.
 *
 * When set, venues and geocoding go through it instead of straight to Google,
 * which is what keeps the Places key off the page and makes the Munch+ gate
 * enforceable. Trailing slashes are trimmed so callers can append paths.
 *
 * The Maps *JavaScript* key is separate and still public — a basemap cannot be
 * drawn without one. Restrict that key to the Maps JavaScript API only, and
 * keep the Places key server-side.
 */
export function apiBase() {
  const value = config().apiBase;
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

/** True when the app should talk to its own backend rather than to Google. */
export const hasApi = () => apiBase().length > 0;

/**
 * Which venue provider to use.
 *
 * `auto` (the default) uses Google when a key is present. `osm` forces the
 * keyless OpenStreetMap path even when a key exists, which costs nothing per
 * search — the switch to throw if a deployment needs to run for free.
 *
 * A key is still required for `google`; asking for it without one falls back
 * to OSM rather than failing every search.
 */
export function providerPreference() {
  const value = config().provider;
  return PROVIDERS.includes(value) ? value : 'auto';
}

/**
 * How much place data each search asks for, which is what decides the SKU
 * Google bills the call under.
 *
 * - `enterprise` (default) — ratings, price, opening hours, contact details.
 *   The current experience, and the most expensive tier.
 * - `pro` — drops all of the above. Cards keep name, type, address, distance
 *   and photo; no stars, no open/closed badge, no price.
 * - `essentials` — also drops photos and the Google listing link.
 *
 * Left at `enterprise` so nothing changes without being asked for. Dropping a
 * tier is a real cut in per-search cost and a real cut in what a card can say;
 * that trade is a product decision, not a default.
 */
export function fieldTier() {
  const value = config().fieldTier;
  return FIELD_TIERS.includes(value) ? value : 'enterprise';
}

/**
 * Minutes a cached provider response stays good for. `0` disables caching.
 *
 * Repeat searches are common — reloads, shared links, re-prompting for
 * location — and none of them are new information, so none of them need to be
 * billed twice.
 */
export function cacheMinutes() {
  const value = config().cacheMinutes;
  if (value === undefined || value === null) return DEFAULT_CACHE_MINUTES;

  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_CACHE_MINUTES;
  return minutes;
}

/**
 * Map ID for cloud styling. Advanced markers require *some* map id, so an
 * unconfigured deployment falls back to Google's demo style rather than
 * silently rendering no markers.
 */
export function mapId() {
  const id = config().mapId;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : DEMO_MAP_ID;
}

/**
 * Whether venue cards offer a photo at all.
 *
 * Defaults to on. Photos are a separate billable request per image, so this
 * is the one knob most likely to be turned off on a busy deployment.
 */
export const showPhotos = () => config().showPhotos !== false;

/**
 * How many cards offer a photo, counted down the list as displayed.
 *
 * Photos load on tap rather than automatically, so this is a ceiling on what a
 * results screen could ever cost in images rather than what it does cost —
 * which is nothing until someone asks.
 *
 * `showPhotos: false` wins over any limit; a limit of 0 has the same effect.
 */
export function photoLimit() {
  if (!showPhotos()) return 0;

  const value = config().photoLimit;
  if (value === undefined || value === null) return DEFAULT_PHOTO_LIMIT;

  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 0) return DEFAULT_PHOTO_LIMIT;
  return Math.floor(limit);
}
