import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireLock, assertLock, LOCK_KEY, releaseLock, setRecoveryState, readRecoveryState, renewLock } from '../netlify/functions/_coordination.mjs';
import {
  applyRestore, createBackup, createRestorePreview, listBackups, validateSnapshot,
  PRIMARY_STORE_NAME, BACKUP_STORE_NAME, pruneBackups
} from '../netlify/functions/_backup.mjs';
import { createSyncHandler } from '../netlify/functions/sync.mjs';
import { hasAdminAuthorization } from '../netlify/functions/_admin-auth.mjs';
import adminHandler from '../netlify/functions/backup-admin.mjs';
import { createDataHandler } from '../netlify/functions/data.mjs';
import { createVersionHandler } from '../netlify/functions/version.mjs';
import { checksumSnapshot } from '../netlify/functions/_backup.mjs';
import { beginSyncJournal } from '../netlify/functions/_sync-journal.mjs';
import { assertCatalogInitializationEnabled, initializeCatalog } from '../netlify/functions/_initialize-catalog.mjs';

class FakeStore {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
    this.etags = new Map();
    this.counter = 0;
    this.calls = { get: 0, getWithMetadata: 0, getMetadata: 0, setJSON: 0, delete: 0, list: 0 };
    this.latency = 0;
    this.beforeSet = null;
    this.beforeGet = null;
    for (const key of this.values.keys()) this.etags.set(key, `"e${++this.counter}"`);
  }
  async get(key) {
    this.calls.get++;
    if (this.latency) await new Promise(resolve => setTimeout(resolve, this.latency));
    await this.beforeGet?.(key);
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }
  async getWithMetadata(key) {
    this.calls.getWithMetadata++;
    if (this.latency) await new Promise(resolve => setTimeout(resolve, this.latency));
    await this.beforeGet?.(key);
    return this.values.has(key) ? { data: structuredClone(this.values.get(key)), etag: this.etags.get(key), metadata: {} } : null;
  }
  async getMetadata(key) { this.calls.getMetadata++; return this.etags.has(key) ? { etag: this.etags.get(key) } : null; }
  async setJSON(key, value, options = {}) {
    this.calls.setJSON++;
    await this.beforeSet?.(key, value, options);
    if (options.onlyIfNew && this.values.has(key)) return { modified: false };
    if (options.onlyIfMatch && this.etags.get(key) !== options.onlyIfMatch) return { modified: false };
    this.values.set(key, structuredClone(value));
    const etag = `"e${++this.counter}"`;
    this.etags.set(key, etag);
    return { modified: true, etag };
  }
  async delete(key) { this.calls.delete++; this.values.delete(key); this.etags.delete(key); }
  async list({ prefix = '' } = {}) {
    this.calls.list++;
    return { blobs: [...this.values.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key, etag: this.etags.get(key) })) };
  }
}

function makeWorld() {
  const catalog = makeTestCatalog();
  const entries = [makeTestEntry('test-entry-001'), makeTestEntry('test-entry-002')];
  const primary = new FakeStore({
    catalog,
    'sync-version': { version: 100, updatedAt: '2026-10-01T00:00:00.000Z' },
    ...Object.fromEntries(entries.map(entry => [`entries/${entry.id}`, entry]))
  });
  return { primary, backups: new FakeStore(), control: new FakeStore() };
}

function makeTestCatalog() {
  return {
    settings: { name: 'Synthetic Test Shop', currency: 'EUR', commission: 0, open: '09:00', close: '17:00' },
    barbers: [{ id: 1, name: 'Test Barber Alpha', commission: 0, active: true }],
    services: [{ id: 1, name: 'Test Service', price: 5, duration: 15 }],
    products: [{ id: 1, name: 'Test Product', stock: 10, cost: 1, price: 2, min: 0, commission: 0 }]
  };
}

function makeTestEntry(id) {
  return {
    id, date: '2030-01-02', time: '10:00', barber: 1, clients: 1,
    service: 'Test Service', serviceItems: [{ id: 1, name: 'Test Service', qty: 1, unitPrice: 5 }],
    productItems: [], payment: 'Test', servicePayment: 'Test', productPayment: null,
    tip: 0, tipPayment: null, total: 5
  };
}

