import test from 'node:test';
import assert from 'node:assert/strict';

import { readEnv } from '../src/env.js';
import { appleEntitlement, decodeJwsPayload, entitlementFor, playEntitlement } from '../src/entitlement.js';

/**
 * Real throwaway keys, generated here.
 *
 * A placeholder string would fail at the signing step, so the store stubs
 * below would never be reached and these tests would pass for the wrong
 * reason — the JWT signing is part of what they cover.
 */
function toPem(buffer) {
  const body = Buffer.from(buffer).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

async function generatePem(algorithm) {
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  return toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
}

const APPLE_ENV = {
  APPLE_KEY_ID: 'KEY123',
  APPLE_ISSUER_ID: 'ISSUER123',
  APPLE_BUNDLE_ID: 'com.what2food.munch',
  APPLE_PRIVATE_KEY: await generatePem({ name: 'ECDSA', namedCurve: 'P-256' }),
};

const PLAY_ENV = {
  PLAY_PACKAGE_NAME: 'com.what2food.munch',
  PLAY_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
  PLAY_PRIVATE_KEY: await generatePem({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }),
};

const jws = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, text: async () => '' });

const NOW = 1_700_000_000_000;

// --------------------------------------------------------------- fails closed

test('an unknown platform is free', async () => {
  const config = readEnv({});
  assert.equal((await entitlementFor({ platform: 'nintendo' }, config)).tier, 'free');
  assert.equal((await entitlementFor({}, config)).tier, 'free');
  assert.equal((await entitlementFor(null, config)).tier, 'free');
});

test('the web is always free — there is no store behind it', async () => {
  const result = await entitlementFor({ platform: 'web', deviceId: 'd' }, readEnv({}));
  assert.equal(result.tier, 'free');
  assert.equal(result.reason, 'web');
});

test('without store credentials nobody gets plus', async () => {
  // The state a fresh deployment is in. It must sell nothing rather than
  // give everything away.
  const config = readEnv({});

  const apple = await entitlementFor({ platform: 'ios', transactionId: 't' }, config);
  const play = await entitlementFor({ platform: 'android', purchaseToken: 'p' }, config);

  assert.equal(apple.tier, 'free');
  assert.equal(apple.reason, 'apple_not_configured');
  assert.equal(play.tier, 'free');
  assert.equal(play.reason, 'play_not_configured');
});

test('an unreachable or unhappy store is free, not plus', async () => {
  const config = readEnv(APPLE_ENV);
  const cases = [
    ['apple_unreachable', () => { throw new Error('network'); }],
    ['apple_rejected', () => fail(401)],
    ['apple_unreadable', () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })],
  ];

  for (const [reason, fetchImpl] of cases) {
    const result = await appleEntitlement({ transactionId: 't' }, config, { now: NOW, fetchImpl });
    assert.equal(result.tier, 'free', reason);
    assert.equal(result.reason, reason);
  }
});

// ------------------------------------------------------------------- Apple

test('a live Apple subscription grants plus', async () => {
  const config = readEnv(APPLE_ENV);
  const fetchImpl = async () => ok({
    data: [{
      lastTransactions: [{
        signedTransactionInfo: jws({
          bundleId: 'com.what2food.munch',
          expiresDate: NOW + 86_400_000,
        }),
      }],
    }],
  });

  const result = await appleEntitlement({ transactionId: 't' }, config, { now: NOW, fetchImpl });
  assert.equal(result.tier, 'plus');
  assert.equal(result.expiresAt, Math.floor((NOW + 86_400_000) / 1000));
});

test('an expired or revoked Apple subscription does not', async () => {
  const config = readEnv(APPLE_ENV);

  const expired = async () => ok({
    data: [{ lastTransactions: [{ signedTransactionInfo: jws({
      bundleId: 'com.what2food.munch', expiresDate: NOW - 1000,
    }) }] }],
  });
  const revoked = async () => ok({
    data: [{ lastTransactions: [{ signedTransactionInfo: jws({
      bundleId: 'com.what2food.munch', expiresDate: NOW + 86_400_000, revocationDate: NOW - 5000,
    }) }] }],
  });

  assert.equal((await appleEntitlement({ transactionId: 't' }, config, { now: NOW, fetchImpl: expired })).tier, 'free');
  assert.equal((await appleEntitlement({ transactionId: 't' }, config, { now: NOW, fetchImpl: revoked })).tier, 'free');
});

