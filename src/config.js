/**
 * Reads the deployment config that `munch.config.js` puts on `window`.
 *
 * Kept behind functions rather than captured at import time so tests (and the
 * setup notice) can react to a key being absent without reloading modules.
 */

const DEMO_MAP_ID = 'DEMO_MAP_ID';

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
