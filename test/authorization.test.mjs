import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  createAdminSessionResolver,
  createPasswordHash
} from '../netlify/functions/_admin-session.mjs';
import {
  AUTH_OPERATIONS,
  AUTH_ROLES,
  AuthorizationError,
  DEVICE_CSRF_COOKIE,
  authorizationErrorResponse,
  createAuthorizer
} from '../netlify/functions/_authorization.mjs';

const ORIGIN = 'https://elevate-staging.example.invalid';
const TEST_ADMIN_PASSWORD = 'synthetic-only-admin-password-31!';
const TEST_CSRF = Buffer.alloc(32, 17).toString('base64url');
const TEST_SESSION_ID = Buffer.alloc(32, 18).toString('base64url');
const adminIdentity = Object.freeze({ subjectId: 'synthetic-admin', role: AUTH_ROLES.ADMIN, csrfToken: TEST_CSRF });
const deviceIdentity = Object.freeze({
  subjectId: 'synthetic-device-session-subject',
  role: AUTH_ROLES.BARBER_DEVICE,
  deviceId: 'synthetic-ipad-device-001',
  generation: 1,
  csrfToken: TEST_CSRF
});
const activeDevice = Object.freeze({
  subjectId: deviceIdentity.subjectId,
  deviceId: deviceIdentity.deviceId,
  generation: 1,
  status: 'active'
});

function createFixture({ admin = null, device = null, adminError, deviceError, registryError, record = activeDevice } = {}) {
  const calls = { admin: 0, device: 0, registry: [] };
  const authorizer = createAuthorizer({
    expectedOrigin: ORIGIN,
    async resolveAdminSession(request) {
      calls.admin++;
      assert.ok(request instanceof Request);
      if (adminError) throw adminError;
      return admin;
    },
    async resolveDeviceSession(request) {
      calls.device++;
      assert.ok(request instanceof Request);
      if (deviceError) throw deviceError;
      return device;
    },
    async findDevice(subjectId, deviceId) {
      calls.registry.push({ subjectId, deviceId });
      if (registryError) throw registryError;
      return record;
    }
  });
  return { authorizer, calls };
}

async function expectFailure(promise, { status, code }) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

function mutationRequest({ cookieName = ADMIN_CSRF_COOKIE, cookieToken = TEST_CSRF, headerToken = TEST_CSRF, origin = ORIGIN } = {}) {
  return new Request(`${ORIGIN}/api/protected`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: `${cookieName}=${cookieToken}`,
      'X-CSRF-Token': headerToken
    }
  });
}

test('construtor exige resolvers confiáveis e Origin HTTPS explícita', () => {
  assert.throws(() => createAuthorizer(), /obrigatórios/);
  assert.throws(() => createAuthorizer({
    resolveAdminSession: async () => null,
    resolveDeviceSession: async () => null,
    findDevice: async () => null,
    expectedOrigin: 'http://example.test'
  }), /obrigatórios/);
});

test('resolvedor administrativo reutiliza a sessão opaca e rejeita sessão ausente, inválida e expirada', async () => {
  const hash = await createPasswordHash(TEST_ADMIN_PASSWORD);
  const env = {
    ADMIN_EMAIL: 'admin.synthetic@example.invalid',
    ADMIN_PASSWORD_SCRYPT_HASH: hash,
    ADMIN_SESSION_EPOCH: 'synthetic-epoch-01',
    ADMIN_AUTH_ORIGIN: ORIGIN
  };
  let now = 1_800_000_000_000;
  const records = new Map();
  const sessionStore = {
    async get(key) { return records.get(key) ?? null; },
    async delete(key) { records.delete(key); }
  };
  const resolveAdminSession = createAdminSessionResolver({ env, sessionStore, now: () => now });
  const authorizer = createAuthorizer({
    expectedOrigin: ORIGIN,
    resolveAdminSession,
    resolveDeviceSession: async () => null,
    findDevice: async () => null
  });

  await expectFailure(authorizer.requireAdmin(new Request(`${ORIGIN}/api/admin`)), {
    status: 401,
    code: 'unauthenticated'
  });
  const invalidSession = new Request(`${ORIGIN}/api/admin`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=malformed-synthetic-session` }
  });
  await expectFailure(authorizer.requireAdmin(invalidSession), { status: 401, code: 'unauthenticated' });

  const sessionKey = `session:${createHash('sha256').update(TEST_SESSION_ID).digest('hex')}`;
  records.set(sessionKey, {
    version: 1,
    principal: 'admin',
    epoch: env.ADMIN_SESSION_EPOCH,
    createdAt: now,
    expiresAt: now + ADMIN_SESSION_TTL_MS,
    csrfToken: TEST_CSRF
  });
  const request = new Request(`${ORIGIN}/api/admin`, {
    headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${TEST_SESSION_ID}` }
  });
  const principal = await authorizer.requireAdmin(request);
  assert.equal(principal.role, AUTH_ROLES.ADMIN);
  assert.equal(principal.subjectId, 'admin');
  assert.equal(principal.csrfToken, TEST_CSRF);

  now += ADMIN_SESSION_TTL_MS + 1;
  await expectFailure(authorizer.requireAdmin(request), { status: 401, code: 'unauthenticated' });
  assert.equal(records.has(sessionKey), false, 'expired sessions are removed by the existing resolver');
});

