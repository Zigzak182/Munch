/**
 * Google Maps Platform, called server-side over REST.
 *
 * The browser build talks to the Maps JavaScript SDK, which needs the key in
 * the page. Here the key never leaves the worker: the client asks this service
 * for venues, and this service asks Google.
 *
 * Responses are normalised into the same place shape the app already uses, so
 * the client gains a provider without gaining any Google-specific parsing.
 * Note the REST payloads differ from the SDK's — `displayName` is an object,
 * `location` uses latitude/longitude, and the URI fields are spelled
 * differently — which is exactly why this normalisation is separate from the
 * browser provider's.
 */

import { HttpError } from './http.js';

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Field masks by billing tier, cumulative and cheapest first — the same split
 * the browser provider documents. Google prices a search by the most
 * expensive field in it, so this list is the single biggest lever on cost.
 */
const ESSENTIALS = [
  'places.id', 'places.displayName', 'places.formattedAddress',
  'places.location', 'places.types',
];

const PRO = [
  ...ESSENTIALS,
  'places.primaryTypeDisplayName', 'places.googleMapsUri', 'places.photos',
];

const ENTERPRISE = [
  ...PRO,
  'places.rating', 'places.userRatingCount', 'places.priceLevel',
  'places.regularOpeningHours', 'places.websiteUri', 'places.nationalPhoneNumber',
];

export const FIELD_MASKS = { essentials: ESSENTIALS, pro: PRO, enterprise: ENTERPRISE };

export const fieldMaskFor = (tier) => (FIELD_MASKS[tier] ?? ENTERPRISE).join(',');

/** Nearby Search returns at most 20 per call. */
const PAGE_LIMIT = 20;

const PRICE_LEVELS = {
  PRICE_LEVEL_FREE: '',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

/**
 * One REST place into the shared shape.
 *
 * `photoName` rather than a URL: building the media URL needs the key, so the
 * client is handed an opaque name and fetches it back through this service.
 */
export function normalizePlace(place) {
  const latitude = place?.location?.latitude;
  const longitude = place?.location?.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;

  const name = place.displayName?.text ?? '';
  if (!name) return null;

  const types = Array.isArray(place.types) ? place.types : [];
  const photo = Array.isArray(place.photos) ? place.photos[0] : null;
  const author = photo?.authorAttributions?.[0];

  return {
    id: place.id,
    name,
    lat: latitude,
    lon: longitude,
    address: place.formattedAddress ?? '',
    typeLabel: place.primaryTypeDisplayName?.text ?? types[0]?.replace(/_/g, ' ') ?? '',
    types,
    rating: typeof place.rating === 'number' ? place.rating : null,
    ratingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    priceLevel: PRICE_LEVELS[place.priceLevel] ?? '',
    website: place.websiteUri ?? '',
    phone: place.nationalPhoneNumber ?? '',
    mapsUrl: place.googleMapsUri ?? '',
    photoName: photo?.name ?? '',
    photoAttribution: author?.displayName
      ? { name: author.displayName, uri: author.uri ?? '' }
      : null,
    openNow: typeof place.regularOpeningHours?.openNow === 'boolean'
      ? place.regularOpeningHours.openNow
      : null,
    hoursText: '',
    takeaway: false,
    outdoorSeating: false,
    vegetarian: types.includes('vegetarian_restaurant') || types.includes('vegan_restaurant'),
    source: 'google',
  };
}

/**
 * Nearby Search. Returns normalised, *unranked* places.
 *
 * Unranked on purpose: ranking depends on the caller's search terms, while the
 * response depends only on the location and the types. Keeping them apart lets
 * one cached response serve every user in the area whatever they typed.
 */
export async function searchNearby({ lat, lon, radius, types, key, fieldTier = 'enterprise', fetchImpl = fetch }) {
  const response = await fetchImpl(PLACES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': fieldMaskFor(fieldTier),
    },
    body: JSON.stringify({
      includedPrimaryTypes: types,
      maxResultCount: PAGE_LIMIT,
      rankPreference: 'DISTANCE',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // The upstream body can quote the request, and the request carries the
    // key — so it is logged here and never returned to the caller.
    console.error('places search failed', response.status, detail.slice(0, 500));
    throw new HttpError(502, 'upstream', 'The venue search is unavailable right now.');
  }

  const body = await response.json();
  return (body.places ?? []).map(normalizePlace).filter(Boolean);
}

/**
 * Resolve a photo name to a temporary image URL.
 *
 * `skipHttpRedirect` asks Google for the URL as JSON instead of a redirect, so
 * this service can hand back a redirect of its own without streaming the bytes
 * through the worker.
 */
export async function photoUrl({ name, maxWidth = 720, key, fetchImpl = fetch }) {
  const url = new URL(`https://places.googleapis.com/v1/${name}/media`);
  url.searchParams.set('maxWidthPx', String(maxWidth));
  url.searchParams.set('skipHttpRedirect', 'true');
  url.searchParams.set('key', key);

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    console.error('photo fetch failed', response.status);
    throw new HttpError(502, 'upstream', 'That photo is unavailable.');
  }

  const body = await response.json();
  if (!body.photoUri) throw new HttpError(502, 'upstream', 'That photo is unavailable.');
  return body.photoUri;
}

/** Resolve a typed place name to coordinates. */
export async function geocode({ query, key, fetchImpl = fetch }) {
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set('address', query);
  url.searchParams.set('key', key);

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    console.error('geocode failed', response.status);
    throw new HttpError(502, 'upstream', 'Could not look that place up.');
  }

  const body = await response.json();
  const first = body.results?.[0];
  if (!first) return null;

  return {
    lat: first.geometry.location.lat,
    lon: first.geometry.location.lng,
    label: first.formatted_address ?? query,
  };
}
