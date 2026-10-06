import { createHash, randomUUID } from 'node:crypto';
import { acquireLock, assertHealthy, assertLock, clearRecoveryState, readRecoveryState, renewLock, releaseLock, setRecoveryState } from './_coordination.mjs';
import { STORE_NAMES } from './_store-names.mjs';

export const PRIMARY_STORE_NAME = STORE_NAMES.primary;
export const BACKUP_STORE_NAME = STORE_NAMES.backups;
export const SNAPSHOT_FORMAT = 'elevate-db-backup/v1';
const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const ENTRY_PREFIX = 'entries/';
const VERSION_KEY = 'sync-version';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function checksumSnapshot(snapshot) {
  const { checksum, ...payload } = snapshot;
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

export function fingerprintData(data) {
  return createHash('sha256').update(canonical({ catalog: data.catalog, entries: data.entries, syncVersion: data.syncVersion, legacyDatabase: data.legacyDatabase ?? null })).digest('hex');
}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== SNAPSHOT_FORMAT) throw new Error('Formato de snapshot inválido ou não suportado.');
  if (!snapshot.timestamp || !Number.isFinite(Date.parse(snapshot.timestamp))) throw new Error('Timestamp do snapshot inválido.');
  if (!snapshot.catalog || typeof snapshot.catalog !== 'object' || !snapshot.catalog.settings || !Array.isArray(snapshot.catalog.barbers) || !Array.isArray(snapshot.catalog.services) || !Array.isArray(snapshot.catalog.products)) {
    throw new Error('Catálogo do snapshot inválido.');
  }
  if (!Array.isArray(snapshot.entries) || !snapshot.syncVersion || typeof snapshot.syncVersion !== 'object' || !Number.isFinite(Number(snapshot.syncVersion.version)) || !Object.hasOwn(snapshot, 'legacyDatabase')) {
    throw new Error('Lançamentos ou sync-version do snapshot inválidos.');
  }
  const entryIds = snapshot.entries.map(entry => String(entry?.id ?? ''));
  if (entryIds.some(id => !id) || new Set(entryIds).size !== entryIds.length) throw new Error('IDs dos lançamentos inválidos ou duplicados.');
  const counts = snapshot.counts;
  if (!counts || counts.entries !== snapshot.entries.length || counts.barbers !== snapshot.catalog.barbers.length || counts.services !== snapshot.catalog.services.length || counts.products !== snapshot.catalog.products.length) {
    throw new Error('Contagens do snapshot inválidas.');
  }
  if (typeof snapshot.checksum !== 'string' || checksumSnapshot(snapshot) !== snapshot.checksum) throw new Error('Checksum do snapshot inválido.');
  return true;
}

async function guardedGet(store, key, lock, options = {}) {
  enforceDeadline(options.deadline);
  await maybeRenew(lock);
  await assertLock(lock);
  return store.get(key, { type: 'json', consistency: 'strong' });
}

function enforceDeadline(deadline) {
  if (deadline && Date.now() >= deadline) throw new Error('Backup interrompido pelo limite de segurança; não foi publicado como válido.');
}

async function maybeRenew(lock) {
  if (lock.expiresAt - Date.now() < Math.max(30_000, lock.ttlMs / 2)) await renewLock(lock);
}

export async function readRemoteSnapshot(primary, lock, { deadline } = {}) {
  enforceDeadline(deadline);
  await assertLock(lock);
  const [catalogValue, legacyDatabase] = await Promise.all([
    guardedGet(primary, CATALOG_KEY, lock, { deadline }),
    guardedGet(primary, LEGACY_KEY, lock, { deadline })
  ]);
  const catalog = catalogValue || legacyDatabase;
  if (!catalog || !catalog.settings || !Array.isArray(catalog.barbers) || !Array.isArray(catalog.services) || !Array.isArray(catalog.products)) {
    throw new Error('O catálogo remoto está incompleto; backup cancelado.');
  }
  await maybeRenew(lock);
  await assertLock(lock);
  const listed = await primary.list({ prefix: ENTRY_PREFIX });
  const keys = (listed?.blobs || []).map(blob => blob.key).sort();
  const entries = [];
  for (const key of keys) {
    enforceDeadline(deadline);
    const entry = await guardedGet(primary, key, lock, { deadline });
    if (entry === null) throw new Error(`Lançamento ${key} desapareceu durante a leitura; backup cancelado.`);
    entries.push(entry);
  }
  const syncVersion = await guardedGet(primary, VERSION_KEY, lock, { deadline }) || { version: 0, updatedAt: null };
  return { catalog, entries, syncVersion, legacyDatabase };
}

