import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store = getStore({ name:'elevate-db', consistency:'strong' });
const CATALOG_KEY='catalog';
const LEGACY_KEY='database';
const ENTRY_PREFIX='entries/';
const VERSION_KEY='sync-version';

function cloneSeed(){ return structuredClone(seed); }
function catalogFromSource(source){
  const fallback=cloneSeed();
  return {
    settings:source?.settings||fallback.settings,
    barbers:Array.isArray(source?.barbers)&&source.barbers.length?source.barbers:fallback.barbers,
    services:Array.isArray(source?.services)&&source.services.length?source.services:fallback.services,
    products:Array.isArray(source?.products)&&source.products.length?source.products:fallback.products
  };
}

async function getCatalog(){
  let catalog=await store.get(CATALOG_KEY,{type:'json',consistency:'strong'});
  if(catalog?.settings && catalog?.barbers?.length && catalog?.services?.length && catalog?.products?.length) return catalog;
  const legacy=await store.get(LEGACY_KEY,{type:'json',consistency:'strong'});
  catalog=catalogFromSource(legacy||catalog||cloneSeed());
  await store.setJSON(CATALOG_KEY,catalog);
  return catalog;
}

async function readEntries(){
  const result=await store.list({prefix:ENTRY_PREFIX});
  const blobs=result?.blobs||[];
  if(!blobs.length) return [];
  const rows=await Promise.all(blobs.map(b=>store.get(b.key,{type:'json',consistency:'strong'})));
  return rows.filter(Boolean).sort((a,b)=>String((b.date||'')+(b.time||'')).localeCompare(String((a.date||'')+(a.time||''))));
}

export default async ()=>{
  try{
    const [catalog,entries,version]=await Promise.all([
      getCatalog(),
      readEntries(),
      store.get(VERSION_KEY,{type:'json',consistency:'strong'})
    ]);
    return Response.json({...catalog,entries,version:version?.version||0,ok:true},{headers:{'Cache-Control':'no-store'}});
  }catch(err){
    console.error('[data] failed',err);
    return Response.json({ok:false,error:'Banco remoto temporariamente indisponível.'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
};
