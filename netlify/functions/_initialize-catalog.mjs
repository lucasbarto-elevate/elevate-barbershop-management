import { acquireLock, assertHealthy, assertLock, releaseLock } from './_coordination.mjs';

const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const VERSION_KEY = 'sync-version';
const ENTRY_PREFIX = 'entries/';

function isCompleteCatalog(value) {
  return !!(value?.settings
    && Array.isArray(value.barbers) && value.barbers.length > 0
    && Array.isArray(value.services) && value.services.length > 0
    && Array.isArray(value.products) && value.products.length > 0);
}

function catalogOnly(source) {
  return structuredClone({
    settings: source.settings,
    barbers: source.barbers,
    services: source.services,
    products: source.products
  });
}

export function assertCatalogInitializationEnabled({ isDefaultProductionConfig, allowFlag } = {}) {
  if (isDefaultProductionConfig || allowFlag !== 'true') {
    throw new Error('Inicialização disponível apenas com configuração de staging e flag temporária ativa.');
  }
}

export async function initializeCatalog({ primary, control, seedCatalog, ownerId } = {}) {
  if (!isCompleteCatalog(seedCatalog)) throw new Error('O catálogo de inicialização configurado é inválido.');
  const lock = await acquireLock(control, 'initialize-catalog', { ownerId });
  try {
    await assertHealthy(control);
    const [currentCatalog, legacy, version] = await Promise.all([
      primary.getWithMetadata(CATALOG_KEY, { type: 'json', consistency: 'strong' }),
      primary.getWithMetadata(LEGACY_KEY, { type: 'json', consistency: 'strong' }),
      primary.getWithMetadata(VERSION_KEY, { type: 'json', consistency: 'strong' })
    ]);

    if (currentCatalog?.etag) {
      if (isCompleteCatalog(currentCatalog.data)) return { initialized: false, reason: 'catalog-already-present' };
      throw new Error('A chave catalog já existe, mas está incompleta; inicialização recusada sem alterar dados.');
    }

    let source;
    if (legacy?.etag) {
      if (!isCompleteCatalog(legacy.data)) {
        throw new Error('A chave database existe, mas está incompleta; inicialização recusada sem alterar dados.');
      }
      source = 'legacy-database';
    } else {
      const entries = await primary.list({ prefix: ENTRY_PREFIX });
      if ((entries?.blobs || []).length > 0 || version?.etag) {
        throw new Error('O store contém entries ou sync-version sem catálogo; inicialização recusada para preservar o estado existente.');
      }
      source = 'seed-catalog';
    }

    const catalog = catalogOnly(source === 'legacy-database' ? legacy.data : seedCatalog);
    await assertLock(lock);
    const written = await primary.setJSON(CATALOG_KEY, catalog, { onlyIfNew: true });
    if (!written?.modified) {
      const raced = await primary.get(CATALOG_KEY, { type: 'json', consistency: 'strong' });
      if (isCompleteCatalog(raced)) return { initialized: false, reason: 'catalog-created-concurrently' };
      throw new Error('Não foi possível criar catalog sem substituir dados existentes.');
    }

    const verified = await primary.get(CATALOG_KEY, { type: 'json', consistency: 'strong' });
    if (!isCompleteCatalog(verified) || JSON.stringify(verified) !== JSON.stringify(catalog)) {
      throw new Error('A verificação da inicialização do catálogo falhou.');
    }
    return {
      initialized: true,
      source,
      counts: {
        barbers: catalog.barbers.length,
        services: catalog.services.length,
        products: catalog.products.length
      }
    };
  } finally {
    await releaseLock(lock);
  }
}
