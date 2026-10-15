import { getStore } from '@netlify/blobs';
import { STORE_NAMES } from './_store-names.mjs';
const VERSION_KEY='sync-version';
let defaultStore;
function getDefaultStore(){
  return defaultStore ||= getStore({ name:STORE_NAMES.primary, consistency:'strong' });
}
export function createVersionHandler(versionStore){
  return async function(){
    try{
      const activeStore=versionStore||getDefaultStore();
      const state=await activeStore.get(VERSION_KEY,{type:'json',consistency:'strong'});
      return Response.json({ok:true,...(state||{version:0,updatedAt:null})},{headers:{'Cache-Control':'no-store'}});
    }catch(err){
      return Response.json({ok:false,error:String(err?.message||err)},{status:503,headers:{'Cache-Control':'no-store'}});
    }
  };
}
export default createVersionHandler();
