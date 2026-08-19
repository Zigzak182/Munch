import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenError, bearerFrom, issueToken, verifyToken } from '../src/token.js';

const SECRET = 'a-test-secret-that-is-long-enough';
const HOUR = 3600;

test('a freshly issued token verifies and carries its claims', async () => {
  const { token, expiresAt } = await issueToken({ sub: 'device-1', tier: 'plus' },
    { secret: SECRET, ttlSeconds: HOUR, now: 1_000_000_000_000 });

  const claims = await verifyToken(token, { secret: SECRET, now: 1_000_000_000_000 });

  assert.equal(claims.sub, 'device-1');
  assert.equal(claims.tier, 'plus');
  assert.equal(claims.exp, expiresAt);
});

test('a token signed with another secret is refused', async () => {
  const { token } = await issueToken({ sub: 'd', tier: 'plus' },
    { secret: 'attacker-secret', ttlSeconds: HOUR });

  await assert.rejects(() => verifyToken(token, { secret: SECRET }), TokenError);
});

test('editing the payload invalidates the token', async () => {
  // The whole paywall rests on this: upgrading yourself to plus by editing
  // the claims must not survive the signature check.
  const { token } = await issueToken({ sub: 'd', tier: 'free' },
    { secret: SECRET, ttlSeconds: HOUR });

  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({
    sub: 'd', tier: 'plus', iat: 1, exp: Math.floor(Date.now() / 1000) + HOUR,
  })).toString('base64url');

  await assert.rejects(
    () => verifyToken(`${header}.${forged}.${signature}`, { secret: SECRET }),
    TokenError,
  );
});

test('an "alg: none" token is refused even with a matching signature slot', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'd', tier: 'plus', exp: Math.floor(Date.now() / 1000) + HOUR,
  })).toString('base64url');

  await assert.rejects(() => verifyToken(`${header}.${payload}.`, { secret: SECRET }), TokenError);
  await assert.rejects(() => verifyToken(`${header}.${payload}.x`, { secret: SECRET }), TokenError);
});

test('an expired token is refused', async () => {
  const start = 1_000_000_000_000;
  const { token } = await issueToken({ sub: 'd', tier: 'plus' },
    { secret: SECRET, ttlSeconds: 60, now: start });

  await assert.doesNotReject(() => verifyToken(token, { secret: SECRET, now: start + 59_000 }));
  await assert.rejects(() => verifyToken(token, { secret: SECRET, now: start + 61_000 }), TokenError);
});

test('malformed input is refused rather than thrown at', async () => {
  for (const bad of ['', 'nonsense', 'a.b', 'a.b.c.d', null, undefined, 42, {}]) {
    await assert.rejects(() => verifyToken(bad, { secret: SECRET }), TokenError,
      `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a token with no subject is refused', async () => {
  const { token } = await issueToken({ sub: '', tier: 'plus' },
    { secret: SECRET, ttlSeconds: HOUR });

  await assert.rejects(() => verifyToken(token, { secret: SECRET }), TokenError);
});

test('bearerFrom reads the header, and only that shape', () => {
  const request = (value) => ({ headers: { get: () => value } });

  assert.equal(bearerFrom(request('Bearer abc.def.ghi')), 'abc.def.ghi');
  assert.equal(bearerFrom(request('bearer abc')), 'abc');
  assert.equal(bearerFrom(request('Basic abc')), null);
  assert.equal(bearerFrom(request(null)), null);
});
