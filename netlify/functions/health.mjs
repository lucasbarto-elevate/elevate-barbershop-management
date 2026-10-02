export default async () => Response.json({ok:true,service:'elevate-sync',time:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