function request(body) { return { method: 'POST', json: async () => body }; }
function cloneValues(store) { return structuredClone(Object.fromEntries(store.values)); }

test('lock denies unexpired owners, takes over expired locks, and stale ETag cannot release new owner', async () => {
  const control = new FakeStore();
  const first = await acquireLock(control, 'sync', { ownerId: 'first', now: 1000, ttlMs: 100 });
  await assert.rejects(() => acquireLock(control, 'backup', { ownerId: 'blocked', now: 1050, ttlMs: 100 }), /Outra operação/);
  const second = await acquireLock(control, 'restore', { ownerId: 'second', now: 1101, ttlMs: 100, safetyMarginMs: 0 });
  assert.equal(await releaseLock(first), false);
  assert.equal((await control.get(LOCK_KEY)).ownerId, 'second');
  assert.equal(await releaseLock(second), true);
});

test('lock is unavailable before expiry and ETag-conditional acquisition permits only one contender', async () => {
  const control = new FakeStore();
  const held = await acquireLock(control, 'sync', { now: 1000, ttlMs: 1000 });
  await assert.rejects(() => acquireLock(control, 'backup', { now: 1500 }), /Outra operação/);
  const current = await control.get(LOCK_KEY);
  const metadata = await control.getMetadata(LOCK_KEY);
  const staleWrite = await control.setJSON(LOCK_KEY, { ...current, ownerId: 'intruder' }, { onlyIfMatch: '"stale"' });
  assert.equal(staleWrite.modified, false);
  await releaseLock(held);
});

test('lease renews by ETag and old owner version can no longer release it', async () => {
  const control = new FakeStore();
  const lock = await acquireLock(control, 'restore', { ttlMs: 10 });
  const stale = { ...lock };
  await assertLock(lock);
  assert.notEqual(lock.etag, stale.etag);
  assert.equal(await releaseLock(stale), false);
  assert.equal(await releaseLock(lock), true);
});

test('sync requests are retryable while another sync owns the lock', async () => {
  const world = makeWorld();
  const handler = createSyncHandler({ store: world.primary, control: world.control });
  const held = await acquireLock(world.control, 'sync', { ownerId: 'first' });
  const response = await handler(request({ entries: [], deletedIds: [], catalog: null }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).retryable, true);
  await releaseLock(held);
});

test('backup and sync cannot overlap; lock-busy sync stays retryable', async () => {
  const world = makeWorld();
  let entered;
  let resume;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  let firstCatalogRead = true;
  world.primary.beforeGet = async key => {
    if (key === 'catalog' && firstCatalogRead) { firstCatalogRead = false; entered(); await gate; }
  };
  const backupPromise = createBackup(world);
  await inside;
  const handler = createSyncHandler({ store: world.primary, control: world.control });
  const response = await handler(request({ entries: [], deletedIds: [], catalog: null }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).retryable, true);
  resume();
  const created = await backupPromise;
  assert.equal(created.snapshot.counts.entries, 2);
  assert.equal((await listBackups(world.backups)).length, 1);
});

test('restore owns the lock and rejects concurrent sync until full verification', async () => {
  const world = makeWorld();
  const { key } = await createBackup(world);
  const preview = await createRestorePreview({ ...world, backupKey: key });
  let entered;
  let resume;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const restorePromise = applyRestore({ ...world, preview, confirmation: preview.backupId, hooks: { afterSafetyBackup: async () => { entered(); await gate; } } });
  await inside;
  const handler = createSyncHandler({ store: world.primary, control: world.control });
  const response = await handler(request({ entries: [], deletedIds: [], catalog: null }));
  assert.equal(response.status, 503);
  resume();
  assert.equal((await restorePromise).ok, true);
});

