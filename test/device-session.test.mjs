import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AUTH_OPERATIONS,
  AUTH_ROLES,
  AuthorizationError,
  createAuthorizer,
  DEVICE_CSRF_COOKIE
} from '../netlify/functions/_authorization.mjs';
import {
  clearDeviceSessionCookieHeaders,
  createDeviceSessionManager,
  DEVICE_AUTHORIZATION_KEY,
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_COOKIE_MAX_AGE_SECONDS,
  deviceSessionCookieHeaders,
  deviceSessionErrorResponse
} from '../netlify/functions/_device-session.mjs';
import { CONTROL_STORE_NAME } from '../netlify/functions/_coordination.mjs';

const ORIGIN = 'https://elevate-staging.example.invalid';

class MemoryCASStore {
  record = null;
  revision = 0;
  failRead = false;
  failWrite = false;
  throwBeforeWrite = false;
  throwAfterWrite = false;
  writeWithoutEtag = false;
  reads = [];
  writes = [];

  async getWithMetadata(key, options) {
    this.reads.push({ key, options });
    if (this.failRead) throw new Error('synthetic storage failure with secret-like marker');
    if (!this.record) return null;
    return structuredClone(this.record);
  }

  async setJSON(key, value, options = {}) {
    this.writes.push({ key, options: { ...options } });
    if (this.failWrite) throw new Error('synthetic storage write failure with secret-like marker');
    if (this.throwBeforeWrite) {
      this.throwBeforeWrite = false;
      throw new Error('synthetic network failure before commit');
    }
    if (options.onlyIfNew && this.record) return { modified: false };
    if (options.onlyIfMatch && this.record?.etag !== options.onlyIfMatch) return { modified: false };
    this.revision++;
    if (this.writeWithoutEtag) {
      this.record = { data: structuredClone(value), etag: `"device-etag-${this.revision}"` };
      return { modified: true, etag: '' };
    }
    const etag = `"device-etag-${this.revision}"`;
    this.record = { data: structuredClone(value), etag };
    if (this.throwAfterWrite) {
      this.throwAfterWrite = false;
      throw new Error('synthetic network failure after commit');
    }
    return { modified: true, etag };
  }
}

class GatedReadCASStore extends MemoryCASStore {
  nextReadBarrier = null;

  gateNextReads(participants) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this.nextReadBarrier = { remaining: participants, promise, release };
  }

  async getWithMetadata(key, options) {
    const snapshot = await super.getWithMetadata(key, options);
    const barrier = this.nextReadBarrier;
    if (barrier) {
      barrier.remaining--;
      if (barrier.remaining === 0) {
        this.nextReadBarrier = null;
        barrier.release();
      }
      await barrier.promise;
    }
    return snapshot;
  }
}

function tokenFactory() {
  let counter = 20;
  return () => Buffer.alloc(32, counter++).toString('base64url');
}

function createFixture({ store = new MemoryCASStore(), clock = () => 1_800_000_000_000 } = {}) {
  let deviceCounter = 0;
  const manager = createDeviceSessionManager({
    store,
    now: clock,
    randomToken: tokenFactory(),
    randomDeviceId: () => `synthetic-ipad-${++deviceCounter}`
  });
  return { store, manager };
}

function cookieRequest(session, { csrf = session.csrfToken, overrideSession = session.sessionId, origin = ORIGIN } = {}) {
  const cookieParts = [`${DEVICE_SESSION_COOKIE}=${overrideSession}`];
  if (csrf) cookieParts.push(`${DEVICE_CSRF_COOKIE}=${csrf}`);
  return new Request(`${ORIGIN}/api/barber/sales`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookieParts.join('; '),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {})
    },
    body: JSON.stringify({ role: 'admin', permissions: ['sales.delete'] })
  });
}

function createDeviceAuthorizer(manager, { admin = null } = {}) {
  return createAuthorizer({
    expectedOrigin: ORIGIN,
    resolveAdminSession: async () => admin,
    resolveDeviceSession: manager.resolveDeviceSession,
    findDevice: manager.findDevice
  });
}

