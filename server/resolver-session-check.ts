import type {ResolverBrowser} from './fomo-resolver-worker.js';
// Public profile reads only. This neither prepares a transfer nor refreshes a
// wallet mapping. Failed probes invalidate readiness and stop queue admission.
export function resolverSessionCheck(browser:ResolverBrowser,now=Date.now,intervalMs=120000){
 let checkedAt:number|null=null;
 return {
  verified(){checkedAt=now();},
  async check(){
   const current=now();
   if(checkedAt!==null&&current>=checkedAt&&current-checkedAt<intervalMs)return false;
   await browser.profile('orangie');
   checkedAt=now();
   return true;
  },
 };
}