test('a subscription for a different app is ignored', async () => {
  // Otherwise any Apple subscription anywhere would unlock Munch+.
  const config = readEnv(APPLE_ENV);
  const fetchImpl = async () => ok({
    data: [{ lastTransactions: [{ signedTransactionInfo: jws({
      bundleId: 'com.someone.else', expiresDate: NOW + 86_400_000,
    }) }] }],
  });

  assert.equal((await appleEntitlement({ transactionId: 't' }, config, { now: NOW, fetchImpl })).tier, 'free');
});

test('a missing transaction id never reaches the store', async () => {
  const config = readEnv(APPLE_ENV);
  let called = false;
  const fetchImpl = async () => { called = true; return ok({}); };

  const result = await appleEntitlement({}, config, { now: NOW, fetchImpl });
  assert.equal(result.reason, 'missing_transaction');
  assert.equal(called, false);
});

// -------------------------------------------------------------------- Play

/** Play needs a token exchange first, then the purchase lookup. */
function playFetch(subscription, { token = 'access-token' } = {}) {
  return async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return ok(token ? { access_token: token } : {});
    }
    return subscription;
  };
}

test('an active Play subscription grants plus', async () => {
  const config = readEnv(PLAY_ENV);
  const fetchImpl = playFetch(ok({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [{ expiryTime: new Date(NOW + 86_400_000).toISOString() }],
  }));

  const result = await playEntitlement({ purchaseToken: 'p' }, config, { now: NOW, fetchImpl });
  assert.equal(result.tier, 'plus');
});

test('a grace-period subscription still counts', async () => {
  const config = readEnv(PLAY_ENV);
  const fetchImpl = playFetch(ok({
    subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    lineItems: [{ expiryTime: new Date(NOW + 3600_000).toISOString() }],
  }));

  assert.equal((await playEntitlement({ purchaseToken: 'p' }, config, { now: NOW, fetchImpl })).tier, 'plus');
});

test('cancelled, paused and expired Play states do not', async () => {
  const config = readEnv(PLAY_ENV);

  for (const state of ['SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_PAUSED',
    'SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_ON_HOLD', 'ANYTHING_ELSE']) {
    const fetchImpl = playFetch(ok({ subscriptionState: state, lineItems: [] }));
    const result = await playEntitlement({ purchaseToken: 'p' }, config, { now: NOW, fetchImpl });
    assert.equal(result.tier, 'free', `${state} should not grant plus`);
  }
});

test('an active state with a past expiry is still refused', async () => {
  const config = readEnv(PLAY_ENV);
  const fetchImpl = playFetch(ok({
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [{ expiryTime: new Date(NOW - 1000).toISOString() }],
  }));

  const result = await playEntitlement({ purchaseToken: 'p' }, config, { now: NOW, fetchImpl });
  assert.equal(result.tier, 'free');
  assert.equal(result.reason, 'play_expired');
});

test('a failed token exchange is free', async () => {
  const config = readEnv(PLAY_ENV);
  const fetchImpl = playFetch(ok({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' }), { token: null });

  assert.equal((await playEntitlement({ purchaseToken: 'p' }, config, { now: NOW, fetchImpl })).reason,
    'play_auth_rejected');
});

// ------------------------------------------------------------------- decode

test('decodeJwsPayload reads a payload and rejects rubbish', () => {
  assert.deepEqual(decodeJwsPayload(jws({ a: 1 })), { a: 1 });
  for (const bad of ['', 'a.b', 'a.!!!.c', null, undefined]) {
    assert.equal(decodeJwsPayload(bad), null);
  }
});
