import { randomUUID } from 'node:crypto';
import { STORE_NAMES } from './_store-names.mjs';

export const CONTROL_STORE_NAME = STORE_NAMES.control;
export const LOCK_KEY = 'mutation-lock';
export const RECOVERY_KEY = 'recovery-state';
// Netlify synchronous functions are forcibly bounded; keep the lease well beyond that
// bound so an expired owner cannot still be a live invocation under normal operation.
export const LOCK_TTL_MS = 10 * 60 * 1000;
export const LOCK_SAFETY_MARGIN_MS = 2 * 60 * 1000;
const READ_RETRIES = 5;

export class LockBusyError extends Error {
  constructor(message = 'Outra operação está a usar os dados remotos. Tente novamente.') {
    super(message); this.name = 'LockBusyError'; this.retryable = true;
  }
}
export class RecoveryRequiredError extends Error {
  constructor(message = 'O armazenamento está em modo de recuperação e requer intervenção administrativa.') {
    super(message); this.name = 'RecoveryRequiredError'; this.retryable = true;
  }
}

// A single getWithMetadata response binds the value and ETag to the same object version.
async function readVersioned(store, key) {
  for (let i = 0; i < READ_RETRIES; i++) {
    const result = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    if (!result) return { value: null, etag: null };
    if (result.etag) return { value: result.data, etag: result.etag };
  }
  throw new LockBusyError(`Não foi possível ler uma versão estável de ${key}.`);
}

async function readLock(controlStore) { return readVersioned(controlStore, LOCK_KEY); }
export async function readRecoveryState(controlStore) {
  const current = await readLock(controlStore);
  return { value: current.value?.recovery || null, etag: current.etag };
}

export async function assertHealthy(controlStore) {
  const { value } = await readRecoveryState(controlStore);
  if (value?.required) throw new RecoveryRequiredError(value.message);
}

export async function acquireLock(controlStore, operationType, options = {}) {
  if (!options.allowRecovery) await assertHealthy(controlStore);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS;
  const ownerId = options.ownerId || randomUUID();
  const current = await readLock(controlStore);
  if (current.value?.recovery?.required && !options.allowRecovery) throw new RecoveryRequiredError(current.value.recovery.message);
  if (current.value && (typeof current.value.expiresAt !== 'number' || !Number.isFinite(current.value.expiresAt))) {
    throw new LockBusyError('O registo do lease é inválido; intervenção administrativa necessária.');
  }
  const margin = options.safetyMarginMs ?? LOCK_SAFETY_MARGIN_MS;
  if (current.value?.ownerId && current.value.expiresAt + margin > now) throw new LockBusyError();
  const record = {
    ownerId, operationType, generation: Number(current.value?.generation || 0) + 1,
    createdAt: new Date(now).toISOString(), expiresAt: now + ttlMs,
    recovery: current.value?.recovery || null
  };
  const result = current.etag
    ? await controlStore.setJSON(LOCK_KEY, record, { onlyIfMatch: current.etag })
    : await controlStore.setJSON(LOCK_KEY, record, { onlyIfNew: true });
  if (!result?.modified || !result.etag) throw new LockBusyError();
  return { controlStore, ownerId, operationType, generation: record.generation, etag: result.etag, expiresAt: record.expiresAt, ttlMs };
}

export async function assertLock(lock, options = {}) {
  const now = options.now ?? Date.now();
  const current = await readLock(lock.controlStore);
  if (!current.value || current.value.ownerId !== lock.ownerId || current.value.generation !== lock.generation || current.etag !== lock.etag || current.value.expiresAt <= now) {
    throw new LockBusyError('O lease foi perdido; operação interrompida para repetição segura.');
  }
  if (current.value.expiresAt - now < Math.max(30_000, lock.ttlMs / 2)) {
    const record = { ...current.value, expiresAt: now + lock.ttlMs };
    const result = await lock.controlStore.setJSON(LOCK_KEY, record, { onlyIfMatch: current.etag });
    if (!result?.modified || !result.etag) throw new LockBusyError('Não foi possível renovar o lease.');
    lock.etag = result.etag; lock.expiresAt = record.expiresAt;
    return { value: record, etag: result.etag };
  }
  return current;
}

export async function renewLock(lock, options = {}) {
  const now = options.now ?? Date.now();
  const current = await assertLock(lock, { now });
  const record = { ...current.value, expiresAt: now + (options.ttlMs ?? lock.ttlMs ?? LOCK_TTL_MS) };
  const result = await lock.controlStore.setJSON(LOCK_KEY, record, { onlyIfMatch: current.etag });
  if (!result?.modified || !result.etag) throw new LockBusyError('Não foi possível renovar o lease.');
  lock.etag = result.etag; lock.expiresAt = record.expiresAt;
  return lock;
}

export async function releaseLock(lock) {
  try {
    const current = await readLock(lock.controlStore);
    if (!current.value || current.value.ownerId !== lock.ownerId || current.value.generation !== lock.generation || current.etag !== lock.etag) return false;
    const record = current.value.recovery?.required
      ? { ...current.value, ownerId: null, operationType: 'recovery-required', expiresAt: Number.MAX_SAFE_INTEGER }
      : { ...current.value, ownerId: null, operationType: 'released', expiresAt: 0 };
    const result = await lock.controlStore.setJSON(LOCK_KEY, record, { onlyIfMatch: current.etag });
    return !!result?.modified;
  } catch (error) { console.error('[coordination] release failed', error); return false; }
}

// Recovery is embedded in the lock record so stale owners cannot clear/set a newer
// owner's barrier using an unrelated control-key ETag. This still cannot make a
// primary-store write atomic with the lock check; see the bounded-runtime limitation.
export async function setRecoveryState(controlStore, lock, state) {
  const current = await assertLock(lock);
  const recovery = { ...state, required: true, generation: lock.generation, ownerId: lock.ownerId, updatedAt: new Date().toISOString() };
  const record = { ...current.value, recovery };
  const result = await controlStore.setJSON(LOCK_KEY, record, { onlyIfMatch: current.etag });
  if (!result?.modified || !result.etag) throw new LockBusyError('Não foi possível definir a barreira de recuperação; ownership perdido.');
  lock.etag = result.etag;
  return recovery;
}

export async function clearRecoveryState(controlStore, lock) {
  const current = await assertLock(lock);
  if (!current.value.recovery?.required) return;
  const record = { ...current.value, recovery: null };
  const result = await controlStore.setJSON(LOCK_KEY, record, { onlyIfMatch: current.etag });
  if (!result?.modified || !result.etag) throw new LockBusyError('A barreira de recuperação mudou; não foi possível limpá-la.');
  lock.etag = result.etag;
}
