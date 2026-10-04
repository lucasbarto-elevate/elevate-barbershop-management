import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store = getStore({ name:'elevate-db', consistency:'strong' });
const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const ENTRY_PREFIX = 'entries/';

function cloneSeed(){ return structuredClone(seed); }

async function readAllEntries(){
  const { blobs } = await store.list({ prefix: ENTRY_PREFIX });
  if(!blobs?.length) return [];
  const rows = await Promise.all(blobs.map(b => store.get(b.key, { type:'json' })));
  return rows.filter(Boolean);
}

async function ensureMigrated(){
  let catalog = await store.get(CATALOG_KEY, { type:'json' });
  const legacy = await store.get(LEGACY_KEY, { type:'json' });
  const source = legacy || cloneSeed();

  if(!catalog){
    catalog = {
      settings: source.settings,
      barbers: source.barbers || [],
      services: source.services || [],
      products: source.products || []
    };
    await store.setJSON(CATALOG_KEY, catalog);
  }

  // Recupera os lancamentos antigos se o catalogo existir mas os blobs de entries estiverem ausentes.
  const existing = await store.list({ prefix: ENTRY_PREFIX });
  if(!existing.blobs?.length){
    const sourceEntries = Array.isArray(source.entries) ? source.entries : [];
    if(sourceEntries.length){
      await Promise.all(sourceEntries.map(entry =>
        store.setJSON(ENTRY_PREFIX + String(entry.id), entry, { onlyIfNew:true })
      ));
    }
  }
  return catalog;
}

export default async () => {
  try{
    const catalog = await ensureMigrated();
    let entries = await readAllEntries();
    if(!entries.length){
      const fallback = cloneSeed().entries || [];
      if(fallback.length){
        await Promise.all(fallback.map(e => store.setJSON(`${ENTRY_PREFIX}${String(e.id)}`, e)));
        entries = fallback;
      }
    }
    entries.sort((a,b)=>String(b.date+b.time).localeCompare(String(a.date+a.time)));
    return Response.json({ ...catalog, entries }, { headers:{'Cache-Control':'no-store'} });
  }catch(err){
    return Response.json({ok:false,error:String(err?.message||err)},{status:500,headers:{'Cache-Control':'no-store'}});
  }
};
