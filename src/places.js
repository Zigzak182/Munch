/**
 * Nearby-venue lookup, backed by OpenStreetMap.
 *
 * Overpass supplies the venues and Nominatim resolves typed-in place names.
 * Both are keyless public services, which is why they were chosen — the app
 * runs with no signup and no secrets — but they are also rate limited, so we
 * query once per search, ask for a bounded result set, and widen the radius
 * only when the first pass comes back thin.
 */

import { boundingBox, distanceMeters } from './geo.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Venue types worth sending a hungry person to. */
const AMENITIES = ['restaurant', 'fast_food', 'cafe', 'bar', 'pub'];

/** Radii tried in order until we have enough results (metres). */
export const SEARCH_RADII = [1500, 4000, 10000];

const MIN_RESULTS = 6;
const MAX_RESULTS = 40;

/** Failure that the UI can present to the user as-is. */
export class PlacesError extends Error {
  constructor(message, { code = 'unknown', cause } = {}) {
    super(message, { cause });
    this.name = 'PlacesError';
    this.code = code;
  }
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the Overpass QL query.
 *
 * Two passes are unioned: venues whose `cuisine` tag matches the chosen
 * cuisine, and venues whose *name* hints at the dish (a taqueria rarely tags
 * itself). `out center` collapses ways and relations to a single coordinate.
 */
export function buildOverpassQuery({ lat, lon }, { cuisineTags = [], nameTerms = [], radius }) {
  const amenity = `^(${AMENITIES.join('|')})$`;
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const clauses = [];

  if (cuisineTags.length > 0) {
    const pattern = cuisineTags.map(escapeRegex).join('|');
    clauses.push(`nwr["amenity"~"${amenity}"]["cuisine"~"${pattern}",i]${around};`);
  }

  if (nameTerms.length > 0) {
    const pattern = nameTerms.map(escapeRegex).join('|');
    clauses.push(`nwr["amenity"~"${amenity}"]["name"~"${pattern}",i]${around};`);
  }

  if (clauses.length === 0) {
    clauses.push(`nwr["amenity"~"${amenity}"]${around};`);
  }

  return `[out:json][timeout:25];(\n  ${clauses.join('\n  ')}\n);out center tags ${MAX_RESULTS * 3};`;
}

/** Reduce a raw Overpass element to the fields the UI needs. */
export function normalizeElement(element) {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!tags.name) return null;

  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const address = [street, tags['addr:city']].filter(Boolean).join(', ');

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name,
    lat,
    lon,
    amenity: tags.amenity ?? '',
    cuisine: tags.cuisine ?? '',
    address,
    openingHours: tags.opening_hours ?? '',
    website: tags.website ?? tags['contact:website'] ?? '',
    phone: tags.phone ?? tags['contact:phone'] ?? '',
    takeaway: tags.takeaway === 'yes',
    outdoorSeating: tags.outdoor_seating === 'yes',
    vegetarian: tags['diet:vegetarian'] === 'yes' || tags['diet:vegan'] === 'yes',
  };
}

const splitCuisine = (value) => value.toLowerCase().split(/[;,]/).map((part) => part.trim());

/**
 * Rank venues: exact cuisine-tag matches first, then name hints, then
 * everything else — and within each tier, closest wins.
 */
export function rankPlaces(places, origin, { cuisineTags = [], nameTerms = [] } = {}) {
  const cuisineSet = new Set(cuisineTags.map((tag) => tag.toLowerCase()));
  const terms = nameTerms.map((term) => term.toLowerCase());

  return places
    .map((place) => {
      const parts = splitCuisine(place.cuisine);
      const haystack = `${place.name} ${place.cuisine}`.toLowerCase();
      const cuisineMatch = parts.some((part) => cuisineSet.has(part));
      const nameMatch = terms.some((term) => haystack.includes(term));

      return {
        ...place,
        distance: distanceMeters(origin, place),
        cuisineMatch,
        nameMatch,
        tier: cuisineMatch ? 0 : nameMatch ? 1 : 2,
      };
    })
    .sort((a, b) => a.tier - b.tier || a.distance - b.distance)
    .slice(0, MAX_RESULTS);
}

async function postOverpass(query, { signal }) {
  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal,
      });

      if (response.status === 429 || response.status === 504) {
        lastError = new PlacesError('The map service is busy. Try again in a moment.', { code: 'busy' });
        continue;
      }
      if (!response.ok) {
        lastError = new PlacesError(`Map service returned ${response.status}.`, { code: 'http' });
        continue;
      }

      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = new PlacesError('Could not reach the map service.', { code: 'network', cause: error });
    }
  }

  throw lastError ?? new PlacesError('Could not reach the map service.', { code: 'network' });
}

/**
 * Find venues near `origin` matching the diagnosis.
 *
 * Widens the search radius until at least `MIN_RESULTS` venues are found or
 * the radii are exhausted, then returns whatever the widest pass produced.
 *
 * @returns {Promise<{places: object[], radius: number}>}
 */
export async function findNearbyPlaces(origin, { cuisineTags = [], nameTerms = [], signal } = {}) {
  let best = { places: [], radius: SEARCH_RADII[0] };

  for (const radius of SEARCH_RADII) {
    const query = buildOverpassQuery(origin, { cuisineTags, nameTerms, radius });
    const data = await postOverpass(query, { signal });

    const box = boundingBox(origin, radius * 1.1);
    const normalized = (data.elements ?? [])
      .map(normalizeElement)
      .filter((place) => place
        && place.lat >= box.minLat && place.lat <= box.maxLat
        && place.lon >= box.minLon && place.lon <= box.maxLon);

    const unique = [...new Map(normalized.map((place) => [place.id, place])).values()];
    const ranked = rankPlaces(unique, origin, { cuisineTags, nameTerms });

    best = { places: ranked, radius };
    if (ranked.length >= MIN_RESULTS) break;
  }

  return best;
}

/**
 * Resolve a typed place name to coordinates, for when GPS is denied or the
 * user wants to plan for somewhere they are not standing.
 */
export async function geocode(query, { signal } = {}) {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new PlacesError('Could not reach the search service.', { code: 'network', cause: error });
  }

  if (!response.ok) {
    throw new PlacesError('Place search is unavailable right now.', { code: 'http' });
  }

  const [match] = await response.json();
  if (!match) {
    throw new PlacesError(`No place found for “${query}”.`, { code: 'not-found' });
  }

  return {
    lat: Number(match.lat),
    lon: Number(match.lon),
    label: match.display_name,
  };
}