test('backup failure does not publish a valid snapshot', async () => {
  const world = makeWorld();
  world.primary.list = async () => { throw new Error('simulated read fault'); };
  await assert.rejects(() => createBackup(world), /simulated read fault/);
  assert.equal((await listBackups(world.backups)).length, 0);
});

test('explicit initializer creates only catalog in an empty store and is idempotent', async () => {
  const primary = new FakeStore();
  const control = new FakeStore();
  const seedCatalog = makeTestCatalog();
  const first = await initializeCatalog({ primary, control, seedCatalog });
  assert.equal(first.initialized, true);
  assert.equal(first.source, 'seed-catalog');
  assert.deepEqual(await primary.get('catalog'), seedCatalog);
  assert.equal(await primary.get('database'), null);
  assert.equal(await primary.get('sync-version'), null);
  assert.deepEqual((await primary.list({ prefix: 'entries/' })).blobs, []);
  const second = await initializeCatalog({ primary, control, seedCatalog });
  assert.deepEqual(second, { initialized: false, reason: 'catalog-already-present' });
  assert.deepEqual(await primary.get('catalog'), seedCatalog);
});

test('initializer copies a complete legacy catalog without deleting or changing database', async () => {
  const legacy = makeTestCatalog();
  legacy.entries = [{ id: 'legacy-test-entry' }];
  const primary = new FakeStore({ database: legacy });
  const control = new FakeStore();
  const result = await initializeCatalog({ primary, control, seedCatalog: makeTestCatalog() });
  assert.equal(result.initialized, true);
  assert.equal(result.source, 'legacy-database');
  assert.deepEqual(await primary.get('catalog'), makeTestCatalog());
  assert.deepEqual(await primary.get('database'), legacy);
});

test('initializer refuses partial catalog, legacy data, or existing entries without overwriting', async () => {
  for (const initial of [
    { catalog: { settings: { name: 'partial test' } } },
    { database: { settings: { name: 'partial test' } } },
    { 'entries/test-entry-existing': makeTestEntry('test-entry-existing') }
  ]) {
    const primary = new FakeStore(initial);
    const before = cloneValues(primary);
    await assert.rejects(() => initializeCatalog({ primary, control: new FakeStore(), seedCatalog: makeTestCatalog() }));
    assert.deepEqual(cloneValues(primary), before);
  }
});

test('catalog initialization endpoint requires explicit staging arming and restore authorization', async () => {
  const oldRead = process.env.BACKUP_READ_TOKEN;
  const oldRestore = process.env.BACKUP_RESTORE_TOKEN;
  const oldAllow = process.env.BACKUP_ALLOW_CATALOG_INITIALIZATION;
  process.env.BACKUP_READ_TOKEN = 'read-test-token';
  process.env.BACKUP_RESTORE_TOKEN = 'restore-test-token';
  process.env.BACKUP_ALLOW_CATALOG_INITIALIZATION = 'true';
  try {
    const readResponse = await adminHandler(new Request('https://example.test/api/backup-admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer read-test-token' },
      body: JSON.stringify({ action: 'initialize-catalog' })
    }));
    assert.equal(readResponse.status, 401);
    const response = await adminHandler(new Request('https://example.test/api/backup-admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer restore-test-token' },
      body: JSON.stringify({ action: 'initialize-catalog' })
    }));
    assert.equal(response.status, 403); // The test module uses production defaults.
  } finally {
    if (oldRead === undefined) delete process.env.BACKUP_READ_TOKEN; else process.env.BACKUP_READ_TOKEN = oldRead;
    if (oldRestore === undefined) delete process.env.BACKUP_RESTORE_TOKEN; else process.env.BACKUP_RESTORE_TOKEN = oldRestore;
    if (oldAllow === undefined) delete process.env.BACKUP_ALLOW_CATALOG_INITIALIZATION; else process.env.BACKUP_ALLOW_CATALOG_INITIALIZATION = oldAllow;
  }
});

