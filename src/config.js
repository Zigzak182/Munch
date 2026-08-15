/**
 * Reads the deployment config that `munch.config.js` puts on `window`.
 *
 * Kept behind functions rather than captured at import time so tests (and the
 * setup notice) can react to a key being absent without reloading modules.
 */

const DEMO_MAP_ID = 'DEMO_MAP_ID';

/** Photos on the first few cards only — see `photoLimit`. */
const DEFAULT_PHOTO_LIMIT = 3;

const config = () => (typeof window === 'undefined' ? {} : window.MUNCH_CONFIG ?? {});

/** The Google Maps Platform key, or '' when the app should run without it. */
export function googleApiKey() {
  const key = config().googleMapsApiKey;
  return typeof key === 'string' ? key.trim() : '';
}

/** True when Google should be used for venues and the map. */
export const hasGoogle = () => googleApiKey().length > 0;

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
 * Whether venue cards show a photo.
 *
 * Defaults to on. Photos are a separate billable request per image, so this
 * is the one knob most likely to be turned off on a busy deployment.
 */
export const showPhotos = () => config().showPhotos !== false;

/**
 * How many cards may show a photo, counted down the list as displayed.
 *
 * Photos are billed per image fetched, and a fully scrolled list of twenty is
 * twenty requests — several times the cost of the search itself. Capping the
 * top few keeps the visual hook where it matters, on the results you actually
 * look at, and leaves the tail as text.
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
