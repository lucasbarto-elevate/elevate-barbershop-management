/* Delegate background refreshes to the app's guarded sync coordinator. */
(()=>{
 let running=false;
 async function refresh(){
  if(running||typeof loadRemote!=='function')return;
  running=true;
  try{
   if(typeof hasPendingSyncWork==='function'&&hasPendingSyncWork())await syncRemoteNow();
   else await loadRemote(false);
  }catch(err){console.error('[Elevate sync runtime] refresh failed',err);}
  finally{running=false;}
 }
 window.addEventListener('focus',refresh);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 window.addEventListener('online',refresh);
 setInterval(refresh,5000);
 setTimeout(refresh,250);
})();
