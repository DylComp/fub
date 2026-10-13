import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ResolverFailure } from '../server/fomo-resolver-worker.js';
import type { ResolverCurrency } from '../server/fomo-draft-decoder.js';
import { draftRequest, fomoBrowserTransport, fomoPageRequest } from './fomo-browser.js';
const exec = promisify(execFile);

// Local macOS adapter. Targets one explicitly selected tab and does not copy the
// Chrome profile, inspect storage, export authentication or close the user's tab.
export function fomoMainChrome(tabId:string,currency:ResolverCurrency='usdc') {
  if(process.platform!=='darwin'||!/^\d{1,16}$/.test(tabId))throw Error('An explicit main Chrome tab ID on macOS is required.');
  async function evaluate(script:string) {
    const source=`tell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nif (id of t as text) is ${JSON.stringify(tabId)} then return execute t javascript ${JSON.stringify(script)}\nend repeat\nend repeat\nend tell`;
    try {
      const {stdout}=await exec('/usr/bin/osascript',['-e',source],{timeout:5000,maxBuffer:1100000});
      return stdout.trim();
    }catch{throw new ResolverFailure('retry');}
  }
  return fomoBrowserTransport(async(kind,value)=>{
    const id='fomo-resolver-'+randomUUID(),args=draftRequest(kind,value,currency);
    const code=`try{const response=await (${fomoPageRequest.toString()})(${JSON.stringify(args)});const out=document.getElementById(${JSON.stringify(id)});if(out)out.textContent=JSON.stringify({done:true,response});}catch{const out=document.getElementById(${JSON.stringify(id)});if(out)out.textContent=JSON.stringify({done:true,response:{status:0,failure:'retry'}});}`;
    try {
      const started=await evaluate(`(()=>{if(location.origin!=='https://fomo.family')return 'wrong_origin';const out=document.createElement('script');out.type='application/json';out.id=${JSON.stringify(id)};out.textContent='{"done":false}';document.documentElement.append(out);const s=document.createElement('script');s.id=${JSON.stringify(id+'-script')};s.type='module';s.nonce=document.querySelector('script[nonce]')?.nonce||'';s.textContent=${JSON.stringify(code)};document.documentElement.append(s);return 'started';})()`);
      if(started!=='started')throw new ResolverFailure('login_required');
      const deadline=Date.now()+30000;
      while(Date.now()<deadline){
        await delay(250);
        const raw=await evaluate(`location.origin==='https://fomo.family'?(document.getElementById(${JSON.stringify(id)})?.textContent||''):''`);
        if(!raw||raw.length>1048576)throw new ResolverFailure('retry');
        const result=JSON.parse(raw);
        if(result.done===true)return result.response as Awaited<ReturnType<typeof fomoPageRequest>>;
      }
      throw new ResolverFailure('retry');
    } finally {
      await evaluate(`document.getElementById(${JSON.stringify(id)})?.remove();document.getElementById(${JSON.stringify(id+'-script')})?.remove();'cleaned'`).catch(()=>{});
    }
  });
}
