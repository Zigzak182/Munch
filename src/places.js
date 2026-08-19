/**
 * Venue lookup: picks a provider, caches what it costs to ask, and gets out
 * of the way.
 *
 * Google Places is used whenever an API key is configured — better coverage,
 * ratings, and one fast request. Without a key, or with `provider: 'osm'`, the
 * app falls back to OpenStreetMap so it still works for anyone who loads it,
 * at the cost of patchier data and no map.
 *
 * Both provider calls are billed, so both go through the cache. See cache.js
 * for why that matters more than it looks.
 */

import { cacheMinutes, hasGoogle, providerPreference } from './config.js';
import { cacheKey, coarse, read, write } from './cache.js';
import * as google from './providers/google.js';
import * as osm from './providers/osm.js';

export { MAX_RESULTS, PlacesError, SEARCH_RADIUS, WIDE_RADIUS, rankPlaces } from './places-shared.js';
export { clear as clearCache, stats as cacheStats } from './cache.js';

/**
 * Which provider is answering — surfaced in the UI's attribution line.
 *
 * `osm` is honoured even when a key exists (that is the point of the switch);
 * `google` still needs a key, and falls back rather than failing every search.
 */
export function activeProvider() {
  if (providerPreference() === 'osm' || !hasGoogle()) return 'osm';
  return 'google';
}

const providerFor = () => (activeProvider() === 'google' ? google : osm);

const ttlMs = () => cacheMinutes() * 60 * 1000;

/**
 * Find venues near `origin` for a cuisine.
 *
 * Callers pass both sets of type hints; the provider uses whichever it
 * understands, so neither side needs to know which one is live.
 *
 * @param {{lat:number, lon:number}} origin
 * @param {{googleTypes?: string[], cuisineTags?: string[], nameTerms?: string[],
 *          amenities?: string[], shops?: string[], signal?: AbortSignal}} options
 * @returns {Promise<{places: object[], radius: number}>}
 */
export async function findNearbyPlaces(origin, options = {}) {
  const { googleTypes, cuisineTags, nameTerms, amenities, shops } = options;
  const ttl = ttlMs();

  // Note what is *absent* from the key: the AbortSignal, which changes on
  // every call and has no bearing on the answer.
  const key = cacheKey('places', {
    provider: activeProvider(),
    origin: coarse(origin),
    googleTypes,
    cuisineTags,
    nameTerms,
    amenities,
    shops,
  });

  if (ttl > 0) {
    const cached = read(key, { ttlMs: ttl });
    if (cached) return cached;
  }

  const result = await providerFor().findNearbyPlaces(origin, options);

  // An empty result is not worth remembering. It is usually a thin area or a
  // transient provider hiccup, and holding "nothing here" for half an hour
  // makes a retry pointless — which is exactly what someone will try next.
  if (ttl > 0 && result.places.length > 0) write(key, result);

  return result;
}

/** Resolve a typed place name to coordinates. Also billed, also cached. */
export async function geocode(query, options = {}) {
  const ttl = ttlMs();
  const key = cacheKey('geocode', {
    provider: activeProvider(),
    query: String(query ?? '').trim().toLowerCase(),
  });

  if (ttl > 0) {
    const cached = read(key, { ttlMs: ttl });
    if (cached) return cached;
  }

  const result = await providerFor().geocode(query, options);
  if (ttl > 0 && result) write(key, result);

  return result;
}
