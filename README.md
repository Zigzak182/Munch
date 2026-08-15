# Munch

**Hunger diagnostics.** Two questions — how it should *feel* and what it should
*taste* of — then Munch decides the cuisine for you and maps the closest places
that fit.

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

No build step and no dependencies — plain ES modules, so the app just needs to
be *served* rather than opened as a `file://` URL:

```bash
npm start          # python3 -m http.server 8080
# then open http://localhost:8080

npm test           # node --test
```

Geolocation requires a secure context: `https://` in production, or
`localhost` in development. If the browser denies location, the results screen
also takes a typed place name.

### Setting up Google

Venues, ratings and the map come from Google Maps Platform. Paste a key into
`munch.config.js` and redeploy:

```js
window.MUNCH_CONFIG = {
  googleMapsApiKey: 'AIza…',
  mapId: '',            // optional, for cloud-based map styling
};
```

Enable **Maps JavaScript API**, **Places API (New)** and **Geocoding API** on
the project the key belongs to.

**The key is public.** It ships to the browser, which is normal for Maps
Platform keys but only safe if you restrict it:

- *Application restrictions → Websites*: add your site, e.g.
  `https://yourname.github.io/*`
- *API restrictions*: limit it to the three APIs above
- Set a **billing budget alert**, so a scraped key cannot quietly run up a bill

An unrestricted key on a public site will eventually be found and used.

Without a key the app still runs: it falls back to OpenStreetMap for venues
and hides the map, since there is no basemap to draw. Coverage is patchier and
there are no ratings, so this is a fallback rather than a mode to ship.

### Cost

Each search is one Nearby Search call. The requested field set includes
ratings, price level, opening hours and contact details, which puts the call in
the **Enterprise** SKU — the most expensive tier. Trim `FIELDS` in
`src/providers/google.js` from the bottom up to drop into the cheaper Pro tier
if a free allowance is the priority.

**Photos are billed separately, per image fetched**, which makes them the most
expensive part of a results screen: a fully scrolled list of 20 venues would be
20 requests on top of the one search. Three brakes, all in `munch.config.js`:

| setting | effect |
| --- | --- |
| `photoLimit: 3` (default) | only the top three cards can show a photo |
| lazy loading (always on) | off-screen cards cost nothing until scrolled to |
| `showPhotos: false` | no photos at all, no photo requests |

The limit follows display order, so re-sorting moves the photos to whatever is
now on top. Counting the billable units per search — one Nearby Search, up to
`photoLimit` photo fetches, one map load, and a geocode only if a place name
was typed — against Google's current pricing is the way to estimate a bill;
set a budget alert either way.

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
   craving for crispy reaches tonkatsu first.

   Those dishes are **never displayed**. Printing a dish name above a list of
   venues implies those venues serve it, and no available API can confirm what
   is on a restaurant's current menu — Google Places has no menu field, and the
   only live sources are per-merchant POS or partner-only delivery APIs. So the
   screen shows the craving profile, and venue cards link out to the business
   for the real menu. The dishes stay internal, choosing the cuisine and
   sharpening the search terms.
4. **Reveal** — a full-screen moment (~4.7s) shuffles the cuisines, decelerating
   into the chosen one like a wheel coming to rest, then bursts. Since the app
   decides for you, the decision has to be seen being made, or it reads as a
   label that was always there. It lands on the cuisine alone — no dish, for
   the reason above. Tap or press any key to skip, and it collapses to ~650ms
   with no confetti under `prefers-reduced-motion`.
5. **Location** — requested automatically once the reveal ends, via the
   browser's Geolocation API; Nominatim handles typed place names.
6. **Venues** — one Places Nearby Search within 5 km, filtered server-side by
   the cuisine's `includedPrimaryTypes` and ranked by distance, widening to
   15 km only when it finds nothing at all. The OpenStreetMap fallback runs
   the equivalent Overpass query when no key is configured.
7. **Results** — each card carries a credited photo under the name, ranked by
   match quality first and distance second, with the map and the sortable list
   on screen together: stacked on a phone, side by side
   from 860px with the map sticky as the list scrolls past. Every venue links
   out to directions, its website and its Google listing.

## Data sources

Venues, geocoding and the map come from **Google Maps Platform** (Places API
New, Geocoding, Maps JavaScript). The **OpenStreetMap** stack — Overpass and
Nominatim — remains as the keyless fallback.

There is no backend. Requests go straight from the browser to whichever
provider is active, so your coordinates reach Google (or Overpass) but are
never stored by this app.

When a search comes up empty the app says so rather than inventing places.

## Layout

```
munch.config.js       your API key — the one file you edit to deploy
index.html            markup for the three screens and the reveal overlay
assets/styles.css     styling — dark-first, light via prefers-color-scheme
src/data.js           questions, cuisines and the dish catalogue
src/diagnosis.js      scoring and ranking (pure)
src/geo.js            haversine distance, formatting, geolocation wrapper
src/reveal.js         the cuisine reveal overlay
src/config.js         reads the deployment config
src/google.js         loads the Maps JS SDK once, and reports auth failures
src/places.js         picks a provider
src/places-shared.js  the shared place shape, ranking and errors
src/providers/        google.js (primary) and osm.js (keyless fallback)
src/map.js            Google Maps wrapper; no-ops without a key
src/app.js            screen flow and DOM wiring
tests/                node:test unit tests
```

Both providers normalise to the same place shape, so `app.js` never learns
which one answered. If the Maps SDK fails to load — bad key, blocked script —
the failure is shown on the results screen and the list carries on.

## Adding to the catalogue

Dishes live in `src/data.js`. They are scoring data, not display copy — no
dish name reaches the screen. Each declares every texture and flavour it
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
