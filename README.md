# Munch

**Hunger diagnostics.** Two questions — how it should *feel* and what it should
*taste* of — then Munch decides the cuisine for you, names the dish you're
actually craving, and maps the closest places that serve it.

```
Crunchy · Soft · Saucy · Crispy      →  what it feels like
Cheesy · Spicy · Savory · Fresh      →  what it tastes of
                                     →  a cuisine, a diagnosis,
                                        and the nearest places
```

Deciding the cuisine is the point: picking it yourself is the step that stalls
people. The results screen still lists the runner-up cuisines underneath, so
the decision is easy to overrule — but you get an answer first.

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

1. **Quiz** — two single-choice screens. Answers are held in memory and
   mirrored into the URL hash (`#saucy/spicy`), so a diagnosis can be
   bookmarked or shared and comes back on reload.
2. **Cuisine** — each cuisine is scored by the sum of its best three dishes
   against the pair. One perfect dish is a lucky guess; three strong ones mean
   the whole kitchen is pointed at what you want. Every one of the sixteen
   pairs resolves to a cuisine, and all four are reachable.
3. **Diagnosis** — dishes within that cuisine are scored on texture and
   flavour, each paying a bonus when the answer matches the dish's *defining*
   trait — the first tag in its list. Gyoza is soft before it is crispy, so a
   craving for crispy reaches tonkatsu first. The top three are shown, with
   the runner-up cuisines offered below as an override.
4. **Reveal** — a short full-screen moment shuffles the cuisines and lands on
   the chosen one. Since the app decides for you, the decision has to be seen
   being made, or it reads as a label that was always there. Tap to skip, and
   it shortens itself under `prefers-reduced-motion`.
5. **Location** — requested automatically once the reveal ends, via the
   browser's Geolocation API; Nominatim handles typed place names.
6. **Venues** — an Overpass query pulls restaurants, fast food, cafés, bars and
   pubs around that point, in two passes: places whose `cuisine` tag matches,
   and places whose *name* hints at the dish (a taqueria rarely tags itself).
   The search starts at 1.5 km and widens to 4 km then 10 km only if it comes
   back thin.
7. **Results** — ranked by match quality first, distance second, and shown as
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
index.html          markup for the three screens and the reveal overlay
assets/styles.css   all styling — dark-first, light mode via prefers-color-scheme
src/data.js         questions, cuisines and the dish catalogue
src/diagnosis.js    scoring and ranking (pure)
src/geo.js          haversine distance, formatting, geolocation wrapper
src/reveal.js       the cuisine reveal overlay
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

Order matters: the first texture and the first flavour are treated as the
dish's defining traits and score a bonus, so list them deliberately.

The test suite checks that every tag is a known id, that all sixteen answer
pairs resolve to a cuisine with all four reachable, and that every
pair-and-cuisine combination still yields at least one dish — so a typo or a
gap in the matrix fails CI rather than showing an empty results screen.
