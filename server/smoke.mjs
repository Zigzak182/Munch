#!/usr/bin/env node
/**
 * Acceptance test for a *deployed* Munch API.
 *
 * Run it against the real worker after deploying, before pointing the site at
 * it. Everything here is a check that has caught something real in similar
 * setups: a missing secret, a CORS list that does not include the site, a
 * paywall that is open, a key echoed back in a response.
 *
 *   node smoke.mjs https://munch-api.you.workers.dev https://www.what2food.com
 *
 * Costs: one Nearby Search against Google (a few cents at most), and one
 * sign-in email if accounts are enabled and you pass --email.
 */

const [, , baseArg, originArg, ...rest] = process.argv;

if (!baseArg) {
  console.error('usage: node smoke.mjs <api-base-url> [site-origin] [--email you@example.com]');
  process.exit(2);
}

const BASE = baseArg.replace(/\/+$/, '');
const ORIGIN = originArg && !originArg.startsWith('--') ? originArg : 'https://www.what2food.com';
const emailFlag = rest.indexOf('--email');
const EMAIL = emailFlag >= 0 ? rest[emailFlag + 1] : null;

let passed = 0;
let failed = 0;
const notes = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const note = (text) => notes.push(text);

async function call(path, { method = 'GET', body, token, origin = ORIGIN } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not json, which is fine for a redirect */ }

  return { response, json, text };
}

console.log(`\nMunch API smoke test\n  target: ${BASE}\n  origin: ${ORIGIN}\n`);

// ------------------------------------------------------------------ health

console.log('health');
{
  const { response, json } = await call('/v1/health');
  check('reachable', response.status !== 0);
  check('configured', json?.ok === true,
    json?.missing?.length ? `missing: ${json.missing.join(', ')}` : '');
  if (json?.ok !== true) {
    console.log('\nStop here — set the missing secrets before going further.\n');
    process.exit(1);
  }
}

// -------------------------------------------------------------------- cors

console.log('\ncors');
{
  const allowed = await call('/v1/health');
  check('site origin is allowed',
    allowed.response.headers.get('access-control-allow-origin') === ORIGIN,
    `got ${allowed.response.headers.get('access-control-allow-origin') ?? 'none'}`);

  const stranger = await call('/v1/session',
    { method: 'POST', body: { platform: 'web', deviceId: 'smoke' }, origin: 'https://evil.example' });
  check('unknown origin refused', stranger.response.status === 403,
    `status ${stranger.response.status}`);
}

// ----------------------------------------------------------------- session

console.log('\nsession');
let token = null;
{
  const { response, json } = await call('/v1/session',
    { method: 'POST', body: { platform: 'web', deviceId: `smoke-${Date.now()}` } });

  check('issued', response.status === 200 && Boolean(json?.token), `status ${response.status}`);
  check('anonymous sessions are free', json?.tier === 'free', `tier ${json?.tier}`);
  check('free tier excludes dessert', !(json?.courses ?? []).includes('dessert'),
    `courses ${(json?.courses ?? []).join(',')}`);
  token = json?.token;
}

if (!token) {
  console.log('\nNo session token — cannot continue.\n');
  process.exit(1);
}

// ----------------------------------------------------------------- paywall

console.log('\npaywall');
{
  const { response, json } = await call('/v1/places', {
    method: 'POST', token,
    body: { lat: 51.5074, lon: -0.1278, cuisine: 'mexican', course: 'dessert' },
  });

  check('dessert refused for a free session', response.status === 402, `status ${response.status}`);
  check('refusal names the upgrade', json?.error === 'upgrade_required', json?.error ?? '');
}

// ------------------------------------------------------- a real Google call

console.log('\nvenues (one billed Google call)');
{
  const { response, json } = await call('/v1/places', {
    method: 'POST', token,
    // Central London: somewhere that definitely has restaurants.
    body: { lat: 51.5074, lon: -0.1278, cuisine: 'italian', course: 'main', terms: ['pizza'] },
  });

  check('search succeeded', response.status === 200, `status ${response.status}`);

  const places = json?.places ?? [];
  check('returned venues', places.length > 0, `${places.length} places`);

  if (places.length > 0) {
    const first = places[0];
    check('places carry a name and a distance',
      Boolean(first.name) && Number.isFinite(first.distance),
      `${first.name} @ ${Math.round(first.distance)}m`);
    check('ratings present (enterprise field tier)', first.rating !== undefined,
      first.rating === null ? 'null — cheaper tier is configured' : String(first.rating));
  }

  if (response.status !== 200) {
    note('The venue search failed. Check that Places API (New) is enabled on the '
      + 'project the server key belongs to, and that the key has no HTTP-referrer '
      + 'restriction — a server-side key must be unrestricted by referrer or '
      + 'restricted by IP, not by website.');
  }
}

// ------------------------------------------------- the key must not come back

console.log('\nkey custody');
{
  const { text } = await call('/v1/places', {
    method: 'POST', token,
    body: { lat: 51.5074, lon: -0.1278, cuisine: 'italian', course: 'main' },
  });

  check('no AIza-style key in the response', !/AIza[0-9A-Za-z_-]{10,}/.test(text));
  check('no googleapis key parameter echoed', !/[?&]key=/.test(text));
}

// ---------------------------------------------------------------- accounts

console.log('\naccounts');
{
  const { response, json } = await call('/v1/auth/code',
    { method: 'POST', body: { email: EMAIL ?? 'smoke-test@example.com', deviceId: 'smoke' } });

  if (response.status === 503 && json?.error === 'no_accounts') {
    check('accounts disabled (no D1 binding)', true, 'expected if you have not created the database');
    note('Accounts are off. Create the D1 database and apply the migration to enable sign-in.');
  } else if (EMAIL) {
    check('sign-in code accepted for sending', response.status === 200, `status ${response.status}`);
    note(`If ${EMAIL} receives a code, email is working. If not, check the sending `
      + 'domain\'s DKIM/SPF in Resend — undelivered codes look exactly like broken sign-in.');
  } else {
    check('sign-in endpoint live', response.status === 200, `status ${response.status}`);
    note('Re-run with --email you@example.com to test that codes actually arrive.');
  }
}

// ------------------------------------------------------------------ summary

console.log(`\n${passed} passed, ${failed} failed`);
for (const item of notes) console.log(`\nnote: ${item}`);
console.log('');

process.exit(failed === 0 ? 0 : 1);
