import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { resetMemoryStore } from '../src/store.js';
import { verifyToken } from '../src/token.js';
import { freshDb, sqliteAvailable } from './helpers/d1.js';

const skip = sqliteAvailable ? false : 'node:sqlite is unavailable (Node 20)';

const ORIGIN = 'https://www.what2food.com';
const SECRET = 'test-secret-long-enough-for-hmac';

/** Captures the code that would have been emailed. */
let lastMail = null;

function envWith(db, extra = {}) {
  return {
    GOOGLE_PLACES_KEY: 'server-side-key',
    TOKEN_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    MUNCH_DB: db,
    ...extra,
  };
}

const post = (path, body, { token } = {}) => new Request(`https://api.test${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const get = (path, { token } = {}) => new Request(`https://api.test${path}`, {
  headers: { Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});

/** Intercept the mail provider and Google alike. */
function stubNetwork({ play = null } = {}) {
  globalThis.fetch = async (url, init) => {
    const text = String(url);
    if (text.includes('api.resend.com')) {
      lastMail = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ id: 'mail-1' }) };
    }
    if (text.includes('oauth2.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at' }) };
    }
    if (text.includes('androidpublisher')) {
      return { ok: true, status: 200, json: async () => play };
    }
    if (text.includes('places:searchNearby')) {
      return { ok: true, status: 200, json: async () => ({ places: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

test.beforeEach(() => {
  resetMemoryStore();
  lastMail = null;
  stubNetwork();
});

// ------------------------------------------------------------------ no db

test('without a database the auth routes say so rather than half-work', async () => {
  const response = await worker.fetch(
    post('/v1/auth/code', { email: 'a@example.com' }),
    { GOOGLE_PLACES_KEY: 'k', TOKEN_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN },
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'no_accounts');
});

test('anonymous sessions still work with accounts enabled', { skip }, async () => {
  const db = freshDb();
  const response = await worker.fetch(
    post('/v1/session', { platform: 'web', deviceId: 'dev-1' }), envWith(db));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.signedIn, false);
  assert.equal(body.tier, 'free');

  const claims = await verifyToken(body.token, { secret: SECRET });
  assert.equal(claims.kind, 'device');
  assert.equal(claims.sub, 'dev:dev-1');
  db.close();
});

// -------------------------------------------------------------- sign-in

test('a code is emailed and never returned in the response', { skip }, async () => {
  const db = freshDb();
  const response = await worker.fetch(
    post('/v1/auth/code', { email: 'Zig@Example.com', deviceId: 'd' }),
    envWith(db, { RESEND_API_KEY: 'key', MAIL_FROM: 'munch@what2food.com' }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sent, true);
  assert.equal(body.code, undefined, 'the code must never come back over the wire');

  // It did go to the mailbox, addressed to the normalised form.
  assert.deepEqual(lastMail.to, ['zig@example.com']);
  assert.match(lastMail.subject, /\d{6} is your Munch sign-in code/);
  db.close();
});

test('the response is the same for a known and an unknown address', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db, { RESEND_API_KEY: 'key', MAIL_FROM: 'm@what2food.com' });

  // Create one account first.
  const first = await worker.fetch(post('/v1/auth/code', { email: 'known@example.com' }), env);
  const second = await worker.fetch(post('/v1/auth/code', { email: 'stranger@example.com' }), env);

  assert.equal(first.status, second.status);
  assert.deepEqual(await first.json(), await second.json());
  db.close();
});

test('a bad address is rejected before anything is sent', { skip }, async () => {
  const db = freshDb();
  const response = await worker.fetch(post('/v1/auth/code', { email: 'not-an-email' }), envWith(db));

  assert.equal(response.status, 400);
  assert.equal(lastMail, null);
  db.close();
});

test('signing in creates the account and returns an account token', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);

  await worker.fetch(post('/v1/auth/code', { email: 'new@example.com' }), env);

  // The route's own code is only stored as a hash, so the test replaces it
  // with one it knows rather than trying to read it back — which is itself
  // the property being relied on.
  const { issueLoginCode } = await import('../src/accounts.js');
  const issued = await issueLoginCode(db, 'new@example.com', { code: '424242' });

  const response = await worker.fetch(
    post('/v1/auth/verify', { email: 'new@example.com', code: issued.code }), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.signedIn, true);
  assert.equal(body.email, 'new@example.com');
  assert.equal(body.tier, 'free');

  const claims = await verifyToken(body.token, { secret: SECRET });
  assert.equal(claims.kind, 'account');
  assert.match(claims.sub, /^acct:/);
  db.close();
});

test('a wrong code is refused, and says nothing about why', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);
  const { issueLoginCode } = await import('../src/accounts.js');
  await issueLoginCode(db, 'a@example.com', { code: '111111' });

  const wrong = await worker.fetch(
    post('/v1/auth/verify', { email: 'a@example.com', code: '222222' }), env);
  const missing = await worker.fetch(
    post('/v1/auth/verify', { email: 'nobody@example.com', code: '222222' }), env);

  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await wrong.json(), await missing.json(),
    'the two failures must be indistinguishable');
  db.close();
});

// ------------------------------------------------------------- purchases

const ACTIVE_PLAY = {
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  lineItems: [{ expiryTime: new Date(Date.now() + 30 * 86_400_000).toISOString() }],
};

const PLAY_ENV = {
  PLAY_PACKAGE_NAME: 'com.what2food.munch',
  PLAY_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
};

