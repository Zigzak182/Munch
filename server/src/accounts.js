/**
 * Accounts, login codes and entitlements — everything that needs a query
 * rather than a key lookup.
 *
 * All SQL lives here. Callers pass a D1 database (or anything with the same
 * `prepare/bind/first/all/run` shape, which is what the tests supply over
 * node:sqlite), so the rest of the worker never assembles a statement.
 */

const encoder = new TextEncoder();

/** Addresses are compared lowercased and trimmed, and stored that way. */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Good enough to reject typos and obvious junk without pretending to
 * validate deliverability — the code that never arrives does that.
 */
export function looksLikeEmail(value) {
  const email = normalizeEmail(value);
  return email.length >= 5 && email.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A six-digit code from the CSPRNG, not Math.random. */
export function generateCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, '0');
}

const nowSeconds = (now) => Math.floor(now / 1000);

// ---------------------------------------------------------------- accounts

export async function findAccountByEmail(db, email) {
  return db.prepare('SELECT * FROM accounts WHERE email = ?')
    .bind(normalizeEmail(email))
    .first();
}

export async function findAccountById(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(String(id)).first();
}

/**
 * The account for an address, created on first sign-in.
 *
 * There is no separate sign-up: proving you can read the address is the
 * whole of registration, so a first-time code and a returning one are the
 * same flow.
 */
export async function upsertAccount(db, email, { now = Date.now() } = {}) {
  const address = normalizeEmail(email);
  const seconds = nowSeconds(now);

  const existing = await findAccountByEmail(db, address);
  if (existing) {
    await db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?')
      .bind(seconds, existing.id).run();
    return { ...existing, last_seen_at: seconds };
  }

  const id = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO accounts (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ).bind(id, address, seconds, seconds).run();

  return { id, email: address, created_at: seconds, last_seen_at: seconds };
}

// ------------------------------------------------------------- login codes

/** How long a code is good for, and how many guesses it allows. */
export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;

/**
 * Issue a code, replacing any outstanding one for that address.
 *
 * Returns the plaintext code for sending. Only the hash is stored, so a
 * dump of this table is not a set of live credentials.
 */
export async function issueLoginCode(db, email, { now = Date.now(), code = generateCode() } = {}) {
  const address = normalizeEmail(email);
  const seconds = nowSeconds(now);
  const expiresAt = seconds + CODE_TTL_MINUTES * 60;

  await db.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       created_at = excluded.created_at`,
  ).bind(address, await sha256Hex(code), expiresAt, seconds).run();

  return { code, expiresAt };
}

/**
 * Check a code and consume it.
 *
 * A correct code is deleted immediately — one use, whatever happens next.
 * A wrong one costs an attempt, and running out of attempts burns the code
 * rather than leaving it open to be ground down.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyLoginCode(db, email, code, { now = Date.now() } = {}) {
  const address = normalizeEmail(email);
  const row = await db.prepare('SELECT * FROM login_codes WHERE email = ?').bind(address).first();

  if (!row) return { ok: false, reason: 'no_code' };

  const seconds = nowSeconds(now);
  if (row.expires_at <= seconds) {
    await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(address).run();
    return { ok: false, reason: 'expired' };
  }

  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(address).run();
    return { ok: false, reason: 'too_many_attempts' };
  }

  // Comparing hashes rather than the codes themselves: both sides are then
  // fixed-length hex, so the comparison leaks nothing about the real code.
  if (await sha256Hex(String(code ?? '')) !== row.code_hash) {
    await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?')
      .bind(address).run();
    return { ok: false, reason: 'wrong_code' };
  }

  await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(address).run();
  return { ok: true };
}

// ------------------------------------------------------------ entitlements

/**
 * Record what a store said about a purchase.
 *
 * `purchase_id` is unique table-wide, so re-sending the same receipt updates
 * the existing row rather than granting a second account access. The conflict
 * clause deliberately does *not* move `account_id`: a purchase stays with the
 * account that first claimed it, and a second account presenting the same
 * receipt gets nothing.
 */
export async function recordEntitlement(db, {
  accountId, platform, purchaseId, productId = null, state, expiresAt = null,
}, { now = Date.now() } = {}) {
  const seconds = nowSeconds(now);

  await db.prepare(
    `INSERT INTO entitlements
       (account_id, platform, purchase_id, product_id, state, expires_at, checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(purchase_id) DO UPDATE SET
       state = excluded.state,
       expires_at = excluded.expires_at,
       product_id = excluded.product_id,
       checked_at = excluded.checked_at`,
  ).bind(accountId, platform, purchaseId, productId, state, expiresAt, seconds, seconds).run();

  return db.prepare('SELECT * FROM entitlements WHERE purchase_id = ?').bind(purchaseId).first();
}

/** Every entitlement on an account, newest first. */
export async function entitlementsFor(db, accountId) {
  const { results } = await db.prepare(
    'SELECT * FROM entitlements WHERE account_id = ? ORDER BY checked_at DESC',
  ).bind(String(accountId)).all();
  return results ?? [];
}

/**
 * The tier an account is entitled to right now.
 *
 * Active *and* unexpired: a row can say `active` while its expiry has passed
 * if nothing has re-checked it since, and the clock is the more recent fact.
 */
export async function tierForAccount(db, accountId, { now = Date.now() } = {}) {
  const seconds = nowSeconds(now);

  const row = await db.prepare(
    `SELECT * FROM entitlements
      WHERE account_id = ? AND state = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY expires_at DESC LIMIT 1`,
  ).bind(String(accountId), seconds).first();

  return row ? { tier: 'plus', entitlement: row } : { tier: 'free', entitlement: null };
}

/** Which account owns a purchase, if any. */
export async function accountForPurchase(db, purchaseId) {
  return db.prepare('SELECT * FROM entitlements WHERE purchase_id = ?')
    .bind(String(purchaseId)).first();
}
