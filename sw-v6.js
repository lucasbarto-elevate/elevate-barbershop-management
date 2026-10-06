const CACHE='elevate-shell-v8';
const ASSETS=['/elevate-logo-white.png','/manifest.json','/sync-runtime-v1.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('elevate-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request,{cache:'no-store'}).then(async response=>{
      if(!response.ok)return response;
      const type=response.headers.get('content-type')||'';
      if(!type.includes('text/html'))return response;
      let html=await response.text();
      if(!html.includes('sync-runtime-v1.js')) html=html.replace('</body>','<script src="/sync-runtime-v1.js?v=1"></script></body>');
      return new Response(html,{status:response.status,statusText:response.statusText,headers:response.headers});
    }).catch(()=>caches.match('/index.html')));
    return;
  }
  event.respondWith(fetch(event.request,{cache:'no-store'}).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{})}
    return response;
  }).catch(()=>caches.match(event.request)));
});
