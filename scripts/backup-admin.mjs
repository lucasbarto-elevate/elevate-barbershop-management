import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const endpoint = process.env.BACKUP_ADMIN_URL;
if (!endpoint) {
  console.error('Defina BACKUP_ADMIN_URL com o endpoint /.netlify/functions/backup-admin do site.');
  process.exit(2);
}

async function prompt(label) {
  const rl = createInterface({ input, output });
  try { return await rl.question(label); } finally { rl.close(); }
}

async function promptSecret(label) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('A autorização deve ser introduzida num terminal interativo.');
  output.write(label);
  input.setRawMode(true);
  input.resume();
  let value = '';
  try {
    return await new Promise((resolve, reject) => {
      const onData = chunk => {
        const char = chunk.toString('utf8');
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelado.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); output.write('\n'); resolve(value); return; }
        if (char === '\u007f') value = value.slice(0, -1);
        else value += char;
      };
      const cleanup = () => input.off('data', onData);
      input.on('data', onData);
    });
  } finally { input.setRawMode(false); }
}

async function call(action, token, extra = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra }),
    cache: 'no-store'
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.error || `Pedido falhou (${response.status}).`);
  return result.result;
}

try {
  const [command, backupKey] = process.argv.slice(2);
  if (command === 'list') {
    const token = await promptSecret('Token BACKUP_READ_TOKEN: ');
    console.table(await call('list', token));
  } else if (command === 'restore') {
    if (!backupKey) throw new Error('Uso: node scripts/backup-admin.mjs restore snapshots/<id>');
    const readToken = await promptSecret('Token BACKUP_READ_TOKEN: ');
    const preview = await call('preview', readToken, { backupKey });
    console.log('Pré-visualização; o store principal ainda não foi alterado:');
    console.log(JSON.stringify(preview, null, 2));
    const answer = await prompt(`Para confirmar, escreva RESTORE ${preview.backupId}: `);
    if (answer !== `RESTORE ${preview.backupId}`) throw new Error('Confirmação não corresponde; nada foi restaurado.');
    const restoreToken = await promptSecret('Token BACKUP_RESTORE_TOKEN: ');
    console.log(await call('restore', restoreToken, { preview, confirmation: preview.backupId }));
  } else if (command === 'recovery-status') {
    const token = await promptSecret('Token BACKUP_READ_TOKEN: ');
    console.log(await call('recovery-status', token));
  } else if (command === 'recover') {
    const readToken = await promptSecret('Token BACKUP_READ_TOKEN: ');
    const preview = await call('recovery-preview', readToken);
    console.log('Reposição do backup de segurança:');
    console.log(JSON.stringify(preview, null, 2));
    if (preview.syncJournalKey) {
      const answer = await prompt(`Para reverter as chaves da sincronização interrompida, escreva ROLLBACK ${preview.syncJournalKey}: `);
      if (answer !== `ROLLBACK ${preview.syncJournalKey}`) throw new Error('Confirmação não corresponde; recuperação não aplicada.');
      const restoreToken = await promptSecret('Token BACKUP_RESTORE_TOKEN: ');
      console.log(await call('recover', restoreToken, { confirmation: { journalKey: preview.syncJournalKey, fingerprint: preview.currentFingerprint } }));
    } else {
      const answer = await prompt(`Para repor o backup e limpar o estado de recuperação, escreva RESTORE ${preview.backupId}: `);
      if (answer !== `RESTORE ${preview.backupId}`) throw new Error('Confirmação não corresponde; recuperação não aplicada.');
      const restoreToken = await promptSecret('Token BACKUP_RESTORE_TOKEN: ');
      console.log(await call('recover', restoreToken, { preview, confirmation: preview.backupId }));
    }
  } else {
    throw new Error('Comandos: list | restore snapshots/<id> | recovery-status | recover');
  }
} catch (error) {
  console.error('[backup-admin] falhou:', error?.message || error);
  process.exitCode = 1;
}
