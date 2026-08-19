/** Request/response plumbing shared by every route. */

/** A failure with a status the client is meant to see. */
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * CORS headers for an allowed origin.
 *
 * The allowlist is explicit: this service holds a billable API key, so a
 * wildcard would let any page on the internet spend the budget. An unknown
 * origin gets no CORS headers at all, and the browser refuses the response.
 */
export function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.get('Origin') ?? '';
  if (!origin || !allowedOrigins.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Turn a thrown error into a response.
 *
 * Only HttpError carries a message meant for the client. Anything else is a
 * bug or an upstream failure, and its message could name internals or a key,
 * so it is logged and replaced.
 */
export function errorResponse(error, headers = {}) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message, ...error.extra },
      { status: error.status, headers });
  }

  console.error('unhandled', error?.stack ?? error);
  return json({ error: 'internal', message: 'Something went wrong.' }, { status: 500, headers });
}

/** Parse a JSON body, rejecting anything that is not an object. */
export async function readJson(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'bad_json', 'Body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_json', 'Body must be a JSON object.');
  }
  return body;
}

/** A finite number within range, or a 400. */
export function requireNumber(value, name, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new HttpError(400, 'bad_request', `${name} must be a number between ${min} and ${max}.`);
  }
  return number;
}