async function expectAuthFailure(promise, { status, code }) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test('usa apenas um registo de controlo no store isolado do site e grava hashes', async () => {
  const { store, manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  assert.equal(CONTROL_STORE_NAME.includes('elevate-db'), true);
  assert.equal(store.record.data.status, 'active');
  assert.equal(store.record.data.generation, 1);
  assert.equal(store.record.data.deviceId, session.deviceId);
  assert.equal(store.record.data.sessionHash, createHash('sha256').update(session.sessionId).digest('hex'));
  assert.equal(store.record.data.csrfHash, createHash('sha256').update(session.csrfToken).digest('hex'));
  assert.equal(JSON.stringify(store.record.data).includes(session.sessionId), false);
  assert.equal(JSON.stringify(store.record.data).includes(session.csrfToken), false);
  assert.equal(new Set(store.writes.map(write => write.key)).size, 1);
  assert.ok(store.reads.every(read => read.options?.consistency === 'strong'));
  assert.equal(store.writes[0].options.onlyIfNew, true);
  assert.equal(DEVICE_AUTHORIZATION_KEY, 'authorization:shared-ipad:active');
});

test('ativação exige confirmação explícita para substituir e geração atual', async () => {
  const { manager } = createFixture();
  const first = await manager.activate({ expectedGeneration: 0 });
  await assert.rejects(manager.activate({ expectedGeneration: 1 }), error => error.code === 'device_already_active');
  await assert.rejects(manager.activate({ replaceExisting: true, expectedGeneration: 0 }), error => error.code === 'device_state_changed');
  const replacement = await manager.activate({ replaceExisting: true, expectedGeneration: first.generation });
  assert.notEqual(replacement.deviceId, first.deviceId);
  assert.equal(replacement.generation, first.generation + 1);
});

test('cookie de sessão é HttpOnly e seguro; CSRF é separado; ambos podem ser expirados', async () => {
  const { manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  const headers = deviceSessionCookieHeaders(session).map(([, value]) => value);
  assert.equal(headers.length, 2);
  const sessionCookie = headers.find(value => value.startsWith(`${DEVICE_SESSION_COOKIE}=`));
  const csrfCookie = headers.find(value => value.startsWith(`${DEVICE_CSRF_COOKIE}=`));
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /Secure/i);
  assert.match(sessionCookie, /SameSite=Lax/i);
  assert.match(sessionCookie, /Path=\//i);
  assert.match(sessionCookie, new RegExp(`Max-Age=${DEVICE_SESSION_COOKIE_MAX_AGE_SECONDS}`));
  assert.doesNotMatch(sessionCookie, /Domain=/i);
  assert.doesNotMatch(csrfCookie, /HttpOnly/i);
  assert.match(csrfCookie, /Secure/i);
  assert.match(csrfCookie, /SameSite=Lax/i);
  assert.equal(clearDeviceSessionCookieHeaders().length, 2);
  assert.ok(clearDeviceSessionCookieHeaders().every(([, value]) => /Max-Age=0/.test(value)));
});

test('cookie válido resolve apenas o dispositivo ativo; cookie ausente ou adulterado falha fechado', async () => {
  const { manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  const authorizer = createDeviceAuthorizer(manager);
  const principal = await authorizer.requireDevice(cookieRequest(session), AUTH_OPERATIONS.SALES_CREATE);
  assert.equal(principal.role, AUTH_ROLES.BARBER_DEVICE);
  assert.equal(principal.deviceId, session.deviceId);
  assert.equal(principal.generation, session.generation);

  await expectAuthFailure(authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 401, code: 'unauthenticated'
  });
  await expectAuthFailure(authorizer.requireDevice(cookieRequest(session, { overrideSession: 'A'.repeat(43) })), {
    status: 401, code: 'unauthenticated'
  });
});

test('CSRF inválido não remove a autenticação de leitura, mas bloqueia a escrita', async () => {
  const { manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  const authorizer = createDeviceAuthorizer(manager);
  const noCsrf = cookieRequest(session, { csrf: 'B'.repeat(43) });
  assert.equal((await authorizer.requireDevice(noCsrf, AUTH_OPERATIONS.SALES_CREATE)).role, AUTH_ROLES.BARBER_DEVICE);
  await expectAuthFailure(authorizer.requireDeviceMutation(noCsrf), { status: 403, code: 'csrf_rejected' });
  await expectAuthFailure(authorizer.requireDeviceMutation(cookieRequest(session, { origin: 'https://attacker.example.invalid' })), {
    status: 403, code: 'origin_rejected'
  });
});

test('papel admin em payload ou header não eleva o dispositivo', async () => {
  const { manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  const authorizer = createDeviceAuthorizer(manager);
  const request = new Request(`${ORIGIN}/api/admin/reports`, {
    headers: {
      Cookie: `${DEVICE_SESSION_COOKIE}=${session.sessionId}; ${DEVICE_CSRF_COOKIE}=${session.csrfToken}`,
      'X-Role': 'admin',
      'X-Permissions': 'reports.read'
    }
  });
  await expectAuthFailure(authorizer.requireAdmin(request, AUTH_OPERATIONS.REPORTS_READ), {
    status: 403, code: 'insufficient_permission'
  });
});

test('revogação invalida a sessão atual e o estado não deixa um segundo iPad ativo', async () => {
  const { store, manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  const revoked = await manager.revoke({ expectedGeneration: session.generation });
  assert.equal(revoked.revoked, true);
  assert.equal(store.record.data.status, 'revoked');
  assert.equal(store.record.data.sessionHash, null);
  assert.equal(store.record.data.csrfHash, null);

  const authorizer = createDeviceAuthorizer(manager);
  await expectAuthFailure(authorizer.requireDevice(cookieRequest(session)), { status: 401, code: 'unauthenticated' });
  const replacement = await manager.activate({ expectedGeneration: revoked.generation });
  assert.equal(replacement.generation, revoked.generation + 1);
  assert.equal(store.record.data.deviceId, replacement.deviceId);
  assert.equal(store.record.data.status, 'active');
});

test('sessão antiga não pode ser reutilizada depois de substituição', async () => {
  const { manager } = createFixture();
  const oldSession = await manager.activate({ expectedGeneration: 0 });
  const oldPrincipal = await manager.resolveDeviceSession(cookieRequest(oldSession));
  const replacement = await manager.activate({ replaceExisting: true, expectedGeneration: oldSession.generation });
  const currentRecord = await manager.findDevice(oldPrincipal.subjectId, oldPrincipal.deviceId);
  assert.equal(currentRecord, null);
  assert.notEqual(oldPrincipal.deviceId, replacement.deviceId);
  const raceAuthorizer = createAuthorizer({
    expectedOrigin: ORIGIN,
    resolveAdminSession: async () => null,
    resolveDeviceSession: async () => oldPrincipal,
    findDevice: manager.findDevice
  });
  await expectAuthFailure(raceAuthorizer.requireDevice(cookieRequest(oldSession)), {
    status: 403, code: 'device_not_authorized'
  });
});

test('duas ativações concorrentes com a mesma geração só podem produzir um ativo', async () => {
  const store = new GatedReadCASStore();
  const { manager } = createFixture({ store });
  store.gateNextReads(2);
  const results = await Promise.allSettled([
    manager.activate({ expectedGeneration: 0 }),
    manager.activate({ expectedGeneration: 0 })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const failure = results.find(result => result.status === 'rejected').reason;
  assert.equal(failure.code, 'device_state_changed');
  assert.equal(store.record.data.status, 'active');
  assert.equal(store.record.data.generation, 1);
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes.filter(write => write.options.onlyIfNew).length, 2);
});

test('duas substituições concorrentes com a mesma geração não deixam duas sessões válidas', async () => {
  const store = new GatedReadCASStore();
  const { manager } = createFixture({ store });
  const initial = await manager.activate({ expectedGeneration: 0 });
  store.gateNextReads(2);
  const results = await Promise.allSettled([
    manager.activate({ replaceExisting: true, expectedGeneration: initial.generation }),
    manager.activate({ replaceExisting: true, expectedGeneration: initial.generation })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'device_state_changed');
  const winningSession = results.find(result => result.status === 'fulfilled').value;
  assert.equal(store.record.data.deviceId, winningSession.deviceId);
  assert.equal(store.record.data.generation, winningSession.generation);
  assert.notEqual(store.record.data.sessionHash, createHash('sha256').update(initial.sessionId).digest('hex'));
  assert.equal(new Set(store.writes.map(write => write.key)).size, 1);
  assert.equal(store.record.data.status, 'active');
});

test('revogação simultânea com substituição tem um único vencedor CAS e no máximo um ativo', async () => {
  const store = new GatedReadCASStore();
  const { manager } = createFixture({ store });
  const initial = await manager.activate({ expectedGeneration: 0 });
  store.gateNextReads(2);

  const results = await Promise.allSettled([
    manager.revoke({ expectedGeneration: initial.generation }),
    manager.activate({ replaceExisting: true, expectedGeneration: initial.generation })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'device_state_changed');
  assert.equal(new Set(store.writes.map(write => write.key)).size, 1);

  const state = store.record.data;
  assert.ok(['active', 'revoked'].includes(state.status));
  if (state.status === 'active') {
    const successfulActivation = results.find(result => result.status === 'fulfilled').value;
    assert.equal(state.deviceId, successfulActivation.deviceId);
    assert.equal(state.generation, successfulActivation.generation);
  } else {
    assert.equal(state.sessionHash, null);
    assert.equal(state.csrfHash, null);
  }
});

test('estado divergente, geração antiga e armazenamento indisponível falham fechado', async () => {
  const { store, manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  await assert.rejects(manager.revoke({ expectedGeneration: session.generation + 1 }), error => error.code === 'device_state_changed');
  store.failRead = true;
  await assert.rejects(manager.resolveDeviceSession(cookieRequest(session)), error => error.code === 'device_store_unavailable');
  store.failRead = false;
  store.failWrite = true;
  await assert.rejects(manager.revoke({ expectedGeneration: session.generation }), error => error.code === 'device_store_unavailable');
});

test('falha de leitura durante autorização do dispositivo é recusada', async () => {
  const { store, manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  store.failRead = true;
  const authorizer = createDeviceAuthorizer(manager);
  await expectAuthFailure(authorizer.requireDevice(cookieRequest(session)), {
    status: 503, code: 'device_session_unavailable'
  });
});

test('falha de rede após commit confirma o estado; falha antes do commit não emite sessão', async () => {
  const committedStore = new MemoryCASStore();
  committedStore.throwAfterWrite = true;
  const committed = createFixture({ store: committedStore });
  const session = await committed.manager.activate({ expectedGeneration: 0 });
  assert.equal(committedStore.record.data.sessionHash, createHash('sha256').update(session.sessionId).digest('hex'));
  assert.equal((await committed.manager.resolveDeviceSession(cookieRequest(session))).deviceId, session.deviceId);

  const uncommittedStore = new MemoryCASStore();
  uncommittedStore.throwBeforeWrite = true;
  const uncommitted = createFixture({ store: uncommittedStore });
  await assert.rejects(uncommitted.manager.activate({ expectedGeneration: 0 }), error => error.code === 'device_store_unavailable');
  assert.equal(uncommittedStore.record, null);
  const retry = await uncommitted.manager.activate({ expectedGeneration: 0 });
  assert.ok(retry.sessionId);
  assert.equal(uncommittedStore.record.data.status, 'active');
});

test('revogação durante operação já autorizada não cancela escrita em curso; nova autorização é recusada', async () => {
  const { manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  const authorizer = createDeviceAuthorizer(manager);
  const request = cookieRequest(session);
  let signalAuthorized;
  let releaseOperation;
  const authorizationReached = new Promise(resolve => { signalAuthorized = resolve; });
  const operationGate = new Promise(resolve => { releaseOperation = resolve; });
  let operationWrote = false;
  const inFlightOperation = (async () => {
    const principal = await authorizer.requireDeviceMutation(request);
    signalAuthorized(principal);
    await operationGate;
    // Represents a future business handler that has already passed auth.
    operationWrote = true;
  })();
  const authorizedPrincipal = await authorizationReached;

  await manager.revoke({ expectedGeneration: session.generation });
  await expectAuthFailure(authorizer.requireDeviceMutation(request), {
    status: 401, code: 'unauthenticated'
  });
  releaseOperation();
  await inFlightOperation;

  // An already returned principal is not a revocable handle. Future business
  // handlers must serialize revocation and writes and revalidate before commit.
  assert.equal(authorizedPrincipal.deviceId, session.deviceId);
  assert.equal(operationWrote, true);
});

test('resultados CAS sem ETag só são aceites após leitura forte confirmar a gravação', async () => {
  const store = new MemoryCASStore();
  store.writeWithoutEtag = true;
  const { manager } = createFixture({ store });
  const session = await manager.activate({ expectedGeneration: 0 });
  assert.equal(store.record.data.sessionHash, createHash('sha256').update(session.sessionId).digest('hex'));
  assert.ok(store.reads.length >= 2, 'must read back the conditionally written singleton');

  const emptyStore = new MemoryCASStore();
  emptyStore.writeWithoutEtag = true;
  emptyStore.getWithMetadata = async function (key, options) {
    this.reads.push({ key, options });
    if (this.failRead) throw new Error('synthetic read failure');
    return null;
  };
  const failed = createFixture({ store: emptyStore });
  await assert.rejects(failed.manager.activate({ expectedGeneration: 0 }), error => error.code === 'device_store_unavailable');
});

test('erros sanitizados não revelam tokens e o módulo não os escreve em logs', async () => {
  const { store, manager } = createFixture();
  const session = await manager.activate({ expectedGeneration: 0 });
  store.failRead = true;
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    let error;
    try { await manager.resolveDeviceSession(cookieRequest(session)); } catch (caught) { error = caught; }
    const response = deviceSessionErrorResponse(error);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.doesNotMatch(body, new RegExp(session.sessionId));
    assert.doesNotMatch(body, new RegExp(session.csrfToken));
    assert.doesNotMatch(body, /synthetic storage failure/);
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalError;
  }
});

test('resposta de erro após falha incerta não contém identificadores ou hashes de sessão', async () => {
  const store = new MemoryCASStore();
  store.throwBeforeWrite = true;
  const { manager } = createFixture({ store });
  let error;
  try { await manager.activate({ expectedGeneration: 0 }); } catch (caught) { error = caught; }
  const response = deviceSessionErrorResponse(error);
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.doesNotMatch(body, /sessionId|csrfToken|sessionHash|csrfHash|synthetic network failure/);
});
