import type {Rpc} from './funding.js';
export async function readOrderSol(wallet:string,slot:number,rpc:Rpc){
 const v=await rpc('getBalance',[wallet,{commitment:'finalized',minContextSlot:slot}]) as {context?:{slot?:number};value?:number};
 if(!Number.isSafeInteger(v?.context?.slot)||v.context!.slot!<slot||!Number.isSafeInteger(v.value)||v.value!<0)throw Error('SOL funding could not be verified.');
 return {raw:String(v.value),slot:v.context!.slot!};
}
