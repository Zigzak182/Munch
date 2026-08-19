import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, sqliteAvailable } from './helpers/d1.js';
import {
  CODE_MAX_ATTEMPTS, accountForPurchase, entitlementsFor, findAccountByEmail,
  generateCode, issueLoginCode, looksLikeEmail, normalizeEmail, recordEntitlement,
  sha256Hex, tierForAccount, upsertAccount, verifyLoginCode,
} from '../src/accounts.js';

const skip = sqliteAvailable ? false : 'node:sqlite is unavailable (Node 20)';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

// ------------------------------------------------------------ pure helpers

test('emails are normalised before they are compared', () => {
  assert.equal(normalizeEmail('  Zig@Example.COM '), 'zig@example.com');
  assert.equal(normalizeEmail(undefined), '');
});

test('obvious junk is rejected without pretending to check deliverability', () => {
  for (const good of ['a@b.co', 'zigzak182@gmail.com', 'first.last+tag@sub.domain.org']) {
    assert.ok(looksLikeEmail(good), good);
  }
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@b.co', 'a@.co', `${'x'.repeat(250)}@b.co`]) {
    assert.ok(!looksLikeEmail(bad), bad);
  }
});

test('codes are six digits and come from the CSPRNG', () => {
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  // Not a randomness test — just enough to catch a constant.
  assert.ok(codes.size > 100, `only ${codes.size} distinct codes in 200`);
});

// --------------------------------------------------------------- accounts

test('signing in twice reuses the account rather than making a second', { skip }, async () => {
  const db = freshDb();
  const first = await upsertAccount(db, 'Zig@Example.com', { now: NOW });
  const second = await upsertAccount(db, '  zig@example.com  ', { now: NOW + MINUTE });

  assert.equal(first.id, second.id);
  assert.equal(second.email, 'zig@example.com');
  assert.ok(second.last_seen_at > first.last_seen_at);

  const { results } = await db.prepare('SELECT * FROM accounts').bind().all();
  assert.equal(results.length, 1);
  db.close();
});

test('there is no separate sign-up — a first code creates the account', { skip }, async () => {
  const db = freshDb();
  assert.equal(await findAccountByEmail(db, 'new@example.com'), null);

  await upsertAccount(db, 'new@example.com', { now: NOW });
  assert.ok(await findAccountByEmail(db, 'new@example.com'));
  db.close();
});

// ------------------------------------------------------------ login codes

test('only the hash of a code is stored', { skip }, async () => {
  const db = freshDb();
  const { code } = await issueLoginCode(db, 'a@example.com', { now: NOW });

  const row = await db.prepare('SELECT * FROM login_codes WHERE email = ?')
    .bind('a@example.com').first();

  assert.notEqual(row.code_hash, code);
  assert.equal(row.code_hash, await sha256Hex(code));
  db.close();
});

test('a correct code works exactly once', { skip }, async () => {
  const db = freshDb();
  const { code } = await issueLoginCode(db, 'a@example.com', { now: NOW });

  assert.deepEqual(await verifyLoginCode(db, 'a@example.com', code, { now: NOW }), { ok: true });
  // Replaying it must fail — the row is gone.
  assert.equal((await verifyLoginCode(db, 'a@example.com', code, { now: NOW })).reason, 'no_code');
  db.close();
});

test('an expired code is refused', { skip }, async () => {
  const db = freshDb();
  const { code } = await issueLoginCode(db, 'a@example.com', { now: NOW });

  const late = NOW + 11 * MINUTE;
  assert.equal((await verifyLoginCode(db, 'a@example.com', code, { now: late })).reason, 'expired');
  db.close();
});

test('guessing is capped, and running out burns the code', { skip }, async () => {
  const db = freshDb();
  const { code } = await issueLoginCode(db, 'a@example.com', { now: NOW });

  for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) {
    const result = await verifyLoginCode(db, 'a@example.com', '000000', { now: NOW });
    assert.equal(result.reason, 'wrong_code');
  }

  // The real code no longer helps: the attempts are spent.
  const result = await verifyLoginCode(db, 'a@example.com', code, { now: NOW });
  assert.equal(result.reason, 'too_many_attempts');
  db.close();
});

test('requesting a new code invalidates the old one', { skip }, async () => {
  const db = freshDb();
  const { code: first } = await issueLoginCode(db, 'a@example.com', { now: NOW });
  const { code: second } = await issueLoginCode(db, 'a@example.com', { now: NOW + MINUTE });

  assert.equal((await verifyLoginCode(db, 'a@example.com', first, { now: NOW + MINUTE })).reason,
    'wrong_code');
  assert.deepEqual(await verifyLoginCode(db, 'a@example.com', second, { now: NOW + MINUTE }),
    { ok: true });
  db.close();
});