test('catalog initialization requires staging store overrides and the temporary arming flag', () => {
  assert.throws(() => assertCatalogInitializationEnabled({ isDefaultProductionConfig: true, allowFlag: 'true' }), /apenas com configuração de staging/);
  assert.throws(() => assertCatalogInitializationEnabled({ isDefaultProductionConfig: false, allowFlag: undefined }), /flag temporária ativa/);
  assert.doesNotThrow(() => assertCatalogInitializationEnabled({ isDefaultProductionConfig: false, allowFlag: 'true' }));
});

test('backup budget expiry leaves no valid snapshot even under slow simulated Blob reads', async () => {
  const world = makeWorld();
  for (let i = 0; i < 100; i++) world.primary.values.set(`entries/slow-${i}`, { id: `slow-${i}` });
  world.primary.latency = 15;
  const previous = process.env.BACKUP_MAX_DURATION_MS;
  process.env.BACKUP_MAX_DURATION_MS = '75';
  try {
    await assert.rejects(() => createBackup(world), /limite de segurança/);
    assert.equal((await listBackups(world.backups)).length, 0);
  } finally {
    if (previous === undefined) delete process.env.BACKUP_MAX_DURATION_MS;
    else process.env.BACKUP_MAX_DURATION_MS = previous;
  }
});

test('invalid checksum and invalid snapshot format are rejected', async () => {
  const world = makeWorld();
  const { snapshot } = await createBackup(world);
  assert.equal(validateSnapshot(snapshot), true);
  assert.throws(() => validateSnapshot({ ...snapshot, checksum: 'bad' }), /Checksum/);
  assert.throws(() => validateSnapshot({ ...snapshot, format: 'other' }), /Formato/);
  assert.throws(() => validateSnapshot({ ...snapshot, entries: null }), /Lançamentos/);
});

test('restore preview does not write to the primary store', async () => {
  const world = makeWorld();
  const { key } = await createBackup(world);
  const before = cloneValues(world.primary);
  const preview = await createRestorePreview({ ...world, backupKey: key });
  assert.ok(preview.currentFingerprint);
  assert.deepEqual(cloneValues(world.primary), before);
});

test('restore refuses if primary state changed after preview', async () => {
  const world = makeWorld();
  const { key } = await createBackup(world);
  const preview = await createRestorePreview({ ...world, backupKey: key });
  const changed = await world.primary.get('catalog');
  changed.products[0].stock += 1;
  await world.primary.setJSON('catalog', changed);
  const beforeRestore = cloneValues(world.primary);
  await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId }), /mudou desde a pré-visualização/);
  assert.deepEqual(cloneValues(world.primary), beforeRestore);
});

test('restore fingerprint includes legacy database key', async () => {
  const world = makeWorld();
  await world.primary.setJSON('database', { settings: { legacy: true } });
  const backup = await createBackup(world);
  const preview = await createRestorePreview({ ...world, backupKey: backup.key });
  await world.primary.setJSON('database', { settings: { legacy: false } });
  await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId }), /mudou desde a pré-visualização/);
});

test('restore cannot start without creating its mandatory safety backup', async () => {
  const world = makeWorld();
  const { key } = await createBackup(world);
  const preview = await createRestorePreview({ ...world, backupKey: key });
  const before = cloneValues(world.primary);
  world.backups.beforeSet = async (blobKey, value) => {
    if (blobKey.startsWith('staging/') && value.kind === 'restore-safety') throw new Error('safety backup denied');
  };
  await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId }), /safety backup denied/);
  assert.deepEqual(cloneValues(world.primary), before);
});

test('partial restore automatically rolls back and leaves sync-version monotonic', async () => {
  const world = makeWorld();
  const { key } = await createBackup(world);
  const changedCatalog = await world.primary.get('catalog');
  changedCatalog.settings.name = 'Current state';
  await world.primary.setJSON('catalog', changedCatalog);
  await world.primary.setJSON('entries/extra', { id: 'extra', date: '2026-10-02', time: '10:00' });
  const originalCatalog = await world.primary.get('catalog');
  const originalKeys = (await world.primary.list({ prefix: 'entries/' })).blobs.map(item => item.key);
  const preview = await createRestorePreview({ ...world, backupKey: key });
  let failOnce = true;
  await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId, hooks: { afterWrite: async type => {
    if (type === 'catalog' && failOnce) { failOnce = false; throw new Error('partial write fault'); }
  } } }), /partial write fault/);
  assert.deepEqual(await world.primary.get('catalog'), originalCatalog);
  assert.deepEqual((await world.primary.list({ prefix: 'entries/' })).blobs.map(item => item.key), originalKeys);
  assert.ok((await world.primary.get('sync-version')).version > 100);
  assert.ok((await listBackups(world.backups)).some(row => row.kind === 'restore-safety'));
});

