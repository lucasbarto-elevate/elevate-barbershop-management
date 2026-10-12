import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/async function loadRemote\(force=false\)\{[\s\S]*?\n\}/m);
assert.ok(match, 'Expected loadRemote() in index.html');
const loadRemoteSource = match[0];

function testCatalog(name = 'Remote Test Shop') {
  return {
    settings: { name, currency: 'EUR' },
    barbers: [{ id: 'test-barber', name: 'Synthetic Barber', active: true }],
    services: [{ id: 'test-service', name: 'Synthetic Service', price: 5 }],
    products: [{ id: 'test-product', name: 'Synthetic Product', stock: 3, commission: 0 }],
    entries: [{ id: 'test-entry', total: 5 }],
    version: 12
  };
}

function makeHarness({ fetch, pendingSync = [], pendingDeletes = [], catalogDirty = false, syncRemoteNow } = {}) {
  const localValues = new Map();
  const state = {
    db: testCatalog('Local Test Shop'),
    remoteLoadPromise: null,
    remoteLoadInFlight: false,
    remoteLoaded: false,
    remoteVersion: null,
    syncInFlight: false,
    pendingSync: [...pendingSync],
    pendingDeletes: [...pendingDeletes],
    catalogDirty,
    backendOnline: null,
    renders: 0,
    statusUpdates: 0,
    fetchCalls: []
  };
  const context = vm.createContext({
    state,
    db: state.db,
    remoteLoadPromise: null,
    remoteLoadInFlight: false,
    remoteLoaded: false,
    remoteVersion: null,
    syncInFlight: false,
    backendOnline: null,
    pendingSync: state.pendingSync,
    pendingDeletes: state.pendingDeletes,
    catalogDirty: state.catalogDirty,
    key: 'test-database-key',
    catalogSyncKey: 'test-catalog-dirty-key',
    hasPendingSyncWork: () => state.pendingSync.length > 0 || state.pendingDeletes.length > 0 || state.catalogDirty,
    syncRemoteNow: syncRemoteNow || (async () => true),
    render: () => { state.renders++; },
    updateConnectionStatus: () => { state.statusUpdates++; },
    localStorage: {
      setItem(key, value) { localValues.set(key, value); },
      removeItem(key) { localValues.delete(key); },
      getItem(key) { return localValues.get(key) ?? null; }
    },
    fetch: async (...args) => {
      state.fetchCalls.push(args);
      return fetch(...args);
    },
    console: { info() {}, error() {} }
  });
  vm.runInContext(loadRemoteSource, context);
  return { context, state, localValues };
}

function jsonResponse(value, ok = true) {
  return { ok, json: async () => value };
}

test('loadRemote applies a valid remote snapshot and renders without a ReferenceError', async () => {
  const remote = testCatalog();
  const { context, state, localValues } = makeHarness({
    fetch: async url => url === '/api/version'
      ? jsonResponse({ ok: true, version: 12 })
      : jsonResponse(remote)
  });

  assert.equal(await vm.runInContext('loadRemote(true)', context), true);
  assert.equal(context.db.settings.name, 'Remote Test Shop');
  assert.equal(context.remoteVersion, 12);
  assert.equal(context.remoteLoaded, true);
  assert.equal(context.backendOnline, true);
  assert.equal(state.renders, 1);
  assert.equal(state.statusUpdates, 1);
  assert.deepEqual(state.fetchCalls.map(([url]) => url), ['/api/version', '/api/data']);
  assert.deepEqual(JSON.parse(localValues.get('test-database-key')).settings, remote.settings);
});

test('loadRemote preserves queued local work when its sync attempt fails', async () => {
  const { context, state, localValues } = makeHarness({
    pendingSync: ['test-pending-entry'],
    catalogDirty: true,
    syncRemoteNow: async () => false,
    fetch: async () => assert.fail('Remote API must not be fetched while local work remains pending')
  });
  localValues.set('test-catalog-dirty-key', '1');

  assert.equal(await vm.runInContext('loadRemote(true)', context), false);
  assert.deepEqual(state.pendingSync, ['test-pending-entry']);
  assert.equal(context.catalogDirty, true);
  assert.equal(localValues.get('test-catalog-dirty-key'), '1');
  assert.equal(context.db.settings.name, 'Local Test Shop');
  assert.equal(state.renders, 0);
  assert.equal(state.fetchCalls.length, 0);
});

test('loadRemote discards a fetched snapshot if local work is queued during the read', async () => {
  const remote = testCatalog();
  const { context, state, localValues } = makeHarness({
    fetch: async url => url === '/api/version'
      ? jsonResponse({ ok: true, version: 12 })
      : {
          ok: true,
          json: async () => {
            state.pendingSync.push('test-created-during-read');
            return remote;
          }
        }
  });
  localValues.set('test-database-key', JSON.stringify(state.db));

  assert.equal(await vm.runInContext('loadRemote(true)', context), false);
  assert.deepEqual(state.pendingSync, ['test-created-during-read']);
  assert.equal(context.db.settings.name, 'Local Test Shop');
  assert.equal(JSON.parse(localValues.get('test-database-key')).settings.name, 'Local Test Shop');
  assert.equal(state.renders, 0);
  assert.equal(context.backendOnline, null);
});
