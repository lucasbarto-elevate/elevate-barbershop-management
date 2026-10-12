import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_ROLES,
  AuthorizationError,
  authorizationErrorResponse,
  createAuthorizer
} from '../netlify/functions/_authorization.mjs';

const adminIdentity = Object.freeze({ id: 'test-identity-admin-001', roles: [AUTH_ROLES.ADMIN] });
const deviceIdentity = Object.freeze({ id: 'test-identity-device-001', roles: [AUTH_ROLES.BARBER_DEVICE] });
const activeDevice = Object.freeze({
  identityId: 'test-identity-device-001',
  deviceId: 'test-ipad-front-desk-001',
  status: 'active'
});

function makeAuthorizer({ identity = null, device = null, identityError, deviceError } = {}) {
  const calls = { identity: 0, device: [] };
  const authorize = createAuthorizer({
    async getIdentity(request) {
      calls.identity++;
      assert.ok(request instanceof Request);
      if (identityError) throw identityError;
      return identity;
    },
    async findDevice(identityId) {
      calls.device.push(identityId);
      if (deviceError) throw deviceError;
      return device;
    }
  });
  return { authorize, calls };
}

async function expectAuthorizationFailure(promise, { status, code }) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test('pedido sem autenticação é recusado com 401', async () => {
  const { authorize, calls } = makeAuthorizer();
  await expectAuthorizationFailure(authorize(new Request('https://example.test/api/test'), AUTH_ROLES.ADMIN), {
    status: 401,
    code: 'unauthenticated'
  });
  assert.deepEqual(calls.device, []);
});

test('papéis declarados pelo cliente em headers ou body não autenticam o pedido', async () => {
  const { authorize } = makeAuthorizer();
  const request = new Request('https://example.test/api/test', {
    method: 'POST',
    headers: { Authorization: 'Bearer synthetic-admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: adminIdentity.id, roles: [AUTH_ROLES.ADMIN] })
  });
  await expectAuthorizationFailure(authorize(request, AUTH_ROLES.ADMIN), {
    status: 401,
    code: 'unauthenticated'
  });
});

test('administrador autenticado recebe principal admin sem consultar registo de dispositivos', async () => {
  const { authorize, calls } = makeAuthorizer({ identity: adminIdentity });
  assert.deepEqual(await authorize(new Request('https://example.test/api/test'), AUTH_ROLES.ADMIN), {
    subjectId: 'test-identity-admin-001',
    role: 'admin'
  });
  assert.deepEqual(calls.device, []);
});

test('dispositivo autenticado e ativo recebe principal barber-device', async () => {
  const { authorize, calls } = makeAuthorizer({ identity: deviceIdentity, device: activeDevice });
  assert.deepEqual(await authorize(new Request('https://example.test/api/test'), AUTH_ROLES.BARBER_DEVICE), {
    subjectId: 'test-identity-device-001',
    role: 'barber-device',
    deviceId: 'test-ipad-front-desk-001'
  });
  assert.deepEqual(calls.device, ['test-identity-device-001']);
});

test('dispositivo revogado é recusado', async () => {
  const { authorize } = makeAuthorizer({
    identity: deviceIdentity,
    device: { ...activeDevice, status: 'revoked' }
  });
  await expectAuthorizationFailure(authorize(new Request('https://example.test/api/test'), AUTH_ROLES.BARBER_DEVICE), {
    status: 403,
    code: 'device_revoked'
  });
});

test('dispositivo sem registo ativo ou com identidade divergente é recusado', async () => {
  const missing = makeAuthorizer({ identity: deviceIdentity });
  await expectAuthorizationFailure(missing.authorize(new Request('https://example.test/api/test'), AUTH_ROLES.BARBER_DEVICE), {
    status: 403,
    code: 'device_not_authorized'
  });

  const mismatch = makeAuthorizer({
    identity: deviceIdentity,
    device: { ...activeDevice, identityId: 'test-identity-other-device-001' }
  });
  await expectAuthorizationFailure(mismatch.authorize(new Request('https://example.test/api/test'), AUTH_ROLES.BARBER_DEVICE), {
    status: 403,
    code: 'device_not_authorized'
  });
});

test('papel insuficiente é recusado sem consultar o registo de dispositivos', async () => {
  const { authorize, calls } = makeAuthorizer({ identity: deviceIdentity, device: activeDevice });
  await expectAuthorizationFailure(authorize(new Request('https://example.test/api/test'), AUTH_ROLES.ADMIN), {
    status: 403,
    code: 'insufficient_role'
  });
  assert.deepEqual(calls.device, []);
});

test('identidade malformada ou com papéis incompatíveis é recusada', async () => {
  const malformed = makeAuthorizer({ identity: { id: '', roles: [AUTH_ROLES.ADMIN] } });
  await expectAuthorizationFailure(malformed.authorize(new Request('https://example.test/api/test'), AUTH_ROLES.ADMIN), {
    status: 401,
    code: 'invalid_identity'
  });

  const mixedRoles = makeAuthorizer({ identity: { id: 'test-identity-mixed-001', roles: [AUTH_ROLES.ADMIN, AUTH_ROLES.BARBER_DEVICE] } });
  await expectAuthorizationFailure(mixedRoles.authorize(new Request('https://example.test/api/test'), AUTH_ROLES.BARBER_DEVICE), {
    status: 403,
    code: 'ambiguous_roles'
  });
});

test('falhas de Identity e do registo também falham fechadas', async () => {
  const identityUnavailable = makeAuthorizer({ identityError: new Error('synthetic identity failure') });
  await expectAuthorizationFailure(identityUnavailable.authorize(new Request('https://example.test/api/test'), AUTH_ROLES.ADMIN), {
    status: 503,
    code: 'identity_unavailable'
  });

  const registryUnavailable = makeAuthorizer({ identity: deviceIdentity, deviceError: new Error('synthetic registry failure') });
  await expectAuthorizationFailure(registryUnavailable.authorize(new Request('https://example.test/api/test'), AUTH_ROLES.BARBER_DEVICE), {
    status: 503,
    code: 'device_registry_unavailable'
  });
});

test('dependências ausentes ou papel desconhecido não ativam qualquer modo permissivo', async () => {
  assert.throws(() => createAuthorizer(), /obrigatórios/);
  const { authorize } = makeAuthorizer({ identity: adminIdentity });
  await expectAuthorizationFailure(authorize(new Request('https://example.test/api/test'), 'owner'), {
    status: 503,
    code: 'authorization_misconfigured'
  });
});

test('resposta de erro é sanitizada e não cacheável', async () => {
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
