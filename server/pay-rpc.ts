import {ChainRpcError,rpcRequest,type Rpc} from './funding.js';

const reads=new Set(['getMultipleAccounts','getLatestBlockhash','getFeeForMessage','simulateTransaction','getBlockHeight']);
export function payRpc(
 request:Rpc=(method,params)=>rpcRequest(method,params,process.env.PAY_TRANSFER_RPC_URL||process.env.SOLANA_RPC_URL),
 wait:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
):Rpc{
 return async(method,params)=>{
  for(let attempt=0;;attempt++){
   try{return await request(method,params);}
   catch(error){
    // Load-balanced RPC nodes can lag the finalized slot another node just
    // returned. Preserve the exact request and minimum slot; never retry writes.
    if(!(error instanceof ChainRpcError)||error.code!==-32016||!reads.has(method)||attempt>=3)throw error;
    await wait(250*2**attempt);
   }
  }
 };
}
