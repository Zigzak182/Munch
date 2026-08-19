/**
 * Turning a store purchase into a tier.
 *
 * **This module fails closed.** Every path that cannot positively confirm a
 * live subscription returns `free`: missing credentials, an unreachable store
 * API, a malformed response, an expired or revoked purchase, an unrecognised
 * state. There is no branch that grants `plus` by default, and adding one
 * would turn the paywall off for everybody without any test noticing.
 *
 * The stores are the authority. Rather than verifying Apple's JWS offline
 * against its certificate chain, this asks the App Store Server API directly
 * over TLS using our own signed credentials, and trusts that authenticated
 * answer. Same for Play. It is less code to get wrong, and the answer is
 * fresher — an offline receipt says what was true when it was issued, while
 * the API says what is true now, including cancellations.
 */

import { appleConfigured, playConfigured } from './env.js';

const encoder = new TextEncoder();

const base64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const encodeJson = (value) => base64Url(encoder.encode(JSON.stringify(value)));

/** Decode a JWS payload *without* verifying it. Only for values from a TLS
 *  response we already authenticated — never for anything client-supplied. */
export function decodeJwsPayload(jws) {
  const parts = String(jws ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
    ));
  } catch {
    return null;
  }
}

/** PEM (PKCS#8) to the raw bytes WebCrypto wants. */
function pemToBytes(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

/** Sign a JWT with ES256 (Apple) or RS256 (Google service accounts). */
async function signJwt(header, claims, privateKeyPem, algorithm) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(privateKeyPem),
    algorithm.importParams,
    false,
    ['sign'],
  );

  const body = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(algorithm.signParams, key, encoder.encode(body));

  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

const ES256 = {
  importParams: { name: 'ECDSA', namedCurve: 'P-256' },
  signParams: { name: 'ECDSA', hash: 'SHA-256' },
};

const RS256 = {
  importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  signParams: { name: 'RSASSA-PKCS1-v1_5' },
};

const FREE = (reason) => ({ tier: 'free', reason });

// ------------------------------------------------------------------- Apple

const APPLE_HOSTS = {
  production: 'https://api.storekit.itunes.apple.com',
  sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

/** A short-lived ES256 token identifying us to the App Store Server API. */
async function appleAuthToken(config, now) {
  const issuedAt = Math.floor(now / 1000);
  return signJwt(
    { alg: 'ES256', kid: config.apple.keyId, typ: 'JWT' },
    {
      iss: config.apple.issuerId,
      iat: issuedAt,
      exp: issuedAt + 600,
      aud: 'appstoreconnect-v1',
      bid: config.apple.bundleId,
    },
    config.apple.privateKey,
    ES256,
  );
}

/**
 * Ask Apple about a transaction.
 *
 * A subscription is live when it has not expired and has not been revoked;
 * `expiresDate` and `revocationDate` are epoch milliseconds.
 */
export async function appleEntitlement({ transactionId }, config, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!appleConfigured(config)) return FREE('apple_not_configured');
  if (!transactionId) return FREE('missing_transaction');

  const host = APPLE_HOSTS[config.apple.environment] ?? APPLE_HOSTS.production;

  // Signing is separated from the call so a malformed key reads as a
  // configuration fault in the logs rather than as a flaky network.
  let auth;
  try {
    auth = await appleAuthToken(config, now);
  } catch (error) {
    console.error('apple key unusable', error);
    return FREE('apple_bad_key');
  }

  let response;
  try {
    response = await fetchImpl(`${host}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
  } catch (error) {
    console.error('apple lookup failed', error);
    return FREE('apple_unreachable');
  }

  if (!response.ok) {
    console.error('apple lookup rejected', response.status);
    return FREE('apple_rejected');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return FREE('apple_unreadable');
  }

  const transactions = (body.data ?? []).flatMap((group) => group.lastTransactions ?? []);

  for (const entry of transactions) {
    const info = decodeJwsPayload(entry.signedTransactionInfo);
    if (!info) continue;
    if (info.bundleId && info.bundleId !== config.apple.bundleId) continue;
    if (info.revocationDate) continue;
    if (typeof info.expiresDate === 'number' && info.expiresDate > now) {
      return { tier: 'plus', reason: 'apple_active', expiresAt: Math.floor(info.expiresDate / 1000) };
    }
  }

  return FREE('apple_inactive');
}

// -------------------------------------------------------------------- Play

/** Subscription states Google reports that we treat as paid. */
const PLAY_ACTIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

/** Exchange the service account key for an OAuth access token. */
async function playAccessToken(config, now, fetchImpl) {
  const issuedAt = Math.floor(now / 1000);
  const assertion = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: config.play.clientEmail,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
    config.play.privateKey,
    RS256,
  );

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return body?.access_token ?? null;
}

export async function playEntitlement({ purchaseToken }, config, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!playConfigured(config)) return FREE('play_not_configured');
  if (!purchaseToken) return FREE('missing_purchase_token');

  let accessToken;
  try {
    accessToken = await playAccessToken(config, now, fetchImpl);
  } catch (error) {
    // Covers both an unusable service-account key and a failed exchange; both
    // land on free, which is the only safe answer either way.
    console.error('play auth failed', error);
    return FREE('play_unreachable');
  }
  if (!accessToken) return FREE('play_auth_rejected');

  const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'
    + `${encodeURIComponent(config.play.packageName)}/purchases/subscriptionsv2/tokens/`
    + encodeURIComponent(purchaseToken);

  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    console.error('play lookup failed', error);
    return FREE('play_unreachable');
  }

  if (!response.ok) {
    console.error('play lookup rejected', response.status);
    return FREE('play_rejected');
  }

  const body = await response.json().catch(() => null);
  if (!body) return FREE('play_unreadable');
  if (!PLAY_ACTIVE_STATES.has(body.subscriptionState)) return FREE('play_inactive');

  const expiry = body.lineItems?.[0]?.expiryTime;
  const expiresAt = expiry ? Math.floor(Date.parse(expiry) / 1000) : undefined;
  if (expiresAt && expiresAt * 1000 <= now) return FREE('play_expired');

  return { tier: 'plus', reason: 'play_active', expiresAt };
}

// ------------------------------------------------------------------ router

/**
 * The tier a purchase claim earns.
 *
 * Anything unrecognised is free — including `web`, which has no store behind
 * it and so can never be anything else.
 *
 * @returns {Promise<{tier: 'free'|'plus', reason: string, expiresAt?: number}>}
 */
export async function entitlementFor(claim, config, options = {}) {
  switch (claim?.platform) {
    case 'ios':
      return appleEntitlement(claim, config, options);
    case 'android':
      return playEntitlement(claim, config, options);
    case 'web':
      return FREE('web');
    default:
      return FREE('unknown_platform');
  }
}
