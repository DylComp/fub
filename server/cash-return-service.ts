import {CASH_NETWORKS,type CashNetwork} from '../src/cash-route.js';
import {cashRelay} from './cash-relay.js';
import type {CashReturnIntent} from './cash-return-route.js';
import {prepareCashReturnQuote} from './cash-return-quote.js';
import {simulateCashReturn} from './cash-return-simulation.js';
import {prepareCashReturnGas,finalizedCashEvm} from './cash-return-transaction.js';
import {inspectCashSaleReceipt,cashSaleReceiptMinimum} from './cash-return-receipt.js';
import {readCashSolanaCredit,readCashDelivery} from './cash-receipt.js';
import {saleHashes,type CashReturnStore,type CashSale} from './cash-return-store.js';
import type {CashWalletBinding} from './cash-wallet-binding.js';
import type {CashRouteQuote} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const terminal=(p:CashSale)=>['complete','refunded','reverted','expired'].includes(p.state);
const hash=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const signature=(v:unknown)=>typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(v);
export function cashReturnService(config:{store:CashReturnStore;evm:Rpc;evmFor?:(network:CashNetwork)=>Rpc;solana:Rpc;
 binding:(wallet:string,network:CashNetwork)=>Promise<CashWalletBinding|null>;enabled:()=>boolean;
 // Fixed-origin, separately enabled RPC. This callback only receives already
 // inspected, durably saved bytes. It never constructs or signs transactions.
 broadcast:(signed:string,network:CashNetwork)=>Promise<unknown>;
 fetcher?:typeof fetch;now?:()=>number;
},dependencies={simulate:simulateCashReturn,gas:prepareCashReturnGas,finalized:finalizedCashEvm,source:inspectCashSaleReceipt,minimum:cashSaleReceiptMinimum,credit:readCashSolanaCredit,refund:readCashDelivery}){
 const {store}=config,now=config.now||Date.now,relay=cashRelay(config.fetcher);
 const rpcFor=(network:CashNetwork)=>{if(config.evmFor)return config.evmFor(network);if(network!=='base')throw Error('Cash execution RPC is not configured for this network.');return config.evm;};
 async function ownership(i:CashReturnIntent){const b=await config.binding(i.cashWallet,i.network);
  if(!b||b.network!==i.network||b.accountType!=='eoa'||b.sourceWallet!==i.cashWallet||b.recipient!==i.wallet.toLowerCase()||b.verifiedAt>now()||b.expiresAt<=now())throw Error('Verify the original funding wallet and its cross-chain account.');
 }
 async function recheck(p:CashSale){
  const evm=rpcFor(p.simulation.route.intent.network);
  const quote=(p.simulation as typeof p.simulation&{rawQuote:unknown}).rawQuote;
  // Revalidate the SAME order and transaction bytes. A stale readiness check
  // must not replace an EVM sale that may already have been signed locally.
  const simulation=await dependencies.simulate(quote,p.simulation.route.intent,evm,now(),p.gas.transactions.map(tx=>tx.gas));
  if(simulation.route.orderId!==p.simulation.route.orderId||simulation.route.sale.data!==p.simulation.route.sale.data||simulation.route.approval?.data!==p.simulation.route.approval?.data)throw Error('The cash sale changed.');
  const fresh=await dependencies.gas(simulation,evm,p.gas.maxCostWei,now());
  const used=[...(simulation.route.approval?[simulation.approvalGasUsed]:[]),simulation.saleGasUsed];
  if(fresh.transactions.length!==p.gas.transactions.length||fresh.transactions.some((tx,i)=>tx.nonce!==p.gas.transactions[i].nonce||
    tx.from!==p.gas.transactions[i].from||tx.to!==p.gas.transactions[i].to||tx.data!==p.gas.transactions[i].data||
    BigInt(used[i])>BigInt(p.gas.transactions[i].gas)||
    (fresh.baseFeePerGas===undefined?BigInt(tx.maxFeePerGas):BigInt(fresh.baseFeePerGas)+BigInt(p.gas.transactions[i].maxPriorityFeePerGas))>BigInt(p.gas.transactions[i].maxFeePerGas)))throw Error('Sale gas or nonce changed. Review the existing attempt.');
  // Actual calls were simulated at the saved limits. Do not demand a second
  // 30% buffer on top of them when gas usage moves by a few units.
  const l1=BigInt(fresh.maxL1FeeWei)>BigInt(p.gas.maxL1FeeWei)?fresh.maxL1FeeWei:p.gas.maxL1FeeWei;
  const maximum=p.gas.transactions.reduce((n,tx)=>n+BigInt(tx.gas)*BigInt(tx.maxFeePerGas),BigInt(l1));
  if(maximum>BigInt(p.gas.maxCostWei)||maximum>BigInt(fresh.balanceWei))throw Error('Sale gas balance or budget changed.');
  return {...p,simulation:{...simulation,rawQuote:quote},gas:{...p.gas,checkedAt:fresh.checkedAt,expiresAt:fresh.expiresAt,balanceWei:fresh.balanceWei,maxL1FeeWei:l1}};
 }
 async function recover(p:CashSale):Promise<CashSale>{
  const network=p.simulation.route.intent.network,evm=rpcFor(network),chainId=CASH_NETWORKS[network].chainId;
  if(terminal(p)||!p.signed||!p.hashes)return p;
  const hashes=await saleHashes(p,p.signed);if(JSON.stringify(hashes)!==JSON.stringify(p.hashes))throw Error('Sale journal signatures changed.');
  const receipts=await Promise.all(p.signed.map((signed,i)=>dependencies.finalized(p.gas.transactions[i],signed,evm)));
  if(receipts.some(r=>r.state==='pending'))return p;
  const fee=receipts.reduce((sum,r)=>sum+BigInt(r.feeWei!),0n);
  // Approval-only success leaves an allowance to clean up. Preserve the nonce
  // reservation and report attention; do not quietly call that a finished sale.
  if(receipts.some(r=>r.state==='reverted'))return store.settle(p.id,p.wallet,receipts.every(r=>r.state==='reverted')?'reverted':'needs-attention',String(fee));
  const source=dependencies.source(p.simulation.route,receipts.at(-1)!.receipt,dependencies.minimum(p.simulation));
  if(fee>BigInt(p.gas.maxCostWei))return store.settle(p.id,p.wallet,'needs-attention',String(fee));
  const s=await relay.status(p.simulation.route.requestId) as any;
  const route=p.simulation.route;
  if(s.originChainId!==chainId||s.destinationChainId!==792703809||!Array.isArray(s.inTxHashes)||s.inTxHashes.length>4||!s.inTxHashes.every(hash)||!s.inTxHashes.includes(hashes.at(-1))||!Array.isArray(s.txHashes)||s.txHashes.length>4||!s.txHashes.every((v:unknown)=>hash(v)||signature(v)))return store.settle(p.id,p.wallet,'needs-attention',String(fee));
  if(s.status==='success'){
   for(const tx of s.txHashes){if(!signature(tx))continue;const receipt=await dependencies.credit(route.requestId,p.wallet,tx,config.solana);
    if(receipt&&receipt.requestId===route.requestId&&receipt.recipient===p.wallet&&receipt.currency==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'&&receipt.chainId===792703809&&receipt.transaction===tx&&receipt.finalized&&receipt.successful&&BigInt(receipt.receivedRaw)>=BigInt(route.minimumRaw))return store.settle(p.id,p.wallet,'complete',String(fee),receipt);
   }
  }
  if(s.status==='refund'){
   // A source-chain refund stays on that chain. It is not returned Solana cash.
   for(const tx of s.txHashes){if(!hash(tx))continue;
    const q={network,requestId:route.requestId,recipient:route.intent.wallet,token:route.refundCurrency,minimumRaw:'1'} as CashRouteQuote;
    const receipt=await dependencies.refund(q,tx,evm);
    if(receipt&&receipt.requestId===route.requestId&&receipt.chainId===chainId&&receipt.recipient.toLowerCase()===route.intent.wallet.toLowerCase()&&receipt.currency.toLowerCase()===route.refundCurrency.toLowerCase()&&receipt.finalized&&receipt.successful&&BigInt(receipt.receivedRaw)<=BigInt(source.depositedUsdcRaw))return store.settle(p.id,p.wallet,'refunded',String(fee),receipt);
   }
  }
  return store.settle(p.id,p.wallet,s.status==='delayed'?'delayed':['failure','refund'].includes(s.status)?'needs-attention':'settling',String(fee));
 }
 return {
  inspectPrepared:recheck,
  async prepare(id:string,intent:CashReturnIntent,maxGasWei:string){
   const evm=rpcFor(intent.network);
   if(!config.enabled())throw Error('Cash sales are not enabled.');if(!uuid(id))throw Error('Invalid cash sale ID.');await ownership(intent);
   const old=await store.get(id,intent.cashWallet);if(old){const i=old.simulation.route.intent;
    if(i.network!==intent.network||i.cashWallet!==intent.cashWallet||i.wallet!==intent.wallet.toLowerCase()||i.token!==intent.token.toLowerCase()||i.amountRaw!==intent.amountRaw||i.slippageBps!==intent.slippageBps||old.gas.maxCostWei!==maxGasWei)throw Error('This sale ID belongs to different limits.');
    if(old.state!=='prepared'||old.signed)return recover(old);
    try{return await recheck(old);}catch(error){
     if(!(error instanceof Error)||!['Cash sale simulation failed.','Cash return order expired.','Cash sale simulation exceeds the saved gas limit.'].includes(error.message))throw error;
     // Fresh calldata is allowed only for the same reserved nonce pair and
     // identical approval. Either old or new sale can execute, never both.
     // The UI must show the new review before requesting any signatures.
     const {quote,simulation}=await prepareCashReturnQuote(intent,relay.quote,evm,now(),dependencies.simulate);
     const gas=await dependencies.gas(simulation,evm,maxGasWei,now());
     const oldApproval=old.simulation.route.approval,newApproval=simulation.route.approval;
     if(!!oldApproval!==!!newApproval||oldApproval&&newApproval&&
       (oldApproval.to.toLowerCase()!==newApproval.to.toLowerCase()||oldApproval.data.toLowerCase()!==newApproval.data.toLowerCase())||
       gas.transactions.length!==old.gas.transactions.length||gas.transactions.some((tx,i)=>tx.nonce!==old.gas.transactions[i].nonce))throw Error('The previous sale may have started. Check its status before changing the quote.');
     return store.refresh(old,{...simulation,rawQuote:quote} as typeof simulation,gas);
    }
   }
   const {quote,simulation}=await prepareCashReturnQuote(intent,relay.quote,evm,now(),dependencies.simulate);
   const gas=await dependencies.gas(simulation,evm,maxGasWei,now());
   // Preserve the inspected quote for fresh pre-broadcast simulation. It is
   // not client-provided when submitting and its bytes are not signing input.
   return store.reserve(id,{...simulation,rawQuote:quote} as typeof simulation,gas);
  },
  async submit(id:string,wallet:string,signed:string[]){
   if(!uuid(id))throw Error('Invalid cash sale ID.');const p=await store.get(id,wallet);if(!p)throw Error('Cash sale not found.');
   const hashes=await saleHashes(p,signed);
   if(p.signed){if(JSON.stringify(p.signed)!==JSON.stringify(signed))throw Error('Different sale signatures are already recorded.');return recover(p);}
   if(!config.enabled())throw Error('Cash sales are not enabled.');await ownership(p.simulation.route.intent);
   await recheck(p);
   const bound=await store.bind(id,wallet,signed);
   // Nonces serialize approval before sale. Persist BOTH signatures before any
   // broadcast, so process death cannot lose the second transaction identity.
   for(let i=0;i<signed.length;i++){
    try{if(await config.broadcast(signed[i],p.simulation.route.intent.network)!==hashes[i])return store.settle(id,wallet,'needs-attention');}
    catch{return bound;}
   }
   return bound;
  },
  async status(id:string,wallet:string){if(!uuid(id))throw Error('Invalid cash sale ID.');const p=await store.get(id,wallet);return p?recover(p):null;},
  // Explicit resume sends the SAME saved bytes. Ethereum hashes/nonces prevent
  // duplicate execution. Never construct a replacement on a lost response.
  async resume(id:string,wallet:string){const p=await this.status(id,wallet);if(!p||terminal(p)||!p.signed)return p;
   if(!config.enabled())return p;await ownership(p.simulation.route.intent);
   for(let i=0;i<p.signed.length;i++){
    const r=await dependencies.finalized(p.gas.transactions[i],p.signed[i],rpcFor(p.simulation.route.intent.network));if(r.state==='reverted')return recover(p);
    if(r.state==='pending'){try{await config.broadcast(p.signed[i],p.simulation.route.intent.network);}catch{return p;}}
   }return recover(p);
  },
  async recoverBatch(){const results=[];for(const p of await store.pending(25)){try{results.push({id:p.id,state:(await recover(p)).state});}catch{results.push({id:p.id,state:'unavailable'});}}return results;}
 };
}
