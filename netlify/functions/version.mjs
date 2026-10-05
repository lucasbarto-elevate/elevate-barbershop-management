import { getStore } from '@netlify/blobs';
const store = getStore({ name:'elevate-db', consistency:'strong' });
const VERSION_KEY='sync-version';
export default async function(){
  try{
    let state=await store.get(VERSION_KEY,{type:'json'});
    if(!state){
      state={version:Date.now(),updatedAt:new Date().toISOString()};
      await store.setJSON(VERSION_KEY,state,{onlyIfNew:true});
      state=await store.get(VERSION_KEY,{type:'json'})||state;
    }
    return Response.json({ok:true,...state},{headers:{'Cache-Control':'no-store'}});
  }catch(err){
    return Response.json({ok:false,error:String(err?.message||err)},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
