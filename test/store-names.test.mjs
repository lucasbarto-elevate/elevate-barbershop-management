import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveStoreNames, STORE_NAMES } from '../netlify/functions/_store-names.mjs';
import { PRIMARY_STORE_NAME, BACKUP_STORE_NAME } from '../netlify/functions/_backup.mjs';
import { CONTROL_STORE_NAME } from '../netlify/functions/_coordination.mjs';

const defaults = {
  primary: 'elevate-db',
  control: 'elevate-db-control',
  backups: 'elevate-db-backups'
};
const staging = {
  ELEVATE_DB_STORE_NAME: 'elevate-db-staging',
  ELEVATE_DB_CONTROL_STORE_NAME: 'elevate-db-control-staging',
  ELEVATE_DB_BACKUPS_STORE_NAME: 'elevate-db-backups-staging'
};

test('sem overrides usa exatamente os nomes padrão atuais', () => {
  assert.deepEqual(resolveStoreNames({}), defaults);
});

test('três overrides selecionam exatamente os stores de staging', () => {
  assert.deepEqual(resolveStoreNames(staging), {
    primary: 'elevate-db-staging',
    control: 'elevate-db-control-staging',
    backups: 'elevate-db-backups-staging'
  });
});

test('três overrides não relacionados com produção e distintos são aceites', () => {
  assert.deepEqual(resolveStoreNames({
    ELEVATE_DB_STORE_NAME: 'test-data-store',
    ELEVATE_DB_CONTROL_STORE_NAME: 'test-control-store',
    ELEVATE_DB_BACKUPS_STORE_NAME: 'test-backup-store'
  }), {
    primary: 'test-data-store',
    control: 'test-control-store',
    backups: 'test-backup-store'
  });
});

test('um override isolado falha com erro claro', () => {
  assert.throws(() => resolveStoreNames({ ELEVATE_DB_STORE_NAME: staging.ELEVATE_DB_STORE_NAME }), /Configuração incompleta dos stores/);
});

test('dois overrides falham com erro claro', () => {
  assert.throws(() => resolveStoreNames({
    ELEVATE_DB_STORE_NAME: staging.ELEVATE_DB_STORE_NAME,
    ELEVATE_DB_CONTROL_STORE_NAME: staging.ELEVATE_DB_CONTROL_STORE_NAME
  }), /Configuração incompleta dos stores/);
});

test('override vazio ou só com espaços falha', () => {
  for (const empty of ['', '   ']) {
    assert.throws(() => resolveStoreNames({ ...staging, ELEVATE_DB_STORE_NAME: empty }), /vazios ou inválidos/);
  }
});

test('dois overrides iguais são rejeitados mesmo quando o terceiro é diferente', () => {
  assert.throws(() => resolveStoreNames({
    ELEVATE_DB_STORE_NAME: 'test-shared-store',
    ELEVATE_DB_CONTROL_STORE_NAME: 'test-shared-store',
    ELEVATE_DB_BACKUPS_STORE_NAME: 'test-backup-store'
  }), /têm de ser diferentes entre si/);
});

test('três overrides iguais são rejeitados', () => {
  assert.throws(() => resolveStoreNames({
    ELEVATE_DB_STORE_NAME: 'test-shared-store',
    ELEVATE_DB_CONTROL_STORE_NAME: 'test-shared-store',
    ELEVATE_DB_BACKUPS_STORE_NAME: 'test-shared-store'
  }), /têm de ser diferentes entre si/);
});

test('override igual a qualquer store padrão de produção é rejeitado', () => {
  assert.throws(() => resolveStoreNames({
    ELEVATE_DB_STORE_NAME: 'elevate-db',
    ELEVATE_DB_CONTROL_STORE_NAME: 'test-control-store',
    ELEVATE_DB_BACKUPS_STORE_NAME: 'test-backup-store'
  }), /stores de produção/);
});

test('todas as funções e constantes de stores usam a configuração central', async () => {
  assert.deepEqual(STORE_NAMES, resolveStoreNames(process.env));
  assert.equal(PRIMARY_STORE_NAME, STORE_NAMES.primary);
  assert.equal(BACKUP_STORE_NAME, STORE_NAMES.backups);
  assert.equal(CONTROL_STORE_NAME, STORE_NAMES.control);

  const files = ['data.mjs', 'version.mjs', 'sync.mjs', 'backup-scheduled.mjs', 'backup-retention.mjs', 'backup-admin.mjs'];
  for (const file of files) {
    const source = await readFile(new URL(`../netlify/functions/${file}`, import.meta.url), 'utf8');
    assert.match(source, /_store-names\.mjs|PRIMARY_STORE_NAME|BACKUP_STORE_NAME|CONTROL_STORE_NAME/, `${file} deve importar nomes derivados da configuração central`);
  }

  const codeFiles = ['data.mjs', 'version.mjs', 'sync.mjs', '_backup.mjs', '_coordination.mjs', 'backup-scheduled.mjs', 'backup-retention.mjs', 'backup-admin.mjs'];
  for (const file of codeFiles) {
    const source = await readFile(new URL(`../netlify/functions/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"]elevate-db(?:-control|-backups)?['"]/, `${file} não deve hardcodar nomes de stores`);
  }
});
