# Munch API

A small backend with two jobs.

**1. Custody of the Places key.** The static build ships its API key in the
page, where anyone can read it and spend it. Here the key lives in the worker
and never reaches a browser — including for photos, which are fetched back
through this service rather than by a URL containing the key.

**2. Enforcing Munch+.** A paywall in client-side JavaScript is a suggestion:
the flag is one devtools toggle away from being flipped. This is the only
place the dessert gate can actually hold.

The design point that makes the gate real: **the client never sends venue
types.** It sends a *course* and a *cuisine*, and the server derives the types
itself — importing the same `src/data.js` the quiz uses. There is no field in
which to ask for dessert venues, so there is nothing to forge.

## Endpoints

| method | path | what it does |
| --- | --- | --- |
| `POST` | `/v1/session` | Exchange a device id (and optionally a store purchase) for a signed token |
| `POST` | `/v1/places` | Nearby venues for a course + cuisine. Enforces the paywall |
| `POST` | `/v1/geocode` | Resolve a typed place name |
| `GET` | `/v1/photo` | 302 to a photo, with the key kept behind |
| `GET` | `/v1/health` | Readiness, and which settings are missing |

Refusals are meaningful: **402** means the tier does not include that course
(the app shows an upsell), **401** means the token is missing, forged or
expired, **429** means the hourly ceiling is spent.

## Deploying

Cloudflare Workers is what `wrangler.toml` targets, but `src/index.js` is a
standard `fetch` handler using only Request/Response and WebCrypto, so Deno
Deploy or any equivalent runtime works with a different entry shim.

```bash
cd server
npm install -g wrangler          # once
wrangler kv namespace create MUNCH_KV
#   → paste the returned id into wrangler.toml

wrangler secret put GOOGLE_PLACES_KEY   # a NEW key, restricted to Places API (New) + Geocoding
wrangler secret put TOKEN_SECRET        # e.g. `openssl rand -base64 32`

wrangler deploy
```

Then point the site at it, in `munch.config.js`:

```js
window.MUNCH_CONFIG = {
  apiBase: 'https://munch-api.<your-subdomain>.workers.dev',
  googleMapsApiKey: 'AIza…',   // Maps JavaScript only — see below
};
```

### Two keys, not one

Keep these separate, because only one of them can be hidden:

| key | where it lives | restrict it to |
| --- | --- | --- |
| Maps JavaScript | the page, public | Maps JavaScript API, and your domains by HTTP referrer |
| Places + Geocoding | `wrangler secret`, never public | Places API (New), Geocoding API |

A basemap cannot be drawn without a key in the browser, so that one stays
public — restrict it and accept it. The expensive one does not have to be, and
after this it is not.

**Revoke the old combined key** once traffic is flowing through the proxy. It
has been public on what2food.com and should be treated as compromised.

## Store credentials

Munch+ comes from Apple or Google confirming a live subscription. Without
those credentials **nobody is granted plus** — see "fails closed" below — so
the service is safe to deploy before the mobile apps exist.

```bash
# Apple — App Store Connect → Users and Access → Integrations → In-App Purchase
wrangler secret put APPLE_KEY_ID
wrangler secret put APPLE_ISSUER_ID
wrangler secret put APPLE_PRIVATE_KEY     # contents of the .p8
# and set APPLE_BUNDLE_ID / APPLE_ENVIRONMENT in wrangler.toml

# Google Play — a service account with the Android Publisher role
wrangler secret put PLAY_CLIENT_EMAIL
wrangler secret put PLAY_PRIVATE_KEY
# and set PLAY_PACKAGE_NAME in wrangler.toml
```

The app posts what the store gave it:

```jsonc
POST /v1/session
{ "platform": "ios",     "deviceId": "…", "transactionId": "…" }
{ "platform": "android", "deviceId": "…", "purchaseToken": "…" }
{ "platform": "web",     "deviceId": "…" }                        // always free
```

Rather than verifying Apple's signed receipt offline against its certificate
chain, this asks the App Store Server API directly, over TLS, with our own
signed credentials — and trusts that authenticated answer. Less code to get
wrong, and fresher: an offline receipt says what was true when it was issued,
while the API says what is true now, cancellations included. Play works the
same way.

### It fails closed

Every path that cannot *positively confirm* a live subscription returns
`free`: missing credentials, an unreachable store, a malformed response, an
expired or revoked purchase, an unrecognised state, a subscription belonging
to a different app. There is no branch that grants `plus` by default, and the
tests assert each of those cases individually — because the failure mode of
getting this wrong is silently giving the product away.

## Tiers

| | free | plus |
| --- | --- | --- |
| courses | main | main + dessert |
| searches/hour | 30 | 120 |
| photos/hour | 20 | 120 |

The ceilings are a cost cap as much as a product line: every search that
reaches Google is billed, so an identity asking for hundreds is either abusing
the key or looping by accident.

Rate limiting uses a fixed window, one read and one write. A burst across a
window boundary can briefly reach twice the limit and concurrent requests can
undercount — acceptable, because this is a spend ceiling and not the security
boundary. That boundary is the token signature. Move it to Durable Objects if
you ever need exactness.

## Caching

`/v1/places` caches on **location and venue types only** — not on the caller's
search terms, and not per session. Ranking happens after the cache, per
request, because it is the only part that depends on the terms. So one Google
call serves every user in that area looking for that kind of place, whoever
they are and whatever they typed.

Empty results are never cached: an empty answer is usually a thin area or a
transient hiccup, and remembering "nothing here" for 45 minutes makes the
obvious retry pointless.

## Known gaps

- **Never run against the real Google, Apple or Play APIs.** The sandbox this
  was built in has no outbound network. Request shapes follow the published
  APIs and every response path is unit-tested against fixtures, but the first
  real call is still the first real call. Deploy and hit `/v1/health`, then a
  live search, before pointing users at it.
- **The device id is client-supplied**, so a determined caller can reset their
  own rate limit by generating a new one. It spreads a spend ceiling; it is
  not an identity, and it is not what gates Munch+. Add Turnstile or device
  attestation if abuse becomes real.
- **No refund or revocation webhook.** Entitlement is checked when a session
  is issued and the token then stands for its lifetime (24h by default), so a
  refund can leave up to a day of access. Shorten `TOKEN_TTL_HOURS`, or
  consume App Store Server Notifications and Play RTDN, if that matters.

## Tests

```bash
node --test "test/*.test.js"     # from server/
npm test                         # from the repo root, runs these too
```

`routing.test.js` drives the real `fetch` handler with Google stubbed, so the
paywall, token and cache behaviour are tested through the same path a browser
takes rather than through a mock of it.