test('restore failure plus rollback failure enters recovery mode and blocks sync', async () => {
  const world = makeWorld();
  const { key } = await createBackup(world);
  const changed = await world.primary.get('catalog');
  changed.settings.name = 'state before restore';
  await world.primary.setJSON('catalog', changed);
  const preview = await createRestorePreview({ ...world, backupKey: key });
  let catalogWrites = 0;
  await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId, hooks: { afterWrite: async type => {
    if (type === 'catalog' && ++catalogWrites <= 2) throw new Error('write always fails');
  } } }), /rollback falhou/);
  assert.equal((await readRecoveryState(world.control)).value.required, true);
  const response = await createSyncHandler({ store: world.primary, control: world.control })(request({ entries: [], deletedIds: [], catalog: null }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).retryable, true);
});

test('admin authorization rejects missing/wrong tokens and accepts exact bearer token', () => {
  assert.equal(hasAdminAuthorization(null, 'secret'), false);
  assert.equal(hasAdminAuthorization('Bearer wrong', 'secret'), false);
  assert.equal(hasAdminAuthorization('Bearer secret', 'secret'), true);
  assert.equal(hasAdminAuthorization('Bearer secret', ''), false);
});

test('administrative endpoint rejects invalid authorization before accessing stores', async () => {
  const oldRead = process.env.BACKUP_READ_TOKEN;
  const oldRestore = process.env.BACKUP_RESTORE_TOKEN;
  process.env.BACKUP_READ_TOKEN = 'expected-token';
  process.env.BACKUP_RESTORE_TOKEN = 'different-token';
  try {
    const response = await adminHandler(new Request('https://example.test/api/backup-admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ action: 'list' })
    }));
    assert.equal(response.status, 401);
  } finally {
    if (oldRead === undefined) delete process.env.BACKUP_READ_TOKEN;
    else process.env.BACKUP_READ_TOKEN = oldRead;
    if (oldRestore === undefined) delete process.env.BACKUP_RESTORE_TOKEN;
    else process.env.BACKUP_RESTORE_TOKEN = oldRestore;
  }
});

test('sync preserves entry create/edit/delete, stock deltas, and monotonic version', async () => {
  const world = makeWorld();
  const handler = createSyncHandler({ store: world.primary, control: world.control });
  const entry = { id: 'stock-test', date: '2026-10-06', time: '10:00', barber: 1, clients: 0, total: 20, productItems: [{ id: 1, qty: 2, unitPrice: 10 }] };
  const created = await handler(request({ entries: [entry], deletedIds: [], catalog: null }));
  assert.equal(created.status, 200);
  assert.equal((await world.primary.get('catalog')).products[0].stock, 8);
  const v1 = (await world.primary.get('sync-version')).version;
  const edited = { ...entry, productItems: [{ id: 1, qty: 3, unitPrice: 10 }] };
  assert.equal((await handler(request({ entries: [edited], deletedIds: [], catalog: null }))).status, 200);
  assert.equal((await world.primary.get('catalog')).products[0].stock, 7);
  const v2 = (await world.primary.get('sync-version')).version;
  assert.ok(v2 > v1);
  assert.equal((await handler(request({ entries: [], deletedIds: ['stock-test'], catalog: null }))).status, 200);
  assert.equal((await world.primary.get('catalog')).products[0].stock, 10);
  const v3 = (await world.primary.get('sync-version')).version;
  assert.ok(v3 > v2);
  assert.equal(await world.primary.get('entries/stock-test'), null);
  assert.equal(await world.primary.get('legacy'), null);
});

