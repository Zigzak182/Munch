# Munch

**Hunger diagnostics.** Two questions — how it should *feel* and what it should
*taste* of — then Munch decides the cuisine for you and maps the closest places
that fit.

```
Crunchy · Soft · Saucy · Crispy          →  what it feels like
Cheesy · Spicy · Savory · Fresh · Sweet  →  what it tastes of
                                         →  one of Asian, Italian, Mexican,
                                            Indian, Mediterranean, American,
                                            and the nearest places serving it
```

**Sweet** is the Munch+ answer: it carries a rainbow rim and a candy-striped
badge, and switches the whole search to bakeries, gelaterias and dessert
counters instead of restaurants. See [Courses](#courses).

Deciding the cuisine is the point: picking it yourself is the step that stalls
people. The results screen still lists the runner-up cuisines underneath, so
the decision is easy to overrule — but you get an answer first.

Live at **[www.what2food.com](https://www.what2food.com)**.

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

- *Application restrictions → Websites*: add **every** host the app is served
  from — `https://www.what2food.com/*` and `https://what2food.com/*`. A key
  restricted to one host fails with `RefererNotAllowedMapError` on the other,
  which looks like a blank map and no venues rather than an obvious error
- *API restrictions*: limit it to the three APIs above
- Set a **billing budget alert**, so a scraped key cannot quietly run up a bill

An unrestricted key on a public site will eventually be found and used.

Without a key the app still runs: it falls back to OpenStreetMap for venues
and hides the map, since there is no basemap to draw. Coverage is patchier and
there are no ratings, so this is a fallback rather than a mode to ship.

### Cost

Each *new* search is one Nearby Search call. Three settings in
`munch.config.js` decide what that costs, in descending order of how much they
save and ascending order of what they take away.

**`cacheMinutes: 30`** — repeat searches are served from the tab instead of
being billed again. A reload, a shared link opened twice, tapping "Use my
location" after dismissing the first prompt: none of those are new
information. Costs nothing in data quality. Measured over one session — first
search, reload, re-tap, then a genuinely different search:

| | billed calls |
| --- | --- |
| `cacheMinutes: 30` (default) | **2** |
| `cacheMinutes: 0` | 5 |

Only non-empty results are cached, so an empty answer stays retryable. The
cache is keyed on rounded coordinates (~110 m), the venue types and the search
terms, and lives in `sessionStorage` — so it cannot outlive the visit.

**`fieldTier: 'enterprise'`** — Google prices a search by the most expensive
field in it, so asking for a rating prices the whole call at the Enterprise
rate. The tiers are cumulative:

| tier | adds | a card loses |
| --- | --- | --- |
| `essentials` | id, name, address, location, types | photos, Google listing link |
| `pro` | + primary type, listing link, photos | stars, price, open/closed |
| `enterprise` | + rating, price, hours, contact | — (the default) |

Left at `enterprise` so nothing changes silently; dropping a tier is a real
cut in cost *and* in what a card can say.

**`provider: 'auto'`** — set it to `'osm'` to run entirely on OpenStreetMap:
no map and no ratings, but **no per-search cost at all**. The switch to throw
if a deployment has to run for free, and the natural split if you ever want a
free tier and a paid one.

The tier split is deliberately conservative — a field whose SKU is uncertain
sits with the dearer set, so a cheaper tier cannot cost more than expected.
Check Google's current SKU pricing before budgeting against any of this.

**Photos are billed separately, per image fetched**, so they are **not loaded
automatically**. The top `photoLimit` cards (default 3) show a "Show photo"
button, and the image — and the charge — arrives only when someone taps it. An
ordinary search costs nothing in photos.

| setting | effect |
| --- | --- |
| `photoLimit: 3` (default) | how many cards offer the button |
| `photoLimit: 0` | no buttons |
| `showPhotos: false` | same, and no photo URLs are built at all |

The limit follows display order, so re-sorting moves the buttons to whatever is
now on top. Billable units per search: one Nearby Search **unless the cache
answers it**, one map load, a geocode only if a place name was typed (also
cached), and a photo only per tap. Multiply against Google's current pricing to
estimate a bill; set a budget alert either way.

## How it works

1. **Quiz** — two single-choice screens. Answers are held in memory and
   mirrored into the URL hash (`#saucy/spicy`), so a diagnosis can be
   bookmarked or shared and comes back on reload.
2. **Cuisine** — each of the six cuisines is scored by the sum of its best
   three dishes against the pair, drawn from whichever catalogue the answer
   selects (see [Courses](#courses)). One perfect dish is a lucky guess; three
   strong ones mean the whole kitchen is pointed at what you want. Every one of
   the sixteen pairs resolves to a cuisine, and every cuisine is reachable.

   Because the score sums a cuisine's best three, **catalogue depth wins pairs
   on its own** — a cuisine with more dishes, or with several near-identical
   entries, crowds out better-fitting rivals. Keep the counts level and the
   tags distinct when adding to it.
3. **Diagnosis** — dishes within that cuisine are scored on texture and
   flavour, each paying a bonus when the answer matches the dish's *defining*
   trait — the first tag in its list. Gyoza is soft before it is crispy, so a
   craving for crispy reaches tonkatsu first.

   The diagnosis itself **never names a dish**. Printing a dish name above a
   list of venues implies those venues serve it, and no available API can
   confirm what is on a restaurant's current menu — Google Places has no menu
   field, and the only live sources are per-merchant POS or partner-only
   delivery APIs. So the headline shows the craving profile, and venue cards
   link out to the business for the real menu.

   There is exactly one exception, and it works the other way round — see
   [Suggestions](#suggestions).
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
7. **Results** — ranked by match quality first and distance second, with the
   map and the sortable list on screen together: stacked on a phone, side by
   side from 860px with the map sticky as the list scrolls past. The top few
   cards offer a photo under the name, loaded on tap and credited when shown.
   Every venue links out to directions, its website and its Google listing.

   Travel time switches mode with distance: a walk up to 2 km, a drive past
   it. Quoting "~40 min walk" for somewhere across town is not advice anyone
   acts on.

## Suggestions

The results screen can name a dish — the one place in the app that does. It
earns that by reading the venues rather than talking over them.

Instead of naming a dish and hoping the neighbourhood cooperates, it takes the
six best-fitting candidates and asks which one the venues that actually came
back point at. Support is counted per venue, matched against each venue's
name, primary type and type list.

The wording follows the evidence, and stops entirely when there is none:

| venues pointing that way | screen says |
| --- | --- |
| 3+, and at least 30% of results | **Good odds on Tonkatsu** — *3 places below point that way. We can't read menus, so treat it as a hunch worth having.* |
| 1–2, or a thin share of a long list | **Maybe Tonkatsu** — *Only 1 place below hints at it — a guess rather than a plan. Check the menu before you commit.* |
| none | nothing at all |

Both thresholds matter: three venues out of four is a pattern, three out of
forty is noise that happens to clear a counter.

**Cuisine words are not evidence.** The venue list was already filtered by
cuisine, so "mexican" matching every Mexican restaurant separates nothing —
every candidate would tie on every search. The cuisine's own id, label and
`osmCuisines` are excluded, along with words that describe a venue rather than
food (`restaurant`, `bakery`, `cafe`). What is left — `birria`, `churreria`,
`katsu`, `panaderia` — is what actually carries information.

No phrasing here states that a venue serves anything, and the copy says why:
menus are not published anywhere the app can read. A test asserts the wording
never claims otherwise.

## Courses

Answering **sweet** switches the course from `main` to `dessert`, and that
changes more than the dish list:

| | main | dessert |
| --- | --- | --- |
| catalogue | 60 dishes | 24 desserts |
| Google types | the cuisine's restaurants | `bakery`, `cafe`, `ice_cream_shop`, `donut_shop`, … |
| OSM tags | `amenity=restaurant\|cafe\|…` | plus `shop=bakery\|pastry\|…` |
| backstop terms | the cuisine's `osmCuisines` | `dessert`, `patisserie`, `gelato`, … |

The two catalogues never mix — a savoury craving cannot reach a gelateria and
a sweet one cannot reach a curry house — because every ranking filters on
course before it scores anything.

The cuisine is still derived, so a dessert search stays cuisine-flavoured: the
matched dishes' own terms (`churro`, `baklava`, `pasticceria`) lead the venue
ranking, and only the generic backstop follows. Each cuisine carries exactly
four desserts, one leading on each texture, so no cuisine wins the sweet pairs
on depth alone — the same rule the main catalogue follows.

A bakery is mapped in OpenStreetMap as `shop=bakery`, usually with no
`amenity` and no `cuisine` tag, which is why the fallback provider had to grow
a shop clause; matching on amenity alone returned almost no bakeries at all.

## The backend

There is an optional backend in [`server/`](server/README.md). Without it the
app works exactly as before: the browser talks to Google directly. With it,
two things change that cannot be done from a static page.

**The Places key stops being public.** A key in `munch.config.js` ships to
every visitor and can be scraped and spent. Behind the proxy it lives in the
worker's secrets. The Maps *JavaScript* key stays public — a basemap cannot be
drawn without one — so the two are split, and only the cheap one is exposed.

**Munch+ becomes enforceable.** The dessert gate cannot hold in client-side
JavaScript, where it is one devtools toggle from being off. The mechanism is
narrower than a check: the client sends a *course* and a *cuisine*, never
venue types, and the server derives the types itself from this same
`src/data.js`. There is no field in which to ask for dessert venues.

**Accounts, so a subscription travels.** Sign-in is a six-digit code by email —
no passwords to leak, no social login (which would drag Apple's Sign in with
Apple requirement along with it). Signing in is never required to *use* Munch;
it is how Munch+ follows you from the phone you bought it on to a laptop, and
across a reinstall.

Set `apiBase` in `munch.config.js` to switch the app onto it. The provider is
picked in `src/places.js`, and `app.js` never learns which one answered.

Shipping to the app stores is a separate, longer road: see
[docs/LAUNCH.md](docs/LAUNCH.md).

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
CNAME                 the custom domain GitHub Pages serves from
munch.config.js       your API key — the one file you edit to deploy
index.html            markup for the three screens and the reveal overlay
assets/styles.css     styling — dark-first, light via prefers-color-scheme
src/data.js           questions, cuisines and the dish catalogue
src/diagnosis.js      scoring and ranking (pure)
src/geo.js            haversine distance, formatting, geolocation wrapper
src/reveal.js         the cuisine reveal overlay
src/config.js         reads the deployment config
src/cache.js          TTL cache for billed provider responses
src/suggest.js        reads the venues found for a likely dish
src/google.js         loads the Maps JS SDK once, and reports auth failures
src/places.js         picks a provider
src/places-shared.js  the shared place shape, ranking and errors
src/providers/        api.js (backend), google.js (direct), osm.js (keyless)
src/account.js        the sign-in strip; hidden without a backend
server/               the optional backend: accounts, key custody, the gate
docs/LAUNCH.md        getting to Google Play and the App Store
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
pairs resolve to a cuisine with **every** cuisine reachable, and that every
pair-and-cuisine combination still yields at least one dish — so a typo, an
unreachable cuisine or a gap in the matrix fails CI rather than reaching the
screen.
