/**
 * The Munch API — a small proxy that holds the Places key and the paywall.
 *
 * Two jobs:
 *
 * 1. **Custody of the key.** The browser build ships its key in the page,
 *    where it can be scraped and spent. Here the key lives in the worker and
 *    the client never sees it, including for photos.
 *
 * 2. **Enforcement.** The client asks for a *course* and a *cuisine*, never
 *    for venue types — the server derives those itself from the same data
 *    module the app uses. So a free client cannot request dessert venues by
 *    crafting a request; there is no field in which to ask.
 *
 * Written against the standard `fetch` handler interface, so it runs on
 * Cloudflare Workers (what wrangler.toml targets), Deno Deploy, or any other
 * runtime with Request/Response and WebCrypto.
 */

import { COURSES, CUISINES } from '../../src/data.js';
import { SEARCH_RADIUS, WIDE_RADIUS, rankPlaces } from '../../src/places-shared.js';

import { missingRequired, readEnv } from './env.js';
import { HttpError, corsHeaders, errorResponse, json, readJson, requireNumber } from './http.js';
import { bearerFrom, issueToken, verifyToken } from './token.js';
import { entitlementFor } from './entitlement.js';
import { allowsCourse, describeTier, tierFor } from './tiers.js';
import { createStore } from './store.js';
import { consume } from './ratelimit.js';
import { geocode, photoUrl, searchNearby } from './google.js';
import { sendLoginCode } from './mail.js';
import {
  CODE_TTL_MINUTES, accountForPurchase, entitlementsFor, findAccountById,
  issueLoginCode, looksLikeEmail, normalizeEmail, recordEntitlement, tierForAccount,
  upsertAccount, verifyLoginCode,
} from './accounts.js';

/** Coordinates are rounded in cache keys — about 110 m. */
const COORD_PRECISION = 3;

const cuisineById = (id) => CUISINES.find((entry) => entry.id === id) ?? null;

/**
 * The venue types for a course and cuisine.
 *
 * The client has no say in this. It is the same derivation the browser does,
 * but doing it here is what makes the paywall real.
 */
function typesFor(course, cuisine) {
  const courseConfig = COURSES[course];
  if (!courseConfig) throw new HttpError(400, 'bad_request', 'Unknown course.');
  return courseConfig.googleTypes ?? cuisine.googleTypes;
}

/** Identify the caller, or refuse. */
async function requireSession(request, config, explicitToken = null) {
  const token = explicitToken ?? bearerFrom(request);
  if (!token) throw new HttpError(401, 'no_session', 'Start a session first.');

  try {
    return await verifyToken(token, { secret: config.tokenSecret });
  } catch {
    throw new HttpError(401, 'bad_session', 'Session expired. Start a new one.');
  }
}

async function meter(store, { claims, action, limit, headers }) {
  const result = await consume(store, {
    identity: claims.sub,
    action,
    limit,
    windowSeconds: 3600,
  });

  if (!result.allowed) {
    throw new HttpError(429, 'rate_limited',
      'That is a lot of searching. Try again shortly.',
      { resetAt: result.resetAt });
  }

  headers['X-RateLimit-Remaining'] = String(result.remaining);
}

// ------------------------------------------------------------------ routes

/** The database, or a 503 — never a silent degrade on an auth route. */
function requireDb(config) {
  if (!config.db) {
    throw new HttpError(503, 'no_accounts', 'Accounts are not enabled on this deployment.');
  }
  return config.db;
}

/** Issue a token for whoever this is. */
async function mint(config, { sub, tier, kind, email }) {
  return issueToken(
    { sub, tier, kind, ...(email ? { email } : {}) },
    { secret: config.tokenSecret, ttlSeconds: config.tokenTtlHours * 3600 },
  );
}

/**
 * Start a session.
 *
 * Anonymous by default, because Munch is two questions and a map — putting a
 * sign-in wall in front of that would cost more users than the subscription
 * could ever be worth. An account is how a subscription *travels*: between a
 * phone and a laptop, and across a reinstall.
 *
 * The device id is client-generated and therefore spoofable. That is fine for
 * what it does — spread the rate limit across devices — and it is not what
 * gates Munch+.
 */
async function postSession(request, config, headers) {
  const body = await readJson(request);
  const deviceId = String(body.deviceId ?? '').trim().slice(0, 128);
  if (!deviceId) throw new HttpError(400, 'bad_request', 'deviceId is required.');

  // A store receipt with no account still works — that is the pre-accounts
  // path, and the mobile apps use it before anyone signs in.
  const entitlement = await entitlementFor(body, config);

  const { token, expiresAt } = await mint(config, {
    sub: `dev:${deviceId}`,
    tier: entitlement.tier,
    kind: 'device',
  });

  return json({
    token,
    expiresAt,
    signedIn: false,
    ...describeTier(entitlement.tier),
    // Useful in the app's logs when a purchase does not unlock what someone
    // expected; it names the reason without leaking anything about the store
    // credentials.
    reason: entitlement.reason,
  }, { headers });
}

