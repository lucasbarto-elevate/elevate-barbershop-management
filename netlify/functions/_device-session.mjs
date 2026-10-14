import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CONTROL_STORE_NAME } from './_coordination.mjs';
import { AUTH_ROLES, DEVICE_CSRF_COOKIE } from './_authorization.mjs';

export const DEVICE_AUTHORIZATION_KEY = 'authorization:shared-ipad:active';
export const DEVICE_SESSION_COOKIE = '__Host-elevate-device-session';
export const DEVICE_SESSION_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class DeviceSessionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DeviceSessionError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new DeviceSessionError(status, code, message);
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(request) {
  const cookies = new Map();
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(separator + 1).trim());
  }
  return cookies;
}

function validStoredState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 1 ||
      typeof state.deviceId !== 'string' || !state.deviceId.trim() ||
      !['active', 'revoked'].includes(state.status)) return false;
  if (state.status === 'active') {
    return HASH_PATTERN.test(state.sessionHash || '') && HASH_PATTERN.test(state.csrfHash || '') &&
      typeof state.activatedAt === 'string' && Number.isFinite(Date.parse(state.activatedAt));
  }
  return state.sessionHash === null && state.csrfHash === null &&
    typeof state.revokedAt === 'string' && Number.isFinite(Date.parse(state.revokedAt));
}

function safeEtag(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Open the site's already-isolated control store; no new store or env var. */
export async function loadDeviceAuthorizationStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: CONTROL_STORE_NAME, consistency: 'strong' });
}

function readActiveState(store) {
  return store.getWithMetadata(DEVICE_AUTHORIZATION_KEY, { type: 'json', consistency: 'strong' });
}

function requireStore(store) {
  if (!store || typeof store.getWithMetadata !== 'function' || typeof store.setJSON !== 'function') {
    throw new TypeError('A strong Netlify Blobs device store is required.');
  }
}

async function persistCAS(store, observed, nextState) {
  let result;
  try {
    result = observed?.etag
      ? await store.setJSON(DEVICE_AUTHORIZATION_KEY, nextState, { onlyIfMatch: observed.etag })
      : await store.setJSON(DEVICE_AUTHORIZATION_KEY, nextState, { onlyIfNew: true });
  } catch {
    return confirmConditionalWrite(store, nextState);
  }

  if (result?.modified === false) return confirmConditionalWrite(store, nextState);
  if (result?.modified !== true) fail(503, 'device_store_unavailable', 'Não foi possível guardar a autorização do dispositivo.');
  if (safeEtag(result.etag)) return result.etag;

  // Some SDK error paths can report modified=true with an empty ETag. A network
  // error can also happen after the server committed the write. In either case,
  // never issue a session until a strong read confirms the complete expected state.
  return confirmConditionalWrite(store, nextState);
}

async function confirmConditionalWrite(store, nextState) {
  let confirmed;
  try {
    confirmed = await readActiveState(store);
  } catch {
    fail(503, 'device_store_unavailable', 'Não foi possível confirmar a autorização do dispositivo.');
  }
  if (confirmed && safeEtag(confirmed.etag) && validStoredState(confirmed.data) &&
      sameStoredState(confirmed.data, nextState)) return confirmed.etag;
  if (confirmed?.data && Number.isSafeInteger(confirmed.data.generation) &&
      confirmed.data.generation >= nextState.generation) {
    fail(409, 'device_state_changed', 'O estado do dispositivo mudou; atualize e tente novamente.');
  }
  fail(503, 'device_store_unavailable', 'Não foi possível confirmar a autorização do dispositivo.');
}

function sameStoredState(actual, expected) {
  return ['schemaVersion', 'generation', 'status', 'deviceId', 'sessionHash', 'csrfHash', 'activatedAt', 'revokedAt']
    .every(key => actual[key] === expected[key]);
}

function validateObservedState(observed) {
  if (!observed) return { state: null, etag: null, generation: 0 };
  if (!safeEtag(observed.etag) || !validStoredState(observed.data)) {
    fail(503, 'device_state_invalid', 'O registo do dispositivo não pode ser validado.');
  }
  return { state: observed.data, etag: observed.etag, generation: observed.data.generation };
}

