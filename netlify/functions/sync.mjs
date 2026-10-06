import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';

const store=getStore({name:'elevate-db',consistency:'strong'});
const CATALOG_KEY='catalog', LEGACY_KEY='database', ENTRY_PREFIX='entries/', VERSION_KEY='sync-version';
function cloneSeed(){return structuredClone(seed)}
function validCatalog(c){return !!(c?.settings&&c?.barbers?.length&&c?.services?.length&&c?.products?.length)}
async function getCatalog(){
  let catalog=await store.get(CATALOG_KEY,{type:'json',consistency:'strong'});
  if(validCatalog(catalog)) return catalog;
  const legacy=await store.get(LEGACY_KEY,{type:'json',consistency:'strong'});
  const source=legacy||catalog||cloneSeed(), fallback=cloneSeed();
  catalog={
    settings:source.settings||fallback.settings,
    barbers:Array.isArray(source.barbers)&&source.barbers.length?source.barbers:fallback.barbers,
    services:Array.isArray(source.services)&&source.services.length?source.services:fallback.services,
    products:Array.isArray(source.products)&&source.products.length?source.products:fallback.products
  };
  await store.setJSON(CATALOG_KEY,catalog);
  return catalog;
}
function normalizeEntry(e){return {...e,id:String(e.id),clients:Number(e.clients||0),tip:Number(e.tip||0),total:Number(e.total||0),serviceItems:Array.isArray(e.serviceItems)?e.serviceItems:[],productItems:Array.isArray(e.productItems)?e.productItems:[]}}
function productQty(entry){
  const out=new Map();
  for(const item of (entry?.productItems||[])){
    const id=String(item.id), qty=Number(item.qty||1);
    if(id&&qty>0) out.set(id,(out.get(id)||0)+qty);
  }
  if(!out.size&&entry?.productId) out.set(String(entry.productId),1);
  return out;
}
function applyStockDelta(catalog,delta){
  for(const [id,change] of delta){
    const p=catalog.products.find(x=>String(x.id)===String(id));
    if(!p) continue;
    const next=Number(p.stock||0)+Number(change||0);
    if(next<0) throw new Error(`Estoque insuficiente para ${p.name||id}`);
    p.stock=next;
  }
}
function mergeCatalogEdits(current,incoming,preserveStock){
  if(!incoming) return current;
  const merged={settings:incoming.settings||current.settings,barbers:Array.isArray(incoming.barbers)?incoming.barbers:current.barbers,services:Array.isArray(incoming.services)?incoming.services:current.services,products:current.products};
  if(Array.isArray(incoming.products)) merged.products=incoming.products.map(ip=>{
    const old=current.products.find(p=>String(p.id)===String(ip.id));
    return old&&preserveStock?{...ip,stock:old.stock}:ip;
  });
  return merged;
}
async function bumpVersion(){
  const state={version:Date.now(),updatedAt:new Date().toISOString()};
  await store.setJSON(VERSION_KEY,state);
  return state;
}

export default async req=>{
  if(req.method!=='POST') return Response.json({ok:false,error:'Method not allowed'},{status:405});
  try{
    const body=await req.json();
    let catalog=await getCatalog();
    const incoming=Array.isArray(body.entries)?body.entries.map(normalizeEntry):[];
    const deletedIds=Array.isArray(body.deletedIds)?body.deletedIds.map(String):[];
    let stockChanged=false;

    for(const e of incoming){
      const key=ENTRY_PREFIX+e.id;
      const existing=await store.get(key,{type:'json',consistency:'strong'});
      if(existing===null){
        const delta=new Map(); for(const [id,qty] of productQty(e)) delta.set(id,-qty);
        applyStockDelta(catalog,delta);
        const result=await store.setJSON(key,e,{onlyIfNew:true});
        if(result.modified) stockChanged=stockChanged||delta.size>0;
        else if(await store.get(key,{type:'json',consistency:'strong'})===null) throw new Error('Falha ao gravar lançamento');
      }else{
        const oldQ=productQty(existing),newQ=productQty(e),delta=new Map(),ids=new Set([...oldQ.keys(),...newQ.keys()]);
        for(const id of ids){const d=(oldQ.get(id)||0)-(newQ.get(id)||0);if(d)delta.set(id,d)}
        applyStockDelta(catalog,delta);
        const meta=await store.getMetadata(key,{consistency:'strong'});
        if(!meta?.etag) throw new Error('Lançamento existente sem ETag; recarregue e tente novamente.');
        const result=await store.setJSON(key,e,{onlyIfMatch:meta.etag});
        if(!result.modified) throw new Error('Lançamento foi alterado por outro dispositivo. Recarregue e tente novamente.');
        stockChanged=stockChanged||delta.size>0;
      }
    }

    for(const id of deletedIds){
      const key=ENTRY_PREFIX+id;
      const existing=await store.get(key,{type:'json',consistency:'strong'});
      if(existing){
        const delta=new Map();for(const [pid,qty] of productQty(existing))delta.set(pid,qty);
        applyStockDelta(catalog,delta);
        await store.delete(key);
        stockChanged=stockChanged||delta.size>0;
      }
    }

    if(body.catalog) catalog=mergeCatalogEdits(catalog,body.catalog,incoming.length>0||deletedIds.length>0||stockChanged);
    if(body.catalog||stockChanged) await store.setJSON(CATALOG_KEY,catalog);
    const changed=!!(body.catalog||stockChanged||incoming.length||deletedIds.length);
    const version=changed?await bumpVersion():await store.get(VERSION_KEY,{type:'json',consistency:'strong'});
    return Response.json({ok:true,version:version?.version||0,catalog,entries:incoming,deletedIds,received:incoming.length,deleted:deletedIds.length,stockChanged},{headers:{'Cache-Control':'no-store'}});
  }catch(err){
    console.error('[sync] failed',err);
    const message=String(err?.message||err);
    const status=/Estoque insuficiente|alterado por outro dispositivo|ETag|Falha ao gravar/.test(message)?409:503;
    return Response.json({ok:false,error:message,retryable:status===503},{status,headers:{'Cache-Control':'no-store'}});
  }
};
