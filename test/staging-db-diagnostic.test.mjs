import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler, { config, createStagingDbDiagnostic, isExactStagingStores } from '../netlify/functions/diagnose-staging-db-now.mjs';

const env = {
  ELEVATE_DB_STORE_NAME: 'elevate-db-staging',
  ELEVATE_DB_CONTROL_STORE_NAME: 'elevate-db-control-staging',
  ELEVATE_DB_BACKUPS_STORE_NAME: 'elevate-db-backups-staging'
};
const event = () => new Request('https://example.test/.netlify/functions/diagnose-staging-db-now', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ next_run: '2028-02-29T00:00:00.000Z' })
});

test('diagnostic is a scheduled Function with a distant Run now schedule', async () => {
  assert.deepEqual(config, { schedule: '0 0 29 2 *' });
  assert.equal(typeof handler, 'function');
  const toml = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[functions\."diagnose-staging-db-now"\]\s+schedule = "0 0 29 2 \*"/);
});

test('diagnostic reads only exact staging primary keys and returns counts/presence without values', async () => {
  const reads = [];
  let listOptions;
  const catalogData = { settings: { privateValue: 'must-not-leak' }, barbers: [{}], services: [{}], products: [{}] };
  const store = {
    async getWithMetadata(key, options) {
      reads.push({ key, options });
      const values = {
        catalog: { etag: 'catalog-etag', data: catalogData },
        database: null,
        'sync-version': { etag: 'version-etag', data: { version: 42, secret: 'must-not-leak' } }
      };
      return values[key];
    },
    async list(options) {
      listOptions = options;
      return { blobs: [{ key: 'entries/1' }, { key: 'entries/2' }] };
    },
    async set() { assert.fail('diagnostic must never write'); },
    async setJSON() { assert.fail('diagnostic must never write'); },
    async delete() { assert.fail('diagnostic must never delete'); }
  };
  const fn = createStagingDbDiagnostic({ env, getStoreImpl: options => {
    assert.deepEqual(options, { name: 'elevate-db-staging', consistency: 'strong' });
    return store;
  } });

  const response = await fn(event());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(reads.map(read => read.key).sort(), ['catalog', 'database', 'sync-version']);
  assert.ok(reads.every(read => read.options.consistency === 'strong'));
  assert.deepEqual(listOptions, { prefix: 'entries/' });
  assert.deepEqual(result, { ok: true, result: {
    store: 'elevate-db-staging',
    catalog: { exists: true, complete: true },
    database: { exists: false },
    syncVersion: { exists: true, version: 42 },
    entriesCount: 2
  } });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('diagnostic reports missing/incomplete data without exposing blob content', async () => {
  const fn = createStagingDbDiagnostic({ env, getStoreImpl: () => ({
    async getWithMetadata(key) {
      if (key === 'catalog') return { etag: 'etag', data: { settings: {}, barbers: [], services: 'bad', products: [] } };
      if (key === 'database') return { etag: 'etag', data: { private: 'hidden' } };
      return null;
    },
    async list() { return { blobs: [] }; }
  }) });
  const result = await (await fn(event())).json();
  assert.deepEqual(result, { ok: true, result: {
    store: 'elevate-db-staging', catalog: { exists: true, complete: false }, database: { exists: true },
    syncVersion: { exists: false, version: null }, entriesCount: 0
  } });
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('diagnostic refuses production defaults, partial and mismatched staging stores before opening a store', async () => {
  const variants = [
    {},
    { ...env, ELEVATE_DB_STORE_NAME: 'elevate-db' },
    { ...env, ELEVATE_DB_CONTROL_STORE_NAME: undefined },
    { ...env, ELEVATE_DB_BACKUPS_STORE_NAME: 'other-staging-store' }
  ];
  for (const candidate of variants) {
    assert.equal(isExactStagingStores(candidate), false);
    let opened = false;
    const fn = createStagingDbDiagnostic({ env: candidate, getStoreImpl: () => { opened = true; throw new Error('must not open'); } });
    assert.equal((await fn(event())).status, 403);
    assert.equal(opened, false);
  }
  assert.equal(isExactStagingStores(env), true);
});

test('diagnostic rejects URL, body, header tokens and invalid scheduled events without reading Blobs', async () => {
  let opened = false;
  const fn = createStagingDbDiagnostic({ env, getStoreImpl: () => { opened = true; throw new Error('must not read'); } });
  const invalid = [
    new Request('https://example.test/', { method: 'POST', body: '{}' }),
    new Request('https://example.test/?token=synthetic', { method: 'POST', body: JSON.stringify({ next_run: '2028-02-29T00:00:00.000Z' }) }),
    new Request('https://example.test/', { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: JSON.stringify({ next_run: '2028-02-29T00:00:00.000Z' }) }),
    new Request('https://example.test/', { method: 'POST', body: JSON.stringify({ next_run: '2028-02-29T00:00:00.000Z', token: 'synthetic' }) }),
    new Request('https://example.test/', { method: 'POST', body: JSON.stringify({ next_run: 'invalid' }) })
  ];
  for (const request of invalid) assert.equal((await fn(request)).status, 400);
  assert.equal(opened, false);
});

test('diagnostic logs only sanitized presence and count fields and hides read errors', async () => {
  const logs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => logs.push(JSON.stringify(args));
  console.error = (...args) => logs.push(JSON.stringify(args));
  try {
    const valuesFn = createStagingDbDiagnostic({ env, getStoreImpl: () => ({
      async getWithMetadata(key) {
        const values = {
          catalog: { etag: 'safe-etag', data: { settings: {}, barbers: [], services: [], products: [] } },
          database: null,
          'sync-version': { etag: 'safe-etag', data: { version: 7 } }
        };
        return values[key];
      },
      async list() { return { blobs: [{ key: 'entries/private-id' }] }; }
    }) });
    await valuesFn(event());
    assert.match(logs.join(' '), /"syncVersion":7/);
    const readFn = createStagingDbDiagnostic({ env, getStoreImpl: () => ({
      async getWithMetadata(key) { return key === 'catalog' ? { etag: 'sensitive-etag', data: { settings: {}, barbers: [], services: [], products: [] } } : null; },
      async list() { return { blobs: [{ key: 'entries/private-id' }] }; }
    }) });
    const success = await (await readFn(event())).json();
    const failingFn = createStagingDbDiagnostic({ env, getStoreImpl: () => { throw new Error('sensitive detail'); } });
    const failure = await (await failingFn(event())).json();
    const output = JSON.stringify({ logs, success, failure });
    assert.equal(output.includes('sensitive-etag'), false);
    assert.equal(output.includes('private-id'), false);
    assert.equal(output.includes('sensitive detail'), false);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
});