test('falha ao consultar sessão administrativa falha fechado', async () => {
  const { authorizer } = createFixture({ adminError: new Error('synthetic session store failure') });
  await expectFailure(authorizer.requireAdmin(new Request(`${ORIGIN}/api/admin`)), {
    status: 503,
    code: 'admin_session_unavailable'
  });
});

test('ausência de autenticação não permite operações de negócio', async () => {
  const { authorizer, calls } = createFixture();
  await expectFailure(authorizer.authorizeOperation(new Request(`${ORIGIN}/api/data`), AUTH_OPERATIONS.CATALOG_READ), {
    status: 401,
    code: 'unauthenticated'
  });
  assert.equal(calls.registry.length, 0);
});

test('a única operação pública é health genérico; dados continuam protegidos', async () => {
  const { authorizer, calls } = createFixture();
  assert.deepEqual(await authorizer.authorizeOperation(new Request(`${ORIGIN}/api/health`), AUTH_OPERATIONS.HEALTH_READ), {
    subjectId: 'public', role: AUTH_ROLES.PUBLIC
  });
  await expectFailure(authorizer.authorizeOperation(new Request(`${ORIGIN}/api/data`), AUTH_OPERATIONS.CATALOG_READ), {
    status: 401,
    code: 'unauthenticated'
  });
  assert.equal(calls.admin, 1);
});

test('headers e payload com role, IDs ou permissões não concedem privilégios', async () => {
  const request = new Request(`${ORIGIN}/api/sync`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer synthetic-admin-token',
      'X-Role': 'admin',
      'X-Device-Id': 'synthetic-ipad-device-001',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'admin', roles: ['admin'], deviceId: 'admin', permissions: ['sales.delete'] })
  });
  const { authorizer, calls } = createFixture();
  await expectFailure(authorizer.requireAdmin(request), { status: 401, code: 'unauthenticated' });
  assert.equal(calls.registry.length, 0);
});

