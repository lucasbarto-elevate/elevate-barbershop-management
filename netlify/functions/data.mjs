import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store = getStore({ name:'elevate-db', consistency:'strong' });
const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const ENTRY_PREFIX = 'entries/';

function cloneSeed(){ return structuredClone(seed); }

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

async function blobGet(key, options={type:'json'}, attempts=3){
  let lastError;
  for(let attempt=0; attempt<attempts; attempt++){
    try{
      return await store.get(key, options);
    }catch(err){
      lastError=err;
      if(attempt<attempts-1) await sleep(150*(attempt+1));
    }
  }
  throw lastError;
}

async function listEntries(){
  const result = await store.list({ prefix: ENTRY_PREFIX });
  return result?.blobs || [];
}

async function readEntriesFromBlobs(blobs){
  if(!blobs?.length) return [];
  const rows = await Promise.all(
    blobs.map(b => blobGet(b.key, { type:'json' }))
  );
  return rows.filter(Boolean);
}

async function ensureMigrated(){
  let catalog = await blobGet(CATALOG_KEY, { type:'json' });

  // Fast path: the catalog and individual entry blobs already exist.
  // Do not read the legacy database on every /api/data request.
  let entryBlobs = await listEntries();
  if(catalog && entryBlobs.length) return { catalog, entryBlobs };

  const legacy = await blobGet(LEGACY_KEY, { type:'json' });
  const source = legacy || cloneSeed();

  if(!catalog){
    catalog = {
      settings: source.settings,
      barbers: source.barbers || [],
      services: source.services || [],
      products: source.products || []
    };
    await store.setJSON(CATALOG_KEY, catalog);
  }else{
    // Corrige catálogo incompleto sem substituir estoque/preços existentes.
    let changed=false;
    if(!catalog.settings) { catalog.settings=source.settings; changed=true; }
    if(!Array.isArray(catalog.barbers)||!catalog.barbers.length) { catalog.barbers=source.barbers||[]; changed=true; }
    if(!Array.isArray(catalog.services)||!catalog.services.length) { catalog.services=source.services||[]; changed=true; }
    if(!Array.isArray(catalog.products)||!catalog.products.length) { catalog.products=source.products||[]; changed=true; }
    if(changed) await store.setJSON(CATALOG_KEY,catalog);
  }

  if(!entryBlobs.length){
    const sourceEntries = Array.isArray(source.entries) && source.entries.length
      ? source.entries
      : (cloneSeed().entries || []);

    if(sourceEntries.length){
      await Promise.all(
        sourceEntries.map(entry =>
          store.setJSON(
            ENTRY_PREFIX + String(entry.id),
            entry,
            { onlyIfNew:true }
          )
        )
      );
    }
    entryBlobs = await listEntries();
  }

  return { catalog, entryBlobs };
}

export default async () => {
  try{
    const { catalog, entryBlobs } = await ensureMigrated();
    const entries = await readEntriesFromBlobs(entryBlobs);

    entries.sort((a,b)=>
      String((b.date||'')+(b.time||''))
        .localeCompare(String((a.date||'')+(a.time||'')))
    );

    return Response.json(
      { ...catalog, entries },
      { headers:{'Cache-Control':'no-store'} }
    );
  }catch(err){
    console.error('[data] failed to load database', err);
    return Response.json(
      { ok:false, error:'Não foi possível carregar os dados agora.' },
      { status:500, headers:{'Cache-Control':'no-store'} }
    );
  }
};
