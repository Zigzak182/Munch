/**
 * Google Places provider — the primary venue source.
 *
 * Uses the Places `Place.searchNearby` from the Maps JavaScript API rather
 * than the REST endpoints: the browser is the supported client, so there is
 * no CORS negotiation and no key travelling in a request header.
 */

import { loadGoogle } from '../google.js';
import { MAX_RESULTS, PlacesError, SEARCH_RADIUS, WIDE_RADIUS, rankPlaces } from '../places-shared.js';

/**
 * Fields requested for each place.
 *
 * Ordered by billing tier: everything up to `types` is Pro, and the rest
 * (ratings, price, hours, contact) moves the call into the Enterprise SKU.
 * Trim from the bottom to lower the per-search cost.
 */
const FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'primaryTypeDisplayName',
  'types',
  'googleMapsURI',
  'rating',
  'userRatingCount',
  'priceLevel',
  'regularOpeningHours',
  'websiteURI',
  'nationalPhoneNumber',
];

/** Nearby Search returns at most 20 per call. */
const PAGE_LIMIT = 20;

/** Fallback when a cuisine has no specific Google type. */
const GENERIC_TYPES = ['restaurant'];

const priceLevels = {
  PRICE_LEVEL_FREE: '',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

/** Map the SDK's price enum onto something printable. */
export function formatPriceLevel(level) {
  if (typeof level !== 'string') return '';
  return priceLevels[level] ?? '';
}

/**
 * Turn a Place from the SDK into our normalised shape.
 *
 * Written against plain properties so it can be exercised with fixtures — the
 * only SDK-specific part is `location`, which is a `LatLng` whose coordinates
 * come from methods.
 */
export function normalizePlace(place) {
  const lat = typeof place.location?.lat === 'function' ? place.location.lat() : place.location?.lat;
  const lng = typeof place.location?.lng === 'function' ? place.location.lng() : place.location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const name = place.displayName ?? '';
  if (!name) return null;

  const types = place.types ?? [];
  const hours = place.regularOpeningHours;
  const today = Array.isArray(hours?.weekdayDescriptions)
    // weekdayDescriptions starts on Monday; JS getDay() starts on Sunday.
    ? hours.weekdayDescriptions[(new Date().getDay() + 6) % 7] ?? ''
    : '';

  return {
    id: place.id,
    name,
    lat,
    lon: lng,
    address: place.formattedAddress ?? '',
    typeLabel: place.primaryTypeDisplayName ?? types[0]?.replace(/_/g, ' ') ?? '',
    types,
    rating: typeof place.rating === 'number' ? place.rating : null,
    ratingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    priceLevel: formatPriceLevel(place.priceLevel),
    website: place.websiteURI ?? '',
    phone: place.nationalPhoneNumber ?? '',
    mapsUrl: place.googleMapsURI ?? '',
    openNow: typeof hours?.openNow === 'boolean' ? hours.openNow : null,
    // Strip the leading weekday, which the card already implies.
    hoursText: today.replace(/^[A-Za-z]+:\s*/, ''),
    takeaway: false,
    outdoorSeating: false,
    vegetarian: types.includes('vegetarian_restaurant') || types.includes('vegan_restaurant'),
    source: 'google',
  };
}

/**
 * Find venues near `origin`.
 *
 * `includedPrimaryTypes` does the cuisine filtering server-side, which is why
 * this needs only one request where Overpass needed regex matching on names.
 *
 * @returns {Promise<{places: object[], radius: number}>}
 */
export async function findNearbyPlaces(origin, { googleTypes = [], nameTerms = [], signal } = {}) {
  const maps = await loadGoogle();
  const { Place, SearchNearbyRankPreference } = await maps.importLibrary('places');

  const includedPrimaryTypes = googleTypes.length > 0 ? googleTypes : GENERIC_TYPES;
  let best = { places: [], radius: SEARCH_RADIUS };

  for (const radius of [SEARCH_RADIUS, WIDE_RADIUS]) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let response;
    try {
      response = await Place.searchNearby({
        fields: FIELDS,
        locationRestriction: { center: { lat: origin.lat, lng: origin.lon }, radius },
        includedPrimaryTypes,
        maxResultCount: Math.min(PAGE_LIMIT, MAX_RESULTS),
        rankPreference: SearchNearbyRankPreference.DISTANCE,
      });
    } catch (error) {
      throw new PlacesError(
        'Google could not complete the search. Check the API key restrictions and that Places API (New) is enabled.',
        { code: 'provider', cause: error },
      );
    }

    const normalized = (response.places ?? []).map(normalizePlace).filter(Boolean);
    best = {
      places: rankPlaces(normalized, origin, { matchTypes: includedPrimaryTypes, nameTerms }),
      radius,
    };
    if (best.places.length > 0) break;
  }

  return best;
}

/** Resolve a typed place name to coordinates. */
export async function geocode(query) {
  const maps = await loadGoogle();
  const { Geocoder } = await maps.importLibrary('geocoding');

  let response;
  try {
    response = await new Geocoder().geocode({ address: query });
  } catch (error) {
    throw new PlacesError(`No place found for “${query}”.`, { code: 'not-found', cause: error });
  }

  const [match] = response.results ?? [];
  if (!match) throw new PlacesError(`No place found for “${query}”.`, { code: 'not-found' });

  return {
    lat: match.geometry.location.lat(),
    lon: match.geometry.location.lng(),
    label: match.formatted_address,
  };
}
