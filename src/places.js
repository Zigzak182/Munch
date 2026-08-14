/**
 * Venue lookup: picks a provider and gets out of the way.
 *
 * Google Places is used whenever an API key is configured — better coverage,
 * ratings, and one fast request. Without a key the app falls back to
 * OpenStreetMap so it still works for anyone who loads it, at the cost of
 * patchier data and no map.
 */

import { hasGoogle } from './config.js';
import * as google from './providers/google.js';
import * as osm from './providers/osm.js';

export { MAX_RESULTS, PlacesError, SEARCH_RADIUS, WIDE_RADIUS, rankPlaces } from './places-shared.js';

/** Which provider is answering — surfaced in the UI's attribution line. */
export const activeProvider = () => (hasGoogle() ? 'google' : 'osm');

/**
 * Find venues near `origin` for a cuisine.
 *
 * Callers pass both sets of type hints; the provider uses whichever it
 * understands, so neither side needs to know which one is live.
 *
 * @param {{lat:number, lon:number}} origin
 * @param {{googleTypes?: string[], cuisineTags?: string[], nameTerms?: string[], signal?: AbortSignal}} options
 * @returns {Promise<{places: object[], radius: number}>}
 */
export function findNearbyPlaces(origin, options = {}) {
  return hasGoogle()
    ? google.findNearbyPlaces(origin, options)
    : osm.findNearbyPlaces(origin, options);
}

/** Resolve a typed place name to coordinates. */
export function geocode(query, options = {}) {
  return hasGoogle() ? google.geocode(query, options) : osm.geocode(query, options);
}
