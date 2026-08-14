/**
 * OpenStreetMap provider — the keyless fallback used when no Google Maps API
 * key is configured.
 *
 * Overpass supplies the venues and Nominatim resolves typed-in place names.
 * Both are free community services, so we query once per search, ask for a
 * bounded result set, and widen only when the first pass finds nothing.
 * Coverage is patchier than Google's and there are no ratings, which is why
 * this is the fallback rather than the default.
 */

import { boundingBox } from '../geo.js';
import {
  MAX_RESULTS, PlacesError, SEARCH_RADIUS, WIDE_RADIUS, rankPlaces,
} from '../places-shared.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Venue types worth sending a hungry person to. */
const AMENITIES = ['restaurant', 'fast_food', 'cafe', 'bar', 'pub'];

/** Give up on a mirror after this long and try the next one. */
const ENDPOINT_TIMEOUT = 12000;

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

  // `out center` keeps the default `body` verbosity, which carries tags *and*
  // coordinates. Do not add `tags` here: that verbosity drops coordinates, and
  // since most venues are mapped as single nodes rather than building
  // outlines, it silently discards nearly every real result.
  return `[out:json][timeout:20];(\n  ${clauses.join('\n  ')}\n);out center ${MAX_RESULTS * 3};`;
}

/** Reduce a raw Overpass element to the shared normalised place shape. */
export function normalizeElement(element) {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!tags.name) return null;

  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const address = [street, tags['addr:city']].filter(Boolean).join(', ');
  const cuisine = tags.cuisine ?? '';
  const types = cuisine
    ? cuisine.toLowerCase().split(/[;,]/).map((part) => part.trim()).filter(Boolean)
    : [];

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name,
    lat,
    lon,
    address,
    typeLabel: cuisine.replace(/[;,]/g, ' · ') || (tags.amenity ?? '').replace(/_/g, ' '),
    types: types.length > 0 ? types : [tags.amenity].filter(Boolean),
    rating: null,
    ratingCount: null,
    priceLevel: '',
    website: tags.website ?? tags['contact:website'] ?? '',
    phone: tags.phone ?? tags['contact:phone'] ?? '',
    mapsUrl: '',
    openNow: null,
    hoursText: tags.opening_hours ?? '',
    takeaway: tags.takeaway === 'yes',
    outdoorSeating: tags.outdoor_seating === 'yes',
    vegetarian: tags['diet:vegetarian'] === 'yes' || tags['diet:vegan'] === 'yes',
    source: 'osm',
  };
}

async function postOverpass(query, { signal }) {
  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    // A mirror under load can sit on a connection for the full server-side
    // timeout. Cap each attempt ourselves so a slow one costs seconds, not a
    // minute, before we move on.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, ENDPOINT_TIMEOUT);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
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
      // Only the caller cancelling ends the whole search; our own deadline
      // just means this mirror was too slow.
      if (signal?.aborted) throw error;
      lastError = error.name === 'AbortError'
        ? new PlacesError('The map service is taking too long.', { code: 'timeout' })
        : new PlacesError('Could not reach the map service.', { code: 'network', cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  throw lastError ?? new PlacesError('Could not reach the map service.', { code: 'network' });
}

/**
 * Find venues near `origin` matching the diagnosis.
 *
 * Normally one request. The wider pass runs only when the first finds nothing
 * at all, which is the rural case rather than the everyday one.
 *
 * @returns {Promise<{places: object[], radius: number}>}
 */
export async function findNearbyPlaces(origin, { cuisineTags = [], nameTerms = [], signal } = {}) {
  let best = { places: [], radius: SEARCH_RADIUS };

  for (const radius of [SEARCH_RADIUS, WIDE_RADIUS]) {
    const query = buildOverpassQuery(origin, { cuisineTags, nameTerms, radius });
    const data = await postOverpass(query, { signal });

    const box = boundingBox(origin, radius * 1.1);
    const normalized = (data.elements ?? [])
      .map(normalizeElement)
      .filter((place) => place
        && place.lat >= box.minLat && place.lat <= box.maxLat
        && place.lon >= box.minLon && place.lon <= box.maxLon);

    const unique = [...new Map(normalized.map((place) => [place.id, place])).values()];
    const ranked = rankPlaces(unique, origin, { matchTypes: cuisineTags, nameTerms });

    best = { places: ranked, radius };
    if (ranked.length > 0) break;
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
