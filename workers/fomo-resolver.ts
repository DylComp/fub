import {fomoLeaderLookup} from '../server/fomo-leader-lookup.js';
import type {ResolverBrowser} from '../server/fomo-resolver-worker.js';
import { chromium } from 'playwright';
import {resolverSessionCheck} from '../server/resolver-session-check.js';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { address, isOffCurveAddress } from '@solana/kit';
import { isMint } from '../src/assets.js';
import { fomoBrowser } from './fomo-browser.js';
import { fomoMainChrome } from './fomo-main-chrome.js';
import { fomoResolverStore } from '../server/fomo-resolver-store.js';
import { ResolverFailure, resolveFomoJob } from '../server/fomo-resolver-worker.js';
import { rpcRequest } from '../server/funding.js';
import { auditResolverDatabase } from '../server/fomo-resolver-database.js';
import { resolverHealth, resolverHealthServer } from '../server/fomo-resolver-health.js';
import { MAINNET_GENESIS } from '../server/solana-network.js';
const login=process.argv.includes('--login'), once=process.argv.includes('--once');
if(!login&&process.env.FOMO_RESOLVER_RUN!=='true')throw Error('Set FOMO_RESOLVER_RUN=true only after operator setup and draft validation.');
const operator=process.env.FOMO_RESOLVER_OPERATOR_WALLET||'';
if(!login&&(!process.env.DATABASE_URL||!process.env.SOLANA_RPC_URL||!isMint(operator)||isOffCurveAddress(address(operator))))throw Error('Resolver database, RPC and exact operator wallet are required.');
if(!login)await auditResolverDatabase(process.env.DATABASE_URL!);
const tabId=process.argv.find(v=>v.startsWith('--main-chrome-tab='))?.split('=')[1];
if(tabId&&login)throw Error('Main Chrome uses its existing login; omit --login.');
const currency=process.env.FOMO_RESOLVER_DRAFT_CURRENCY||'usdc';
if(!['sol','usdc'].includes(currency))throw Error('Use sol or usdc for resolver draft currency.');
const draftCurrency=currency as 'sol'|'usdc';
const directory=resolve(process.env.FOMO_RESOLVER_BROWSER_DIR||'.fomo-resolver-browser');
if(!directory.endsWith('/.fomo-resolver-browser'))throw Error('Use a dedicated .fomo-resolver-browser directory, never your personal browser profile.');
if(!tabId){await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);}
const context=tabId?null:await chromium.launchPersistentContext(directory,{headless:!login&&process.env.FOMO_RESOLVER_HEADED!=='true',chromiumSandbox:true, ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),acceptDownloads:false});
let page=context?(context.pages()[0]||await context.newPage()):null;
const health=resolverHealth();
let activeBrowser:ResolverBrowser|null=null;
const tradingStore=!login&&process.env.FOMO_LEADER_LOOKUP_SECRET?fomoResolverStore(process.env.DATABASE_URL!):null;
const leaderLookup=tradingStore?fomoLeaderLookup({secret:process.env.FOMO_LEADER_LOOKUP_SECRET!,ready:()=>!!activeBrowser&&health.snapshot().ready,read:async handle=>(await activeBrowser!.profile(handle)).tradingWallets||null,reserve:handle=>tradingStore.reserveTradingProfileRead(handle),save:profile=>tradingStore.recordTradingProfile(profile),recipient:profile=>tradingStore.tradingRecipient(profile)}):undefined;
const healthServer=process.env.FOMO_RESOLVER_HEALTH_PORT?resolverHealthServer(health,Number(process.env.FOMO_RESOLVER_HEALTH_PORT),'::',leaderLookup):null;
const stop=new AbortController();
let lastLease:string|null=null;
const store=login?null:fomoResolverStore(process.env.DATABASE_URL!);
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{stopping=true;health.update('stopped');stop.abort();void context?.close();});
let stage:'navigation'|'network'|'profile'|'queue'='navigation';
try {
  await page?.goto(login?'https://fomo.family/':'https://fomo.family/profile/orangie',{waitUntil:'domcontentloaded',timeout:30000});
  if(login&&context){health.update('paused');const loginPulse=setInterval(()=>health.update('paused'),10000);context.once('close',()=>clearInterval(loginPulse));console.log('Sign in to the dedicated Fomo operator browser. Close this window when finished. No wallet exports or transfers are requested.');await new Promise<void>(r=>context.once('close',()=>r()));}
  else {
    stage='network';
    if(await rpcRequest('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('A Solana mainnet RPC is required.');
    if(!store)throw Error('Resolver store unavailable.');
    let browser=tabId?fomoMainChrome(tabId,draftCurrency):fomoBrowser(page!,draftCurrency);
    // Startup checks a public profile. No draft call occurs before login works.
    stage='profile';
    for(let attempt=0;attempt<3;attempt++){
      health.update('starting');
      try{
        if(page?.isClosed()&&context){
          page=await context.newPage();
          await page.goto('https://fomo.family/profile/orangie',{waitUntil:'domcontentloaded',timeout:20000});
          browser=fomoBrowser(page,draftCurrency);
        }
        await browser.profile('orangie');break;
      }catch(error){
        const transient=error instanceof ResolverFailure?error.reason==='retry':error instanceof Error&&error.name==='TimeoutError';
        if(!transient||attempt===2||stopping)throw error;
        console.log(JSON.stringify({event:'resolver_startup_retry',attempt:attempt+1}));
        await delay(3000,undefined,{signal:stop.signal});
      }
    }
    activeBrowser=browser;
    const session=resolverSessionCheck(browser);session.verified();
    await store.resumeAuthenticatedSession();
    stage='queue';
    if(process.argv.includes('--resume'))await store.resume();
    const daily=Number(process.env.FOMO_RESOLVER_DAILY_CAP||100);
    do {
      // Check the actual browser before renewing queue readiness, even when idle.
      // A fresh database heartbeat alone does not prove Fomo is still signed in.
      stage='profile';await session.check();stage='queue';
      const lease=randomUUID();lastLease=lease;
      const job=await store.claim(lease,daily);
      let idleDelay=10000;
      if(!job){await store.release(lease);const h=await store.health();if(h?.ready!==true)idleDelay=30000;health.update(h?.ready===true?'ready':h?.pause_reason?'paused':'capacity');if(h?.pause_reason){console.log(JSON.stringify({state:'paused',reason:h.pause_reason}));process.exitCode=1;break;}}
      else {
        const startedAt=Date.now();
        const result=await resolveFomoJob(job,store,browser,operator,async(method,params)=>{
          try{return await rpcRequest(method,params);}catch{throw new ResolverFailure('rpc_unavailable');}
        },draftCurrency);
        console.log(JSON.stringify({handle:job.handle,...result,elapsedMs:Date.now()-startedAt}));
        if(result.state==='matched')session.verified();
        const h=await store.health();health.update(h?.ready===true?'ready':h?.pause_reason?'paused':'capacity');
        if(page?.isClosed()||(result.state==='paused'&&!['missing','retry'].includes(result.reason))){process.exitCode=1;break;}
      }
      // Drain admitted work immediately. Database leases and the rolling five
      // attempts/minute limit remain authoritative, including across restarts.
      if(!once&&!stopping&&!job)await delay(idleDelay,undefined,{signal:stop.signal});
    }while(!once&&!stopping);
  }
}catch(e){if(!stopping){health.update('failed');console.error(JSON.stringify({event:'resolver_stopped',stage,reason:e instanceof ResolverFailure?e.reason:e instanceof Error&&e.name==='TimeoutError'?'timeout':'startup_failed'}));process.exitCode=1;}}
finally{activeBrowser=null;health.update('stopped');if(store&&lastLease)await store.offline(lastLease).catch(()=>{});healthServer?.close();await context?.close();}