// -------------------------------------------------------------------- auth

/**
 * Send a sign-in code.
 *
 * The response is the same whether or not the address has an account, and
 * whether or not the mail actually went out. Anything else turns this into a
 * way to ask "does this person use Munch?".
 */
async function postAuthCode(request, config, store, headers) {
  const db = requireDb(config);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);

  if (!looksLikeEmail(email)) {
    throw new HttpError(400, 'bad_request', 'That does not look like an email address.');
  }

  // Two ceilings: one per address so a mailbox cannot be flooded, one per
  // device so a single client cannot enumerate addresses.
  const deviceId = String(body.deviceId ?? '').trim().slice(0, 128) || 'anonymous';
  for (const [action, identity, limit] of [
    ['login-code-email', email, 5],
    ['login-code-device', deviceId, 15],
  ]) {
    const result = await consume(store, { identity, action, limit, windowSeconds: 3600 });
    if (!result.allowed) {
      throw new HttpError(429, 'rate_limited', 'Too many codes requested. Try again later.');
    }
  }

  const { code } = await issueLoginCode(db, email);
  await sendLoginCode({ to: email, code, minutes: CODE_TTL_MINUTES, config });

  return json({ sent: true, expiresInMinutes: CODE_TTL_MINUTES }, { headers });
}

/**
 * Exchange a code for a signed-in session.
 *
 * Signing in also claims any purchase the caller is holding, which is what
 * makes "I bought this on my phone" work on a laptop.
 */
async function postAuthVerify(request, config, store, headers) {
  const db = requireDb(config);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);

  const guard = await consume(store, {
    identity: email, action: 'login-verify', limit: 20, windowSeconds: 3600,
  });
  if (!guard.allowed) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.');
  }

  const check = await verifyLoginCode(db, email, body.code);
  if (!check.ok) {
    // One message for every failure. Distinguishing "wrong code" from "no
    // code for that address" would answer a question we do not want asked.
    throw new HttpError(401, 'bad_code', 'That code is not right, or it has expired.');
  }

  const account = await upsertAccount(db, email);

  // Claim a purchase presented alongside the code, so buying and signing in
  // can happen in either order.
  if (body.platform && (body.purchaseToken || body.transactionId)) {
    await claimPurchase(db, config, { account, claim: body });
  }

  const { tier } = await tierForAccount(db, account.id);
  const { token, expiresAt } = await mint(config, {
    sub: `acct:${account.id}`, tier, kind: 'account', email: account.email,
  });

  return json({
    token, expiresAt, signedIn: true, email: account.email, ...describeTier(tier),
  }, { headers });
}

/**
 * Attach a store purchase to an account.
 *
 * Verified with the store first, then written. A purchase already claimed by
 * a different account is refused rather than moved — one subscription, one
 * account, or a receipt passed between friends would unlock both.
 */
async function claimPurchase(db, config, { account, claim }) {
  const purchaseId = String(claim.purchaseToken ?? claim.transactionId ?? '').slice(0, 512);
  if (!purchaseId) throw new HttpError(400, 'bad_request', 'No purchase to attach.');

  const existing = await accountForPurchase(db, purchaseId);
  if (existing && existing.account_id !== account.id) {
    throw new HttpError(409, 'already_claimed',
      'That purchase is already attached to another account.');
  }

  const entitlement = await entitlementFor(claim, config);

  await recordEntitlement(db, {
    accountId: account.id,
    platform: claim.platform,
    purchaseId,
    productId: claim.productId ?? null,
    state: entitlement.tier === 'plus' ? 'active' : 'expired',
    expiresAt: entitlement.expiresAt ?? null,
  });

  return entitlement;
}

/** Attach a purchase to the signed-in account. Used after an in-app buy. */
async function postPurchase(request, config, headers) {
  const db = requireDb(config);
  const claims = await requireSession(request, config);
  if (claims.kind !== 'account') {
    throw new HttpError(401, 'sign_in_required', 'Sign in before attaching a purchase.');
  }

  const account = await findAccountById(db, String(claims.sub).replace(/^acct:/, ''));
  if (!account) throw new HttpError(401, 'sign_in_required', 'Sign in again.');

  const body = await readJson(request);
  await claimPurchase(db, config, { account, claim: body });

  const { tier } = await tierForAccount(db, account.id);
  const { token, expiresAt } = await mint(config, {
    sub: `acct:${account.id}`, tier, kind: 'account', email: account.email,
  });

  return json({ token, expiresAt, signedIn: true, email: account.email, ...describeTier(tier) },
    { headers });
}