function makeSnapshot(data, kind = 'scheduled') {
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    kind,
    catalog: data.catalog,
    entries: data.entries,
    legacyDatabase: data.legacyDatabase ?? null,
    syncVersion: data.syncVersion,
    counts: {
      entries: data.entries.length,
      barbers: data.catalog.barbers.length,
      services: data.catalog.services.length,
      products: data.catalog.products.length
    }
  };
  snapshot.checksum = checksumSnapshot(snapshot);
  return snapshot;
}

export async function createBackup({ primary, backups, control, kind = 'scheduled', ownerId, ttlMs } = {}) {
  const budget = Number(process.env.BACKUP_MAX_DURATION_MS || 20_000);
  const deadline = Date.now() + Math.max(1_000, Math.min(Number.isFinite(budget) ? budget : 20_000, 25_000));
  const lock = await acquireLock(control, `backup:${kind}`, { ownerId, ttlMs });
  try {
    await assertHealthy(control);
    const data = await readRemoteSnapshot(primary, lock, { deadline });
    await assertLock(lock);
    const snapshot = makeSnapshot(data, kind);
    enforceDeadline(deadline);
    return await writeValidatedBackup(backups, snapshot, { deadline });
  } finally {
    await releaseLock(lock);
  }
}

export async function listBackups(backups) {
  const listed = await backups.list({ prefix: 'snapshots/' });
  const rows = await Promise.all((listed?.blobs || []).map(async item => {
    const snapshot = await backups.get(item.key, { type: 'json', consistency: 'strong' });
    try { validateSnapshot(snapshot); } catch { return null; }
    return { key: item.key, id: snapshot.id, timestamp: snapshot.timestamp, kind: snapshot.kind, counts: snapshot.counts, checksum: snapshot.checksum };
  }));
  return rows.filter(Boolean).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function retentionConfig(env = process.env) {
  const daily = Number(env.BACKUP_DAILY_DAYS || 30);
  const monthly = Number(env.BACKUP_MONTHLY_MONTHS || 12);
  return {
    dailyDays: Number.isFinite(daily) ? Math.max(1, daily) : 30,
    monthlyMonths: Number.isFinite(monthly) ? Math.max(1, monthly) : 12
  };
}

export async function pruneBackups(backups, options = {}) {
  const lock = options.control ? await acquireLock(options.control, 'backup-retention') : null;
  try {
  if (options.control) await assertHealthy(options.control);
  const now = options.now ?? Date.now();
  const { dailyDays, monthlyMonths } = options.policy || retentionConfig(options.env);
  // Retention is deliberately metadata-only for the whole inventory. Fetch and
  // validate snapshot contents only for the bounded set we might delete.
  const inventory = await backups.list({ prefix: 'snapshots/' });
  const rows = (inventory?.blobs || []).map(item => ({ key: item.key, timestamp: timestampFromSnapshotKey(item.key) }));
  const keep = new Set();
  const dailyCutoff = now - dailyDays * 86400_000;
  for (const row of rows) if (!row.timestamp || Date.parse(row.timestamp) >= dailyCutoff) keep.add(row.key);
  const current = new Date(now);
  const monthlyCutoff = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - monthlyMonths, 1);
  const monthly = new Map();
  for (const row of [...rows].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))) {
    const time = Date.parse(row.timestamp || 'invalid');
    if (time < dailyCutoff && time >= monthlyCutoff) {
      const month = row.timestamp.slice(0, 7);
      if (!monthly.has(month)) monthly.set(month, row);
    }
  }
  const recovery = options.control ? (await readRecoveryState(options.control)).value : null;
  if (recovery?.required && recovery.safetyBackupKey) keep.add(recovery.safetyBackupKey);
  for (const row of monthly.values()) keep.add(row.key);
  const requestedMax = Number(options.maxDeletes ?? 25);
  const maxDeletes = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.min(100, Math.floor(requestedMax)) : 25;
  let removed = 0;
  const candidates = rows.filter(row => !keep.has(row.key)).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  for (const row of candidates) if (removed < maxDeletes) {
    if (lock) await assertLock(lock);
    const snapshot = await backups.get(row.key, { type: 'json', consistency: 'strong' });
    try { validateSnapshot(snapshot); } catch { keep.add(row.key); continue; }
    await backups.delete(row.key);
    removed++;
  }
  return { retained: rows.length - removed, removed, remaining: Math.max(0, candidates.length - removed), complete: candidates.length <= removed };
  } finally {
    if (lock) await releaseLock(lock);
  }
}

