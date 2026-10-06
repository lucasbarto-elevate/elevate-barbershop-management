import { getStore } from '@netlify/blobs';
import { createBackup, PRIMARY_STORE_NAME, BACKUP_STORE_NAME } from './_backup.mjs';
import { CONTROL_STORE_NAME } from './_coordination.mjs';

const primary = getStore({ name: PRIMARY_STORE_NAME, consistency: 'strong' });
const backups = getStore({ name: BACKUP_STORE_NAME, consistency: 'strong' });
const control = getStore({ name: CONTROL_STORE_NAME, consistency: 'strong' });

export default async () => {
  try {
    const result = await createBackup({ primary, backups, control, kind: 'scheduled' });
    console.info('[backup] complete', {
      id: result.snapshot.id,
      entries: result.snapshot.counts.entries,
      checksum: result.snapshot.checksum
    });
    return Response.json({ ok: true, id: result.snapshot.id, counts: result.snapshot.counts, checksum: result.snapshot.checksum });
  } catch (error) {
    console.error('[backup] failed', error);
    return Response.json({ ok: false, error: String(error?.message || error), retryable: error?.retryable === true }, { status: 503 });
  }
}

export const config = { schedule: '0 2 * * *' };
