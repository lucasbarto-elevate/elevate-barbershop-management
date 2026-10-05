import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store = getStore({ name:'elevate-db', consistency:'strong' });
const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const ENTRY_PREFIX = 'entries/';
const VERSION_KEY = 'sync-version';

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

async function safeGet(key, options={type:'json'}){
  try{
    return await blobGet(key, options);
  }catch(err){
    console.error('[data] blob read failed', key, err);
    return null;
  }
}

async function listEntries(){
  try{
    const result = await store.list({ prefix: ENTRY_PREFIX });
    return result?.blobs || [];
  }catch(err){
    console.error('[data] entry list failed', err);
    return [];
  }
}

async function readEntriesFromBlobs(blobs){
  if(!blobs?.length) return [];
  const rows = await Promise.all(
    blobs.map(async b=>{
      try{
        return await blobGet(b.key, { type:'json' });
      }catch(err){
        console.error('[data] skipping unreadable entry', b.key, err);
        return null;
      }
    })
  );
  return rows.filter(Boolean);
}

function catalogFromSource(source){
  return {
    settings: source?.settings || cloneSeed().settings,
    barbers: Array.isArray(source?.barbers) ? source.barbers : [],
    services: Array.isArray(source?.services) ? source.services : [],
    products: Array.isArray(source?.products) ? source.products : []
  };
}

async function ensureMigrated(){
  let catalog = await safeGet(CATALOG_KEY, { type:'json' });
  let entryBlobs = await listEntries();

  // Normal case: catalog and entry blobs are already available.
  if(catalog && entryBlobs.length) return { catalog, entryBlobs };

  // Recover legacy data only when something is missing. A failed read must
  // never make the public GET /api/data endpoint return HTTP 500.
  const legacy = await safeGet(LEGACY_KEY, { type:'json' });
  const source = legacy || cloneSeed();

  if(!catalog){
    catalog = catalogFromSource(source);
    try{
      await store.setJSON(CATALOG_KEY, catalog);
    }catch(err){
      console.error('[data] catalog recovery write failed', err);
    }
  }else{
    let changed=false;
    const fallback=cloneSeed();
    if(!catalog.settings) { catalog.settings=source.settings || fallback.settings; changed=true; }
    if(!Array.isArray(catalog.barbers)||!catalog.barbers.length) { catalog.barbers=source.barbers || fallback.barbers; changed=true; }
    if(!Array.isArray(catalog.services)||!catalog.services.length) { catalog.services=source.services || fallback.services; changed=true; }
    if(!Array.isArray(catalog.products)||!catalog.products.length) { catalog.products=source.products || fallback.products; changed=true; }
    if(changed){
      try{ await store.setJSON(CATALOG_KEY,catalog); }
      catch(err){ console.error('[data] catalog repair write failed', err); }
    }
  }

  // An empty online launch history is valid. Never repopulate it from the seed.

  return { catalog, entryBlobs };
}

export default async () => {
  try{
    const { catalog, entryBlobs } = await ensureMigrated();
    const entries = await readEntriesFromBlobs(entryBlobs);
    const version = await safeGet(VERSION_KEY,{type:'json'});

    entries.sort((a,b)=>
      String((b.date||'')+(b.time||''))
        .localeCompare(String((a.date||'')+(a.time||'')))
    );

    return Response.json(
      { ...catalog, entries, version:version?.version||0, ok:true },
      { headers:{'Cache-Control':'no-store'} }
    );
  }catch(err){
    // Last-resort fallback: the admin/iPad must still receive valid JSON.
    // We do not overwrite the remote database in this path.
    console.error('[data] failed to load database', err);
    const fallback=cloneSeed();
    return Response.json(
      {
        ...catalogFromSource(fallback),
        entries:Array.isArray(fallback.entries) ? fallback.entries : [],
        ok:false,
        degraded:true,
        error:'Banco remoto temporariamente indisponível.'
      },
      { status:200, headers:{'Cache-Control':'no-store'} }
    );
  }
};
