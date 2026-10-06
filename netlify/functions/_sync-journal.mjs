import { assertLock, clearRecoveryState, setRecoveryState } from './_coordination.mjs';

export const SYNC_JOURNAL_PREFIX = 'sync-journals/';
const CATALOG_KEY = 'catalog';
const VERSION_KEY = 'sync-version';
const ENTRY_PREFIX = 'entries/';

export async function beginSyncJournal({ primary, control, body, lock }) {
  const ids = new Set([
    ...(Array.isArray(body.entries) ? body.entries.map(entry => String(entry.id)) : []),
    ...(Array.isArray(body.deletedIds) ? body.deletedIds.map(String) : [])
  ]);
  const entries = {};
  for (const id of ids) {
    await assertLock(lock);
    entries[`${ENTRY_PREFIX}${id}`] = await primary.get(`${ENTRY_PREFIX}${id}`, { type: 'json', consistency: 'strong' });
  }
  await assertLock(lock);
  const journal = {
    format: 'elevate-sync-journal/v1',
    ownerId: lock.ownerId,
    createdAt: new Date().toISOString(),
    catalog: await primary.get(CATALOG_KEY, { type: 'json', consistency: 'strong' }),
    entries,
    syncVersion: await primary.get(VERSION_KEY, { type: 'json', consistency: 'strong' })
  };
  const key = `${SYNC_JOURNAL_PREFIX}${lock.ownerId}`;
  await assertLock(lock);
  const written = await control.setJSON(key, journal, { onlyIfNew: true });
  if (!written?.modified) throw new Error('Não foi possível criar o journal de segurança da sincronização.');
  try {
    await setRecoveryState(control, lock, {
      operation: 'sync-in-progress',
      syncJournalKey: key,
      ownerId: lock.ownerId,
      message: 'Uma sincronização está em curso; novas mutações ficam bloqueadas até conclusão ou recuperação.'
    });
  } catch (error) {
    await assertLock(lock);
    await control.delete(key);
    throw error;
  }
  return { key, journal };
}

export async function rollbackSyncJournal({ primary, control, journalKey, lock, clearRecovery = true }) {
  const journal = await control.get(journalKey, { type: 'json', consistency: 'strong' });
  if (!journal || journal.format !== 'elevate-sync-journal/v1') throw new Error('Journal de sincronização ausente ou inválido.');
  await restorePrimaryValue(primary, CATALOG_KEY, journal.catalog, lock);
  for (const [key, value] of Object.entries(journal.entries)) {
    await restorePrimaryValue(primary, key, value, lock);
  }
  await assertLock(lock);
  const currentVersionState = await primary.getWithMetadata(VERSION_KEY, { type: 'json', consistency: 'strong' });
  const currentVersion = currentVersionState?.data;
  const restoredVersion = {
    version: Math.max(Date.now(), Number(currentVersion?.version || 0) + 1, Number(journal.syncVersion?.version || 0) + 1),
    updatedAt: new Date().toISOString()
  };
  await restorePrimaryValue(primary, VERSION_KEY, restoredVersion, lock, currentVersionState);

  const [catalog, version] = await Promise.all([
    primary.get(CATALOG_KEY, { type: 'json', consistency: 'strong' }),
    primary.get(VERSION_KEY, { type: 'json', consistency: 'strong' })
  ]);
  if (JSON.stringify(catalog) !== JSON.stringify(journal.catalog) || Number(version?.version) !== restoredVersion.version) {
    throw new Error('A verificação do rollback da sincronização falhou.');
  }
  for (const [key, value] of Object.entries(journal.entries)) {
    const restored = await primary.get(key, { type: 'json', consistency: 'strong' });
    if (JSON.stringify(restored) !== JSON.stringify(value)) throw new Error(`Rollback divergente na chave ${key}.`);
  }
  if (clearRecovery) {
    await clearRecoveryState(control, lock);
    await assertLock(lock);
    await control.delete(journalKey);
  }
  return true;
}

async function restorePrimaryValue(primary, key, value, lock, observed = undefined) {
  const metadata = observed === undefined ? await primary.getWithMetadata(key, { type: 'json', consistency: 'strong' }) : observed;
  await assertLock(lock);
  if (value === null) {
    if (metadata?.etag) await primary.delete(key); // delete has no conditional option in Blobs
    return;
  }
  const result = metadata?.etag
    ? await primary.setJSON(key, value, { onlyIfMatch: metadata.etag })
    : await primary.setJSON(key, value, { onlyIfNew: true });
  if (!result?.modified) throw new Error(`Rollback perdeu a concorrência na chave ${key}.`);
}