test('sync rolls back a partial write, preserves retryability, and leaves no recovery marker', async () => {
  const world = makeWorld();
  const handler = createSyncHandler({ store: world.primary, control: world.control });
  const baselineStock = (await world.primary.get('catalog')).products[0].stock;
  let failCatalogOnce = true;
  world.primary.beforeSet = async key => {
    if (key === 'catalog' && failCatalogOnce) { failCatalogOnce = false; throw new Error('catalog write fault'); }
  };
  const response = await handler(request({ entries: [{ id: 'partial-sync', productItems: [{ id: 1, qty: 2 }] }], deletedIds: [], catalog: null }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).retryable, true);
  assert.equal(await world.primary.get('entries/partial-sync'), null);
  assert.equal((await world.primary.get('catalog')).products[0].stock, baselineStock);
  assert.equal((await readRecoveryState(world.control)).value, null);
});

test('stale owner cannot pass the generation and ETag check after takeover', async () => {
  const world = makeWorld();
  const a = await acquireLock(world.control, 'sync', { ownerId: 'A', now: 100, ttlMs: 10, safetyMarginMs: 0 });
  const b = await acquireLock(world.control, 'restore', { ownerId: 'B', now: 111, ttlMs: 100, safetyMarginMs: 0 });
  const before = cloneValues(world.primary);
  await assert.rejects(async () => { await assertLock(a, { now: 112 }); await world.primary.setJSON('catalog', {}); }, /lease foi perdido/);
  assert.deepEqual(cloneValues(world.primary), before);
  assert.equal((await world.control.get(LOCK_KEY)).ownerId, 'B');
  await releaseLock(b);
});

test('stale owner cannot set or clear recovery after a takeover', async () => {
  const control = new FakeStore();
  const a = await acquireLock(control, 'sync', { ownerId: 'A', now: 100, ttlMs: 10, safetyMarginMs: 0 });
  const b = await acquireLock(control, 'recovery', { ownerId: 'B', now: 111, ttlMs: 100, safetyMarginMs: 0, allowRecovery: true });
  await assert.rejects(() => setRecoveryState(control, a, { operation: 'stale' }), /lease foi perdido/);
  assert.equal((await readRecoveryState(control)).value, null);
  await releaseLock(b);
});

test('lock reads value and ETag through one getWithMetadata operation', async () => {
  const control = new FakeStore();
  control.get = async () => { throw new Error('non-atomic get must not be used'); };
  control.getMetadata = async () => { throw new Error('separate metadata read must not be used'); };
  const lock = await acquireLock(control, 'sync');
  await assertLock(lock);
  assert.equal(control.calls.getMetadata, 0);
  await releaseLock(lock);
});