export function deviceSessionErrorResponse(error) {
  if (!(error instanceof DeviceSessionError)) {
    return Response.json(
      { ok: false, error: 'Não foi possível verificar a autorização do dispositivo.', code: 'device_auth_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return Response.json(
    { ok: false, error: error.message, code: error.code },
    { status: error.status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function makeCookie(name, value, { httpOnly = true, maxAge = DEVICE_SESSION_COOKIE_MAX_AGE_SECONDS } = {}) {
  const attributes = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (httpOnly) attributes.push('HttpOnly');
  return attributes.join('; ');
}

/** Build separate Set-Cookie values for a future protected pairing endpoint. */
export function deviceSessionCookieHeaders(session) {
  if (!session || !TOKEN_PATTERN.test(session.sessionId || '') || !TOKEN_PATTERN.test(session.csrfToken || '')) {
    throw new TypeError('A valid internal device session is required.');
  }
  return [
    ['Set-Cookie', makeCookie(DEVICE_SESSION_COOKIE, session.sessionId)],
    ['Set-Cookie', makeCookie(DEVICE_CSRF_COOKIE, session.csrfToken, { httpOnly: false })]
  ];
}

/** Expire cookies on the device when it next contacts a protected endpoint. */
export function clearDeviceSessionCookieHeaders() {
  return [
    ['Set-Cookie', makeCookie(DEVICE_SESSION_COOKIE, '', { maxAge: 0 })],
    ['Set-Cookie', makeCookie(DEVICE_CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 })]
  ];
}

/**
 * Internal device authorization state machine. One CAS-protected key is the
 * sole authority for the active iPad and its session. No multi-blob transaction
 * or public endpoint is implied by this module.
 */
export function createDeviceSessionManager({ store, now = () => Date.now(), randomToken = () => randomBytes(32).toString('base64url'), randomDeviceId = randomUUID } = {}) {
  requireStore(store);
  if (typeof now !== 'function' || typeof randomToken !== 'function' || typeof randomDeviceId !== 'function') {
    throw new TypeError('Device session manager dependencies are required.');
  }

  async function readState() {
    try {
      return validateObservedState(await readActiveState(store));
    } catch (error) {
      if (error instanceof DeviceSessionError) throw error;
      fail(503, 'device_store_unavailable', 'Não foi possível verificar a autorização do dispositivo.');
    }
  }

  async function activate({ replaceExisting = false, expectedGeneration = 0 } = {}) {
    if (typeof replaceExisting !== 'boolean' || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      fail(400, 'invalid_device_change', 'A confirmação do dispositivo não é válida.');
    }
    const observed = await readState();
    if (observed.generation !== expectedGeneration) {
      fail(409, 'device_state_changed', 'O estado do dispositivo mudou; atualize e tente novamente.');
    }
    if (observed.state?.status === 'active' && !replaceExisting) {
      fail(409, 'device_already_active', 'Já existe um iPad autorizado.');
    }

    let sessionId;
    let csrfToken;
    let deviceId;
    try {
      sessionId = randomToken();
      csrfToken = randomToken();
      deviceId = randomDeviceId();
    } catch {
      fail(503, 'secure_random_unavailable', 'Não foi possível criar uma sessão segura para o dispositivo.');
    }
    if (!TOKEN_PATTERN.test(sessionId) || !TOKEN_PATTERN.test(csrfToken) ||
        typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 128) {
      fail(503, 'secure_random_unavailable', 'Não foi possível criar uma sessão segura para o dispositivo.');
    }
    const activatedAt = new Date(now()).toISOString();
    const next = {
      schemaVersion: 1,
      generation: observed.generation + 1,
      status: 'active',
      deviceId,
      sessionHash: digest(sessionId),
      csrfHash: digest(csrfToken),
      activatedAt
    };
    await persistCAS(store, { etag: observed.etag }, next);
    // Raw values exist only in this internal return value so a future pairing
    // endpoint can place them in cookies; never log or serialize this object.
    return Object.freeze({ deviceId, generation: next.generation, sessionId, csrfToken });
  }

  async function revoke({ expectedGeneration } = {}) {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      fail(400, 'invalid_device_change', 'A confirmação do dispositivo não é válida.');
    }
    const observed = await readState();
    if (!observed.state || observed.state.status !== 'active') {
      fail(404, 'no_active_device', 'Não existe um iPad ativo para revogar.');
    }
    if (observed.generation !== expectedGeneration) {
      fail(409, 'device_state_changed', 'O estado do dispositivo mudou; atualize e tente novamente.');
    }
    const next = {
      schemaVersion: 1,
      generation: observed.generation + 1,
      status: 'revoked',
      deviceId: observed.state.deviceId,
      sessionHash: null,
      csrfHash: null,
      activatedAt: observed.state.activatedAt,
      revokedAt: new Date(now()).toISOString()
    };
    await persistCAS(store, { etag: observed.etag }, next);
    return Object.freeze({ revoked: true, deviceId: next.deviceId, generation: next.generation });
  }

  async function resolveDeviceSession(request) {
    const sessionId = parseCookies(request).get(DEVICE_SESSION_COOKIE) || '';
    if (!TOKEN_PATTERN.test(sessionId)) return null;
    const observed = await readState();
    const state = observed.state;
    if (!state || state.status !== 'active' || !constantTimeHexEqual(digest(sessionId), state.sessionHash)) return null;

    const csrfCandidate = parseCookies(request).get(DEVICE_CSRF_COOKIE) || '';
    const csrfToken = TOKEN_PATTERN.test(csrfCandidate) && constantTimeHexEqual(digest(csrfCandidate), state.csrfHash)
      ? csrfCandidate
      : null;
    return Object.freeze({
      subjectId: state.deviceId,
      role: AUTH_ROLES.BARBER_DEVICE,
      deviceId: state.deviceId,
      generation: state.generation,
      csrfToken
    });
  }

  async function findDevice(subjectId, deviceId) {
    const observed = await readState();
    const state = observed.state;
    if (!state || state.deviceId !== deviceId || state.deviceId !== subjectId) return null;
    return Object.freeze({
      subjectId: state.deviceId,
      deviceId: state.deviceId,
      generation: state.generation,
      status: state.status
    });
  }

  return Object.freeze({ activate, revoke, resolveDeviceSession, findDevice, readState });
}
