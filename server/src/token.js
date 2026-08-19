/**
 * Session tokens: a compact HS256 JWT, signed and verified with WebCrypto.
 *
 * The token carries the tier, so every later request can be authorised without
 * calling a store API again. That makes the signature the whole security
 * boundary: a client that could forge one would grant itself Munch+.
 *
 * So the payload is never read before the signature is checked — the parse and
 * the verify are not separable here, and `verifyToken` is the only export that
 * returns claims.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEADER = { alg: 'HS256', typ: 'JWT' };

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const encodeJson = (value) => encodeBase64Url(encoder.encode(JSON.stringify(value)));

async function signingKey(secret) {
  if (!secret) throw new Error('token secret is not configured');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Issue a token.
 *
 * @param {{sub: string, tier: string}} claims
 * @returns {Promise<{token: string, expiresAt: number}>} expiry in epoch seconds
 */
export async function issueToken(claims, { secret, ttlSeconds, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + ttlSeconds;

  const payload = { ...claims, iat: issuedAt, exp: expiresAt };
  const body = `${encodeJson(HEADER)}.${encodeJson(payload)}`;

  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(body));

  return { token: `${body}.${encodeBase64Url(new Uint8Array(signature))}`, expiresAt };
}

/** Raised for any token we will not act on. Never says which part failed. */
export class TokenError extends Error {
  constructor(message = 'Invalid or expired session.') {
    super(message);
    this.name = 'TokenError';
  }
}

/**
 * Verify a token and return its claims.
 *
 * @throws {TokenError} for a bad signature, a malformed token, or an expiry
 */
export async function verifyToken(token, { secret, now = Date.now() }) {
  if (typeof token !== 'string') throw new TokenError();

  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError();

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const body = `${encodedHeader}.${encodedPayload}`;

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      decodeBase64Url(encodedSignature),
      encoder.encode(body),
    );
  } catch {
    throw new TokenError();
  }

  // Nothing below this line runs for an unsigned token.
  if (!valid) throw new TokenError();

  let header;
  let claims;
  try {
    header = JSON.parse(decoder.decode(decodeBase64Url(encodedHeader)));
    claims = JSON.parse(decoder.decode(decodeBase64Url(encodedPayload)));
  } catch {
    throw new TokenError();
  }

  // A signed token still has to be the algorithm we signed with — refusing
  // anything else is what keeps "alg": "none" from ever being considered.
  if (!header || header.alg !== 'HS256') throw new TokenError();
  if (!claims || typeof claims !== 'object') throw new TokenError();
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new TokenError();
  if (typeof claims.sub !== 'string' || !claims.sub) throw new TokenError();

  return claims;
}

/** Pull a bearer token out of the Authorization header, or null. */
export function bearerFrom(request) {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