/**
 * Who this session is, and what it is entitled to.
 *
 * Re-read from the database rather than taken from the token, so a
 * subscription that lapsed — or one just bought on another device — is
 * reflected without waiting for the token to expire.
 */
async function getMe(request, config, headers) {
  const claims = await requireSession(request, config);

  if (claims.kind !== 'account') {
    return json({ signedIn: false, ...describeTier(claims.tier) }, { headers });
  }

  const db = requireDb(config);
  const account = await findAccountById(db, String(claims.sub).replace(/^acct:/, ''));
  if (!account) throw new HttpError(401, 'sign_in_required', 'Sign in again.');

  const { tier, entitlement } = await tierForAccount(db, account.id);
  const all = await entitlementsFor(db, account.id);

  return json({
    signedIn: true,
    email: account.email,
    ...describeTier(tier),
    // Enough for the app to say "renews on the 14th" without another call.
    subscription: entitlement
      ? { platform: entitlement.platform, expiresAt: entitlement.expires_at, state: entitlement.state }
      : null,
    purchases: all.length,
  }, { headers });
}

/**
 * Delete the account and everything attached to it.
 *
 * Both stores require this: Play needs an in-app route to deletion plus a web
 * URL, and App Store guideline 5.1.1(v) requires it in-app. Shipping accounts
 * without it fails review.
 *
 * Entitlement rows go with the account (ON DELETE CASCADE). The *subscription*
 * does not — only the store can cancel that — so the response says so plainly
 * rather than letting someone delete their way into a surprise renewal.
 */
async function deleteMe(request, config, headers) {
  const db = requireDb(config);
  const claims = await requireSession(request, config);

  if (claims.kind !== 'account') {
    throw new HttpError(401, 'sign_in_required', 'Sign in before deleting an account.');
  }

  const accountId = String(claims.sub).replace(/^acct:/, '');
  const account = await findAccountById(db, accountId);
  if (!account) return json({ deleted: true }, { headers });

  await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(account.email).run();
  await db.prepare('DELETE FROM entitlements WHERE account_id = ?').bind(accountId).run();
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId).run();

  return json({
    deleted: true,
    note: 'Your account and its records are gone. An active subscription is held by '
      + 'Google Play or the App Store and must be cancelled there — deleting this '
      + 'account does not stop it renewing.',
  }, { headers });
}

/**
 * Find venues.
 *
 * The response is cached on location and types alone, so it is shared across
 * every caller in the area regardless of what they typed. Ranking happens per
 * request, after the cache, because it depends on the caller's terms.
 */
async function postPlaces(request, config, store, headers) {
  const claims = await requireSession(request, config);
  const tier = tierFor(claims.tier);

  const body = await readJson(request);
  const lat = requireNumber(body.lat, 'lat', { min: -90, max: 90 });
  const lon = requireNumber(body.lon, 'lon', { min: -180, max: 180 });

  const course = String(body.course ?? 'main');
  const cuisine = cuisineById(String(body.cuisine ?? ''));
  if (!cuisine) throw new HttpError(400, 'bad_request', 'Unknown cuisine.');

  // Validity before entitlement: a course that does not exist is a bad
  // request, and answering "upgrade required" would imply that paying would
  // make it work.
  if (!COURSES[course]) throw new HttpError(400, 'bad_request', 'Unknown course.');

  // The paywall.
  if (!allowsCourse(claims.tier, course)) {
    throw new HttpError(402, 'upgrade_required',
      'Dessert search is a Munch+ feature.',
      { feature: course, ...describeTier(claims.tier) });
  }

  await meter(store, { claims, action: 'search', limit: tier.searchesPerHour, headers });

  const types = typesFor(course, cuisine);
  const terms = Array.isArray(body.terms)
    ? body.terms.slice(0, 40).map((term) => String(term).slice(0, 60))
    : [];

  const cacheKey = `places:${lat.toFixed(COORD_PRECISION)},${lon.toFixed(COORD_PRECISION)}`
    + `:${[...types].sort().join(',')}`;

  let found = await store.get(cacheKey);
  let radius = SEARCH_RADIUS;

  if (found) {
    radius = found.radius;
    found = found.places;
  } else {
    const collected = [];
    for (const attempt of [SEARCH_RADIUS, WIDE_RADIUS]) {
      radius = attempt;
      collected.push(...await searchNearby({
        lat, lon, radius: attempt, types, key: config.googleKey, fieldTier: config.fieldTier,
      }));
      if (collected.length > 0) break;
    }
    found = collected;

    // An empty answer is not cached: it is usually a thin area or a hiccup,
    // and remembering "nothing here" makes the obvious retry pointless.
    if (found.length > 0) {
      await store.put(cacheKey, { places: found, radius },
        { ttlSeconds: config.cacheMinutes * 60 });
    }
  }

  const ranked = rankPlaces(found, { lat, lon }, { matchTypes: types, nameTerms: terms });

  return json({ places: ranked, radius, tier: claims.tier }, { headers });
}

