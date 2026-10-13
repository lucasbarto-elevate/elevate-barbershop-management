import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_STORE_NAME,
  ADMIN_SESSION_TTL_MS,
  createAdminAuthHandlers,
  createBlobSessionStore,
  createPasswordHash,
  getRuntimeAuthEnvironment,
  isValidAdminHashConfiguration,
  revokeAdminSession,
  verifyPassword
} from '../netlify/functions/_admin-session.mjs';
import * as loginFunction from '../netlify/functions/admin-login.mjs';
import * as sessionFunction from '../netlify/functions/admin-session.mjs';
import * as logoutFunction from '../netlify/functions/admin-logout.mjs';

const TEST_EMAIL = 'admin.synthetic@example.invalid';
const TEST_PASSWORD = 'synthetic-only-password-97!';
const TEST_ORIGIN = 'https://elevate-staging.example.invalid';
const hash = await createPasswordHash(TEST_PASSWORD);
const env = () => ({
  ADMIN_EMAIL: TEST_EMAIL,
  ADMIN_PASSWORD_SCRYPT_HASH: hash,
  ADMIN_SESSION_EPOCH: 'synthetic-epoch-01',
  ADMIN_AUTH_ORIGIN: TEST_ORIGIN
});

class MemoryBlobs {
  values = new Map();
  reads = [];
  failGet = false;
  failSet = false;
  failDelete = false;
  async get(key, options) {
    this.reads.push({ key, options });
    if (this.failGet) throw new Error('synthetic storage failure');
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value);
  }
  async setJSON(key, value) {
    if (this.failSet) throw new Error('synthetic storage failure');
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    if (this.failDelete) throw new Error('synthetic storage failure');
    this.values.delete(key);
  }
}

function createFixture({ verify = async (password, passwordHash) => password === TEST_PASSWORD && passwordHash === hash, clock = () => 1_800_000_000_000 } = {}) {
  const blobs = new MemoryBlobs();
  let tokenCounter = 0;
  const store = createBlobSessionStore(blobs);
  const handlers = createAdminAuthHandlers({
    env: env(),
    sessionStore: store,
    verify,
    now: clock,
    randomToken: () => Buffer.alloc(32, ++tokenCounter).toString('base64url')
  });
  return { blobs, store, handlers };
}

function headers({ cookie = '', csrf = '', origin = TEST_ORIGIN, contentType = 'application/json' } = {}) {
  const value = new Headers({ Origin: origin });
  if (cookie) value.set('Cookie', cookie);
  if (csrf) value.set('X-CSRF-Token', csrf);
  if (contentType) value.set('Content-Type', contentType);
  return value;
}

function readSetCookie(response, cookieName) {
  const header = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`));
  return header?.slice(cookieName.length + 1).split(';', 1)[0] ?? null;
}

async function beginLogin(handlers) {
  const response = await handlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`));
  const csrfToken = (await response.json()).csrfToken;
  const csrfCookie = readSetCookie(response, ADMIN_CSRF_COOKIE) || csrfToken;
  return { csrfToken, csrfCookie };
}

