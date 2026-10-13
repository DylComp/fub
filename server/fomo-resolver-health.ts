import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';

export type ResolverHealthState = 'starting' | 'ready' | 'capacity' | 'paused' | 'failed' | 'stopped';
// This endpoint is private host health only. It never exposes handles, wallets,
// pause details, browser state or database configuration.
export function resolverHealth(now = Date.now) {
  let state: ResolverHealthState = 'starting', updatedAt = now();
  return {
    update(next: ResolverHealthState) { state = next; updatedAt = now(); },
    snapshot() {
      const fresh = now() >= updatedAt && now() - updatedAt < 90000;
      return { alive: fresh && !['failed','stopped'].includes(state), ready: fresh && state === 'ready' };
    },
  };
}
export function resolverHealthServer(health: ReturnType<typeof resolverHealth>, port: number, host = '::',leaderLookup?:(req:IncomingMessage,res:ServerResponse)=>Promise<unknown>) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid resolver health port.');
  const server = createServer((req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json');
    res.setHeader('X-Content-Type-Options','nosniff');
    if(leaderLookup&&req.url?.split('?')[0]==='/leader'){void leaderLookup(req,res).catch(()=>{if(!res.writableEnded){res.statusCode=503;res.end('{"error":"lookup_unavailable"}');}});return;}
    if (req.method !== 'GET' || !['/healthz','/readyz'].includes(req.url || '')) {
      res.statusCode = 404; res.end('{"error":"not_found"}'); return;
    }
    const snapshot = health.snapshot();
    const ready = req.url === '/healthz' ? snapshot.alive : snapshot.ready;
    res.statusCode = ready ? 200 : 503; res.end(JSON.stringify({ready}));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.listen(port,host);
  return server;
}
