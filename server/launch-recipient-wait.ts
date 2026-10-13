import type { FomoRecipient } from '../src/fomo-recipient.js';
import type { FomoLookup } from '../src/fomo-identity.js';

// A fresh wallet mapping can require an unsigned draft on the private resolver.
// Wait briefly for that same lookup; never use a stale address to route fees.
export async function waitForLaunchRecipient(handle:string, read:()=>Promise<FomoRecipient>, options:{sleep?:(ms:number)=>Promise<void>;now?:()=>number}={}):Promise<FomoLookup> {
 const now=options.now||Date.now, deadline=now()+12000;
 const sleep=options.sleep||((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
 for(let attempt=0;attempt<5;attempt++) {
  const match=await read();
  if(match.handle!==handle)throw Error('Recipient identity changed');
  if(match.state==='matched'&&match.address)return {handle:match.handle,address:match.address,source:match.source,fetchedAt:match.fetchedAt,observedAt:match.observedAt};
  if(match.state!=='pending'||attempt===4||now()+2000>=deadline)throw Error('Recipient wallet unresolved');
  await sleep(2000);
 }
 throw Error('Recipient wallet unresolved');
}
