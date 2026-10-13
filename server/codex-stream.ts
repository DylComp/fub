import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mintFor } from '../src/assets.js';
import { assetAddress, isNetwork, NETWORKS } from '../src/networks.js';
import type { Candle } from '../src/market-data.js';

// Protocol and selected schema fields match Codex-Data/sdk's graphql-ws client
// and src/resources/schema.graphql. No provider key is sent to the browser.
const QUERY = `subscription Chart($tokenId: String!) { onTokenBarsUpdated(tokenId: $tokenId) { tokenId networkId eventSortKey aggregates { r1S { t usd { o h l c volume } } } } }`;
type Socket = Pick<WebSocket, 'send'|'close'|'addEventListener'>;
type Options = { apiKey?: string; socket?: () => Socket; now?: () => number; durationMs?: number };
const active = new Map<string, number>();
const starts = new Map<string, { at: number; count: number }>();
const streamAccessRetry = new Map<string, number>();
const STREAM_ACCESS_MESSAGE='Live updates require a Codex plan with streaming access.';
let total = 0;
let globalStarts={at:0,count:0};

export function streamIdentity(url: URL) {
  if ([...url.searchParams.keys()].some(k=>!['symbol','network'].includes(k)) || url.searchParams.getAll('symbol').length!==1 || url.searchParams.getAll('network').length>1) return null;
  const network=url.searchParams.get('network')||'solana',symbol=url.searchParams.get('symbol')||'';
  if(!isNetwork(network))return null;
  const address=network==='solana'?mintFor(symbol):assetAddress(network,symbol);
  if(!address)return null;
  const networkId=network==='solana'?1399811149:NETWORKS[network].chainId;
  return {tokenId:`${address}:${networkId}`,networkId};
}
export function streamCandle(value: unknown, identity: NonNullable<ReturnType<typeof streamIdentity>>, now=Date.now()): Candle {
  const x=value as {tokenId?:unknown;networkId?:unknown;aggregates?:{r1S?:{t?:unknown;usd?:{o?:unknown;h?:unknown;l?:unknown;c?:unknown;volume?:unknown}}}};
  if(!x||x.tokenId!==identity.tokenId||x.networkId!==identity.networkId)throw Error('Invalid stream');
  const bar=x.aggregates?.r1S,prices=bar?.usd,time=bar?.t;
  const values=[prices?.o,prices?.h,prices?.l,prices?.c];
  if(typeof time!=='number'||!Number.isInteger(time)||time<Math.floor(now/1000)-300||time>Math.floor(now/1000)+10||values.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0))throw Error('Invalid stream');
  const [open,high,low,close]=values as number[];
  const volume=typeof prices?.volume==='string'&&prices.volume.trim()!==''?Number(prices.volume):NaN;
  if(high<Math.max(open,close)||low>Math.min(open,close)||high<low||!Number.isFinite(volume)||volume<0)throw Error('Invalid stream');
  return {time,open,high,low,close,volume};
}
export async function handleMarketStream(req: IncomingMessage,res: ServerResponse,options:Options={}) {
  res.setHeader('Cache-Control','no-store');
  const reject=(code:number)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:'Chart stream unavailable.'}));};
  if(req.method!=='GET'){res.setHeader('Allow','GET');return reject(405);}
  let identity:ReturnType<typeof streamIdentity>;
  try{identity=streamIdentity(new URL(req.url||'','https://www.usefub.app'));}catch{return reject(400);}
  if(!identity)return reject(400);
  const host=req.headers.host,origin=req.headers.origin;
  if(req.headers['sec-fetch-site']==='cross-site'||origin&&(()=>{try{return new URL(origin).host!==host;}catch{return true;}})())return reject(403);
  const apiKey=options.apiKey??process.env.CODEX_API_KEY;
  const event=(name:string,data:unknown)=>res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const open=()=>{res.statusCode=200;res.setHeader('Content-Type','text/event-stream');res.setHeader('X-Accel-Buffering','no');res.flushHeaders?.();res.write('retry: 5000\n\n');};
  if(!apiKey){open();event('status',{status:'unavailable',message:'Live chart feed is not connected.'});res.end();return;}
  const now=options.now??Date.now,time=now();
  const keyHash=createHash('sha256').update(apiKey).digest('hex');
  for(const [key,until] of streamAccessRetry)if(until<=time)streamAccessRetry.delete(key);
  if((streamAccessRetry.get(keyHash)||0)>time){open();event('status',{status:'unavailable',message:STREAM_ACCESS_MESSAGE});res.end();return;}
  for(const [key,entry] of starts)if(time-entry.at>=60000)starts.delete(key);
  const ip=(typeof req.headers['x-forwarded-for']==='string'?req.headers['x-forwarded-for'].split(',')[0].trim():req.socket.remoteAddress)||'unknown';
  const usage=starts.get(ip)||{at:time,count:0};
  if(time-globalStarts.at>=60000)globalStarts={at:time,count:0};
  if(total>=8||(active.get(ip)||0)>=2||usage.count>=20||globalStarts.count>=120||starts.size>=1000)return reject(429);
  usage.count++;globalStarts.count++;starts.set(ip,usage);total++;active.set(ip,(active.get(ip)||0)+1);
  open();
  await new Promise<void>(resolve=>{
    let ws:Socket|undefined,closed=false,ack=false,live=false,lastPong=time;
    const sortKeys=new Map<number,bigint[]>();
    const finish=(unavailable=false,message='Live chart feed is temporarily unavailable.')=>{
      if(closed)return;closed=true;clearTimeout(lifetime);clearTimeout(handshake);clearInterval(heartbeat);
      res.off('close',onClose);total--;const count=(active.get(ip)||1)-1;if(count)active.set(ip,count);else active.delete(ip);
      try{if(ack)ws?.send(JSON.stringify({id:'chart',type:'complete'}));ws?.close();}catch{/* Socket already closed. */}
      if(!res.destroyed&&!res.writableEnded){if(unavailable)event('status',{status:'unavailable',message});res.end();}
      resolve();
    };
    const onClose=()=>finish();res.on('close',onClose);
    const lifetime=setTimeout(()=>finish(),Math.min(options.durationMs??50000,50000));
    const handshake=setTimeout(()=>finish(true),8000);
    const send=(value:unknown)=>{try{ws?.send(JSON.stringify(value));}catch{finish(true);}};
    const heartbeat=setInterval(()=>{if(now()-lastPong>25000){finish(true);return;}send({type:'ping'});if(!res.destroyed&&!res.writableEnded)res.write(': keepalive\n\n');},10000);
    try{
      ws=options.socket?options.socket():new WebSocket('wss://graph.codex.io/graphql','graphql-transport-ws');
      ws.addEventListener('open',()=>send({type:'connection_init',payload:{Authorization:apiKey}}));
      ws.addEventListener('error',()=>finish(true));ws.addEventListener('close',event=>{
        if((event as CloseEvent).code===4403){
          if(streamAccessRetry.size>=32)streamAccessRetry.delete(streamAccessRetry.keys().next().value!);
          streamAccessRetry.set(keyHash,now()+300000);finish(true,STREAM_ACCESS_MESSAGE);
        }else finish(true);
      });
      ws.addEventListener('message',message=>{
        if(closed)return;
        try{
          const data=(message as MessageEvent).data;if(typeof data!=='string'||data.length>16384)throw Error();
          const frame=JSON.parse(data);lastPong=now();
          if(frame.type==='ping'){send({type:'pong'});return;}
          if(frame.type==='pong')return;
          if(frame.type==='connection_ack'&&!ack){ack=true;clearTimeout(handshake);send({id:'chart',type:'subscribe',payload:{query:QUERY,variables:{tokenId:identity.tokenId}}});return;}
          if(frame.type==='next'&&ack&&frame.id==='chart'){
            if(frame.payload?.errors)throw Error();
            const update=frame.payload?.data?.onTokenBarsUpdated;
            const candle=streamCandle(update,identity,now());
            if(typeof update.eventSortKey!=='string'||!/^\d{1,30}#\d{1,30}#\d{1,30}$/.test(update.eventSortKey))throw Error();
            const sortKey=update.eventSortKey.split('#').map((part:string)=>BigInt(part)) as bigint[];
            const previous=sortKeys.get(candle.time);
            if(previous){const differing=sortKey.findIndex((part,index)=>part!==previous[index]);if(differing<0||sortKey[differing]<previous[differing])return;}
            sortKeys.set(candle.time,sortKey);
            if(sortKeys.size>400)sortKeys.delete(sortKeys.keys().next().value!);
            if(!live){live=true;event('status',{status:'live'});}if(!event('candle',candle))finish();return;
          }
          if(frame.type==='error'||frame.type==='complete')finish(true);
        }catch{finish(true);}
      });
    }catch{finish(true);}
  });
}