async function login(handlers, { email = TEST_EMAIL, password = TEST_PASSWORD, origin = TEST_ORIGIN, csrfToken, csrfCookie } = {}) {
  const csrf = csrfToken || (await beginLogin(handlers)).csrfToken;
  const cookie = csrfCookie || csrf;
  return handlers.login(new Request(`${TEST_ORIGIN}/auth/admin/login`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_CSRF_COOKIE}=${cookie}`, csrf, origin }),
    body: JSON.stringify({ email, password })
  }));
}

function sessionCookie(response) {
  const value = readSetCookie(response, ADMIN_SESSION_COOKIE);
  assert.ok(value, 'login should set the opaque session cookie');
  return value;
}

test('scrypt hash uses a unique salt format and verifies only the synthetic password', async () => {
  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(hash.includes(TEST_PASSWORD), false);
  assert.equal(isValidAdminHashConfiguration(hash), true);
  assert.equal(await verifyPassword(TEST_PASSWORD, hash), true);
  assert.equal(await verifyPassword('wrong-synthetic-password', hash), false);
  assert.equal(isValidAdminHashConfiguration('sha256$not-a-password-hash'), false);
});

test('configuration ausente ou malformada falha fechado sem autenticar', async () => {
  const store = createBlobSessionStore(new MemoryBlobs());
  const handlers = createAdminAuthHandlers({ env: {}, sessionStore: store });
  const response = await handlers.handle('session', new Request(`${TEST_ORIGIN}/auth/admin/session`));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'A autenticação administrativa não está disponível.' });

  const badHashHandlers = createAdminAuthHandlers({ env: { ...env(), ADMIN_PASSWORD_SCRYPT_HASH: 'invalid' }, sessionStore: store });
  assert.equal((await badHashHandlers.handle('session', new Request(`${TEST_ORIGIN}/auth/admin/session`))).status, 503);
});

test('ambiente Netlify Functions Node lê process.env e configuração ausente falha fechado', async () => {
  const keys = ['ADMIN_EMAIL', 'ADMIN_PASSWORD_SCRYPT_HASH', 'ADMIN_SESSION_EPOCH', 'ADMIN_AUTH_ORIGIN'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(getRuntimeAuthEnvironment(), Object.fromEntries(keys.map(key => [key, undefined])));
    const store = createBlobSessionStore(new MemoryBlobs());
    const absentHandlers = createAdminAuthHandlers({ env: getRuntimeAuthEnvironment(), sessionStore: store });
    assert.equal((await absentHandlers.handle('session', new Request(`${TEST_ORIGIN}/auth/admin/session`))).status, 503);

    Object.assign(process.env, {
      ADMIN_EMAIL: TEST_EMAIL,
      ADMIN_PASSWORD_SCRYPT_HASH: hash,
      ADMIN_SESSION_EPOCH: 'synthetic-epoch-env',
      ADMIN_AUTH_ORIGIN: TEST_ORIGIN
    });
    assert.deepEqual(getRuntimeAuthEnvironment(), {
      ADMIN_EMAIL: TEST_EMAIL,
      ADMIN_PASSWORD_SCRYPT_HASH: hash,
      ADMIN_SESSION_EPOCH: 'synthetic-epoch-env',
      ADMIN_AUTH_ORIGIN: TEST_ORIGIN
    });
    const configuredHandlers = createAdminAuthHandlers({ env: getRuntimeAuthEnvironment(), sessionStore: store });
    assert.equal((await configuredHandlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`))).status, 200);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('login válido cria sessão opaca no servidor e cookie seguro', async () => {
  const { handlers, blobs } = createFixture();
  const preflight = await beginLogin(handlers);
  const response = await login(handlers, preflight);
  assert.equal(response.status, 200);
  const responseBody = await response.clone().text();
  assert.deepEqual(await response.json(), { ok: true, authenticated: true });

  const sessionId = sessionCookie(response);
  const cookieHeaders = response.headers.getSetCookie();
  assert.equal(cookieHeaders.length, 2, 'session and CSRF cookies must be independent Set-Cookie headers');
  const sessionSetCookie = cookieHeaders.find(value => value.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  const csrfSetCookie = cookieHeaders.find(value => value.startsWith(`${ADMIN_CSRF_COOKIE}=`));
  assert.ok(sessionSetCookie);
  assert.ok(csrfSetCookie);
  assert.match(sessionSetCookie, /HttpOnly/i);
  for (const cookieHeader of [sessionSetCookie, csrfSetCookie]) {
    assert.match(cookieHeader, /Secure/i);
    assert.match(cookieHeader, /SameSite=Lax/i);
    assert.match(cookieHeader, /Path=\//i);
    assert.match(cookieHeader, new RegExp(`Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`));
    assert.doesNotMatch(cookieHeader, /Domain=/i);
  }
  assert.doesNotMatch(csrfSetCookie, /HttpOnly/i, 'CSRF cookie must be readable by same-origin JavaScript');
  assert.ok(sessionId.length >= 40);

  const [[key, record]] = [...blobs.values.entries()];
  assert.match(key, /^session:[a-f0-9]{64}$/);
  assert.equal(key.includes(sessionId), false, 'only a hash of the session identifier is stored');
  assert.equal(record.principal, 'admin');
  assert.equal(record.role, undefined, 'the client cannot supply an administrative role');
  assert.equal(record.expiresAt - record.createdAt, ADMIN_SESSION_TTL_MS);
  assert.equal(responseBody.includes(sessionId), false);
});

test('primeiro login exige bootstrap CSRF; GET de sessão seguido de POST funciona', async () => {
  const blobs = new MemoryBlobs();
  let tokenCounter = 0;
  let verifyCalls = 0;
  const handlers = createAdminAuthHandlers({
    env: env(),
    sessionStore: createBlobSessionStore(blobs),
    verify: async () => { verifyCalls += 1; return true; },
    randomToken: () => Buffer.alloc(32, ++tokenCounter).toString('base64url')
  });

  const unprepared = await handlers.handle('login', new Request(`${TEST_ORIGIN}/auth/admin/login`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  }));
  assert.equal(unprepared.status, 403);
  assert.equal(verifyCalls, 0);

  const invalidOrigin = await handlers.handle('login', new Request(`${TEST_ORIGIN}/auth/admin/login`, {
    method: 'POST',
    headers: headers({ origin: 'https://attacker.example.invalid' }),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  }));
  assert.equal(invalidOrigin.status, 403);
  assert.equal(verifyCalls, 0);

  const preflight = await beginLogin(handlers);
  const loginResponse = await handlers.handle('login', new Request(`${TEST_ORIGIN}/auth/admin/login`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_CSRF_COOKIE}=${preflight.csrfCookie}`, csrf: preflight.csrfToken }),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  }));
  assert.equal(loginResponse.status, 200);
  assert.equal(verifyCalls, 1);
});

test('email inexistente e password incorreta recebem a mesma resposta sem saltar a verificação', async () => {
  let verificationCalls = 0;
  const { handlers } = createFixture({ verify: async () => { verificationCalls += 1; return false; } });
  const preflight = await beginLogin(handlers);
  const makeLoginRequest = ({ email, password }) => new Request(`${TEST_ORIGIN}/auth/admin/login`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_CSRF_COOKIE}=${preflight.csrfCookie}`, csrf: preflight.csrfToken }),
    body: JSON.stringify({ email, password })
  });
  const wrongPassword = await handlers.handle('login', makeLoginRequest({ email: TEST_EMAIL, password: 'synthetic-wrong' }));
  const unknownEmail = await handlers.handle('login', makeLoginRequest({ email: 'unknown.synthetic@example.invalid', password: TEST_PASSWORD }));
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownEmail.json());
  assert.equal(verificationCalls, 2);
});