function timestampFromSnapshotKey(key) {
  const match = String(key).match(/^snapshots\/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)-/);
  if (!match) return null;
  const value = `${match[1]}:${match[2]}:${match[3]}.${match[4]}`;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export async function createRestorePreview({ primary, backups, control, backupKey, ownerId, allowRecovery = false } = {}) {
  const lock = await acquireLock(control, 'restore-preview', { ownerId, allowRecovery });
  try {
    if (!allowRecovery) await assertHealthy(control);
    const target = await backups.get(backupKey, { type: 'json', consistency: 'strong' });
    validateSnapshot(target);
    const current = await readRemoteSnapshot(primary, lock);
    const fingerprint = fingerprintData(current);
    return {
      backupKey,
      backupId: target.id,
      backupChecksum: target.checksum,
      currentFingerprint: fingerprint,
      currentVersion: current.syncVersion.version,
      targetVersion: target.syncVersion.version,
      currentCounts: { entries: current.entries.length, products: current.catalog.products.length },
      targetCounts: { entries: target.entries.length, products: target.catalog.products.length },
      differences: summarizeDifferences(current, target),
      createdAt: new Date().toISOString()
    };
  } finally {
    await releaseLock(lock);
  }
}

function summarizeDifferences(current, target) {
  const currentEntries = new Map(current.entries.map(entry => [String(entry.id), canonical(entry)]));
  const targetEntries = new Map(target.entries.map(entry => [String(entry.id), canonical(entry)]));
  const changedEntryIds = [...new Set([...currentEntries.keys(), ...targetEntries.keys()])]
    .filter(id => currentEntries.get(id) !== targetEntries.get(id)).sort();
  const currentProducts = new Map(current.catalog.products.map(product => [String(product.id), canonical(product)]));
  const targetProducts = new Map(target.catalog.products.map(product => [String(product.id), canonical(product)]));
  const changedProductIds = [...new Set([...currentProducts.keys(), ...targetProducts.keys()])]
    .filter(id => currentProducts.get(id) !== targetProducts.get(id)).sort();
  return {
    changedEntries: changedEntryIds.length,
    addedEntries: target.entries.filter(entry => !currentEntries.has(String(entry.id))).length,
    removedEntries: current.entries.filter(entry => !targetEntries.has(String(entry.id))).length,
    changedEntryIds,
    changedProducts: changedProductIds.length,
    changedProductIds,
    catalogChanged: canonical(current.catalog) !== canonical(target.catalog),
    legacyDatabaseChanged: canonical(current.legacyDatabase ?? null) !== canonical(target.legacyDatabase ?? null)
  };
}

export async function applyRestore({ primary, backups, control, preview, confirmation, ownerId, hooks = {}, allowRecovery = false } = {}) {
  if (!preview?.backupKey || confirmation !== preview.backupId) throw new Error('Confirmação explícita do identificador do backup não corresponde.');
  const lock = await acquireLock(control, 'restore', { ownerId, allowRecovery });
  let safety;
  let mutationStarted = false;
  try {
    if (!allowRecovery) await assertHealthy(control);
    const target = await backups.get(preview.backupKey, { type: 'json', consistency: 'strong' });
    validateSnapshot(target);
    if (target.id !== preview.backupId || target.checksum !== preview.backupChecksum) throw new Error('O backup escolhido mudou desde a pré-visualização.');
    const current = await readRemoteSnapshot(primary, lock);
    const currentFingerprint = fingerprintData(current);
    if (currentFingerprint !== preview.currentFingerprint) throw new Error('O estado remoto mudou desde a pré-visualização; gere uma nova pré-visualização.');

    const safetyResult = await createBackupWhileLocked({ primary, backups, lock, kind: 'restore-safety' });
    safety = safetyResult;
    await hooks.afterSafetyBackup?.(safety.snapshot);
    await setRecoveryState(control, lock, {
      operation: 'restore-in-progress',
      backupKey: preview.backupKey,
      safetyBackupKey: safety.key,
      ownerId: lock.ownerId,
      message: 'A restauração está em curso; sincronizações e backups permanecem bloqueados.'
    });
    mutationStarted = true;
    const verified = await writeSnapshotToPrimary(primary, target, lock, hooks);
    await clearRecoveryState(control, lock);
    return { ok: true, restoredId: target.id, safetyBackupKey: safety.key, version: verified.syncVersion.version };
  } catch (error) {
    if (mutationStarted && safety) {
      try {
        const safetySnapshot = await backups.get(safety.key, { type: 'json', consistency: 'strong' });
        validateSnapshot(safetySnapshot);
        await writeSnapshotToPrimary(primary, safetySnapshot, lock, hooks);
        await clearRecoveryState(control, lock);
      } catch (rollbackError) {
        await setRecoveryState(control, lock, {
          operation: 'restore',
          backupKey: preview.backupKey,
          safetyBackupKey: safety.key,
          ownerId: lock.ownerId,
          message: 'A restauração e a reposição automática falharam. As mutações permanecem bloqueadas até intervenção administrativa.',
          error: String(error?.message || error),
          rollbackError: String(rollbackError?.message || rollbackError)
        });
        throw new Error('Restauração parcial; rollback falhou e o modo de recuperação foi ativado.');
      }
    }
    throw error;
  } finally {
    await releaseLock(lock);
  }
}

