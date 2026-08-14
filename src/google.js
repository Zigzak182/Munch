/**
 * Loads the Google Maps JavaScript API once, on demand.
 *
 * Going through the JS API rather than the Places REST endpoints means no
 * CORS negotiation and no key in a request header — the browser is the
 * supported client for this SDK, and the same load serves both the map and
 * the venue search.
 */

import { googleApiKey } from './config.js';

const CALLBACK = '__munchMapsReady';
const LIBRARIES = 'places,marker';

let loading = null;

/** Raised for anything that leaves us without a usable Google SDK. */
export class GoogleError extends Error {
  constructor(message, { code = 'unknown' } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
  }
}

/**
 * Translate Google's auth failure into something a user can act on.
 *
 * The SDK reports a rejected key by calling `gm_authFailure` and writing the
 * specifics to the console; there is no error object to inspect, so the
 * message has to cover the three things that actually go wrong: the key is
 * restricted to another site, the APIs are not enabled, or billing is not
 * set up.
 */
const AUTH_FAILURE_MESSAGE = 'Google rejected the API key. Check that it allows this site, '
  + 'that Maps JavaScript, Places (New) and Geocoding are enabled, and that billing is on.';

let authFailed = false;

/** Whether Google has told us the key is not usable. */
export const isAuthFailed = () => authFailed;

/**
 * Load the SDK. Repeat calls share the first promise, so the script tag is
 * only ever added once.
 *
 * @returns {Promise<typeof google.maps>}
 */
export function loadGoogle() {
  if (loading) return loading;

  const key = googleApiKey();
  if (!key) {
    return Promise.reject(new GoogleError('No Google Maps API key is configured.', { code: 'no-key' }));
  }

  loading = new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve(window.google.maps);
      return;
    }

    window.gm_authFailure = () => {
      authFailed = true;
      reject(new GoogleError(AUTH_FAILURE_MESSAGE, { code: 'auth' }));
    };

    window[CALLBACK] = () => {
      delete window[CALLBACK];
      resolve(window.google.maps);
    };

    const script = document.createElement('script');
    const params = new URLSearchParams({
      key,
      libraries: LIBRARIES,
      v: 'weekly',
      loading: 'async',
      callback: CALLBACK,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => reject(new GoogleError(
      'Could not load Google Maps. Check your connection and any content blockers.',
      { code: 'network' },
    ));

    document.head.append(script);
  });

  // A failed load should not poison every later attempt.
  loading.catch(() => { loading = null; });

  return loading;
}