test('session consulta sessão válida, rejeita sessão inválida e expirada', async () => {
  let clock = 1_800_000_000_000;
  const { handlers } = createFixture({ clock: () => clock });
  const preflight = await beginLogin(handlers);
  const signedIn = await login(handlers, preflight);
  const sid = sessionCookie(signedIn);
  const csrf = readSetCookie(signedIn, ADMIN_CSRF_COOKIE) || preflight.csrfToken;
  const good = await handlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${sid}; ${ADMIN_CSRF_COOKIE}=${csrf}` }
  }));
  assert.equal((await good.json()).authenticated, true);

  const invalid = await handlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=invalid-session-id-which-is-not-valid` }
  }));
  assert.equal((await invalid.json()).authenticated, false);

  clock += ADMIN_SESSION_TTL_MS + 1;
  const expired = await handlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${sid}; ${ADMIN_CSRF_COOKIE}=${csrf}` }
  }));
  assert.equal((await expired.json()).authenticated, false);
});

test('logout exige CSRF e Origin válidos, elimina sessão e expira cookies', async () => {
  const { handlers, blobs } = createFixture();
  const preflight = await beginLogin(handlers);
  const signedIn = await login(handlers, preflight);
  const sid = sessionCookie(signedIn);
  const csrf = readSetCookie(signedIn, ADMIN_CSRF_COOKIE) || preflight.csrfToken;

  const badCsrf = await handlers.handle('logout', new Request(`${TEST_ORIGIN}/auth/admin/logout`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_SESSION_COOKIE}=${sid}; ${ADMIN_CSRF_COOKIE}=${csrf}`, csrf: 'A'.repeat(43) })
  }));
  assert.equal(badCsrf.status, 403);
  assert.equal(blobs.values.size, 1);

  const badOrigin = await handlers.handle('logout', new Request(`${TEST_ORIGIN}/auth/admin/logout`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_SESSION_COOKIE}=${sid}; ${ADMIN_CSRF_COOKIE}=${csrf}`, csrf, origin: 'https://evil.example.invalid' })
  }));
  assert.equal(badOrigin.status, 403);
  assert.equal(blobs.values.size, 1);

  const response = await handlers.logout(new Request(`${TEST_ORIGIN}/auth/admin/logout`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_SESSION_COOKIE}=${sid}; ${ADMIN_CSRF_COOKIE}=${csrf}`, csrf })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, authenticated: false });
  assert.equal(blobs.values.size, 0);
  const clearedCookies = response.headers.getSetCookie();
  assert.equal(clearedCookies.length, 2, 'logout must expire both cookies independently');
  assert.ok(clearedCookies.every(value => /Max-Age=0/.test(value)));
});