async function createBackupWhileLocked({ primary, backups, lock, kind }) {
  const data = await readRemoteSnapshot(primary, lock);
  await assertLock(lock);
  const snapshot = makeSnapshot(data, kind);
  return writeValidatedBackup(backups, snapshot);
}

async function writeValidatedBackup(backups, snapshot, { deadline } = {}) {
  const stagingKey = `staging/${snapshot.id}`;
  const key = `snapshots/${snapshot.id}`;
  enforceDeadline(deadline);
  const staged = await backups.setJSON(stagingKey, snapshot, { onlyIfNew: true });
  if (!staged?.modified) throw new Error('Não foi possível iniciar a gravação do snapshot.');
  try {
    const stored = await backups.get(stagingKey, { type: 'json', consistency: 'strong' });
    validateSnapshot(stored);
    if (stored.id !== snapshot.id || stored.checksum !== snapshot.checksum) throw new Error('A verificação pós-gravação do backup falhou.');
    enforceDeadline(deadline);
    const committed = await backups.setJSON(key, stored, { onlyIfNew: true });
    if (!committed?.modified) throw new Error('Não foi possível confirmar o snapshot de backup.');
    await backups.delete(stagingKey).catch(error => console.error('[backup] staging cleanup failed', error));
    return { key, snapshot: stored };
  } catch (error) {
    await backups.delete(stagingKey).catch(() => {});
    throw error;
  }
}

async function writeSnapshotToPrimary(primary, snapshot, lock, hooks = {}) {
  validateSnapshot(snapshot);
  const targetKeys = new Set(snapshot.entries.map(entry => `${ENTRY_PREFIX}${String(entry.id)}`));
  await maybeRenew(lock);
  await assertLock(lock);
  const listed = await primary.list({ prefix: ENTRY_PREFIX });
  for (const item of listed?.blobs || []) {
    if (!targetKeys.has(item.key)) {
      await maybeRenew(lock);
      await assertLock(lock);
      await primary.delete(item.key);
      await hooks.afterWrite?.('delete-entry', item.key);
    }
  }
  await maybeRenew(lock);
  await assertLock(lock);
  await conditionalPrimarySet(primary, CATALOG_KEY, snapshot.catalog, lock);
  await hooks.afterWrite?.('catalog', CATALOG_KEY);
  if (snapshot.legacyDatabase === null) {
    const legacyMetadata = await primary.getMetadata(LEGACY_KEY, { consistency: 'strong' });
    if (legacyMetadata?.etag) { await assertLock(lock); await primary.delete(LEGACY_KEY); }
  } else if (Object.hasOwn(snapshot, 'legacyDatabase')) {
    await conditionalPrimarySet(primary, LEGACY_KEY, snapshot.legacyDatabase, lock);
  }
  for (const entry of snapshot.entries) {
    const key = `${ENTRY_PREFIX}${String(entry.id)}`;
    await maybeRenew(lock);
    await assertLock(lock);
    await conditionalPrimarySet(primary, key, entry, lock);
    await hooks.afterWrite?.('entry', key);
  }
  await maybeRenew(lock);
  await assertLock(lock);
  const currentVersionState = await primary.getWithMetadata(VERSION_KEY, { type: 'json', consistency: 'strong' });
  const currentVersion = currentVersionState?.data;
  const version = Math.max(Date.now(), Number(currentVersion?.version || 0) + 1, Number(snapshot.syncVersion.version || 0) + 1);
  await conditionalPrimarySet(primary, VERSION_KEY, { version, updatedAt: new Date().toISOString() }, lock, currentVersionState);
  await hooks.afterWrite?.('version', VERSION_KEY);

  const verified = await readRemoteSnapshot(primary, lock);
  if (canonical(verified.catalog) !== canonical(snapshot.catalog) || canonical(verified.entries) !== canonical([...snapshot.entries].sort((a, b) => `${ENTRY_PREFIX}${a.id}`.localeCompare(`${ENTRY_PREFIX}${b.id}`)))) {
    throw new Error('Verificação pós-restauração diverge do snapshot aplicado.');
  }
  if (canonical(verified.legacyDatabase ?? null) !== canonical(snapshot.legacyDatabase ?? null)) throw new Error('A chave legacy database diverge do snapshot aplicado.');
  return verified;
}

async function conditionalPrimarySet(primary, key, value, lock, observed = undefined) {
  const metadata = observed === undefined ? await primary.getWithMetadata(key, { type: 'json', consistency: 'strong' }) : observed;
  await assertLock(lock);
  const result = metadata?.etag
    ? await primary.setJSON(key, value, { onlyIfMatch: metadata.etag })
    : await primary.setJSON(key, value, { onlyIfNew: true });
  if (!result?.modified) throw new Error(`A chave ${key} mudou durante a escrita; operação abortada.`);
  return result;
}
