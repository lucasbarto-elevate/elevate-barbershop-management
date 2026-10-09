import { resolveStoreNames } from './_store-names.mjs';
import { hasAdminAuthorization } from './_admin-auth.mjs';

const STAGING_STORES = Object.freeze({
  primary: 'elevate-db-staging',
  control: 'elevate-db-control-staging',
  backups: 'elevate-db-backups-staging'
});

const STAGING_ADMIN_ENDPOINT = 'https://elevate-barbershop-staging.netlify.app/.netlify/functions/backup-admin';
const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body, status) {
  return Response.json(body, { status, headers: NO_STORE });
}

export function isStagingConfiguration(env = process.env) {
  if (env.BACKUP_ALLOW_CATALOG_INITIALIZATION !== 'true') return false;

  let names;
  try {
    names = resolveStoreNames(env);
  } catch {
    return false;
  }

  return names.primary === STAGING_STORES.primary
    && names.control === STAGING_STORES.control
    && names.backups === STAGING_STORES.backups;
}

export function isStagingAdminEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.href === STAGING_ADMIN_ENDPOINT
      && url.protocol === 'https:'
      && url.hostname === 'elevate-barbershop-staging.netlify.app'
      && url.pathname === '/.netlify/functions/backup-admin'
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function createStagingCatalogInitializer({ env = process.env, fetchImpl = fetch } = {}) {
  return async request => {
    const routeToken = env.STAGING_CATALOG_INITIALIZE_TOKEN;
    if (!routeToken
      || Buffer.byteLength(routeToken) < 32
      || routeToken === env.BACKUP_RESTORE_TOKEN
      || routeToken === env.BACKUP_READ_TOKEN
      || !hasAdminAuthorization(request.headers.get('authorization'), routeToken)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON inválido.' }, 400); }
    if (body?.action !== 'initialize-catalog') return json({ ok: false, error: 'Ação inválida.' }, 400);

    if (!isStagingConfiguration(env)) {
      return json({ ok: false, error: 'Inicialização desativada ou configuração não é exclusivamente staging.' }, 403);
    }

    const restoreToken = env.BACKUP_RESTORE_TOKEN;
    const readToken = env.BACKUP_READ_TOKEN;
    if (!restoreToken || !readToken || restoreToken === readToken) {
      return json({ ok: false, error: 'Configuração administrativa indisponível.' }, 503);
    }

    if (!isStagingAdminEndpoint(env.BACKUP_ADMIN_URL)) {
      return json({ ok: false, error: 'Endpoint administrativo de staging inválido.' }, 503);
    }

    try {
      const response = await fetchImpl(STAGING_ADMIN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${restoreToken}`
        },
        body: JSON.stringify({ action: 'initialize-catalog' }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        return json({ ok: false, error: 'A inicialização do catálogo falhou; consulte os logs da Function administrativa.' }, 502);
      }

      const remote = result.result && typeof result.result === 'object' ? result.result : {};
      const safeResult = { initialized: remote.initialized === true };
      if (['catalog-already-present', 'catalog-created-concurrently'].includes(remote.reason)) safeResult.reason = remote.reason;
      if (['seed-catalog', 'legacy-database'].includes(remote.source)) safeResult.source = remote.source;
      if (remote.counts && typeof remote.counts === 'object') {
        const counts = Object.fromEntries(['barbers', 'services', 'products']
          .filter(key => Number.isSafeInteger(remote.counts[key]) && remote.counts[key] >= 0)
          .map(key => [key, remote.counts[key]]));
        if (Object.keys(counts).length) safeResult.counts = counts;
      }
      return json({ ok: true, result: safeResult }, 200);
    } catch {
      return json({ ok: false, error: 'A Function administrativa de staging não respondeu.' }, 502);
    }
  };
}

export default createStagingCatalogInitializer();