test('logout rejeita Origin e CSRF inválidos antes de consultar Blobs', async () => {
  const { handlers, blobs } = createFixture();
  const guessedSession = Buffer.alloc(32, 71).toString('base64url');
  const cookie = `${ADMIN_SESSION_COOKIE}=${guessedSession}; ${ADMIN_CSRF_COOKIE}=${'A'.repeat(43)}`;

  const badOrigin = await handlers.handle('logout', new Request(`${TEST_ORIGIN}/auth/admin/logout`, {
    method: 'POST', headers: headers({ cookie, csrf: 'A'.repeat(43), origin: 'https://attacker.example.invalid' })
  }));
  assert.equal(badOrigin.status, 403);
  assert.equal(blobs.reads.length, 0);

  const badCsrf = await handlers.handle('logout', new Request(`${TEST_ORIGIN}/auth/admin/logout`, {
    method: 'POST', headers: headers({ cookie, csrf: 'B'.repeat(43) })
  }));
  assert.equal(badCsrf.status, 403);
  assert.equal(blobs.reads.length, 0);
});

test('revogação individual e mudança de geração invalidam sessões', async () => {
  const { handlers, store } = createFixture();
  const preflight = await beginLogin(handlers);
  const signedIn = await login(handlers, preflight);
  const sid = sessionCookie(signedIn);
  assert.equal(await revokeAdminSession(sid, store), true);
  assert.equal(await revokeAdminSession('invalid', store), false);
  const afterDelete = await handlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${sid}` }
  }));
  assert.equal((await afterDelete.json()).authenticated, false);

  const fixture = createFixture();
  const pre = await beginLogin(fixture.handlers);
  const response = await login(fixture.handlers, pre);
  const sessionId = sessionCookie(response);
  fixture.handlers = createAdminAuthHandlers({
    env: { ...env(), ADMIN_SESSION_EPOCH: 'synthetic-epoch-02' },
    sessionStore: fixture.store,
    randomToken: () => Buffer.alloc(32, 99).toString('base64url')
  });
  const afterEpochChange = await fixture.handlers.session(new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}` }
  }));
  assert.equal((await afterEpochChange.json()).authenticated, false);
});

test('falhas do armazenamento falham fechado e não são devolvidas ao cliente', async () => {
  const { handlers, blobs, store } = createFixture();
  const preflightBeforeFailure = await beginLogin(handlers);
  const signedIn = await login(handlers, preflightBeforeFailure);
  const sid = sessionCookie(signedIn);
  blobs.failGet = true;
  const sessionResponse = await handlers.handle('session', new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${sid}` }
  }));
  assert.equal(sessionResponse.status, 503);
  assert.doesNotMatch(await sessionResponse.text(), /synthetic storage failure/);
  blobs.failGet = false;
  await revokeAdminSession(sid, store);

  blobs.failSet = true;
  const preflight = await beginLogin(handlers);
  const loginResponse = await handlers.handle('login', new Request(`${TEST_ORIGIN}/auth/admin/login`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_CSRF_COOKIE}=${preflight.csrfCookie}`, csrf: preflight.csrfToken }),
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  }));
  assert.equal(loginResponse.status, 503);
  assert.doesNotMatch(await loginResponse.text(), /synthetic storage failure/);
  assert.equal(blobs.values.size, 0);

  blobs.failSet = false;
  const usableLogin = await login(handlers, preflight);
  const sidAfterFailure = sessionCookie(usableLogin);
  const csrf = readSetCookie(usableLogin, ADMIN_CSRF_COOKIE) || preflight.csrfToken;
  blobs.failDelete = true;
  const logoutResponse = await handlers.handle('logout', new Request(`${TEST_ORIGIN}/auth/admin/logout`, {
    method: 'POST',
    headers: headers({ cookie: `${ADMIN_SESSION_COOKIE}=${sidAfterFailure}; ${ADMIN_CSRF_COOKIE}=${csrf}`, csrf })
  }));
  assert.equal(logoutResponse.status, 503);
  assert.doesNotMatch(await logoutResponse.text(), /synthetic storage failure/);
  assert.equal(blobs.values.size, 1, 'logout must not claim revocation when storage deletion failed');
});

