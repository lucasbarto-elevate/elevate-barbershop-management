import { getStore } from '@netlify/blobs';
import { resolveStoreNames } from './_store-names.mjs';

const STAGING_STORES = Object.freeze({
  primary: 'elevate-db-staging',
  control: 'elevate-db-control-staging',
  backups: 'elevate-db-backups-staging'
});
const ENTRY_PREFIX = 'entries/';
const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function validScheduledEvent(request) {
  if (!request || typeof request.json !== 'function') return false;
  try {
    const url = new URL(request.url);
    if (url.search || url.hash || request.headers?.has('authorization')) return false;
  } catch { return false; }
  return request.json().then(event => event && Object.keys(event).length === 1
    && typeof event.next_run === 'string'
    && Number.isFinite(Date.parse(event.next_run))).catch(() => false);
}

export function isExactStagingStores(env = process.env) {
  try {
    const stores = resolveStoreNames(env);
    return stores.primary === STAGING_STORES.primary
      && stores.control === STAGING_STORES.control
      && stores.backups === STAGING_STORES.backups;
  } catch {
    return false;
  }
}

function isCompleteCatalog(value) {
  return !!(value?.settings
    && Array.isArray(value.barbers)
    && Array.isArray(value.services)
    && Array.isArray(value.products));
}

function safeVersion(value) {
  const version = Number(value?.version);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

export function createStagingDbDiagnostic({ env = process.env, getStoreImpl = getStore } = {}) {
  return async request => {
    if (!await validScheduledEvent(request)) return json({ ok: false, error: 'Evento agendado inválido.' }, 400);
    if (!isExactStagingStores(env)) return json({ ok: false, error: 'Diagnóstico permitido apenas com os stores exatos de staging.' }, 403);

    try {
      const store = getStoreImpl({ name: STAGING_STORES.primary, consistency: 'strong' });
      const [catalog, database, syncVersion, listed] = await Promise.all([
        store.getWithMetadata('catalog', { type: 'json', consistency: 'strong' }),
        store.getWithMetadata('database', { type: 'json', consistency: 'strong' }),
        store.getWithMetadata('sync-version', { type: 'json', consistency: 'strong' }),
        store.list({ prefix: ENTRY_PREFIX })
      ]);
      const entriesCount = Array.isArray(listed?.blobs) ? listed.blobs.length : 0;
      const result = {
        store: STAGING_STORES.primary,
        catalog: { exists: Boolean(catalog?.etag), complete: Boolean(catalog?.etag) && isCompleteCatalog(catalog.data) },
        database: { exists: Boolean(database?.etag) },
        syncVersion: {
          exists: Boolean(syncVersion?.etag),
          version: syncVersion?.etag ? safeVersion(syncVersion.data) : null
        },
        entriesCount
      };
      console.info('[diagnose-staging-db-now] complete', {
        catalogExists: result.catalog.exists,
        catalogComplete: result.catalog.complete,
        databaseExists: result.database.exists,
        syncVersionExists: result.syncVersion.exists,
        syncVersion: result.syncVersion.version,
        entriesCount
      });
      return json({ ok: true, result });
    } catch {
      console.error('[diagnose-staging-db-now] read failed');
      return json({ ok: false, error: 'Não foi possível concluir o diagnóstico de staging.' }, 503);
    }
  };
}

export default createStagingDbDiagnostic();

// Temporary leap-day schedule exists only to expose the dashboard Run now action.
export const config = { schedule: '0 0 29 2 *' };