test('renewal racing an expired-lock takeover has one CAS winner', async () => {
  const control = new FakeStore();
  const a = await acquireLock(control, 'backup', { ownerId: 'A', now: 1000, ttlMs: 100, safetyMarginMs: 0 });
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  control.beforeSet = async key => {
    if (key !== LOCK_KEY) return;
    calls++;
    if (calls === 2) release();
    if (calls <= 2) await gate;
  };
  const outcomes = await Promise.allSettled([
    renewLock(a, { now: 1050, ttlMs: 100 }),
    acquireLock(control, 'restore', { ownerId: 'B', now: 1200, ttlMs: 100, safetyMarginMs: 0 })
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const current = await control.get(LOCK_KEY);
  assert.ok(['A', 'B'].includes(current.ownerId));
});

test('data and version GETs remain read-only during recovery, including absent keys', async () => {
  const primary = new FakeStore({ database: makeTestCatalog() });
  const control = new FakeStore();
  const lock = await acquireLock(control, 'recovery');
  await setRecoveryState(control, lock, { operation: 'restore', message: 'maintenance' });
  await releaseLock(lock);
  const dataBefore = cloneValues(primary);
  const dataResponse = await createDataHandler(primary)();
  assert.equal(dataResponse.status, 200);
  assert.deepEqual(cloneValues(primary), dataBefore);
  const emptyVersion = new FakeStore();
  const versionResponse = await createVersionHandler(emptyVersion)();
  const versionBody = await versionResponse.json();
  assert.equal(versionBody.version, 0);
  assert.equal(emptyVersion.calls.setJSON, 0);
  assert.equal(emptyVersion.calls.delete, 0);
});

test('interrupted sync leaves recovery barrier and rejects every new mutator', async () => {
  const world = makeWorld();
  const backup = await createBackup(world);
  const preview = await createRestorePreview({ ...world, backupKey: backup.key });
  const lock = await acquireLock(world.control, 'sync');
  await beginSyncJournal({ primary: world.primary, control: world.control, body: { entries: [], deletedIds: [] }, lock });
  await releaseLock(lock); // Simulates invocation termination before rollback/commit.
  const response = await createSyncHandler({ store: world.primary, control: world.control })(request({ entries: [], deletedIds: [], catalog: null }));
  assert.equal(response.status, 503);
  assert.equal((await readRecoveryState(world.control)).value.required, true);
  await assert.rejects(() => createBackup(world), /recuperação/);
  await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId }), /recuperação/);
  await assert.rejects(() => pruneBackups(world.backups, { control: world.control }), /recuperação/);
});

test('interrupted restore keeps its recovery barrier available to an administrative preview', async () => {
  const world = makeWorld();
  const safety = await createBackup(world);
  const currentCatalog = await world.primary.get('catalog');
  currentCatalog.settings.name = 'partially changed';
  await world.primary.setJSON('catalog', currentCatalog);
  const lock = await acquireLock(world.control, 'restore');
  await setRecoveryState(world.control, lock, { operation: 'restore-in-progress', safetyBackupKey: safety.key, message: 'interrupted' });
  await releaseLock(lock); // Simulates process termination after recovery barrier and a partial write.
  assert.equal((await readRecoveryState(world.control)).value.required, true);
  const preview = await createRestorePreview({ ...world, backupKey: safety.key, allowRecovery: true });
  assert.ok(preview.currentFingerprint);
  const response = await createSyncHandler({ store: world.primary, control: world.control })(request({ entries: [], deletedIds: [] }));
  assert.equal(response.status, 503);
});

test('backup operation count scales approximately as fixed overhead plus two operations per entry', async t => {
  for (const count of [10, 100, 500, 1000]) await t.test(`${count} entries`, async () => {
    const world = makeWorld();
    const catalog = await world.primary.get('catalog');
    const entries = Array.from({ length: count }, (_, i) => ({ id: `perf-${i}`, date: '2026-10-06', time: '10:00' }));
    for (const entry of entries) world.primary.values.set(`entries/${entry.id}`, entry);
    world.primary.latency = 1; // Simulated per-entry Blob read latency.
    world.control.latency = 1; // Simulated network latency for each ownership check.
    const started = Date.now();
    const result = await createBackup(world);
    const elapsed = Date.now() - started;
    const operations = Object.values(world.primary.calls).reduce((sum, value) => sum + value, 0)
      + Object.values(world.control.calls).reduce((sum, value) => sum + value, 0)
      + Object.values(world.backups.calls).reduce((sum, value) => sum + value, 0);
    assert.equal(result.snapshot.counts.entries, count + 2);
    assert.ok(operations >= 2 * (count + 2), `expected ~2 operations per entry; observed ${operations}`);
    assert.ok(operations <= 2 * (count + 2) + 50, `unexpected fixed overhead; observed ${operations}`);
    assert.ok(elapsed < 30_000);
    assert.ok(catalog);
  });
});