async function signIn(db, env, email) {
  const { issueLoginCode } = await import('../src/accounts.js');
  const { code } = await issueLoginCode(db, email, { code: '424242' });
  const response = await worker.fetch(post('/v1/auth/verify', { email, code }), env);
  return (await response.json()).token;
}

test('a purchase attaches to the account and upgrades it', { skip }, async () => {
  // Play verification needs a real key to sign the assertion; generate one.
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;

  stubNetwork({ play: ACTIVE_PLAY });
  const db = freshDb();
  const env = envWith(db, { ...PLAY_ENV, PLAY_PRIVATE_KEY: pem });

  const token = await signIn(db, env, 'buyer@example.com');

  const response = await worker.fetch(
    post('/v1/purchase', { platform: 'android', purchaseToken: 'tok-1', productId: 'plus_monthly' },
      { token }),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.tier, 'plus');
  assert.ok(body.courses.includes('dessert'));

  // And it survives a fresh sign-in on another device.
  const again = await signIn(db, env, 'buyer@example.com');
  const me = await worker.fetch(get('/v1/me', { token: again }), env);
  const profile = await me.json();

  assert.equal(profile.tier, 'plus');
  assert.equal(profile.subscription.platform, 'android');
  db.close();
});

test('attaching a purchase needs a signed-in session', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);

  const anon = await worker.fetch(post('/v1/session', { platform: 'web', deviceId: 'd' }), env);
  const { token } = await anon.json();

  const response = await worker.fetch(
    post('/v1/purchase', { platform: 'android', purchaseToken: 't' }, { token }), env);

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'sign_in_required');
  db.close();
});

test('a purchase already owned by someone else is refused', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);
  const { upsertAccount, recordEntitlement } = await import('../src/accounts.js');

  const owner = await upsertAccount(db, 'owner@example.com');
  await recordEntitlement(db, {
    accountId: owner.id, platform: 'android', purchaseId: 'shared', state: 'active',
    expiresAt: Math.floor((Date.now() + 86_400_000) / 1000),
  });

  const token = await signIn(db, env, 'freeloader@example.com');
  const response = await worker.fetch(
    post('/v1/purchase', { platform: 'android', purchaseToken: 'shared' }, { token }), env);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'already_claimed');
  db.close();
});

// -------------------------------------------------------------------- me

test('/v1/me reports an anonymous session honestly', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);
  const anon = await worker.fetch(post('/v1/session', { platform: 'web', deviceId: 'd' }), env);
  const { token } = await anon.json();

  const response = await worker.fetch(get('/v1/me', { token }), env);
  const body = await response.json();

  assert.equal(body.signedIn, false);
  assert.equal(body.tier, 'free');
  db.close();
});

test('/v1/me re-reads the tier rather than trusting the token', { skip }, async () => {
  // A token minted while paid must not keep working once the row lapses.
  const db = freshDb();
  const env = envWith(db);
  const { upsertAccount, recordEntitlement } = await import('../src/accounts.js');

  const account = await upsertAccount(db, 'lapsing@example.com');
  await recordEntitlement(db, {
    accountId: account.id, platform: 'android', purchaseId: 'p', state: 'active',
    expiresAt: Math.floor((Date.now() + 86_400_000) / 1000),
  });

  const token = await signIn(db, env, 'lapsing@example.com');
  assert.equal((await (await worker.fetch(get('/v1/me', { token }), env)).json()).tier, 'plus');

  // The subscription lapses; the token is untouched and still valid.
  await recordEntitlement(db, {
    accountId: account.id, platform: 'android', purchaseId: 'p', state: 'expired',
    expiresAt: Math.floor((Date.now() - 1000) / 1000),
  });

  const after = await worker.fetch(get('/v1/me', { token }), env);
  assert.equal((await after.json()).tier, 'free');
  db.close();
});

// ---------------------------------------------------------------- deletion

test('an account can be deleted, which both stores require', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);
  const { upsertAccount, recordEntitlement, findAccountByEmail } = await import('../src/accounts.js');

  const account = await upsertAccount(db, 'leaving@example.com');
  await recordEntitlement(db, {
    accountId: account.id, platform: 'android', purchaseId: 'gone', state: 'active',
    expiresAt: Math.floor((Date.now() + 86_400_000) / 1000),
  });

  const token = await signIn(db, env, 'leaving@example.com');
  const response = await worker.fetch(new Request('https://api.test/v1/me', {
    method: 'DELETE',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
  }), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.deleted, true);
  // It must say plainly that the subscription is not cancelled by this.
  assert.match(body.note, /cancel|does not stop it renewing/i);

  assert.equal(await findAccountByEmail(db, 'leaving@example.com'), null);
  const left = await db.prepare('SELECT * FROM entitlements WHERE account_id = ?')
    .bind(account.id).all();
  assert.equal(left.results.length, 0, 'entitlements must go with the account');
  db.close();
});

test('deletion needs a signed-in session, not just any token', { skip }, async () => {
  const db = freshDb();
  const env = envWith(db);
  const anon = await worker.fetch(post('/v1/session', { platform: 'web', deviceId: 'd' }), env);
  const { token } = await anon.json();

  const response = await worker.fetch(new Request('https://api.test/v1/me', {
    method: 'DELETE',
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
  }), env);

  assert.equal(response.status, 401);
  db.close();
});