test('dispositivo só é aceite com sessão verificada e registo ativo correspondente', async () => {
  const { authorizer, calls } = createFixture({ device: deviceIdentity });
  const principal = await authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`));
  assert.equal(principal.deviceId, deviceIdentity.deviceId);
  assert.deepEqual(calls.registry, [{ subjectId: deviceIdentity.subjectId, deviceId: deviceIdentity.deviceId }]);

  const missing = createFixture({ device: deviceIdentity, record: null });
  await expectFailure(missing.authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 403,
    code: 'device_not_authorized'
  });

  const revoked = createFixture({ device: deviceIdentity, record: { ...activeDevice, status: 'revoked' } });
  await expectFailure(revoked.authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 403,
    code: 'device_revoked'
  });
});

test('geração antiga ou inválida do dispositivo é recusada mesmo com ID e papel corretos', async () => {
  const stalePrincipal = { ...deviceIdentity, generation: 4 };
  const staleRecord = { ...activeDevice, generation: 5 };
  const stale = createFixture({ device: stalePrincipal, record: staleRecord });
  await expectFailure(stale.authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 403,
    code: 'device_not_authorized'
  });

  const malformed = createFixture({ device: { ...deviceIdentity, generation: Number.MAX_SAFE_INTEGER + 1 } });
  await expectFailure(malformed.authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 403,
    code: 'device_not_authorized'
  });
});

test('falha do registo de dispositivos ou sessão do iPad falha fechado', async () => {
  const registryFailure = createFixture({ device: deviceIdentity, registryError: new Error('synthetic registry failure') });
  await expectFailure(registryFailure.authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 503,
    code: 'device_registry_unavailable'
  });

  const sessionFailure = createFixture({ deviceError: new Error('synthetic device session failure') });
  await expectFailure(sessionFailure.authorizer.requireDevice(new Request(`${ORIGIN}/api/barber/sales`)), {
    status: 503,
    code: 'device_session_unavailable'
  });
});

test('matriz limita o iPad a catálogo, vendas do dia e criação append-only', async () => {
  const device = createFixture({ device: deviceIdentity });
  for (const operation of [AUTH_OPERATIONS.CATALOG_READ, AUTH_OPERATIONS.TODAY_SALES_READ, AUTH_OPERATIONS.SALES_CREATE]) {
    assert.equal((await device.authorizer.authorizeOperation(new Request(`${ORIGIN}/api`), operation)).role, AUTH_ROLES.BARBER_DEVICE);
  }
  for (const operation of [
    AUTH_OPERATIONS.SALES_EDIT,
    AUTH_OPERATIONS.SALES_DELETE,
    AUTH_OPERATIONS.CATALOG_WRITE,
    AUTH_OPERATIONS.MANUAL_STOCK_WRITE,
    AUTH_OPERATIONS.REPORTS_READ,
    AUTH_OPERATIONS.BACKUPS_MANAGE,
    AUTH_OPERATIONS.DEVICES_MANAGE
  ]) {
    await expectFailure(device.authorizer.authorizeOperation(new Request(`${ORIGIN}/api`), operation), {
      status: 403,
      code: 'insufficient_permission'
    });
  }

  const admin = createFixture({ admin: adminIdentity });
  for (const operation of Object.values(AUTH_OPERATIONS)) {
    assert.equal((await admin.authorizer.authorizeOperation(new Request(`${ORIGIN}/api`, {
      headers: { Cookie: `${ADMIN_SESSION_COOKIE}=${TEST_SESSION_ID}` }
    }), operation)).role, AUTH_ROLES.ADMIN);
  }
});

test('papel contraditório ou principal de resolver inválido é recusado', async () => {
  const mixed = createFixture({ admin: { ...adminIdentity, role: AUTH_ROLES.BARBER_DEVICE } });
  await expectFailure(mixed.authorizer.requireAdmin(new Request(`${ORIGIN}/api/admin`)), {
    status: 503,
    code: 'authorization_misconfigured'
  });
});

test('Origin e CSRF devem corresponder ao Origin esperado e à sessão do servidor', async () => {
  const { authorizer } = createFixture({ admin: adminIdentity });
  assert.equal(await authorizer.requireAdminMutation(mutationRequest(), AUTH_OPERATIONS.DEVICES_MANAGE).then(p => p.role), AUTH_ROLES.ADMIN);

  await expectFailure(authorizer.requireAdminMutation(mutationRequest({ origin: 'https://attacker.example.invalid' }), AUTH_OPERATIONS.DEVICES_MANAGE), {
    status: 403,
    code: 'origin_rejected'
  });
  await expectFailure(authorizer.requireAdminMutation(mutationRequest({ cookieToken: 'A'.repeat(43) }), AUTH_OPERATIONS.DEVICES_MANAGE), {
    status: 403,
    code: 'csrf_rejected'
  });
  await expectFailure(authorizer.requireAdminMutation(mutationRequest({ headerToken: 'B'.repeat(43) }), AUTH_OPERATIONS.DEVICES_MANAGE), {
    status: 403,
    code: 'csrf_rejected'
  });

  const { authorizer: deviceAuthorizer } = createFixture({ device: deviceIdentity });
  const deviceRequest = mutationRequest({ cookieName: DEVICE_CSRF_COOKIE });
  assert.equal((await deviceAuthorizer.requireDeviceMutation(deviceRequest)).role, AUTH_ROLES.BARBER_DEVICE);
});

test('cookie CSRF de outro perfil não é aceite e operações sem política falham fechado', async () => {
  const { authorizer } = createFixture({ admin: adminIdentity });
  await expectFailure(authorizer.requireAdminMutation(mutationRequest({ cookieName: DEVICE_CSRF_COOKIE }), AUTH_OPERATIONS.DEVICES_MANAGE), {
    status: 403,
    code: 'csrf_rejected'
  });
  await expectFailure(authorizer.authorizeOperation(new Request(`${ORIGIN}/api`), 'unknown.operation'), {
    status: 503,
    code: 'authorization_misconfigured'
  });
});

test('falhas de autorização geram respostas sanitizadas e não cacheáveis', async () => {
  const response = authorizationErrorResponse(new AuthorizationError(403, 'device_revoked', 'Este dispositivo está revogado ou inativo.'));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Este dispositivo está revogado ou inativo.',
    code: 'device_revoked'
  });

  const unexpected = authorizationErrorResponse(new Error('synthetic internal detail'));
  assert.equal(unexpected.status, 503);
  assert.doesNotMatch(await unexpected.text(), /synthetic internal detail/);
});
