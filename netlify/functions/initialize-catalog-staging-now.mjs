import { isStagingAdminEndpoint, isStagingConfiguration } from './initialize-catalog-staging.mjs';

const STAGING_ADMIN_ENDPOINT = 'https://elevate-barbershop-staging.netlify.app/.netlify/functions/backup-admin';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
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

export function createStagingCatalogScheduledInitializer({ env = process.env, fetchImpl = fetch } = {}) {
  return async request => {
    // Netlify invokes scheduled functions with a platform event containing next_run.
    // Scheduled Functions cannot be invoked directly by URL.
    if (!await validScheduledEvent(request)) return json({ ok: false, error: 'Evento agendado inválido.' }, 400);

    if (!isStagingConfiguration(env)) {
      return json({ ok: false, error: 'Inicialização desativada ou configuração não é exclusivamente staging.' }, 403);
    }

    const initToken = env.STAGING_CATALOG_INITIALIZE_TOKEN;
    const restoreToken = env.BACKUP_RESTORE_TOKEN;
    const readToken = env.BACKUP_READ_TOKEN;
    if (!initToken || Buffer.byteLength(initToken) < 32 || !restoreToken || !readToken
      || initToken === restoreToken || initToken === readToken || restoreToken === readToken) {
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
        console.error('[initialize-catalog-staging-now] initialization failed');
        return json({ ok: false, error: 'A inicialização falhou; consulte os logs sanitizados da Function administrativa.' }, 502);
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
      console.info('[initialize-catalog-staging-now] complete', { initialized: safeResult.initialized, source: safeResult.source });
      return json({ ok: true, result: safeResult });
    } catch {
      console.error('[initialize-catalog-staging-now] administrative Function unavailable');
      return json({ ok: false, error: 'A Function administrativa de staging não respondeu.' }, 502);
    }
  };
}

export default createStagingCatalogScheduledInitializer();

// Leap-day scheduling keeps the automatic run distant. Remove this Function and
// its netlify.toml schedule immediately after the one-time Run now invocation.
export const config = { schedule: '0 0 29 2 *' };
