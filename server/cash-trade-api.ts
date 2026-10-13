import {handlePublicCash,cashPublicHistory,publicCashNetworks,CASH_PUBLIC_BUDGETS} from './cash-public.js';
import {cashGasBudget} from '../src/cash-network-policy.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readWalletSession} from './wallet-session.js';
import {cashWalletStore} from './cash-wallet-store.js';
import {cashPurchaseStore} from './cash-purchase-store.js';
import {cashReturnStore} from './cash-return-store.js';
import {cashPurchaseService} from './cash-purchase-service.js';
import {cashReturnService} from './cash-return-service.js';
import {cashEvmRpc} from './cash-evm-rpc.js';
import {rpcRequest} from './funding.js';
import {payRpc as retryLaggingSolanaRpc} from './pay-rpc.js';
import {cashAmountRaw,isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {isEvmAddress} from '../src/networks.js';
import {publicProviderJson} from './public-provider-json.js';
// Pilot exposure is separate from preparing the implementation. No default
// wallet or token, and no execution without a configured production API key.
export function cashPilotNetwork():CashNetwork {
 const network=process.env.CASH_PILOT_NETWORK||'base';
 if(!isCashNetwork(network))throw Error('Invalid cash execution network.');return network;
}
export function cashPilotBudgets(){
 const network=cashPilotNetwork();
 // Retain exactly the earlier Base limits. Other networks require explicit
 // test settings; adding a chain never silently authorizes a larger budget.
 const gasTopupUsdcRaw=process.env.CASH_PILOT_GAS_USDC_RAW||(network==='base'?'100000':'');
 const maxGasRaw=process.env.CASH_PILOT_SALE_GAS_RAW||(network==='base'?'100000000000000':'');
 if(!/^[1-9]\d{0,5}$/.test(gasTopupUsdcRaw)||BigInt(gasTopupUsdcRaw)>500000n)throw Error('Configure the bounded destination gas allocation.');
 cashGasBudget(network,maxGasRaw);return {gasTopupUsdcRaw,maxGasRaw};
}
export function cashTradeRuntime(selectedNetwork:CashNetwork=cashPilotNetwork()){
 const url=process.env.DATABASE_URL||'';
 if(process.env.CASH_DURABLE_STORAGE!=='true'||!url)throw Error('Cross-chain storage is not active.');
 const network=selectedNetwork,bindings=cashWalletStore(url),evm=cashEvmRpc(network),solana=retryLaggingSolanaRpc(rpcRequest);
 const enabled=(n:CashNetwork=network)=>process.env.CASH_EXECUTION_ENABLED==='true'&&!!process.env.RELAY_API_KEY&&!!process.env[`CASH_${n.toUpperCase()}_RPC_URL`];
 const purchases=cashPurchaseService({store:cashPurchaseStore(url),solana,evm:cashEvmRpc,binding:bindings.binding,enabled});
 const returns=cashReturnService({store:cashReturnStore(url),solana,evm,evmFor:cashEvmRpc,binding:bindings.binding,enabled,
  broadcast:async(signed,sourceNetwork)=>{
   if(!enabled()||sourceNetwork!==network)throw Error('Cash execution is not active.');
   const endpoint=process.env[`CASH_${sourceNetwork.toUpperCase()}_RPC_URL`]!;
   if(new URL(endpoint).protocol!=='https:')throw Error('Invalid cash execution RPC.');
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[signed]}),redirect:'error',signal:AbortSignal.timeout(10000)});
   const data=await publicProviderJson(response) as any;if(data.error)throw Error('Sale submission is unresolved.');return data.result;
  }});
 return {bindings,purchases,returns,enabled};
}
const cashErrors = new Set(['Sale exceeds its total gas budget.','Destination gas has not arrived or is insufficient. No sale was submitted.','Cash sale swap changed.','Cash sale source pool changed.','Cash sale source pool is not canonical.','Cash sale source pool could not be verified.','Cash sale source pool is unsupported.','Cash sale simulation failed.','Cash sale aggregator deployment changed.','Cash network verification is unavailable.','The execution RPC is not configured.','Chain verification unavailable.','Not enough Solana USDC for this purchase.','Cash deposit simulation failed.','Cash purchase exceeds its SOL fee limit.','Cash deposit simulation differs from the approved purchase.','Cash simulation transfer differs from the approved purchase.','Refresh the cash transaction before signing.','Confirm ownership of both trading wallets.','Cross-chain storage is not active.']);
export function cashTradeHandler(options:{runtime?:typeof cashTradeRuntime;session?:typeof readWalletSession;history?:ReturnType<typeof cashPublicHistory>}={}){
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.method!=='POST')return send(405,{message:'POST required.'});
  const user=(options.session||readWalletSession)(req);if(!user)return send(401,{message:'Connect and verify your Solana wallet.'});
  if(req.headers.origin!==user.origin||req.headers['x-fomo-request']!=='1'||req.headers['x-fub-csrf']!==user.csrf||req.headers['content-type']?.split(';')[0]!=='application/json'||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')return send(403,{message:'Open cross-chain trading on Fub.'});
  let action='unknown';
  try{
   if(new URL(req.url||'/','https://local.invalid').searchParams.toString()!=='action=cash-trade')return send(400,{message:'Invalid cash request.'});
   let b=(req as IncomingMessage&{body?:any}).body;
   if(b===undefined){let size=0;const chunks=[];for await(const part of req){const chunk=Buffer.from(part);size+=chunk.length;if(size>300000)throw Error();chunks.push(chunk);}b=Buffer.concat(chunks).toString();}
   if(typeof b==='string'){if(Buffer.byteLength(b)>300000)throw Error();b=JSON.parse(b);}
   if(!b||typeof b!=='object'||Array.isArray(b)||Buffer.byteLength(JSON.stringify(b))>300000)return send(400,{message:'Invalid cash request.'});
   if(typeof b.action==='string'&&/^[a-z-]{1,32}$/.test(b.action))action=b.action;
   const network:CashNetwork=isCashNetwork(b.network)?b.network:cashPilotNetwork(),keys=Object.keys(b).sort().join(','),runtime=(options.runtime||cashTradeRuntime)(network);
   if(b.action==='capabilities'&&keys==='action,network'&&isCashNetwork(b.network)){
    const publicAccess=publicCashNetworks().includes(network)&&runtime.enabled(network);
    if(publicAccess)return send(200,{network,executionEnabled:true,publicAccess:true,pilotWallet:false,automaticCopyingEnabled:false,buyCapRaw:'10000000000',...CASH_PUBLIC_BUDGETS[network]});
    // Older controlled-test UI stays compatible while public rollout is off.
    const pilot=network===cashPilotNetwork()&&process.env.CASH_PILOT_WALLET===user.wallet;
    return send(200,{network,publicAccess:false,publicRecovery:!pilot,executionEnabled:runtime.enabled(network),pilotWallet:pilot,automaticCopyingEnabled:false,...(pilot?{...cashPilotBudgets(),purchaseId:process.env.CASH_PILOT_PURCHASE_ID,saleId:process.env.CASH_PILOT_SALE_ID,token:process.env.CASH_PILOT_TOKEN,buyCapRaw:process.env.CASH_PILOT_BUY_USDC_RAW}:{})});
   }
   if(action.startsWith('public-')&&isCashNetwork(b.network)){const r=await handlePublicCash(b,user.wallet,network,runtime,options.history||cashPublicHistory(process.env.DATABASE_URL||''));return send(r.status,r.data);}
   if(Object.hasOwn(b,'network'))return send(400,{message:'Invalid cash action or fields.'});
   if(b.action==='capabilities'&&keys==='action')return send(200,{network,executionEnabled:runtime.enabled(),pilotWallet:process.env.CASH_PILOT_WALLET===user.wallet,automaticCopyingEnabled:false,...(process.env.CASH_PILOT_WALLET===user.wallet?{...cashPilotBudgets(),purchaseId:process.env.CASH_PILOT_PURCHASE_ID,saleId:process.env.CASH_PILOT_SALE_ID,token:process.env.CASH_PILOT_TOKEN,buyCapRaw:process.env.CASH_PILOT_BUY_USDC_RAW}:{})});
   // Status remains available after execution is stopped or ownership expires.
   if(['purchase-status','sale-status'].includes(b.action)&&keys==='action,id'&&typeof b.id==='string')return send(200,await(b.action==='purchase-status'?runtime.purchases.status(b.id,user.wallet):runtime.returns.status(b.id,user.wallet)));
   if(!runtime.enabled()||process.env.CASH_PILOT_WALLET!==user.wallet)return send(409,{message:'Cross-chain execution is awaiting its funded acceptance test.'});
   const binding=await runtime.bindings.binding(user.wallet,network);if(!binding||binding.accountType!=='eoa')return send(409,{message:'Verify your cross-chain wallet before trading.'});
   if(b.action==='purchase-prepare'&&keys==='action,amount,id,token'&&typeof b.id==='string'&&typeof b.amount==='string'&&typeof b.token==='string'&&isEvmAddress(b.token)){
    const amountRaw=cashAmountRaw(b.amount),cap=process.env.CASH_PILOT_BUY_USDC_RAW||'0';
    if(!/^[1-9]\d{0,8}$/.test(cap)||BigInt(amountRaw)>BigInt(cap)||b.token.toLowerCase()!==process.env.CASH_PILOT_TOKEN?.toLowerCase()||b.id!==process.env.CASH_PILOT_PURCHASE_ID)return send(403,{message:'This purchase is outside the approved pilot.'});
    return send(200,await runtime.purchases.prepare(b.id,{sourceWallet:user.wallet,recipient:binding.recipient,network,token:b.token.toLowerCase(),amountRaw,slippageBps:100,gasTopupUsdcRaw:cashPilotBudgets().gasTopupUsdcRaw}));
   }
   if(b.action==='purchase-submit'&&keys==='action,id,signed'&&typeof b.id==='string'&&typeof b.signed==='string'&&b.id===process.env.CASH_PILOT_PURCHASE_ID)return send(200,await runtime.purchases.submit(b.id,user.wallet,b.signed));
   if(b.action==='purchase-resume'&&keys==='action,id'&&b.id===process.env.CASH_PILOT_PURCHASE_ID)return send(200,await runtime.purchases.resume(b.id,user.wallet));
   if(b.action==='sale-prepare'&&keys==='action,id,purchaseId'&&b.id===process.env.CASH_PILOT_SALE_ID&&b.purchaseId===process.env.CASH_PILOT_PURCHASE_ID){
    const purchase=await runtime.purchases.status(b.purchaseId,user.wallet);
    if(!purchase||purchase.state!=='complete'||!purchase.receipt||purchase.review.intent.network!==network||purchase.review.intent.recipient!==binding.recipient)return send(409,{message:'Wait for the verified purchase delivery before selling.'});
    // Pilot can sell ONLY the amount credited by that exact test purchase.
    return send(200,await runtime.returns.prepare(b.id,{network,wallet:binding.recipient,cashWallet:user.wallet,token:purchase.review.intent.token,amountRaw:purchase.receipt.receivedRaw,slippageBps:100},cashPilotBudgets().maxGasRaw));
   }
   if(b.action==='sale-submit'&&keys==='action,id,signed'&&b.id===process.env.CASH_PILOT_SALE_ID&&Array.isArray(b.signed)&&b.signed.every((v:unknown)=>typeof v==='string'))return send(200,await runtime.returns.submit(b.id,user.wallet,b.signed));
   if(b.action==='sale-resume'&&keys==='action,id'&&b.id===process.env.CASH_PILOT_SALE_ID)return send(200,await runtime.returns.resume(b.id,user.wallet));
   return send(400,{message:'Invalid cash action or fields.'});
  }catch(e){const known=e instanceof Error&&cashErrors.has(e.message)?e.message:null;console.error(JSON.stringify({event:'cash_step_failed',action,reason:known||'unclassified',errorType:e instanceof Error?e.name:'unknown'}));return send(503,{message:known||'This cross-chain step could not be verified. Check the existing attempt before retrying.'});}
 };
}
export const handleCashTrade=cashTradeHandler();
