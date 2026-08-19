-- Accounts and entitlements.
--
-- Until now a subscription was tied to whatever device it was bought on: no
-- way to answer "is this person paid?", and a reinstall lost it. These three
-- tables move entitlement onto a person.
--
-- Apply with:  wrangler d1 migrations apply munch --remote

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  -- Stored lowercased and trimmed; UNIQUE is what stops two accounts for the
  -- same person, so normalisation has to happen before the insert.
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,           -- 'ios' | 'android'
  -- Apple's transactionId or Play's purchaseToken. UNIQUE across the table:
  -- one subscription unlocks one account, so a token shared between friends
  -- cannot light up both.
  purchase_id   TEXT NOT NULL UNIQUE,
  product_id    TEXT,
  state         TEXT NOT NULL,           -- 'active' | 'expired' | 'revoked'
  expires_at    INTEGER,                 -- epoch seconds, null when unknown
  checked_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS entitlements_account
  ON entitlements (account_id, state);

-- One live code per address. Requesting another replaces it, so an old code
-- stops working the moment a new one is sent.
CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  -- The hash, never the code. A leaked database should not be a set of live
  -- login credentials.
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
