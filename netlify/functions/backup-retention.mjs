import { getStore } from '@netlify/blobs';
import { pruneBackups, BACKUP_STORE_NAME } from './_backup.mjs';
import { CONTROL_STORE_NAME } from './_coordination.mjs';

const backups = getStore({ name: BACKUP_STORE_NAME, consistency: 'strong' });
const control = getStore({ name: CONTROL_STORE_NAME, consistency: 'strong' });

export default async () => {
  try {
    const result = await pruneBackups(backups, {
      control,
      maxDeletes: Number(process.env.BACKUP_RETENTION_MAX_DELETES || 25)
    });
    console.info('[backup-retention] pass complete', result);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    // Retention is deliberately independent: a failure never invalidates snapshots.
    console.error('[backup-retention] pass failed', error);
    return Response.json({ ok: false, retryable: error?.retryable === true }, { status: 503 });
  }
};

export const config = { schedule: '0 3 * * *' };
