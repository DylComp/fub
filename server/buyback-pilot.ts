import {validateBuybackPolicy,type BuybackPolicy} from './buyback-model.js';
export type BuybackPilot={policy:BuybackPolicy;expiresAt:number;replacementOf?:string};
// Independent of the public official mint. A pilot may consume recorded treasury
// revenue once, but cannot declare its engineering target the platform coin.
export function buybackPilotPolicy(value:string|undefined,treasury:string,now=Date.now()):BuybackPilot|undefined{
 if(!value)return undefined;
 try{
  const p=JSON.parse(value);
  const keys=p&&Object.keys(p).filter(k=>k!=='replacementOf').sort().join();
  if(!p||!['dailyCap,expiresAt,maxInput,maxOverhead,mint,slippageBps,treasury','acceptanceRoute,dailyCap,expiresAt,maxInput,maxOverhead,mint,slippageBps,treasury'].includes(keys)||p.treasury!==treasury||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=0||p.expiresAt>now+86400000||('replacementOf' in p&&(p.acceptanceRoute!=='pump-amm'||typeof p.replacementOf!=='string'||!/^[a-f0-9]{64}$/.test(p.replacementOf))))throw Error();
  const {expiresAt,replacementOf,...limits}=p;const policy:BuybackPolicy={...limits,purpose:'engineering'};validateBuybackPolicy(policy);
  if(BigInt(policy.maxInput)>1000000n||BigInt(policy.maxOverhead)>(policy.acceptanceRoute==='pump-amm'?10000000n:3000000n)||policy.slippageBps>100||BigInt(policy.dailyCap)!==BigInt(policy.maxInput)+BigInt(policy.maxOverhead))throw Error();
  return {policy,expiresAt,...(replacementOf?{replacementOf}:{})};
 }catch{throw Error('Invalid one-attempt buyback pilot policy.');}
}
