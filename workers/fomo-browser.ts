import type { Page } from 'playwright';
import { fomoHandle } from '../src/fomo-identity.js';
import { parseDirectProfile, ResolverFailure } from '../server/fomo-resolver-worker.js';
import type { ResolverBrowser } from '../server/fomo-resolver-worker.js';
import { RESOLVER_USDC, RESOLVER_SOL, type ResolverCurrency } from '../server/fomo-draft-decoder.js';

export type FomoRequest = {kind:'profile'|'draft';value:string;mint:string;amount:string};
export function draftRequest(kind:FomoRequest['kind'],value:string,currency:ResolverCurrency):FomoRequest {
  return {kind,value,mint:currency==='sol'?RESOLVER_SOL:RESOLVER_USDC,amount:currency==='sol'?'20000000':'2000000'};
}
// Self-contained: this runs in Fomo's page, with credentials staying there.
export async function fomoPageRequest({kind,value,mint,amount}:FomoRequest) {

      // Vite may load this module through a dynamic import without retaining a
      // modulepreload link. Resource timing still identifies the exact public JS
      // asset loaded by this page. Never import an unrelated or cross-origin URL.
      const asset=[...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'),l=>l.href),
        ...performance.getEntriesByType('resource').map(entry=>entry.name)]
        .map(href=>{try{return new URL(href);}catch{return null;}})
        .find((u):u is URL=>!!u&&u.origin===location.origin&&/^\/assets\/fomoFetch-v[0-9]+-[A-Za-z0-9_-]+\.js$/.test(u.pathname)&&!u.search&&!u.hash);
      if(!asset)return {status:0,failure:'upstream_changed'};
      try {
        // Import the wrapper already used by Fomo in this page. Its authentication
        // remains inside the browser; only allowlisted public fields leave it.
        const module=await import(/* @vite-ignore */ asset.href);
        if(typeof module.f!=='function')return {status:0,failure:'upstream_changed'};
        // A loaded API module does not mean the page's Privy provider has
        // mounted. This exact SDK startup error occurs before an API request.
        // Wait briefly for initialization; never retry an upstream request or denial.
        const request=async()=>kind==='profile'
          ?module.f('/v2/users/userHandle/'+encodeURIComponent(value),{timeoutMs:12000})
          :module.f('/transfers/v2/send',{method:'POST',timeoutMs:15000,body:JSON.stringify({destinationUserId:value,tokenAddress:mint,amount})});
        const until=Date.now()+5000;
        let r;
        for(;;){
          try{r=await request();break;}
          catch(e){
            if(!(e instanceof Error)||!e.message.startsWith('No global PrivyClient instance found.')||Date.now()>=until)throw e;
            await new Promise(resolve=>setTimeout(resolve,250));
          }
        }
        const p=r.responseObject;
        if(kind==='profile'&&p?.private===true)return {status:404,failure:null};
        if(r.statusCode!==200) {
          const msg=typeof r.message==='string'?r.message:'';
          return {status:r.statusCode,failure:r.statusCode===400&&/does not have token account|exceeds the available balance|insufficient/i.test(msg)?'operator_setup':null};
        }
        let publicBalances:unknown,publicSpotlight:unknown,publicSnapshot:unknown;
        // Only enrich an explicitly public profile matching the requested handle.
        // Credentials and viewer-specific fields remain inside Fomo's browser.
        if(kind==='profile'&&p?.private===false&&typeof p.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(p.id)&&typeof p.userHandle==='string'&&p.userHandle.toLowerCase()===value){
          const pick=(v:unknown,keys:string[])=>{const r=v&&typeof v==='object'?v as Record<string,unknown>:{};return Object.fromEntries(keys.map(k=>[k,r[k]]));};
          const trade=(v:unknown)=>pick(v,['tokenAddress','networkId','humanTokenAmount','sumSwapOpen','sumTransferIn','avgEntryPrice','avgTransferInPrice','realizedPnlUsd']);
          // Public enrichment reads can fail transiently while identity succeeds.
          // Retry a failed read once; never replay a draft or an explicit denial.
          const publicRead=async(path:string)=>{
            for(let attempt=0;;attempt++){
              try{const response=await module.f(path,{timeoutMs:8000});if(attempt===0&&response.statusCode>=500){await new Promise(resolve=>setTimeout(resolve,250));continue;}return response;}
              catch(error){if(attempt!==0)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
            }
          };
          const results=await Promise.allSettled([
            publicRead('/v2/users/'+encodeURIComponent(p.id)+'/balances'),
            publicRead('/v2/users/'+encodeURIComponent(p.id)+'/spotlight'),
            publicRead('/v2/userTokens/aggregatedSnapshotById?userId='+encodeURIComponent(p.id)+'&snapshotId='+Math.floor((Date.now()-86400000)/3600000)*3600),
          ]);
          const balances=results[0].status==='fulfilled'&&results[0].value.statusCode===200?results[0].value.responseObject:null;
          if(Array.isArray(balances?.balances)&&balances.balances.length<=5000)publicBalances={otherEquity:balances.otherEquity,otherPnlV2:balances.otherPnlV2,livePerpPnl:balances.livePerpPnl,balances:balances.balances.map((row:Record<string,unknown>)=>{
            const r=row as any,t=r.tokenFilterResult?.token;
            return {balance:pick(r.balance,['tokenAddress','shiftedBalance']),valuation:pick(r.valuation,['useLivePrice','includeInEquity','includeUnrealizedPnl','includeRealizedPnl']),tokenFilterResult:{priceUSD:r.tokenFilterResult?.priceUSD,token:{...pick(t,['address','networkId','name','symbol']),info:pick(t?.info,['imageSmallUrl','imageLargeUrl','name','symbol'])}},userToken:pick(r.userToken,['humanAmountRemaining','averageEntryPriceUsd','currentRealizedPnlUsd','currentCostBasisUsd']),...(r.activeTrade?{activeTrade:trade(r.activeTrade)}:{})};
          })};
          if(publicBalances&&JSON.stringify(publicBalances).length>900000)publicBalances=undefined;
          const snapshot=results[2].status==='fulfilled'&&results[2].value.statusCode===200?results[2].value.responseObject:null;
          if(snapshot)publicSnapshot=pick(snapshot,['snapshotId','pnl']);
          const spotlight=results[1].status==='fulfilled'&&results[1].value.statusCode===200?results[1].value.responseObject:null;
          if(Array.isArray(spotlight?.bestTrades)&&spotlight.bestTrades.length<=20)publicSpotlight={bestTrades:spotlight.bestTrades.slice(0,5).map((row:any)=>({userId:row.userId,trade:{...trade(row.trade),tokenMetadata:pick(row.trade?.tokenMetadata,['networkId','name','symbol','imageLargeUrl','currentPrice'])}}))};
        }
        return kind==='profile'?{status:200,profile:p&&{id:p.id,userHandle:p.userHandle,private:p.private,address:p.address,evmAddress:p.evmAddress,displayName:p.displayName,profilePictureLink:p.profilePictureLink,followers:p.followers,numTrades:p.numTrades,description:p.description,following:p.following,createdAt:p.createdAt,averageHoldTimeSeconds:p.averageHoldTimeSeconds,publicBalances,publicSpotlight,publicSnapshot}}:
          {status:200,draft:p&&{transaction:typeof p.transferTransaction?.transferTransaction==='string'&&p.transferTransaction.transferTransaction.length<=1644?p.transferTransaction.transferTransaction:null,feeUsd:p.transferFeeUsd,feeToken:p.transferFeeTokenAddress}};
      } catch(e) {
        return {status:0,failure:e instanceof Error&&!e.message.startsWith('No global PrivyClient instance found.')&&/PrivyClient|access token/i.test(e.message)?'login_required':'retry'};
      }

}

export function fomoBrowserTransport(send:(kind:FomoRequest['kind'],value:string)=>ReturnType<typeof fomoPageRequest>):ResolverBrowser {
  async function request(kind:FomoRequest['kind'],value:string) {
    const response=await send(kind,value);
    if(response.status!==200) {
      if(response.failure==='operator_setup')throw new ResolverFailure('operator_setup');
      if([401,403].includes(response.status)||response.failure==='login_required')throw new ResolverFailure('login_required');
      if(response.status===429)throw new ResolverFailure('rate_limited');
      if(response.status===404&&kind==='profile')throw new ResolverFailure('missing');
      if(response.failure==='upstream_changed'||response.status===400)throw new ResolverFailure('upstream_changed');
      throw new ResolverFailure('retry');
    }
    return response;
  }
  return {
    async profile(handle){if(fomoHandle(handle)!==handle)throw new ResolverFailure('missing');return parseDirectProfile((await request('profile',handle)).profile,handle);},
    async draft(id){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new ResolverFailure('upstream_changed');return (await request('draft',id)).draft;},
  };
}

// Serialized separately by Playwright, so it has no module-scope dependencies.
export function fomoPageAssetReady() {
  return [...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'),l=>l.href),
    ...performance.getEntriesByType('resource').map(entry=>entry.name)].some(href=>{
      try {const u=new URL(href);return u.origin===location.origin&&/^\/assets\/fomoFetch-v[0-9]+-[A-Za-z0-9_-]+\.js$/.test(u.pathname)&&!u.search&&!u.hash;}catch{return false;}
    });
}

// Uses a dedicated signed-in Playwright page; never reads cookies or tokens.
export function fomoBrowser(page:Page,currency:ResolverCurrency='usdc'):ResolverBrowser {
  return fomoBrowserTransport(async(kind,value)=>{
    if(new URL(page.url()).origin!=='https://fomo.family')throw new ResolverFailure('login_required');
    let timer:ReturnType<typeof setTimeout>|undefined;let stage:'module'|'request'='request';const started=Date.now();
    const operation=(async()=>{
      // Startup navigates once. The signed-in application owns its auth client;
      // profile API reads do not require loading a different profile route.
      // Keeping that context avoids tearing down Privy between profile and draft.
      if(kind==='profile'){
        stage='module';await page.waitForFunction(fomoPageAssetReady,undefined,{timeout:20000});
      }
      stage='request';
      const result=await page.evaluate(fomoPageRequest,draftRequest(kind,value,currency));
      // A client exception/timeout can leave an apparently open but unusable tab.
      // Retire it once. Never repeat a draft or retry an explicit auth denial here.
      if(result.status===0&&result.failure==='retry')throw new ResolverFailure('retry');
      return result;
    })();
    return Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void page.close().catch(()=>{});reject(new ResolverFailure('retry'));},30000);})]).catch(async error=>{
      // Navigation can time out before the overall deadline. Retrying against
      // that same half-loaded page kept the worker "ready" while every queued
      // lookup failed. Closing it makes the worker exit and lets the existing
      // supervisor reopen the persistent signed-in browser. Provider responses
      // (including login-required) are handled separately by the transport.
      if(!page.isClosed())await page.close().catch(()=>{});
      console.log(JSON.stringify({event:'resolver_browser_failure',kind,stage,elapsedMs:Date.now()-started,closed:page.isClosed(),reason:error instanceof ResolverFailure?error.reason:error instanceof Error&&error.name==='TimeoutError'?'timeout':'browser_error'}));
      throw error;
    }).finally(()=>clearTimeout(timer));
  });
}