/**
 * Resolve a typed place name.
 *
 * Also billed, also cached — and cached on the query alone, so "Shoreditch"
 * costs one geocode however many people type it.
 */
async function postGeocode(request, config, store, headers) {
  const claims = await requireSession(request, config);
  const tier = tierFor(claims.tier);

  const body = await readJson(request);
  const query = String(body.query ?? '').trim().slice(0, 200);
  if (!query) throw new HttpError(400, 'bad_request', 'query is required.');

  await meter(store, { claims, action: 'search', limit: tier.searchesPerHour, headers });

  const cacheKey = `geocode:${query.toLowerCase()}`;
  const cached = await store.get(cacheKey);
  if (cached) return json(cached, { headers });

  const result = await geocode({ query, key: config.googleKey });
  if (!result) throw new HttpError(404, 'not_found', 'Could not find that place.');

  await store.put(cacheKey, result, { ttlSeconds: config.cacheMinutes * 60 });
  return json(result, { headers });
}

/**
 * Redirect to a photo.
 *
 * Google's media URL needs the key, so the client holds an opaque photo name
 * and asks for it here. The redirect target is a signed, expiring Google URL —
 * public, but not the key.
 */
async function getPhoto(request, config, store, headers) {
  const url = new URL(request.url);

  // An <img> cannot set an Authorization header, so this route also accepts
  // the token as a query parameter. It is the same signed token, just carried
  // where an image tag can reach it — and the response is sent with
  // no-referrer so it does not travel on to Google in a Referer header.
  const claims = await requireSession(request, config, url.searchParams.get('t'));
  const tier = tierFor(claims.tier);

  const name = url.searchParams.get('name') ?? '';
  const width = Math.min(1600, Math.max(80, Number(url.searchParams.get('w')) || 720));

  // Photo names look like `places/{id}/photos/{ref}`. Anything else is not
  // ours to forward — this endpoint must not become an open relay.
  if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)) {
    throw new HttpError(400, 'bad_request', 'Not a photo reference.');
  }

  await meter(store, { claims, action: 'photo', limit: tier.photosPerHour, headers });

  const target = await photoUrl({ name, maxWidth: width, key: config.googleKey });
  return new Response(null, {
    status: 302,
    headers: { ...headers, Location: target, 'Referrer-Policy': 'no-referrer' },
  });
}

// ----------------------------------------------------------------- handler

export default {
  async fetch(request, env) {
    const config = readEnv(env);
    const headers = corsHeaders(request, config.allowedOrigins);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);

    if (url.pathname === '/v1/health') {
      const missing = missingRequired(config);
      return json({ ok: missing.length === 0, missing }, {
        status: missing.length === 0 ? 200 : 503,
        headers,
      });
    }

    try {
      const missing = missingRequired(config);
      if (missing.length > 0) {
        console.error('not configured; missing', missing.join(', '));
        throw new HttpError(503, 'not_configured', 'The service is not configured.');
      }

      // A browser request without an allowed Origin gets no CORS headers and
      // so cannot read the response anyway; refusing it outright saves the
      // upstream call and makes the intent explicit.
      const origin = request.headers.get('Origin');
      if (origin && !config.allowedOrigins.includes(origin)) {
        throw new HttpError(403, 'forbidden_origin', 'Origin not allowed.');
      }

      const store = createStore(config.kv);

      if (request.method === 'POST' && url.pathname === '/v1/session') {
        return await postSession(request, config, headers);
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/code') {
        return await postAuthCode(request, config, store, headers);
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/verify') {
        return await postAuthVerify(request, config, store, headers);
      }
      if (request.method === 'POST' && url.pathname === '/v1/purchase') {
        return await postPurchase(request, config, headers);
      }
      if (request.method === 'GET' && url.pathname === '/v1/me') {
        return await getMe(request, config, headers);
      }
      if (request.method === 'DELETE' && url.pathname === '/v1/me') {
        return await deleteMe(request, config, headers);
      }
      if (request.method === 'POST' && url.pathname === '/v1/places') {
        return await postPlaces(request, config, store, headers);
      }
      if (request.method === 'POST' && url.pathname === '/v1/geocode') {
        return await postGeocode(request, config, store, headers);
      }
      if (request.method === 'GET' && url.pathname === '/v1/photo') {
        return await getPhoto(request, config, store, headers);
      }

      throw new HttpError(404, 'not_found', 'No such endpoint.');
    } catch (error) {
      return errorResponse(error, headers);
    }
  },
};
