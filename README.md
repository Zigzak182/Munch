# Munch

**Hunger diagnostics.** Three questions — how it should *feel*, what it should
*taste* of, and which *cuisine* you're in the mood for — then Munch names the
dish you're actually craving and maps the closest places that serve it.

```
Crunchy · Soft · Saucy · Crispy      →  what it feels like
Cheesy · Spicy · Savory · Fresh      →  what it tastes of
Japanese · Mexican · Mediterranean · American
                                     →  where we're going
                                     →  a diagnosis + the nearest places
```

## Running it

No build step, no dependencies, no API keys. Any static server works — the app
is plain ES modules, so it does need to be *served* rather than opened as a
`file://` URL:

```bash
npm start          # python3 -m http.server 8080
# then open http://localhost:8080
```

Geolocation requires a secure context, which means `https://` in production or
`localhost` in development. If the browser denies location (or you're planning
ahead for somewhere else), the results screen also takes a typed place name.

```bash
npm test           # node --test — unit tests for the pure modules
```

## How it works

1. **Quiz** — three single-choice screens. Answers are held in memory and
   mirrored into the URL hash (`#saucy/spicy/japanese`), so a diagnosis can be
   bookmarked or shared and comes back on reload.
2. **Diagnosis** — every dish in the catalogue is scored against the answers:
   cuisine is weighted heaviest (it also constrains where we can send you),
   then texture and flavour independently. Ties break toward the more
   specifically tagged dish. The top three are shown.
3. **Location** — the browser's Geolocation API, or Nominatim for a typed
   place name.
4. **Venues** — an Overpass query pulls restaurants, fast food, cafés, bars and
   pubs around that point, in two passes: places whose `cuisine` tag matches,
   and places whose *name* hints at the dish (a taqueria rarely tags itself).
   The search starts at 1.5 km and widens to 4 km then 10 km only if it comes
   back thin.
5. **Results** — ranked by match quality first, distance second, and shown as
   either a map or a sortable list. Every venue links out to directions.

## Data sources

Venue data, geocoding and map tiles all come from
[OpenStreetMap](https://www.openstreetmap.org/copyright) — via Overpass,
Nominatim and the standard tile server. All three are free, keyless community
services, which is why there is nothing to sign up for; it also means results
are only as complete as OSM's coverage in your area, and that heavy use should
be pointed at your own Overpass instance or a commercial provider. Requests go
straight from the browser to those services; there is no backend and your
coordinates are not stored anywhere.

Coverage is genuinely uneven: dense cities are well tagged, and quieter areas
may return little or nothing. When a search comes up empty the app says so
rather than inventing places.

## Layout

```
index.html          markup for the four screens
assets/styles.css   all styling — dark-first, light mode via prefers-color-scheme
src/data.js         questions, cuisines and the dish catalogue
src/diagnosis.js    scoring and ranking (pure)
src/geo.js          haversine distance, formatting, geolocation wrapper
src/places.js       Overpass + Nominatim queries, venue ranking
src/map.js          Leaflet wrapper; degrades to list-only if Leaflet is absent
src/app.js          screen flow and DOM wiring
tests/              node:test unit tests for the pure modules
```

Leaflet is loaded from a CDN with subresource integrity. If it fails to load,
the map is skipped and results fall back to the list view.

## Adding to the catalogue

Dishes live in `src/data.js`. Each one declares every texture and flavour it
honestly satisfies, plus `terms` used to match venue names:

```js
{
  id: 'birria',
  name: 'Birria tacos & consommé',
  cuisine: 'mexican',
  textures: ['saucy', 'crispy'],
  flavors: ['savory', 'spicy'],
  note: 'Fat-fried tortilla, stewed beef, a cup of broth for dunking.',
  terms: ['birria', 'taco', 'mexican'],
}
```

The test suite checks that every tag is a known id and that all 64 answer
combinations still resolve to at least one dish, so a typo or a gap in the
matrix fails the build rather than showing an empty results screen.
