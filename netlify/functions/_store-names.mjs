const ENV_KEYS = Object.freeze([
  'ELEVATE_DB_STORE_NAME',
  'ELEVATE_DB_CONTROL_STORE_NAME',
  'ELEVATE_DB_BACKUPS_STORE_NAME'
]);

const DEFAULTS = Object.freeze({
  primary: 'elevate-db',
  control: 'elevate-db-control',
  backups: 'elevate-db-backups'
});

export function resolveStoreNames(env = process.env) {
  const configured = ENV_KEYS.map(key => Object.hasOwn(env, key));
  if (configured.every(value => !value)) return DEFAULTS;

  const missing = ENV_KEYS.filter(key => !Object.hasOwn(env, key));
  if (missing.length) {
    throw new Error(`Configuração incompleta dos stores Netlify Blobs. Configure as três variáveis: ${ENV_KEYS.join(', ')}.`);
  }

  const values = ENV_KEYS.map(key => String(env[key] ?? '').trim());
  const empty = ENV_KEYS.filter((key, index) => !values[index]);
  if (empty.length) {
    throw new Error(`Nomes de stores vazios ou inválidos: ${empty.join(', ')}.`);
  }

  if (new Set(values).size !== values.length) {
    throw new Error('Os três nomes de stores configurados têm de ser diferentes entre si.');
  }

  const productionNames = new Set(Object.values(DEFAULTS));
  const productionOverrides = ENV_KEYS.filter((key, index) => productionNames.has(values[index]));
  if (productionOverrides.length) {
    throw new Error(`Overrides não podem apontar para stores de produção: ${productionOverrides.join(', ')}.`);
  }

  return Object.freeze({
    primary: values[0],
    control: values[1],
    backups: values[2]
  });
}

// Evaluated in the Netlify Functions runtime. This module is never imported by
// frontend code, and all Functions use this single environment configuration.
export const STORE_NAMES = resolveStoreNames();
