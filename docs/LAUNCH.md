# Getting Munch live

Android first, then Apple once Android is proven. In order, because each part
depends on the one before it.

Two things worth knowing before you start, because they set the timeline:

- **Google may require 12 testers for 14 continuous days** before it will let a
  *personal* developer account publish to production. That is a two-week wall
  you cannot shorten, and it is the single most common reason a first launch
  slips. Organisation accounts are exempt. Check which you have before
  planning around a date. (See [Stage 2](#stage-2--google-play).)
- **Apple charges $99/year, Google charges $25 once.** So ~$124 in the first
  year before a penny comes in — around 12 subscribers at $0.99 net.

---

## Stage 0 — Deploy the backend

Nothing else works until this does. The app in the stores talks to this, not
to Google directly.

```bash
cd server

npm install -g wrangler
wrangler login

# Shared cache and rate-limit counters
wrangler kv namespace create MUNCH_KV
#   → paste the id into wrangler.toml

# Accounts and entitlements
wrangler d1 create munch
#   → paste the database_id into wrangler.toml
wrangler d1 migrations apply munch --remote

# Secrets — never in wrangler.toml, which is committed
wrangler secret put GOOGLE_PLACES_KEY   # a NEW key: Places API (New) + Geocoding only
wrangler secret put TOKEN_SECRET        # openssl rand -base64 32
wrangler secret put RESEND_API_KEY      # for sign-in codes
wrangler deploy
```

Check it: `curl https://munch-api.<you>.workers.dev/v1/health` should return
`{"ok":true,"missing":[]}`.

Then point the site at it — in `munch.config.js`:

```js
apiBase: 'https://munch-api.<you>.workers.dev',
```

### Email

Sign-in codes need a sender. [Resend](https://resend.com) has a free tier;
verify the `what2food.com` domain and add its DKIM/SPF records, or codes will
land in spam and sign-in will look broken. Set `MAIL_FROM` in `wrangler.toml`
to an address on the verified domain.

Without `RESEND_API_KEY` the worker logs the code instead of sending it —
fine for testing (`wrangler tail`), useless for real users.

### Revoke the old key

The current combined key has been public on what2food.com and should be
treated as compromised. Once traffic flows through the proxy: restrict the
browser key to **Maps JavaScript API** only, then delete the old one and issue
a fresh browser key.

**Checkpoint:** what2food.com works, a dessert search is refused as Munch+, and
signing in with an emailed code works.

---

## Stage 1 — Build the app

### What to build it with

You need **Google Play Billing** — Play requires it for digital goods, so a
plain web wrapper cannot take the payment. That rules out a pure PWA or a
Trusted Web Activity.

**Capacitor** is the fit: it wraps the existing site in a native shell and
gives you native plugins for billing, geolocation and the rest. You keep one
codebase.

```bash
npm install @capacitor/core @capacitor/cli
npx cap init Munch com.what2food.munch --web-dir=.
npm install @capacitor/android
npx cap add android
```

Set `server.url` in `capacitor.config.json` to `https://www.what2food.com`
during development so the shell loads the live site; bundle the assets locally
before release so the app still opens without a connection.

### Billing: roll your own or RevenueCat

The backend already verifies Play and App Store purchases, so you can call
`/v1/purchase` directly from the billing plugin's success callback and be
done.

[RevenueCat](https://www.revenuecat.com) is the alternative: it wraps both
stores, handles receipt validation and renewal webhooks, and is free below
~$2.5k/month revenue. It would replace `server/src/entitlement.js`. Worth it
if renewal edge cases start eating your time; not worth adding before you have
a single subscriber.

### The one thing that gets apps rejected

Apple guideline 4.2 rejects apps that are "simply a repackaged website".
Android is more permissive, but the same work protects both. Before submitting
to Apple, add things a website cannot do:

- native location permission prompts (not the browser's)
- offline handling — a real screen, not a Chrome error page
- a native share sheet for a diagnosis
- ideally a home-screen widget or shortcut

Android first partly for this reason: you get a real app shipped and tested
while the iOS-specific polish is still being written.

---

## Stage 2 — Google Play

### 2.1 Account and app

1. Register at [play.google.com/console](https://play.google.com/console) —
   **$25, one time**. Choose **organisation** over personal if you have a
   registered business; it exempts you from the 12-tester rule below.
2. Identity verification takes a few days. Start it now.
3. Create the app: name, default language, "App", "Paid or free: Free"
   (the app is free; the subscription is an in-app product).

### 2.2 The subscription product

**Monetise → Products → Subscriptions → Create.**

- Product ID: `munch_plus_monthly` — **this cannot be changed later**
- Name: Munch+
- Base plan: monthly, auto-renewing, $0.99
- Consider a 7-day free trial; it lifts conversion and costs nothing on
  subscriptions nobody would have bought

Set `PLAY_PACKAGE_NAME` in `wrangler.toml` to `com.what2food.munch`.

### 2.3 Service account, so the backend can verify purchases

1. Play Console → **Setup → API access → Create new service account**; it
   sends you to Google Cloud.
2. Create the service account, then create a **JSON key** and download it.
3. Back in Play Console, grant it **View financial data** and **Manage
   orders and subscriptions**.
4. From the JSON:
   ```bash
   wrangler secret put PLAY_CLIENT_EMAIL   # "client_email"
   wrangler secret put PLAY_PRIVATE_KEY    # "private_key", newlines and all
   ```

Permissions can take up to 24 hours to propagate. If verification returns
`play_rejected` on day one, wait before debugging it.

### 2.4 Store listing

All required before you can publish:

- Short description (80 chars) and full description (4000)
- App icon 512×512, feature graphic 1024×500
- At least 2 phone screenshots
- **Privacy policy URL** — mandatory. You collect location and, now, email
  addresses. Host it at `what2food.com/privacy`.
- **Data safety form**: declare location (app functionality, not shared) and
  email (account management). Answering this wrongly is a suspension risk —
  it is a legal declaration, not a marketing form.
- Content rating questionnaire
- Target audience: 13+ keeps you out of the Families programme's extra rules

### 2.5 Account deletion

Play requires a way to request account deletion, **both in-app and at a public
URL**. In-app is already built (the "Delete account" link in the sign-in
strip). Add a web page at `what2food.com/delete-account` explaining the same
thing, and enter that URL in the Data safety form.

### 2.6 Testing tracks — the 14-day wall

1. **Internal testing** — up to 100 testers, live in minutes. Do all real
   debugging here. Test on a real device with a real card; sandbox purchases
   behave differently.
2. **Closed testing** — if your account is **personal and was created after
   13 Nov 2023**, Google requires **12 testers opted in continuously for 14
   days** before production access opens. Recruit the twelve early, get them
   to actually install and keep it installed, and start the clock while you
   polish. This is not something you can rush at the end.
3. **Production** — staged rollout, start at 20%.

### 2.7 Verify before you promote

- [ ] A real purchase completes and `/v1/purchase` returns `tier: "plus"`
- [ ] Desserts unlock immediately after purchase
- [ ] Munch+ follows the account to a second device after signing in
- [ ] Cancelling in Play drops the account back to free by the expiry date
- [ ] Deleting an account works and says the subscription is separate
- [ ] `wrangler tail` shows no `play_rejected` or `play_bad_key`

---

## Stage 3 — Apple, once Android is proven

Only start once Android has real users and the purchase path has held up.
Apple's review is slower and stricter; going second means arriving with the
bugs already found.

### 3.1 Account

- [developer.apple.com/programs](https://developer.apple.com/programs) —
  **$99/year**. Organisation enrolment needs a D-U-N-S number and takes
  1–2 weeks; individual is faster.
- You need a Mac with Xcode to build and submit. No way around it.

### 3.2 The app

```bash
npm install @capacitor/ios
npx cap add ios
npx cap open ios
```

In App Store Connect: create the app, bundle ID `com.what2food.munch`.

### 3.3 The subscription

**Features → Subscriptions → create a group**, then a subscription:

- Product ID: `munch_plus_monthly` — same as Android for your own sanity
- $0.99/month, auto-renewable
- Add a localised display name and description, and a review screenshot

Then the credentials the backend needs:

1. **Users and Access → Integrations → In-App Purchase → generate a key**
2. Download the `.p8` (**once only** — it cannot be downloaded again)
3. ```bash
   wrangler secret put APPLE_KEY_ID       # from the key list
   wrangler secret put APPLE_ISSUER_ID    # top of the Integrations page
   wrangler secret put APPLE_PRIVATE_KEY  # contents of the .p8
   ```
4. Set `APPLE_BUNDLE_ID` in `wrangler.toml`, and `APPLE_ENVIRONMENT` to
   `sandbox` while testing — sandbox receipts fail against production and the
   failure looks exactly like a broken key.

### 3.4 Review

- **TestFlight first.** Internal testers are instant; external needs a review
  pass but a light one.
- Expect 24–48 hours per submission. Budget for one rejection.
- In App Review notes: explain that Munch+ unlocks dessert search, and give a
  **sandbox account** they can use. Reviewers who cannot test the paid path
  reject the app.
- Guideline 3.1.1: the subscription must use in-app purchase. Do not mention
  or link to any other way to pay from inside the app.
- Guideline 4.2: see [Stage 1](#the-one-thing-that-gets-apps-rejected).
- Guideline 5.1.1(v): in-app account deletion — already built.
- **Sign in with Apple is not required here.** It becomes mandatory only if
  you offer third-party social login (Google, Facebook). Email codes avoid
  that entirely; adding "Sign in with Google" later would pull Apple sign-in
  in with it.

### 3.5 Also required

- Privacy policy URL (same one)
- **App Privacy** questionnaire — Apple's version of Data safety. Declare
  location and email.
- Subscription terms in the description: price, period, and that it
  auto-renews. Apple rejects listings that omit this.

---

## Stage 4 — After launch

- **Refunds.** Entitlement is checked when a session is issued and the token
  stands for `TOKEN_TTL_HOURS` (24 by default), so a refund can leave up to a
  day of access. Shorten it, or consume Play RTDN and App Store Server
  Notifications to revoke immediately.
- **Watch the Google bill.** The shared cache should keep it low, but set a
  budget alert regardless.
- **Watch `wrangler tail`** for `apple_*` / `play_*` failure reasons. Every
  one means somebody paid and did not get what they paid for.
- **Who is paying:**
  ```bash
  wrangler d1 execute munch --remote --command \
    "SELECT a.email, e.platform, e.state, datetime(e.expires_at,'unixepoch') AS expires
       FROM entitlements e JOIN accounts a ON a.id = e.account_id
      WHERE e.state = 'active' ORDER BY e.expires_at DESC"
  ```

---

## Realistic timeline

| | |
| --- | --- |
| Backend deployed and live | a day |
| Capacitor shell + billing | a few days |
| Play account verification | 2–5 days (start early) |
| Internal testing and fixes | a week |
| **Closed testing wall** | **14 days, if personal account** |
| Play production | a day |
| iOS build and TestFlight | a week |
| App Store review | 1–3 days, plus a likely rejection |

**Roughly 5–7 weeks to both stores**, most of it waiting rather than working.
The two long poles — Play's 14-day test window and Apple's enrolment — both
start on the day you begin them, so begin them first and build while they run.
