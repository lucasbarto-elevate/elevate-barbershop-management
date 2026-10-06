/* Elevate production sync runtime.
   Bypasses a stale remoteLoadInFlight lock in older HTML shells and keeps
   all open devices updated without reloading the page. */
(()=>{
  let checking=false;
  async function refreshRemote(){
    if(checking) return;
    if(typeof pendingSync!=='undefined' && (pendingSync.length||pendingDeletes.length||catalogDirty)) return;
    checking=true;
    try{
      const vr=await fetch('/api/version',{cache:'no-store'});
      if(!vr.ok) throw new Error('version-http-'+vr.status);
      const vs=await vr.json();
      if(!vs.ok) throw new Error('version-response');
      if(typeof remoteVersion!=='undefined' && remoteLoaded && String(vs.version||'')===String(remoteVersion||'')){
        backendOnline=true; updateConnectionStatus(); return;
      }
      const r=await fetch('/api/data',{cache:'no-store'});
      if(!r.ok) throw new Error('data-http-'+r.status);
      const remote=await r.json();
      if(!remote?.ok||!remote.settings||!Array.isArray(remote.entries)) throw new Error('invalid-remote-database');
      db=remote;
      db.products=(db.products||[]).map(p=>({...p,commission:Number(p.commission||0)}));
      db.barbers=(db.barbers||[]).map(b=>b.name==='Elevate Barbershop'?{...b,commission:0}:b);
      remoteVersion=remote.version||vs.version||null;
      remoteLoaded=true;
      remoteLoadInFlight=false;
      backendOnline=true;
      localStorage.setItem(key,JSON.stringify(db));
      render(); updateConnectionStatus();
    }catch(err){
      console.error('[Elevate runtime] atualização remota falhou',err);
      backendOnline=false; updateConnectionStatus();
    }finally{checking=false;}
  }
  window.addEventListener('focus',refreshRemote);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshRemote()});
  setInterval(refreshRemote,1500);
  setTimeout(refreshRemote,250);
})();
