/**
 * Deployment configuration, read from the platform's environment.
 *
 * Nothing here has a default that would weaken security. The two secrets the
 * service cannot work without — the Places key and the token signing secret —
 * have no fallback, and a request arrives as a 503 rather than running in some
 * degraded mode that quietly grants access.
 */

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const list = (value) => String(value ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

export function readEnv(env = {}) {
  return {
    /** The *server-side* Places key. Never sent to a browser. */
    googleKey: String(env.GOOGLE_PLACES_KEY ?? '').trim(),

    /** HMAC secret for session tokens. Rotating it invalidates every token. */
    tokenSecret: String(env.TOKEN_SECRET ?? '').trim(),

    /** Exact origins allowed to call this service. No wildcards. */
    allowedOrigins: list(env.ALLOWED_ORIGINS),

    cacheMinutes: number(env.CACHE_MINUTES, 45),
    tokenTtlHours: number(env.TOKEN_TTL_HOURS, 24),

    /** Which field set to request: essentials | pro | enterprise. */
    fieldTier: String(env.FIELD_TIER ?? 'enterprise').trim(),

    /** Cloudflare KV, or null when running without one (memory fallback). */
    kv: env.MUNCH_KV ?? null,

    apple: {
      keyId: String(env.APPLE_KEY_ID ?? '').trim(),
      issuerId: String(env.APPLE_ISSUER_ID ?? '').trim(),
      bundleId: String(env.APPLE_BUNDLE_ID ?? '').trim(),
      privateKey: String(env.APPLE_PRIVATE_KEY ?? '').trim(),
      // 'production' or 'sandbox'; sandbox receipts fail against production.
      environment: String(env.APPLE_ENVIRONMENT ?? 'production').trim(),
    },

    play: {
      packageName: String(env.PLAY_PACKAGE_NAME ?? '').trim(),
      clientEmail: String(env.PLAY_CLIENT_EMAIL ?? '').trim(),
      privateKey: String(env.PLAY_PRIVATE_KEY ?? '').trim(),
    },
  };
}

/** True when the store's credentials are all present. */
export const appleConfigured = (config) =>
  Boolean(config.apple.keyId && config.apple.issuerId
    && config.apple.bundleId && config.apple.privateKey);

export const playConfigured = (config) =>
  Boolean(config.play.packageName && config.play.clientEmail && config.play.privateKey);

/** What the service cannot start without. */
export function missingRequired(config) {
  const missing = [];
  if (!config.googleKey) missing.push('GOOGLE_PLACES_KEY');
  if (!config.tokenSecret) missing.push('TOKEN_SECRET');
  if (config.allowedOrigins.length === 0) missing.push('ALLOWED_ORIGINS');
  return missing;
}
