import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createStagingCatalogInitializer,
  isStagingAdminEndpoint,
  isStagingConfiguration
} from '../netlify/functions/initialize-catalog-staging.mjs';

const restoreSecret = 'synthetic-restore-token-for-tests';
const initializeSecret = 'synthetic-staging-initialize-token-for-tests';
const stagingEnv = {
  BACKUP_ALLOW_CATALOG_INITIALIZATION: 'true',
  BACKUP_RESTORE_TOKEN: restoreSecret,
  BACKUP_READ_TOKEN: 'synthetic-read-token-for-tests',
  STAGING_CATALOG_INITIALIZE_TOKEN: initializeSecret,
  BACKUP_ADMIN_URL: 'https://elevatebarbershop-staging.netlify.app/.netlify/functions/backup-admin',
  ELEVATE_DB_STORE_NAME: 'elevate-db-staging',
  ELEVATE_DB_CONTROL_STORE_NAME: 'elevate-db-control-staging',
  ELEVATE_DB_BACKUPS_STORE_NAME: 'elevate-db-backups-staging'
};

function request({ method = 'POST', body = { action: 'initialize-catalog' }, authorization = `Bearer ${initializeSecret}` } = {}) {
  return new Request('https://elevatebarbershop-staging.netlify.app/.netlify/functions/initialize-catalog-staging', {
    method,
    headers: { ...(authorization ? { Authorization: authorization } : {}), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
  });
}

test('temporary initializer accepts only the exact staging store configuration and arming flag', () => {
  assert.equal(isStagingConfiguration(stagingEnv), true);
  assert.equal(isStagingConfiguration({ ...stagingEnv, BACKUP_ALLOW_CATALOG_INITIALIZATION: 'false' }), false);
  assert.equal(isStagingConfiguration({ ...stagingEnv, ELEVATE_DB_STORE_NAME: 'elevate-db' }), false);
  assert.equal(isStagingConfiguration({
    BACKUP_ALLOW_CATALOG_INITIALIZATION: 'true',
    ELEVATE_DB_STORE_NAME: 'elevate-db',
    ELEVATE_DB_CONTROL_STORE_NAME: 'elevate-db-control',
    ELEVATE_DB_BACKUPS_STORE_NAME: 'elevate-db-backups'
  }), false);
  assert.equal(isStagingConfiguration({ ...stagingEnv, ELEVATE_DB_CONTROL_STORE_NAME: undefined }), false);
});

test('temporary initializer accepts only the exact HTTPS staging admin endpoint', () => {
  assert.equal(isStagingAdminEndpoint(stagingEnv.BACKUP_ADMIN_URL), true);
  for (const endpoint of [
    'http://elevatebarbershop-staging.netlify.app/.netlify/functions/backup-admin',
    'https://elevatebarbershop.ie/.netlify/functions/backup-admin',
    'https://elevatebarbershop-staging.netlify.app.evil.test/.netlify/functions/backup-admin',
    'https://elevatebarbershop-staging.netlify.app/.netlify/functions/backup-admin?target=prod',
    'https://elevatebarbershop-staging.netlify.app/.netlify/functions/other'
  ]) assert.equal(isStagingAdminEndpoint(endpoint), false, endpoint);
});

test('temporary initializer is an ordinary request Function with no schedule configuration', async () => {
  const source = await readFile(new URL('../netlify/functions/initialize-catalog-staging.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /export\s+const\s+config\s*=|schedule\s*:/);
});

test('route requires its dedicated bearer token before method, body, or fetch handling', async () => {
  let called = false;
  const handler = createStagingCatalogInitializer({ env: stagingEnv, fetchImpl: async () => { called = true; } });
  for (const requestValue of [
    request({ authorization: '' }),
    request({ authorization: 'Bearer wrong-token' }),
    request({ authorization: `Bearer ${restoreSecret}` }),
    request({ authorization: `Bearer ${stagingEnv.BACKUP_READ_TOKEN}` }),
    request({ method: 'GET', authorization: '' })
  ]) {
    const response = await handler(requestValue);
    assert.equal(response.status, 401);
    const responseText = JSON.stringify(await response.json());
    assert.equal(responseText.includes(initializeSecret), false);
    assert.equal(responseText.includes(restoreSecret), false);
  }
  assert.equal(called, false);

  const noConfiguredToken = createStagingCatalogInitializer({
    env: { ...stagingEnv, STAGING_CATALOG_INITIALIZE_TOKEN: undefined },
    fetchImpl: async () => { called = true; }
  });
  assert.equal((await noConfiguredToken(request())).status, 401);

  const sameAsRestore = createStagingCatalogInitializer({
    env: { ...stagingEnv, STAGING_CATALOG_INITIALIZE_TOKEN: restoreSecret },
    fetchImpl: async () => { called = true; }
  });
  assert.equal((await sameAsRestore(request({ authorization: `Bearer ${restoreSecret}` }))).status, 401);
  const sameAsRead = createStagingCatalogInitializer({
    env: { ...stagingEnv, STAGING_CATALOG_INITIALIZE_TOKEN: stagingEnv.BACKUP_READ_TOKEN },
    fetchImpl: async () => { called = true; }
  });
  assert.equal((await sameAsRead(request({ authorization: `Bearer ${stagingEnv.BACKUP_READ_TOKEN}` }))).status, 401);
  const tooShort = createStagingCatalogInitializer({
    env: { ...stagingEnv, STAGING_CATALOG_INITIALIZE_TOKEN: 'short' },
    fetchImpl: async () => { called = true; }
  });
  assert.equal((await tooShort(request({ authorization: 'Bearer short' }))).status, 401);
  assert.equal(called, false);
});

test('initializer sends a fixed authenticated action to staging and returns only sanitized data', async () => {
  let call;
  const handler = createStagingCatalogInitializer({
    env: stagingEnv,
    fetchImpl: async (url, options) => {
      call = { url, options };
      return Response.json({ ok: true, result: {
        initialized: true,
        source: 'seed-catalog',
        counts: { barbers: 1, secret: restoreSecret },
        reason: restoreSecret,
        token: restoreSecret
      } });
    }
  });

  const response = await handler(request());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(call.url, stagingEnv.BACKUP_ADMIN_URL);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, `Bearer ${restoreSecret}`);
  assert.deepEqual(JSON.parse(call.options.body), { action: 'initialize-catalog' });
  assert.equal(call.options.redirect, 'error');
  assert.equal(JSON.stringify(result).includes(restoreSecret), false);
  assert.deepEqual(result, { ok: true, result: { initialized: true, source: 'seed-catalog', counts: { barbers: 1 } } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('initializer fails closed for production, partial configuration, missing flag or missing/equal tokens', async () => {
  const envs = [
    { ...stagingEnv, ELEVATE_DB_STORE_NAME: 'elevate-db' },
    { ...stagingEnv, ELEVATE_DB_CONTROL_STORE_NAME: undefined },
    { ...stagingEnv, BACKUP_ALLOW_CATALOG_INITIALIZATION: undefined },
    { ...stagingEnv, BACKUP_RESTORE_TOKEN: undefined },
    { ...stagingEnv, BACKUP_READ_TOKEN: restoreSecret }
  ];
  for (const env of envs) {
    let called = false;
    const handler = createStagingCatalogInitializer({ env, fetchImpl: async () => { called = true; } });
    const response = await handler(request());
    assert.notEqual(response.status, 200);
    assert.equal(called, false);
    assert.equal(JSON.stringify(await response.json()).includes(restoreSecret), false);
  }
});

test('initializer rejects non-POST, wrong action, and non-staging admin URLs without making requests', async () => {
  let called = false;
  const handler = createStagingCatalogInitializer({
    env: stagingEnv,
    fetchImpl: async () => { called = true; }
  });
  assert.equal((await handler(request({ method: 'GET' }))).status, 405);
  assert.equal((await handler(request({ body: { action: 'restore' } }))).status, 400);
  const badEndpoint = createStagingCatalogInitializer({
    env: { ...stagingEnv, BACKUP_ADMIN_URL: 'https://elevatebarbershop.ie/.netlify/functions/backup-admin' },
    fetchImpl: async () => { called = true; }
  });
  const response = await badEndpoint(request());
  assert.equal(response.status, 503);
  assert.equal(called, false);
});

test('initializer does not expose remote error bodies or token in responses', async () => {
  const handler = createStagingCatalogInitializer({
    env: stagingEnv,
    fetchImpl: async () => Response.json({ ok: false, error: `failed with ${restoreSecret}` }, { status: 403 })
  });
  const response = await handler(request());
  assert.equal(response.status, 502);
  assert.equal(JSON.stringify(await response.json()).includes(restoreSecret), false);
});
