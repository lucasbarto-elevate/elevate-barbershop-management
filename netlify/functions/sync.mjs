import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store = getStore({ name:'elevate-db', consistency:'strong' });
const CATALOG_KEY = 'catalog';
const LEGACY_KEY = 'database';
const ENTRY_PREFIX = 'entries/';

function cloneSeed(){ return structuredClone(seed); }

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
    await store.setJSON(CATALOG_KEY,catalog);
  }else{
    let changed=false;
    if(!catalog.settings){catalog.settings=source.settings;changed=true;}
    if(!Array.isArray(catalog.barbers)||!catalog.barbers.length){catalog.barbers=source.barbers||[];changed=true;}
    if(!Array.isArray(catalog.services)||!catalog.services.length){catalog.services=source.services||[];changed=true;}
    if(!Array.isArray(catalog.products)||!catalog.products.length){catalog.products=source.products||[];changed=true;}
    if(changed) await store.setJSON(CATALOG_KEY,catalog);
  }

  // If the catalog exists but the individual launch blobs do not,
  // restore the legacy/seed launches without overwriting existing ones.
  const existing = await store.list({ prefix: ENTRY_PREFIX });
  if(!existing.blobs?.length){
    for(const entry of (source.entries || [])){
      await store.setJSON(`${ENTRY_PREFIX}${String(entry.id)}`, entry, { onlyIfNew:true });
    }
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

function productQty(entry){
  const out=new Map();
  for(const item of (entry?.productItems||[])){
    const id=String(item.id);
    const qty=Number(item.qty||1);
    if(id && qty>0) out.set(id,(out.get(id)||0)+qty);
  }
  // Legacy product-only entries
  if(!out.size && entry?.productId){
    out.set(String(entry.productId),1);
  }
  return out;
}

function applyStockDelta(catalog, delta){
  for(const [id,change] of delta.entries()){
    const p=catalog.products.find(x=>String(x.id)===String(id));
    if(!p) continue;
    const next=Number(p.stock||0)+Number(change||0);
    if(next<0) throw new Error(`Estoque insuficiente para ${p.name||id}`);
    p.stock=next;
  }
}

function mergeCatalogEdits(current,incoming,preserveStock){
  if(!incoming) return current;
  const merged={
    settings: incoming.settings || current.settings,
    barbers: Array.isArray(incoming.barbers)?incoming.barbers:current.barbers,
    services: Array.isArray(incoming.services)?incoming.services:current.services,
    products: current.products
  };
  if(Array.isArray(incoming.products)){
    merged.products=incoming.products.map(ip=>{
      const old=current.products.find(p=>String(p.id)===String(ip.id));
      if(!old) return ip;
      return preserveStock ? {...ip,stock:old.stock} : ip;
    });
  }
  return merged;
}

async function readAllEntries(){
  const { blobs }=await store.list({prefix:ENTRY_PREFIX});
  if(!blobs?.length) return [];
  const rows=await Promise.all(blobs.map(b=>store.get(b.key,{type:'json'})));
  return rows.filter(Boolean);
}

export default async (req)=>{
  if(req.method!=='POST') return Response.json({error:'Method not allowed'},{status:405});
  try{
    const body=await req.json();
    let catalog=await ensureMigrated();
    const incoming=Array.isArray(body.entries)?body.entries.map(normalizeEntry):[];
    const deletedIds=Array.isArray(body.deletedIds)?body.deletedIds.map(String):[];
    let stockChanged=false;

    // Entries are individually idempotent. A retry of the same new launch
    // cannot create a second stock movement.
    for(const e of incoming){
      const key=`${ENTRY_PREFIX}${e.id}`;
      const existing=await store.get(key,{type:'json',consistency:'strong'});
      if(existing===null){
        const delta=new Map();
        for(const [id,qty] of productQty(e)) delta.set(id,-qty);
        applyStockDelta(catalog,delta);
        const result=await store.setJSON(key,e,{onlyIfNew:true});
        if(result.modified){
          stockChanged=stockChanged || delta.size>0;
        }else{
          // Another request created it between our read and write.
          const winner=await store.get(key,{type:'json',consistency:'strong'});
          if(winner===null) throw new Error('Falha ao gravar lançamento');
        }
      }else{
        // Admin edit: adjust stock only by the quantity difference.
        const oldQ=productQty(existing), newQ=productQty(e), delta=new Map();
        const ids=new Set([...oldQ.keys(),...newQ.keys()]);
        for(const id of ids){
          const oldQty=oldQ.get(id)||0, newQty=newQ.get(id)||0;
          if(oldQty!==newQty) delta.set(id,oldQty-newQty);
        }
        applyStockDelta(catalog,delta);
        const meta=await store.getMetadata(key);
        const result=await store.setJSON(key,e,{onlyIfMatch:meta?.etag});
        if(!result.modified) throw new Error('Lançamento foi alterado por outro dispositivo. Recarregue e tente novamente.');
        stockChanged=stockChanged || delta.size>0;
      }
    }

    // Admin deletion: restore the products that belonged to the deleted launch.
    for(const id of deletedIds){
      const key=`${ENTRY_PREFIX}${id}`;
      const existing=await store.get(key,{type:'json',consistency:'strong'});
      if(existing){
        const delta=new Map();
        for(const [pid,qty] of productQty(existing)) delta.set(pid,qty);
        applyStockDelta(catalog,delta);
        await store.delete(key);
        stockChanged=stockChanged || delta.size>0;
      }
    }

    // Catalog changes are a separate operation. When a sale is in the same
    // request, server stock remains authoritative and is never replaced by
    // an old iPad stock value.
    if(body.catalog){
      catalog=mergeCatalogEdits(catalog,body.catalog, incoming.length>0 || deletedIds.length>0 || stockChanged);
    }

    if(body.catalog || stockChanged){
      await store.setJSON(CATALOG_KEY,catalog);
    }

    let entries=await readAllEntries();
    entries.sort((a,b)=>String(b.date+b.time).localeCompare(String(a.date+a.time)));
    return Response.json({
      ok:true,
      db:{...catalog,entries},
      received:incoming.length,
      deleted:deletedIds.length,
      stockChanged
    },{headers:{'Cache-Control':'no-store'}});
  }catch(err){
    return Response.json({ok:false,error:String(err?.message||err)},{status:409,headers:{'Cache-Control':'no-store'}});
  }
};
