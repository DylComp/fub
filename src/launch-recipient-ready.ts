import { validFomoRecipient } from './fomo-recipient';

export async function confirmLaunchRecipientReady(handle:string, expected:string, signal:AbortSignal, options:{read?:()=>Promise<unknown>;wait?:(ms:number)=>Promise<void>}={}) {
 const read=options.read||asyncRead;
 async function asyncRead(){const r=await fetch(`/api/wallet?action=recipient&handle=${encodeURIComponent(handle)}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),cache:'no-store'});if(!r.ok)throw Error('Fomo lookup is unavailable. Your coin has not been changed.');return r.json();}
 async function pause(ms:number){signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',stop);resolve();},timer=setTimeout(done,ms),stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};signal.addEventListener('abort',stop,{once:true});});}
 for(let attempt=0;attempt<15;attempt++){
  signal.throwIfAborted();const profile=await read();signal.throwIfAborted();
  if(!validFomoRecipient(profile,handle))throw Error('The Fomo profile response could not be verified.');
  if(profile.state==='matched') {if(profile.address!==expected)throw Error('The recipient wallet changed. Find and confirm it again.');return;}
  if(profile.state!=='pending')throw Error('The recipient wallet could not be verified. Find and confirm it again.');
  if(attempt===14)throw Error('Fomo lookup is still refreshing. Resume this launch shortly.');
  await (options.wait||pause)(Math.min(10000,Math.max(5000,(profile.retryAfter||10)*1000)));
 }
}
