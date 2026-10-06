import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';
import { STORE_NAMES } from './_store-names.mjs';

const store = getStore({ name:STORE_NAMES.primary, consistency:'strong' });
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

async function getCatalog(dataStore){
  let catalog=await dataStore.get(CATALOG_KEY,{type:'json',consistency:'strong'});
  if(catalog?.settings && catalog?.barbers?.length && catalog?.services?.length && catalog?.products?.length) return catalog;
  const legacy=await dataStore.get(LEGACY_KEY,{type:'json',consistency:'strong'});
  // GET remains read-only: retain the historical fallback response without repairing
  // the primary store as a side effect of a normal read.
  return catalogFromSource(legacy||catalog||cloneSeed());
}

async function readEntries(dataStore){
  const result=await dataStore.list({prefix:ENTRY_PREFIX});
  const blobs=result?.blobs||[];
  if(!blobs.length) return [];
  const rows=await Promise.all(blobs.map(b=>dataStore.get(b.key,{type:'json',consistency:'strong'})));
  return rows.filter(Boolean).sort((a,b)=>String((b.date||'')+(b.time||'')).localeCompare(String((a.date||'')+(a.time||''))));
}

export function createDataHandler(dataStore = store){
  return async ()=>{
    try{
      const [catalog,entries,version]=await Promise.all([
        getCatalog(dataStore),
        readEntries(dataStore),
        dataStore.get(VERSION_KEY,{type:'json',consistency:'strong'})
      ]);
      return Response.json({...catalog,entries,version:version?.version||0,ok:true},{headers:{'Cache-Control':'no-store'}});
    }catch(err){
      console.error('[data] failed',err);
      return Response.json({ok:false,error:'Banco remoto temporariamente indisponível.'},{status:503,headers:{'Cache-Control':'no-store'}});
    }
  };
}

export default createDataHandler();
