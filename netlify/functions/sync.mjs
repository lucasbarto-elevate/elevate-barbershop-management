import { getStore } from '@netlify/blobs';
import { seed } from './_seed.mjs';
import { acquireLock, assertHealthy, assertLock, clearRecoveryState, releaseLock, setRecoveryState } from './_coordination.mjs';
import { beginSyncJournal, rollbackSyncJournal } from './_sync-journal.mjs';
import { STORE_NAMES } from './_store-names.mjs';

const CATALOG_KEY='catalog', LEGACY_KEY='database', ENTRY_PREFIX='entries/', VERSION_KEY='sync-version';
function cloneSeed(){return structuredClone(seed)}
function validCatalog(c){return !!(c?.settings&&c?.barbers?.length&&c?.services?.length&&c?.products?.length)}
async function getCatalog(lock,store){
  const observed=await store.getWithMetadata(CATALOG_KEY,{type:'json',consistency:'strong'});
  let catalog=observed?.data;
  if(validCatalog(catalog)) return { catalog, etag: observed.etag };
  const legacy=await store.get(LEGACY_KEY,{type:'json',consistency:'strong'});
  const source=legacy||catalog||cloneSeed(), fallback=cloneSeed();
  catalog={
    settings:source.settings||fallback.settings,
    barbers:Array.isArray(source.barbers)&&source.barbers.length?source.barbers:fallback.barbers,
    services:Array.isArray(source.services)&&source.services.length?source.services:fallback.services,
    products:Array.isArray(source.products)&&source.products.length?source.products:fallback.products
  };
  await assertLock(lock);
  const result=observed?.etag
    ?await store.setJSON(CATALOG_KEY,catalog,{onlyIfMatch:observed.etag})
    :await store.setJSON(CATALOG_KEY,catalog,{onlyIfNew:true});
  if(!result?.modified) throw new Error('Catálogo mudou durante a inicialização coordenada.');
  return { catalog, etag: result.etag };
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
async function bumpVersion(lock,store){
  // Compare-and-swap keeps the version monotonic even when mutations finish together.
  for(let attempt=0;attempt<32;attempt++){
    const observed=await store.getWithMetadata(VERSION_KEY,{type:'json',consistency:'strong'});
    const current=observed?.data;
    const state={version:Math.max(Date.now(),Number(current?.version||0)+1),updatedAt:new Date().toISOString()};
    await assertLock(lock);
    const result=!observed?.etag
      ?await store.setJSON(VERSION_KEY,state,{onlyIfNew:true})
      :await store.setJSON(VERSION_KEY,state,{onlyIfMatch:observed.etag});
    if(result?.modified)return state;
    await new Promise(resolve=>setTimeout(resolve,Math.min(10*(attempt+1),100)));
  }
  throw new Error('Não foi possível incrementar a versão remota após várias tentativas.');
}

export function createSyncHandler(stores = {}){
  const store=stores.store||getStore({name:STORE_NAMES.primary,consistency:'strong'});
  const control=stores.control||getStore({name:STORE_NAMES.control,consistency:'strong'});
  return async req=>{
  if(req.method!=='POST') return Response.json({ok:false,error:'Method not allowed'},{status:405});
  let lock;
  let journalKey;
  try{
    const body=await req.json();
    lock=await acquireLock(control,'sync');
    await assertHealthy(control);
    ({ key: journalKey } = await beginSyncJournal({ primary: store, control, body, lock }));
    const catalogState=await getCatalog(lock,store);
    let catalog=catalogState.catalog;
    let catalogEtag=catalogState.etag;
    const incoming=Array.isArray(body.entries)?body.entries.map(normalizeEntry):[];
    const deletedIds=Array.isArray(body.deletedIds)?body.deletedIds.map(String):[];
    let stockChanged=false;

    for(const e of incoming){
      const key=ENTRY_PREFIX+e.id;
      const observed=await store.getWithMetadata(key,{type:'json',consistency:'strong'});
      const existing=observed?.data??null;
      if(existing===null){
        const delta=new Map(); for(const [id,qty] of productQty(e)) delta.set(id,-qty);
        applyStockDelta(catalog,delta);
        await assertLock(lock);
        const result=await store.setJSON(key,e,{onlyIfNew:true});
        if(result.modified) stockChanged=stockChanged||delta.size>0;
        else if(await store.get(key,{type:'json',consistency:'strong'})===null) throw new Error('Falha ao gravar lançamento');
      }else{
        const oldQ=productQty(existing),newQ=productQty(e),delta=new Map(),ids=new Set([...oldQ.keys(),...newQ.keys()]);
        for(const id of ids){const d=(oldQ.get(id)||0)-(newQ.get(id)||0);if(d)delta.set(id,d)}
        applyStockDelta(catalog,delta);
        if(!observed?.etag) throw new Error('Lançamento existente sem ETag; recarregue e tente novamente.');
        await assertLock(lock);
        const result=await store.setJSON(key,e,{onlyIfMatch:observed.etag});
        if(!result.modified) throw new Error('Lançamento foi alterado por outro dispositivo. Recarregue e tente novamente.');
        stockChanged=stockChanged||delta.size>0;
      }
    }

    for(const id of deletedIds){
      const key=ENTRY_PREFIX+id;
      const observed=await store.getWithMetadata(key,{type:'json',consistency:'strong'});
      const existing=observed?.data??null;
      if(existing){
        const delta=new Map();for(const [pid,qty] of productQty(existing))delta.set(pid,qty);
        applyStockDelta(catalog,delta);
        await assertLock(lock);
        if(!observed?.etag) throw new Error('Lançamento mudou antes da exclusão. Recarregue e tente novamente.');
        await assertLock(lock);
        await store.delete(key);
        stockChanged=stockChanged||delta.size>0;
      }
    }

    if(body.catalog) catalog=mergeCatalogEdits(catalog,body.catalog,incoming.length>0||deletedIds.length>0||stockChanged);
    if(body.catalog||stockChanged){
      await assertLock(lock);
      const result=catalogEtag
        ?await store.setJSON(CATALOG_KEY,catalog,{onlyIfMatch:catalogEtag})
        :await store.setJSON(CATALOG_KEY,catalog,{onlyIfNew:true});
      if(!result?.modified) throw new Error('Catálogo foi alterado por outra operação. Recarregue e tente novamente.');
      catalogEtag=result.etag;
    }
    const changed=!!(body.catalog||stockChanged||incoming.length||deletedIds.length);
    const version=changed?await bumpVersion(lock,store):await store.get(VERSION_KEY,{type:'json',consistency:'strong'});
    await clearRecoveryState(control,lock);
    if(journalKey){await assertLock(lock);await control.delete(journalKey);journalKey=null;}
    return Response.json({ok:true,version:version?.version||0,catalog,entries:incoming,deletedIds,received:incoming.length,deleted:deletedIds.length,stockChanged},{headers:{'Cache-Control':'no-store'}});
  }catch(err){
    console.error('[sync] failed',err);
    if(lock&&journalKey){
      try{await rollbackSyncJournal({primary:store,control,journalKey,lock});journalKey=null;}
      catch(rollbackError){
        console.error('[sync] rollback failed; recovery required',rollbackError);
        await setRecoveryState(control,lock,{operation:'sync-recovery-required',syncJournalKey:journalKey,ownerId:lock.ownerId,message:'Uma sincronização falhou e o rollback automático não foi confirmado. As mutações permanecem bloqueadas.',error:String(err?.message||err),rollbackError:String(rollbackError?.message||rollbackError)}).catch(stateError=>console.error('[sync] recovery marker failed',stateError));
      }
    }
    const message=String(err?.message||err);
    const status=/Estoque insuficiente|alterado por outro dispositivo|ETag|Falha ao gravar/.test(message)?409:503;
    const recovery=!!journalKey;
    return Response.json({ok:false,error:recovery?'A sincronização entrou em modo de recuperação; contacte um administrador.':message,retryable:!recovery&&(err?.retryable===true||status===503)},{status,headers:{'Cache-Control':'no-store'}});
  }finally{
    if(lock) await releaseLock(lock);
  }
  };
}

export default async req=>createSyncHandler()(req);
