/**
 * Thin wrapper around Leaflet so the rest of the app never touches the global
 * `L`. Leaflet is loaded from a CDN in index.html; if it failed to load, every
 * function here degrades to a no-op and the list view carries the results.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

let map = null;
let markerLayer = null;
const markersById = new Map();

/** True when the Leaflet bundle is present. */
export const isAvailable = () => typeof window !== 'undefined' && typeof window.L !== 'undefined';

/** Create the map once; later calls just return the existing instance. */
export function ensureMap(container) {
  if (!isAvailable() || map) return map;

  map = window.L.map(container, { zoomControl: true, scrollWheelZoom: true });
  window.L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  markerLayer = window.L.layerGroup().addTo(map);
  return map;
}

const icon = (className) => window.L.divIcon({
  className: `pin ${className}`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

/**
 * Draw the "you are here" dot plus one pin per venue, and fit the viewport to
 * everything on screen.
 *
 * @param {{lat:number, lon:number}} origin
 * @param {object[]} places ranked venues, as returned by `findNearbyPlaces`
 * @param {(place: object) => string} popupHtml renderer for a marker popup
 */
export function renderPlaces(origin, places, popupHtml) {
  if (!map || !markerLayer) return;

  markerLayer.clearLayers();
  markersById.clear();

  window.L.circleMarker([origin.lat, origin.lon], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#2f6bff',
    fillOpacity: 1,
  }).addTo(markerLayer).bindPopup('You are here');

  places.forEach((place) => {
    const marker = window.L.marker([place.lat, place.lon], {
      icon: icon(place.tier === 0 ? 'pin--match' : 'pin--near'),
      title: place.name,
      alt: place.name,
    });
    marker.bindPopup(popupHtml ? popupHtml(place) : escapeHtml(place.name));
    marker.addTo(markerLayer);
    markersById.set(place.id, marker);
  });

  const points = [[origin.lat, origin.lon], ...places.map((place) => [place.lat, place.lon])];
  if (points.length > 1) {
    map.fitBounds(window.L.latLngBounds(points).pad(0.15), { maxZoom: 16 });
  } else {
    map.setView([origin.lat, origin.lon], 15);
  }
}

/** Centre on one venue and open its popup — used when a list row is clicked. */
export function focusPlace(id) {
  const marker = markersById.get(id);
  if (!map || !marker) return;
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
  marker.openPopup();
}

/** Leaflet mis-measures a container that was hidden when created. */
export function refresh() {
  if (map) map.invalidateSize();
}
