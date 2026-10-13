import {privyAccessVerifier, privyDid, providerId} from './privy-owner.js';
import {isEvmAddress} from '../src/networks.js';

export type CreatedCashOwner = {userId:string; walletId:string; address:string; ownerId:string; tradingAuthorized:false};
// A linked profile is not proof of custody. Before granting an execution
// permission, verify the actual wallet owner quorum using private provider
// access. This reader never creates a wallet or installs a signer.
export function createdCashOwnerReader(config:{appId:string;appSecret:string;fetcher?:typeof fetch;verifyAccess?:(token:string)=>Promise<string>}) {
  if (!providerId(config.appId) || !config.appSecret || /[\s:]/.test(config.appSecret)) throw Error('Cash ownership verification is not configured.');
  const verifyAccess = config.verifyAccess || privyAccessVerifier(config.appId);
  const fetcher = config.fetcher || fetch;
  const authorization = 'Basic ' + Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64');
  async function read(path:string, signal:AbortSignal):Promise<Record<string,unknown>> {
    const response = await fetcher(`https://api.privy.io/v1/${path}`, {
      method:'GET', headers:{Authorization:authorization,'privy-app-id':config.appId}, redirect:'error', cache:'no-store', signal,
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 65536) {await response.body?.cancel(); throw Error();}
    const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw Error();chunks.push(part.value);}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    signal.throwIfAborted();
    const result=JSON.parse(Buffer.concat(chunks).toString());
    if (!result || typeof result!=='object' || Array.isArray(result)) throw Error();
    return result;
  }
  return async (token:string, walletId:string, address:string, external:AbortSignal):Promise<CreatedCashOwner> => {
    try {
      if (!providerId(walletId) || !isEvmAddress(address) || /^0x0{40}$/i.test(address)) throw Error();
      external.throwIfAborted();
      const userId=await verifyAccess(token);
      if (!privyDid(userId)) throw Error();
      const signal=AbortSignal.any([external,AbortSignal.timeout(8000)]);
      const wallet=await read(`wallets/${walletId}`,signal);
      if (wallet.id!==walletId || wallet.chain_type!=='ethereum' || typeof wallet.address!=='string' || wallet.address.toLowerCase()!==address.toLowerCase() ||
        wallet.archived_at!==null || wallet.imported_at!==null || !providerId(wallet.owner_id) ||
        !Array.isArray(wallet.additional_signers) || wallet.additional_signers.length!==0) throw Error();
      const owner=await read(`key_quorums/${wallet.owner_id}`,signal);
      if(owner.id!==wallet.owner_id || owner.authorization_threshold!==1 || !Array.isArray(owner.user_ids) || owner.user_ids.length!==1 || owner.user_ids[0]!==userId ||
        !Array.isArray(owner.authorization_keys) || owner.authorization_keys.length!==0 || !Array.isArray(owner.key_quorum_ids) || owner.key_quorum_ids.length!==0) throw Error();
      signal.throwIfAborted();
      return {userId,walletId,address:address.toLowerCase(),ownerId:wallet.owner_id,tradingAuthorized:false};
    } catch {throw Error('The user-owned cross-chain wallet could not be verified. No trading access was granted.');}
  };
}
