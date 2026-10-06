import { getStore } from '@netlify/blobs';
import { STORE_NAMES } from './_store-names.mjs';
const store = getStore({ name:STORE_NAMES.primary, consistency:'strong' });
const VERSION_KEY='sync-version';
export function createVersionHandler(versionStore = store){
  return async function(){
    try{
      const state=await versionStore.get(VERSION_KEY,{type:'json',consistency:'strong'});
      return Response.json({ok:true,...(state||{version:0,updatedAt:null})},{headers:{'Cache-Control':'no-store'}});
    }catch(err){
      return Response.json({ok:false,error:String(err?.message||err)},{status:503,headers:{'Cache-Control':'no-store'}});
    }
  };
}
export default createVersionHandler();