test('leituras de sessão do adaptador Blobs pedem consistência forte, inclusive concorrentes', async () => {
  const blobs = new MemoryBlobs();
  const store = createBlobSessionStore(blobs);
  const record = {
    version: 1,
    principal: 'admin',
    epoch: 'synthetic-epoch-01',
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_000_000 + ADMIN_SESSION_TTL_MS,
    csrfToken: Buffer.alloc(32, 10).toString('base64url')
  };
  const sessionId = Buffer.alloc(32, 11).toString('base64url');
  const { createHash } = await import('node:crypto');
  const key = `session:${createHash('sha256').update(sessionId).digest('hex')}`;
  blobs.values.set(key, record);
  const handlers = createAdminAuthHandlers({ env: env(), sessionStore: store, now: () => 1_800_000_000_001 });
  const request = new Request(`${TEST_ORIGIN}/auth/admin/session`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}; ${ADMIN_CSRF_COOKIE}=${record.csrfToken}` }
  });
  const responses = await Promise.all([handlers.session(request), handlers.session(request)]);
  assert.deepEqual(await Promise.all(responses.map(async response => (await response.json()).authenticated)), [true, true]);
  assert.equal(blobs.reads.length, 2);
  assert.ok(blobs.reads.every(read => read.options?.consistency === 'strong'));
});

test('Functions têm rotas isoladas e limites locais por endpoint', () => {
  assert.equal(loginFunction.config.path, '/auth/admin/login');
  assert.equal(loginFunction.config.method, 'POST');
  assert.deepEqual(loginFunction.config.rateLimit, { windowLimit: 5, windowSize: 60, aggregateBy: ['ip', 'domain'] });
  assert.equal(sessionFunction.config.path, '/auth/admin/session');
  assert.deepEqual(sessionFunction.config.rateLimit, { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] });
  assert.equal(logoutFunction.config.path, '/auth/admin/logout');
  assert.deepEqual(logoutFunction.config.rateLimit, { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] });
  assert.equal(ADMIN_SESSION_STORE_NAME, 'elevate-admin-sessions');
  assert.notEqual(ADMIN_SESSION_STORE_NAME, 'elevate-db');
  assert.notEqual(ADMIN_SESSION_STORE_NAME, 'elevate-db-control');
  assert.notEqual(ADMIN_SESSION_STORE_NAME, 'elevate-db-backups');
});

test('APIs atuais e frontend não foram ligados à autenticação nesta fase', async () => {
  for (const file of ['data.mjs', 'version.mjs', 'sync.mjs']) {
    const source = await readFile(new URL(`../netlify/functions/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /_admin-session|admin-login|admin-session|admin-logout/);
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /auth\/admin|ADMIN_PASSWORD|ADMIN_SESSION/);
});

test('tokens de sessão e password não aparecem em logs nem no corpo das respostas', async () => {
  const { handlers } = createFixture();
  const logs = [];
  const originals = ['log', 'info', 'warn', 'error'].map(method => [method, console[method]]);
  for (const [method] of originals) console[method] = (...values) => logs.push(values.join(' '));
  try {
    const preflight = await beginLogin(handlers);
    const response = await login(handlers, preflight);
    const sessionId = sessionCookie(response);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(TEST_PASSWORD));
    assert.equal(body.includes(sessionId), false);
    assert.equal(logs.length, 0);
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
});