test('retention interruption is resumable and never touches primary data', async () => {
  const world = makeWorld();
  const created = [];
  for (let i = 0; i < 3; i++) created.push(await createBackup(world));
  for (const [i, backup] of created.entries()) {
    const snapshot = structuredClone(backup.snapshot);
    snapshot.timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
    snapshot.id = `${snapshot.timestamp.replace(/[:.]/g, '-')}-${i.toString().padStart(8, '0')}`;
    snapshot.checksum = checksumSnapshot(snapshot);
    await world.backups.setJSON(`snapshots/${snapshot.id}`, snapshot, { onlyIfNew: true });
    await world.backups.delete(backup.key);
  }
  const before = cloneValues(world.primary);
  let deletes = 0;
  const deleteImpl = world.backups.delete.bind(world.backups);
  world.backups.delete = async key => {
    if (key.startsWith('snapshots/') && ++deletes === 2) throw new Error('interrupted retention');
    return deleteImpl(key);
  };
  await assert.rejects(() => pruneBackups(world.backups, { control: world.control, now: Date.parse('2026-10-06T00:00:00Z'), policy: { dailyDays: 30, monthlyMonths: 12 }, maxDeletes: 10 }), /interrupted/);
  world.backups.delete = deleteImpl;
  const resumed = await pruneBackups(world.backups, { control: world.control, now: Date.parse('2026-10-06T00:00:00Z'), policy: { dailyDays: 30, monthlyMonths: 12 }, maxDeletes: 10 });
  assert.equal(resumed.complete, true);
  assert.equal((await listBackups(world.backups)).length, 1);
  assert.deepEqual(cloneValues(world.primary), before);
});

test('restore rolls back after each individual delete/set failure', async t => {
  for (const failAt of [1, 2, 3, 4, 5]) await t.test(`failure after mutation ${failAt}`, async () => {
    const world = makeWorld();
    const backup = await createBackup(world);
    await world.primary.setJSON('entries/extra', { id: 'extra', date: '2026-10-06', time: '12:00' });
    const beforeCatalog = await world.primary.get('catalog');
    const beforeEntries = (await world.primary.list({ prefix: 'entries/' })).blobs.map(row => row.key).sort();
    const preview = await createRestorePreview({ ...world, backupKey: backup.key });
    let mutation = 0, failed = false;
    await assert.rejects(() => applyRestore({ ...world, preview, confirmation: preview.backupId, hooks: { afterWrite: async () => {
      mutation++;
      if (!failed && mutation === failAt) { failed = true; throw new Error(`fault ${failAt}`); }
    } } }), new RegExp(`fault ${failAt}`));
    assert.deepEqual(await world.primary.get('catalog'), beforeCatalog);
    assert.deepEqual((await world.primary.list({ prefix: 'entries/' })).blobs.map(row => row.key).sort(), beforeEntries);
    assert.equal((await readRecoveryState(world.control)).value, null);
  });
});

test('admin tokens must be distinct; read and restore scopes cannot substitute', async () => {
  const oldRead = process.env.BACKUP_READ_TOKEN, oldRestore = process.env.BACKUP_RESTORE_TOKEN;
  const call = async (read, restore, token, action) => {
    if (read === undefined) delete process.env.BACKUP_READ_TOKEN; else process.env.BACKUP_READ_TOKEN = read;
    if (restore === undefined) delete process.env.BACKUP_RESTORE_TOKEN; else process.env.BACKUP_RESTORE_TOKEN = restore;
    return adminHandler(new Request('https://example.test/api/backup-admin', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action }) }));
  };
  try {
    assert.equal((await call('read', 'restore', 'read', 'restore')).status, 401);
    assert.equal((await call('read', 'restore', 'restore', 'list')).status, 401);
    assert.equal((await call('same', 'same', 'same', 'list')).status, 503);
    assert.equal((await call(undefined, 'restore', 'restore', 'restore')).status, 503);
    assert.equal((await call('read', undefined, 'read', 'list')).status, 503);
  } finally {
    if (oldRead === undefined) delete process.env.BACKUP_READ_TOKEN; else process.env.BACKUP_READ_TOKEN = oldRead;
    if (oldRestore === undefined) delete process.env.BACKUP_RESTORE_TOKEN; else process.env.BACKUP_RESTORE_TOKEN = oldRestore;
  }
});
