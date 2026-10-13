export async function walletSessionRequest<T>(action:'status'|'challenge'|'verify'|'logout',body?:object,signal?:AbortSignal):Promise<T>{
 const response=await fetch('/api/wallet-session?action='+action,{method:action==='status'?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:action==='status'?{}:{'Content-Type':'application/json','X-Fomo-Request':'1'},...(action==='status'?{}:{body:JSON.stringify(body)})});
 const result=await response.json();if(!response.ok)throw Error(typeof result.message==='string'?result.message:'Wallet sign-in failed.');return result;
}
