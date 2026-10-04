import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store = getStore({ name:'elevate-db', consistency:'strong' });
const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const ENTRY_PREFIX = 'entries/';

function cloneSeed(){ return structuredClone(seed); }

async function ensureMigrated(){
  let catalog = await store.get(CATALOG_KEY, { type:'json' });
  if(catalog) return catalog;

  const legacy = await store.get(LEGACY_KEY, { type:'json' });
  const source = legacy || cloneSeed();
  catalog = {
    settings: source.settings,
    barbers: source.barbers || [],
    services: source.services || [],
    products: source.products || []
  };
  await store.setJSON(CATALOG_KEY, catalog);
  for(const entry of (source.entries || [])){
    await store.setJSON(`${ENTRY_PREFIX}${String(entry.id)}`, entry);
  }
  return catalog;
}

function normalizeEntry(e){
  return {
    ...e,
    id:String(e.id),
    clients:Number(e.clients||0),
    tip:Number(e.tip||0),
    total:Number(e.total||0),
    serviceItems:Array.isArray(e.serviceItems)?e.serviceItems:[],
    productItems:Array.isArray(e.productItems)?e.productItems:[]
  };
}

export default async (req) => {
  if(req.method!=='POST') return Response.json({error:'Method not allowed'},{status:405});
  try{
    const body=await req.json();
    let catalog=await ensureMigrated();
    const incoming=Array.isArray(body.entries)?body.entries.map(normalizeEntry):[];

    // Each launch is its own blob. This avoids the old read/modify/write race where
    // two iPads could overwrite each other's launches.
    await Promise.all(incoming.map(e => store.setJSON(`${ENTRY_PREFIX}${e.id}`, e)));

    if(body.catalog){
      catalog={
        settings: body.catalog.settings || catalog.settings,
        barbers: Array.isArray(body.catalog.barbers)?body.catalog.barbers:catalog.barbers,
        services: Array.isArray(body.catalog.services)?body.catalog.services:catalog.services,
        products: Array.isArray(body.catalog.products)?body.catalog.products:catalog.products
      };
      await store.setJSON(CATALOG_KEY,catalog);
    }

    const { blobs } = await store.list({ prefix: ENTRY_PREFIX });
    const rows = await Promise.all((blobs||[]).map(b=>store.get(b.key,{type:'json'})));
    const entries=rows.filter(Boolean).sort((a,b)=>String(b.date+b.time).localeCompare(String(a.date+a.time)));
    return Response.json({ok:true,db:{...catalog,entries},received:incoming.length},{headers:{'Cache-Control':'no-store'}});
  }catch(err){
    return Response.json({ok:false,error:String(err?.message||err)},{status:400,headers:{'Cache-Control':'no-store'}});
  }
};