test('a code for one address does not unlock another', { skip }, async () => {
  const db = freshDb();
  const { code } = await issueLoginCode(db, 'a@example.com', { now: NOW });

  assert.equal((await verifyLoginCode(db, 'b@example.com', code, { now: NOW })).reason, 'no_code');
  db.close();
});

// ----------------------------------------------------------- entitlements

async function accountWithSub(db, email, { state = 'active', expiresAt, purchaseId = 'p-1' } = {}) {
  const account = await upsertAccount(db, email, { now: NOW });
  await recordEntitlement(db, {
    accountId: account.id,
    platform: 'android',
    purchaseId,
    productId: 'munch_plus_monthly',
    state,
    expiresAt: expiresAt ?? Math.floor((NOW + 30 * 24 * 3600_000) / 1000),
  }, { now: NOW });
  return account;
}

test('an active subscription makes the account plus', { skip }, async () => {
  const db = freshDb();
  const account = await accountWithSub(db, 'paid@example.com');

  const { tier, entitlement } = await tierForAccount(db, account.id, { now: NOW });
  assert.equal(tier, 'plus');
  assert.equal(entitlement.platform, 'android');
  db.close();
});

test('an account with no subscription is free', { skip }, async () => {
  const db = freshDb();
  const account = await upsertAccount(db, 'free@example.com', { now: NOW });

  assert.equal((await tierForAccount(db, account.id, { now: NOW })).tier, 'free');
  db.close();
});

test('a lapsed expiry beats a stale "active" row', { skip }, async () => {
  // The row can still say active if nothing has re-checked it; the clock is
  // the more recent fact, so the clock wins.
  const db = freshDb();
  const account = await accountWithSub(db, 'lapsed@example.com', {
    expiresAt: Math.floor((NOW - MINUTE) / 1000),
  });

  assert.equal((await tierForAccount(db, account.id, { now: NOW })).tier, 'free');
  db.close();
});

test('a revoked subscription is not plus', { skip }, async () => {
  const db = freshDb();
  const account = await accountWithSub(db, 'refunded@example.com', { state: 'revoked' });

  assert.equal((await tierForAccount(db, account.id, { now: NOW })).tier, 'free');
  db.close();
});

test('one purchase cannot light up two accounts', { skip }, async () => {
  // The receipt-passed-between-friends case. The unique constraint plus the
  // conflict clause keep the purchase with whoever claimed it first.
  const db = freshDb();
  const first = await accountWithSub(db, 'first@example.com', { purchaseId: 'shared-token' });
  const second = await upsertAccount(db, 'second@example.com', { now: NOW });

  await recordEntitlement(db, {
    accountId: second.id,
    platform: 'android',
    purchaseId: 'shared-token',
    state: 'active',
    expiresAt: Math.floor((NOW + 86_400_000) / 1000),
  }, { now: NOW });

  const owner = await accountForPurchase(db, 'shared-token');
  assert.equal(owner.account_id, first.id, 'the purchase must stay with the first claimant');
  assert.equal((await tierForAccount(db, second.id, { now: NOW })).tier, 'free');
  db.close();
});

test('re-checking a purchase updates it in place', { skip }, async () => {
  const db = freshDb();
  const account = await accountWithSub(db, 'renew@example.com', { purchaseId: 'tok' });

  await recordEntitlement(db, {
    accountId: account.id,
    platform: 'android',
    purchaseId: 'tok',
    state: 'expired',
    expiresAt: Math.floor((NOW - 1000) / 1000),
  }, { now: NOW });

  const rows = await entitlementsFor(db, account.id);
  assert.equal(rows.length, 1, 'should update, not duplicate');
  assert.equal(rows[0].state, 'expired');
  assert.equal((await tierForAccount(db, account.id, { now: NOW })).tier, 'free');
  db.close();
});

test('a subscription follows the account, not the device', { skip }, async () => {
  // The whole point: same person, new phone, still paid.
  const db = freshDb();
  const account = await accountWithSub(db, 'traveller@example.com');

  const returning = await upsertAccount(db, 'TRAVELLER@example.com', { now: NOW + 90 * MINUTE });
  assert.equal(returning.id, account.id);
  assert.equal((await tierForAccount(db, returning.id, { now: NOW })).tier, 'plus');
  db.close();
});
