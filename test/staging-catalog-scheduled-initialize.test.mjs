import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler, { config, createStagingCatalogScheduledInitializer } from '../netlify/functions/initialize-catalog-staging-now.mjs';

const restore = 'synthetic-restore-token-for-scheduled-tests';
const init = 'synthetic-staging-catalog-initialize-token-123456';
const env = {
  BACKUP_ALLOW_CATALOG_INITIALIZATION: 'true',
  BACKUP_RESTORE_TOKEN: restore,
  BACKUP_READ_TOKEN: 'synthetic-read-token-for-scheduled-tests',
  STAGING_CATALOG_INITIALIZE_TOKEN: init,
  BACKUP_ADMIN_URL: 'https://elevatebarbershop-staging.netlify.app/.netlify/functions/backup-admin',
  ELEVATE_DB_STORE_NAME: 'elevate-db-staging',
  ELEVATE_DB_CONTROL_STORE_NAME: 'elevate-db-control-staging',
  ELEVATE_DB_BACKUPS_STORE_NAME: 'elevate-db-backups-staging'
};

function scheduledRequest(payload = { next_run: '2028-02-29T00:00:00.000Z' }) {
  return new Request('https://example.test/.netlify/functions/initialize-catalog-staging-now', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
}

test('scheduled initializer uses a distant leap-day schedule for Run now', async () => {
  assert.deepEqual(config, { schedule: '0 0 29 2 *' });
  const toml = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[functions\."initialize-catalog-staging-now"\]\s+schedule = "0 0 29 2 \*"/);
  assert.equal(typeof handler, 'function');
});

test('scheduled event invokes fixed staging admin action using environment secrets internally', async () => {
  let call;
  const fn = createStagingCatalogScheduledInitializer({ env, fetchImpl: async (url, options) => {
    call = { url, options };
    return Response.json({ ok: true, result: { initialized: true, source: 'legacy-database', counts: { barbers: 2, services: 3, products: 4, token: restore } } });
  } });
  const response = await fn(scheduledRequest());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(call.url, env.BACKUP_ADMIN_URL);
  assert.equal(call.options.headers.Authorization, `Bearer ${restore}`);
  assert.deepEqual(JSON.parse(call.options.body), { action: 'initialize-catalog' });
  assert.equal(call.options.redirect, 'error');
  assert.deepEqual(result, { ok: true, result: { initialized: true, source: 'legacy-database', counts: { barbers: 2, services: 3, products: 4 } } });
  assert.equal(JSON.stringify(result).includes(restore), false);
  assert.equal(JSON.stringify(result).includes(init), false);
});

test('scheduled initializer rejects invalid events without calling admin', async () => {
  let called = false;
  const fn = createStagingCatalogScheduledInitializer({ env, fetchImpl: async () => { called = true; } });
  const queryToken = new Request('https://example.test/?token=not-a-secret', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next_run: '2028-02-29T00:00:00.000Z' })
  });
  const bodyToken = scheduledRequest({ next_run: '2028-02-29T00:00:00.000Z', token: 'ignored-input' });
  const headerToken = new Request('https://example.test/', {
    method: 'POST', headers: { Authorization: 'Bearer ignored-input', 'Content-Type': 'application/json' }, body: JSON.stringify({ next_run: '2028-02-29T00:00:00.000Z' })
  });
  for (const request of [new Request('https://example.test/'), scheduledRequest({}), scheduledRequest({ next_run: 'invalid' }), queryToken, bodyToken, headerToken]) {
    assert.equal((await fn(request)).status, 400);
  }
  assert.equal(called, false);
});

test('scheduled initializer fails closed for production/default, partial, or unarmed config', async () => {
  const cases = [
    { ...env, ELEVATE_DB_STORE_NAME: 'elevate-db' },
    { ...env, ELEVATE_DB_CONTROL_STORE_NAME: undefined },
    { ...env, BACKUP_ALLOW_CATALOG_INITIALIZATION: 'false' },
    { ...env, STAGING_CATALOG_INITIALIZE_TOKEN: undefined },
    { ...env, STAGING_CATALOG_INITIALIZE_TOKEN: restore },
    { ...env, BACKUP_RESTORE_TOKEN: undefined },
    { ...env, BACKUP_READ_TOKEN: restore },
    { ...env, BACKUP_ADMIN_URL: 'https://elevatebarbershop.ie/.netlify/functions/backup-admin' }
  ];
  for (const candidate of cases) {
    let called = false;
    const fn = createStagingCatalogScheduledInitializer({ env: candidate, fetchImpl: async () => { called = true; } });
    assert.notEqual((await fn(scheduledRequest())).status, 200);
    assert.equal(called, false);
  }
});

test('scheduled initializer logs and returns no tokens or upstream error content', async () => {
  const logs = [];
  const oldError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const fn = createStagingCatalogScheduledInitializer({ env, fetchImpl: async () => Response.json({ ok: false, error: restore }, { status: 403 }) });
    const response = await fn(scheduledRequest());
    const output = `${JSON.stringify(await response.json())} ${logs.join(' ')}`;
    assert.equal(response.status, 502);
    assert.equal(output.includes(restore), false);
    assert.equal(output.includes(init), false);
  } finally { console.error = oldError; }
});
