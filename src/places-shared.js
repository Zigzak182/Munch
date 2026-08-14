/**
 * Provider-neutral pieces of the venue search.
 *
 * Both the Google and OpenStreetMap providers normalise into the same place
 * shape and hand it here to be measured and ranked, so the UI never learns
 * which one answered.
 *
 * A normalised place:
 *   { id, name, lat, lon, address, typeLabel, types[], rating, ratingCount,
 *     priceLevel, website, phone, mapsUrl, openNow, hoursText, badges[],
 *     source }
 */

import { distanceMeters } from './geo.js';

/** How far out to look, and how far to stretch when nothing is found. */
export const SEARCH_RADIUS = 5000;
export const WIDE_RADIUS = 15000;

export const MAX_RESULTS = 40;

/** Failure that the UI can present to the user as-is. */
export class PlacesError extends Error {
  constructor(message, { code = 'unknown', cause } = {}) {
    super(message, { cause });
    this.name = 'PlacesError';
    this.code = code;
  }
}

/**
 * Rank venues: exact type matches first, then name hints, then everything
 * else — and within each tier, closest wins.
 *
 * @param {object[]} places normalised places
 * @param {{lat:number, lon:number}} origin
 * @param {{matchTypes?: string[], nameTerms?: string[]}} options
 */
export function rankPlaces(places, origin, { matchTypes = [], nameTerms = [] } = {}) {
  const wanted = new Set(matchTypes.map((type) => type.toLowerCase()));
  const terms = nameTerms.map((term) => term.toLowerCase());

  return places
    .map((place) => {
      const types = (place.types ?? []).map((type) => type.toLowerCase());
      const haystack = `${place.name} ${types.join(' ')}`.toLowerCase();
      const typeMatch = types.some((type) => wanted.has(type));
      const nameMatch = terms.some((term) => haystack.includes(term));

      return {
        ...place,
        distance: distanceMeters(origin, place),
        cuisineMatch: typeMatch,
        nameMatch,
        tier: typeMatch ? 0 : nameMatch ? 1 : 2,
      };
    })
    .sort((a, b) => a.tier - b.tier || a.distance - b.distance)
    .slice(0, MAX_RESULTS);
}
