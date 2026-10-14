import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const ADMIN_SESSION_STORE_NAME = 'elevate-admin-sessions';
export const ADMIN_SESSION_COOKIE = '__Host-elevate-admin-session';
export const ADMIN_CSRF_COOKIE = '__Host-elevate-admin-csrf';
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SCRYPT_PARAMETERS = Object.freeze({ N: 2 ** 15, r: 8, p: 3, keyLength: 64, maxmem: 128 * 1024 * 1024 });

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});

function authError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function json(body, status = 200, extraHeaders = []) {
  const headers = new Headers(NO_STORE_HEADERS);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [name, value] of extraHeaders) headers.append(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function safeCookie(name, value, { httpOnly = true, maxAge = 0 } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

function clearCookies() {
  return [
    ['Set-Cookie', safeCookie(ADMIN_SESSION_COOKIE, '', { maxAge: 0 })],
    ['Set-Cookie', safeCookie(ADMIN_CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 })]
  ];
}

function parseCookies(request) {
  const result = new Map();
  for (const item of (request.headers.get('cookie') || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!result.has(name)) result.set(name, value);
  }
  return result;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length ? decoded : null;
}

export async function createPasswordHash(password, { salt = randomBytes(16) } = {}) {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new TypeError('A password must be a non-empty string of at most 1024 bytes.');
  }
  if (!Buffer.isBuffer(salt) || salt.length !== 16) throw new TypeError('The scrypt salt must be exactly 16 random bytes.');
  const derived = await scrypt(password, salt, SCRYPT_PARAMETERS.keyLength, {
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    maxmem: SCRYPT_PARAMETERS.maxmem
  });
  return `scrypt$${SCRYPT_PARAMETERS.N}$${SCRYPT_PARAMETERS.r}$${SCRYPT_PARAMETERS.p}$${Buffer.from(salt).toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const match = encoded.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/);
  if (!match) return null;
  const [, nText, rText, pText, saltText, keyText] = match;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  // Hash parameters come from trusted deployment configuration, but strict
  // bounds prevent a malformed value from requesting unbounded CPU or memory.
  if (N !== SCRYPT_PARAMETERS.N || r !== SCRYPT_PARAMETERS.r || p !== SCRYPT_PARAMETERS.p) return null;
  const salt = decodeBase64Url(saltText);
  const expected = decodeBase64Url(keyText);
  if (!salt || salt.length !== 16 || !expected || expected.length !== SCRYPT_PARAMETERS.keyLength) return null;
  return { salt, expected };
}

export function isValidAdminHashConfiguration(encoded) {
  return Boolean(parsePasswordHash(encoded));
}

export async function verifyPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) return false;
  const actual = await scrypt(password, parsed.salt, parsed.expected.length, {
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    maxmem: SCRYPT_PARAMETERS.maxmem
  });
  return timingSafeEqual(Buffer.from(actual), parsed.expected);
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function readConfig(env) {
  const email = normalizeEmail(env.ADMIN_EMAIL);
  const hash = env.ADMIN_PASSWORD_SCRYPT_HASH;
  const epoch = typeof env.ADMIN_SESSION_EPOCH === 'string' ? env.ADMIN_SESSION_EPOCH.trim() : '';
  let origin = '';
  try {
    const parsed = new URL(env.ADMIN_AUTH_ORIGIN || '');
    if (parsed.protocol === 'https:' && parsed.origin === env.ADMIN_AUTH_ORIGIN) origin = parsed.origin;
  } catch { /* fail closed below */ }
  if (!email || !isValidAdminHashConfiguration(hash) || !epoch || epoch.length > 128 || !origin) {
    throw authError(503, 'auth_unavailable', 'A autenticação administrativa não está disponível.');
  }
  return Object.freeze({ email, hash, epoch, origin });
}

function cookieHeaders(sessionId, csrfToken) {
  return [
    ['Set-Cookie', safeCookie(ADMIN_SESSION_COOKIE, sessionId, { maxAge: ADMIN_SESSION_TTL_MS / 1000 })],
    ['Set-Cookie', safeCookie(ADMIN_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge: ADMIN_SESSION_TTL_MS / 1000 })]
  ];
}

function originIsValid(request, config) {
  return request.headers.get('origin') === config.origin;
}

function csrfIsValid(request, cookies, expected = null) {
  const cookieToken = cookies.get(ADMIN_CSRF_COOKIE) || '';
  const headerToken = request.headers.get('x-csrf-token') || '';
  if (!CSRF_TOKEN_PATTERN.test(cookieToken) || !CSRF_TOKEN_PATTERN.test(headerToken)) return false;
  return equalText(cookieToken, headerToken) && (expected === null || equalText(cookieToken, expected));
}

async function readSession(request, store, config, now) {
  const sessionId = parseCookies(request).get(ADMIN_SESSION_COOKIE) || '';
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const sessionKey = `session:${digest(sessionId)}`;
  const record = await store.get(sessionKey);
  if (!record) return null;
  if (record.version !== 1 || record.principal !== 'admin' || record.epoch !== config.epoch ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt) || record.expiresAt <= now ||
      record.expiresAt - record.createdAt > ADMIN_SESSION_TTL_MS || !CSRF_TOKEN_PATTERN.test(record.csrfToken)) {
    await store.delete(sessionKey);
    return null;
  }
  return { sessionId, sessionKey, record };
}

/**
 * Build a server-side admin-session resolver for protected Functions.
 * The returned principal is created only after validating the existing opaque
 * HttpOnly session cookie against the strongly-consistent session store.
 * Its CSRF value is internal to the Function and must never be serialized.
 */
export function createAdminSessionResolver({ env, sessionStore, now = () => Date.now() } = {}) {
  if (!env || typeof env !== 'object' || !sessionStore ||
      typeof sessionStore.get !== 'function' || typeof sessionStore.delete !== 'function' ||
      typeof now !== 'function') {
    throw new TypeError('Admin session resolver dependencies are required.');
  }

  return async function resolveAdminSession(request) {
    const config = readConfig(env);
    const active = await readSession(request, sessionStore, config, now());
    if (!active) return null;
    return Object.freeze({
      subjectId: 'admin',
      role: 'admin',
      csrfToken: active.record.csrfToken,
      csrfCookieName: ADMIN_CSRF_COOKIE
    });
  };
}

function validateMutation(request, config, cookies, csrfToken = null) {
  if (!originIsValid(request, config)) throw authError(403, 'origin_rejected', 'Pedido não autorizado.');
  if (!csrfIsValid(request, cookies, csrfToken)) throw authError(403, 'csrf_rejected', 'Pedido não autorizado.');
}

function publicError(error) {
  if (error?.status === 401) return json({ ok: false, error: 'Credenciais inválidas.' }, 401);
  if (error?.status === 403) return json({ ok: false, error: 'Pedido não autorizado.' }, 403);
  if (error?.status === 405) return json({ ok: false, error: 'Método não permitido.' }, 405);
  if (error?.status === 400) return json({ ok: false, error: 'Pedido inválido.' }, 400);
  return json({ ok: false, error: 'A autenticação administrativa não está disponível.' }, 503);
}

export function createBlobSessionStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function' || typeof store.delete !== 'function') {
    throw new TypeError('Netlify Blobs store adapter is invalid.');
  }
  return Object.freeze({
    get: key => store.get(key, { type: 'json', consistency: 'strong' }),
    set: (key, value) => store.setJSON(key, value),
    delete: key => store.delete(key)
  });
}

export async function loadAdminSessionStore() {
  const { getStore } = await import('@netlify/blobs');
  return createBlobSessionStore(getStore({ name: ADMIN_SESSION_STORE_NAME, consistency: 'strong' }));
}

export async function revokeAdminSession(sessionId, sessionStore) {
  if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) return false;
  await sessionStore.delete(`session:${digest(sessionId)}`);
  return true;
}

export function createAdminAuthHandlers({ env, sessionStore, now = () => Date.now(), randomToken = () => randomBytes(32).toString('base64url'), verify = verifyPassword } = {}) {
  if (!env || typeof env !== 'object' || !sessionStore ||
      typeof sessionStore.get !== 'function' || typeof sessionStore.set !== 'function' || typeof sessionStore.delete !== 'function' ||
      typeof now !== 'function' || typeof randomToken !== 'function' || typeof verify !== 'function') {
    throw new TypeError('Admin auth dependencies are required.');
  }

  async function session(request) {
    if (request.method !== 'GET') throw authError(405, 'method_not_allowed', 'Método não permitido.');
    const config = readConfig(env);
    const cookies = parseCookies(request);
    const active = await readSession(request, sessionStore, config, now());
    let csrfToken;
    const extraHeaders = [];
    if (active) {
      csrfToken = active.record.csrfToken;
      if (!equalText(cookies.get(ADMIN_CSRF_COOKIE) || '', csrfToken)) {
        extraHeaders.push(['Set-Cookie', safeCookie(ADMIN_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge: ADMIN_SESSION_TTL_MS / 1000 })]);
      }
    } else {
      csrfToken = cookies.get(ADMIN_CSRF_COOKIE) || '';
      if (!CSRF_TOKEN_PATTERN.test(csrfToken)) {
        csrfToken = randomToken();
        if (!CSRF_TOKEN_PATTERN.test(csrfToken)) throw new Error('Random token source returned an invalid token.');
        extraHeaders.push(['Set-Cookie', safeCookie(ADMIN_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge: 15 * 60 })]);
      }
    }
    return json({ ok: true, authenticated: Boolean(active), csrfToken }, 200, extraHeaders);
  }

  async function login(request) {
    if (request.method !== 'POST') throw authError(405, 'method_not_allowed', 'Método não permitido.');
    const config = readConfig(env);
    const cookies = parseCookies(request);
    validateMutation(request, config, cookies);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw authError(400, 'invalid_request', 'Pedido inválido.');
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > 4096) throw authError(400, 'invalid_request', 'Pedido inválido.');
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf8') > 4096) throw authError(400, 'invalid_request', 'Pedido inválido.');
    let body;
    try { body = JSON.parse(rawBody); } catch { throw authError(400, 'invalid_request', 'Pedido inválido.'); }
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === 'string' && Buffer.byteLength(body.password, 'utf8') <= 1024 ? body.password : '';
    if (!password) throw authError(401, 'invalid_credentials', 'Credenciais inválidas.');

    // Always run scrypt for a syntactically valid password, including an
    // unknown email, so the public response does not reveal account existence.
    const passwordMatches = await verify(password, config.hash);
    if (!email || !equalText(email, config.email) || !passwordMatches) {
      throw authError(401, 'invalid_credentials', 'Credenciais inválidas.');
    }

    const sessionId = randomToken();
    const csrfToken = cookies.get(ADMIN_CSRF_COOKIE) || '';
    if (!SESSION_ID_PATTERN.test(sessionId) || !CSRF_TOKEN_PATTERN.test(csrfToken)) throw new Error('Secure token generation failed.');
    const createdAt = now();
    const record = {
      version: 1,
      principal: 'admin',
      epoch: config.epoch,
      createdAt,
      expiresAt: createdAt + ADMIN_SESSION_TTL_MS,
      csrfToken
    };
    await sessionStore.set(`session:${digest(sessionId)}`, record);
    return json({ ok: true, authenticated: true }, 200, cookieHeaders(sessionId, csrfToken));
  }

  async function logout(request) {
    if (request.method !== 'POST') throw authError(405, 'method_not_allowed', 'Método não permitido.');
    const config = readConfig(env);
    const cookies = parseCookies(request);
    // Reject cross-origin and malformed CSRF requests before an attacker can
    // force a strongly-consistent Blob read with a guessed session identifier.
    validateMutation(request, config, cookies);
    const active = await readSession(request, sessionStore, config, now());
    if (active && !csrfIsValid(request, cookies, active.record.csrfToken)) {
      throw authError(403, 'csrf_rejected', 'Pedido não autorizado.');
    }
    if (active) await sessionStore.delete(active.sessionKey);
    return json({ ok: true, authenticated: false }, 200, clearCookies());
  }

  return Object.freeze({
    session,
    login,
    logout,
    handle: async (operation, request) => {
      try {
        if (!['session', 'login', 'logout'].includes(operation)) throw authError(404, 'not_found', 'Não encontrado.');
        return await ({ session, login, logout })[operation](request);
      } catch (error) {
        return publicError(error);
      }
    }
  });
}

export function getRuntimeAuthEnvironment() {
  const env = {};
  for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_SCRYPT_HASH', 'ADMIN_SESSION_EPOCH', 'ADMIN_AUTH_ORIGIN']) {
    // Netlify Functions run on Node.js; their documented runtime environment
    // interface is process.env (Netlify.env is the Edge Functions API).
    env[key] = process.env[key];
  }
  return env;
}

export async function runAdminAuthOperation(operation, request) {
  try {
    const sessionStore = await loadAdminSessionStore();
    const handlers = createAdminAuthHandlers({ env: getRuntimeAuthEnvironment(), sessionStore });
    return await handlers.handle(operation, request);
  } catch {
    return json({ ok: false, error: 'A autenticação administrativa não está disponível.' }, 503);
  }
}
