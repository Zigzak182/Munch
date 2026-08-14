/**
 * Google Maps wrapper.
 *
 * The rest of the app never touches `google.maps` directly, and every export
 * is safe to call when the SDK is unavailable — without a configured key the
 * map simply never appears and the list carries the results.
 */

import { hasGoogle, mapId } from './config.js';
import { loadGoogle } from './google.js';

let map = null;
let mapsApi = null;
let infoWindow = null;
let AdvancedMarkerElement = null;
let renderPopup = null;
const entriesById = new Map();
let markers = [];

/** True when a map could be shown at all. */
export const isAvailable = () => hasGoogle();

/**
 * Create the map once. Returns null when the SDK cannot be loaded, so callers
 * can fall back to the list without special-casing.
 */
export async function ensureMap(container) {
  if (map) return map;
  if (!hasGoogle()) return null;

  mapsApi = await loadGoogle();
  const [{ Map, InfoWindow }, marker] = await Promise.all([
    mapsApi.importLibrary('maps'),
    mapsApi.importLibrary('marker'),
  ]);

  AdvancedMarkerElement = marker.AdvancedMarkerElement;
  map = new Map(container, {
    center: { lat: 0, lng: 0 },
    zoom: 15,
    mapId: mapId(),
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
  });
  infoWindow = new InfoWindow();

  return map;
}

/** A small coloured dot, matching the pin styling the app used before. */
function pin(className) {
  const element = document.createElement('div');
  element.className = `pin ${className}`;
  return element;
}

function clearMarkers() {
  markers.forEach((marker) => { marker.map = null; });
  markers = [];
  entriesById.clear();
}

/** Open a venue's popup. Shared by marker clicks and `focusPlace`. */
function openPopup(marker, place) {
  infoWindow.setContent(renderPopup ? renderPopup(place) : place.name);
  infoWindow.open({ map, anchor: marker });
}

/**
 * Draw the "you are here" dot plus one pin per venue, and fit the viewport to
 * everything on screen.
 *
 * @param {{lat:number, lon:number}} origin
 * @param {object[]} places ranked venues
 * @param {(place: object) => string} popupHtml renderer for a marker popup
 */
export async function renderPlaces(origin, places, popupHtml) {
  if (!map || !AdvancedMarkerElement) return;

  renderPopup = popupHtml;
  clearMarkers();

  const here = new AdvancedMarkerElement({
    map,
    position: { lat: origin.lat, lng: origin.lon },
    content: pin('pin--here'),
    title: 'You are here',
  });
  markers.push(here);

  places.forEach((place) => {
    const marker = new AdvancedMarkerElement({
      map,
      position: { lat: place.lat, lng: place.lon },
      content: pin(place.tier === 0 ? 'pin--match' : 'pin--near'),
      title: place.name,
    });
    marker.addListener('click', () => openPopup(marker, place));
    markers.push(marker);
    entriesById.set(place.id, { marker, place });
  });

  const bounds = new mapsApi.LatLngBounds();
  bounds.extend({ lat: origin.lat, lng: origin.lon });
  places.forEach((place) => bounds.extend({ lat: place.lat, lng: place.lon }));

  if (places.length > 0) {
    map.fitBounds(bounds, 48);
  } else {
    map.setCenter({ lat: origin.lat, lng: origin.lon });
    map.setZoom(15);
  }
}

/** Centre on one venue and open its popup — used when a list row is clicked. */
export function focusPlace(id) {
  const entry = entriesById.get(id);
  if (!map || !entry) return;
  map.panTo(entry.marker.position);
  if (map.getZoom() < 16) map.setZoom(16);
  openPopup(entry.marker, entry.place);
}

/** Google resizes itself; kept so callers do not need to know that. */
export function refresh() {}
