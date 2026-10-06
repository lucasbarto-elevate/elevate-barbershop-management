import { getStore } from '@netlify/blobs';
import { applyRestore, createRestorePreview, fingerprintData, readRemoteSnapshot, listBackups, BACKUP_STORE_NAME, PRIMARY_STORE_NAME } from './_backup.mjs';
import { acquireLock, CONTROL_STORE_NAME, readRecoveryState, releaseLock } from './_coordination.mjs';
import { rollbackSyncJournal } from './_sync-journal.mjs';
import { hasAdminAuthorization } from './_admin-auth.mjs';

export default async req => {
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'JSON inválido.' }, { status: 400 }); }
  const readToken = process.env.BACKUP_READ_TOKEN;
  const restoreToken = process.env.BACKUP_RESTORE_TOKEN;
  if (!readToken || !restoreToken || readToken === restoreToken) {
    return Response.json({ ok: false, error: 'Configuração administrativa inválida.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const restoreAction = ['restore', 'recover'].includes(body?.action);
  const secret = restoreAction ? restoreToken : readToken;
  if (!hasAdminAuthorization(req.headers.get('authorization'), secret)) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  try {
    const primary = getStore({ name: PRIMARY_STORE_NAME, consistency: 'strong' });
    const backups = getStore({ name: BACKUP_STORE_NAME, consistency: 'strong' });
    const control = getStore({ name: CONTROL_STORE_NAME, consistency: 'strong' });
    let result;
    if (body.action === 'list') result = await listBackups(backups);
    else if (body.action === 'preview') result = await createRestorePreview({ primary, backups, control, backupKey: body.backupKey });
    else if (body.action === 'restore') result = await applyRestore({ primary, backups, control, preview: body.preview, confirmation: body.confirmation });
    else if (body.action === 'recovery-status') result = (await readRecoveryState(control)).value || { required: false };
    else if (body.action === 'recovery-preview') {
      const recovery = (await readRecoveryState(control)).value;
      if (!recovery?.required) throw new Error('O sistema não está em modo de recuperação.');
      if (recovery.syncJournalKey) {
        const lock = await acquireLock(control, 'recovery-preview', { allowRecovery: true });
        try {
          const currentRecovery = (await readRecoveryState(control)).value;
          if (!currentRecovery?.required || currentRecovery.syncJournalKey !== recovery.syncJournalKey) throw new Error('O estado de recuperação mudou; gere outra pré-visualização.');
          const journal = await control.get(recovery.syncJournalKey, { type: 'json', consistency: 'strong' });
          if (!journal) throw new Error('Journal de sincronização não encontrado.');
          const current = await readRemoteSnapshot(primary, lock);
          const changedEntries = [];
          for (const [key, value] of Object.entries(journal.entries || {})) {
            const id = key.replace(/^entries\//, '');
            const currentEntry = current.entries.find(entry => String(entry.id) === id) || null;
            if (JSON.stringify(currentEntry) !== JSON.stringify(value)) changedEntries.push(key);
          }
          result = {
            operation: recovery.operation,
            syncJournalKey: recovery.syncJournalKey,
            createdAt: journal.createdAt,
            affectedEntries: Object.keys(journal.entries || {}).length,
            changedEntries,
            catalogChanged: JSON.stringify(current.catalog) !== JSON.stringify(journal.catalog),
            currentVersion: current.syncVersion?.version || 0,
            journalVersion: journal.syncVersion?.version || 0,
            currentFingerprint: fingerprintData(current),
            message: recovery.message
          };
        } finally { await releaseLock(lock); }
      } else if (recovery.safetyBackupKey) {
        result = await createRestorePreview({ primary, backups, control, backupKey: recovery.safetyBackupKey, allowRecovery: true });
      } else throw new Error('Não existe dado de recuperação disponível.');
    }
    else if (body.action === 'recover') {
      const recovery = (await readRecoveryState(control)).value;
      if (recovery?.syncJournalKey) {
        if (body.confirmation?.journalKey !== recovery.syncJournalKey || !body.confirmation?.fingerprint) throw new Error('Confirmação explícita do journal e fingerprint são obrigatórios.');
        const lock = await acquireLock(control, 'sync-recovery', { allowRecovery: true });
        try {
          const currentRecovery = (await readRecoveryState(control)).value;
          if (!currentRecovery?.required || currentRecovery.syncJournalKey !== recovery.syncJournalKey) throw new Error('O estado de recuperação mudou; gere outra pré-visualização.');
          const current = await readRemoteSnapshot(primary, lock);
          if (fingerprintData(current) !== body.confirmation.fingerprint) throw new Error('O estado mudou desde a pré-visualização da recuperação. Gere outra pré-visualização.');
          await rollbackSyncJournal({ primary, control, journalKey: recovery.syncJournalKey, lock });
          result = { recovered: true, operation: 'sync-rollback', syncJournalKey: recovery.syncJournalKey };
        } finally { await releaseLock(lock); }
      } else result = await applyRestore({ primary, backups, control, preview: body.preview, confirmation: body.confirmation, allowRecovery: true });
    }
    else return Response.json({ ok: false, error: 'Ação inválida.' }, { status: 400 });
    return Response.json({ ok: true, result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error?.retryable ? 503 : 409;
    console.error('[backup-admin] operation failed', error);
    return Response.json({ ok: false, error: String(error?.message || error), retryable: error?.retryable === true }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
};
