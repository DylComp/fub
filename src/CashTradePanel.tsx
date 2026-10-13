import {CASH_GAS_POLICY} from './cash-network-policy';
import {finishTask,useCompletedTask} from "./task-completion";
import {useEffect,useRef,useState} from 'react';
import {useSignTransaction,useUser,useWallets} from '@privy-io/react-auth';
import {verifyManagedCashAccount} from './cash-account-client';
import {formatUnits} from 'viem';
import {cashSaleWalletRequest,inspectCashWalletSale} from './cash-sale-signing';
import {cashSaleReviewDecision} from './cash-sale-review';
import {managedCashIdentity} from './managed-cash-wallet';
import {cashTradeRequest,type CashPilot} from './cash-trade-client';
import {cashAmountRaw,CASH_NETWORKS,type CashNetwork} from './cash-route';
import type {CashPurchase} from '../server/cash-purchase-store';
import type {CashSale} from '../server/cash-return-store';
import type {WalletConnection} from './useWallet';
import {Modal} from './ui';
const terminal=new Set(['complete','refunded','reverted','expired']);
export function CashTradePanel({connection,userId,network,token,amount,hidden,isCurrent,close,onSigningChange}:{connection:WalletConnection;userId:string;network:CashNetwork;token:string;amount:string;hidden:boolean;isCurrent:()=>boolean;close:()=>void;onSigningChange:(active:boolean)=>void}){
 const {user}=useUser(),{signTransaction}=useSignTransaction(),{wallets}=useWallets();
 const [pilot,setPilot]=useState<CashPilot|null>(null),[purchase,setPurchase]=useState<CashPurchase|null>(null),[sale,setSale]=useState<CashSale|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [reviewNotice,setReviewNotice]=useState('');
 const lock=useRef(false),active=useRef(true),latest=useRef({user,isCurrent,wallets});latest.current={user,isCurrent,wallets};
 const source=connection.session?.address||'';
 useCompletedTask(sale?.state==='complete'&&sale.receipt?sale.id:null,()=>{close();finishTask({message:`${formatUnits(BigInt(sale!.receipt!.receivedRaw),6)} USDC returned to your Solana wallet.`,destination:'#orders'});});
 useEffect(()=>{active.current=true;return()=>{active.current=false;onSigningChange(false);};},[onSigningChange]);
 const guard=()=>{if(!active.current||!latest.current.isCurrent()||latest.current.user?.id!==userId)throw Error('Your connected wallet changed. Reopen the trade.');};
 const request=async<T,>(body:object):Promise<T>=>{guard();const data=await cashTradeRequest<T>(body,source);guard();return data;};
 async function refresh(){
  const config=await request<CashPilot>({action:'capabilities',network});
  if(config.publicAccess){
   // Once selected, always recover this exact trade rather than switching to a
   // different purchase when a timer observes completion.
   if(pilot?.publicAccess&&pilot.purchaseId&&pilot.saleId){
    const [p,s]=await Promise.all([request<CashPurchase|null>({action:'purchase-status',id:pilot.purchaseId}),request<CashSale|null>({action:'sale-status',id:pilot.saleId})]);
    setPilot({...config,purchaseId:pilot.purchaseId,saleId:pilot.saleId});setPurchase(p);setSale(s);return;
   }
   const state=await request<{purchaseId:string;saleId:string;purchase:CashPurchase|null;sale:CashSale|null}>({action:'public-state',network,token});
   setPilot({...config,purchaseId:state.purchaseId,saleId:state.saleId});setPurchase(state.purchase);setSale(state.sale);return;
  }
  setPilot(config);
  if(!config.pilotWallet||!config.purchaseId||!config.saleId)return;
  const [p,s]=await Promise.all([request<CashPurchase|null>({action:'purchase-status',id:config.purchaseId}),request<CashSale|null>({action:'sale-status',id:config.saleId})]);
  setPurchase(p);setSale(s);
 }
 async function work(action:()=>Promise<void>,clearError=true){if(lock.current)return;lock.current=true;setBusy(true);if(clearError)setError('');try{await action();}catch(e){if(active.current)setError(e instanceof Error?e.message:'Trade unavailable. Check the existing attempt.');}finally{lock.current=false;if(active.current){setBusy(false);setMessage('');}onSigningChange(false);}}
 useEffect(()=>{void work(refresh);},[source,userId,network]);
 useEffect(()=>{
  if(!pilot?.purchaseId||(!purchase&&!sale)||terminal.has(sale?.state||'')||purchase?.state==='prepared'&&!sale)return;
  const timer=setInterval(()=>{if(!lock.current&&document.visibilityState==='visible')void work(refresh,false);},6000);return()=>clearInterval(timer);
 },[pilot?.purchaseId,purchase?.state,sale?.state]);
 function identity(){guard();const account=managedCashIdentity(latest.current.user?.linkedAccounts||[]);if(!account)throw Error('Verify your cross-chain wallet first.');return account;}
 async function verifyOwnership(account:ReturnType<typeof identity>){
  setMessage('Checking wallet ownership…');
  const sign=async<T,>(action:()=>Promise<T>):Promise<T>=>{
   guard();onSigningChange(true);try{return await action();}finally{onSigningChange(false);}
  };
  // Check the durable proof at the moment of review, including when this
  // dialog has stayed open past expiry. Renew before a short-lived quote.
  await verifyManagedCashAccount({sourceWallet:source,recipient:account.address,network,minValidityMs:300000,
   current:()=>active.current&&latest.current.isCurrent()&&latest.current.user?.id===userId,
   progress:setMessage,connection:{
    signWalletSession:c=>sign(()=>connection.signWalletSession(c)),
    signCashWallet:c=>sign(()=>connection.signCashWallet(c)),
   },signEvm:async encoded=>{
    guard();const signer=latest.current.wallets.find(w=>['privy','privy-v2'].includes(w.walletClientType)&&!w.imported&&w.address.toLowerCase()===account.address);
    if(!signer)throw Error('Your cross-chain wallet signer is loading. Retry in a moment.');
    const provider=await signer.getEthereumProvider();guard();
    const result=await sign(()=>provider.request({method:'personal_sign',params:[encoded,account.address]}));guard();
    if(typeof result!=='string')throw Error('Wallet ownership was not confirmed.');return result;
   },
  });guard();
 }
 const tradeAmount=purchase?formatUnits(BigInt(purchase.review.intent.amountRaw),6):amount;
 function tradeAction(action:string,fields:Record<string,unknown>){return pilot?.publicAccess?{action:'public-'+action,network,...fields,...(action.startsWith('sale-')?{purchaseId:pilot.purchaseId}:{})}:{action,...fields};}
 async function buy(confirm=false){
  const account=identity();if(pilot?.network!==network||!pilot?.executionEnabled||(!pilot.publicAccess&&(!pilot.pilotWallet||pilot.token?.toLowerCase()!==token.toLowerCase()))||!pilot.purchaseId||BigInt(cashAmountRaw(tradeAmount))>BigInt(pilot.buyCapRaw||'0'))throw Error('This token, network or amount is unavailable for this wallet.');
  await verifyOwnership(account);
  setMessage('Checking funds and simulating the purchase…');
  const p=await request<CashPurchase>(tradeAction('purchase-prepare',{id:pilot.purchaseId,token,amount:tradeAmount}));setPurchase(p);
  if(p.state!=='prepared'||!confirm)return;
  if(p.review.quote.expiresAt<=Date.now())throw Error('This unsigned review is expiring. Check trade status, then refresh the purchase. Nothing was submitted.');
  // The signing helper independently rebuilds the pinned Solana deposit.
  const intent={sourceWallet:source,recipient:account.address,network,token:token.toLowerCase(),amountRaw:cashAmountRaw(tradeAmount),slippageBps:100,gasTopupUsdcRaw:pilot.gasTopupUsdcRaw||(network==='base'?'100000':undefined)};
  setMessage('Confirm the USDC purchase in your Solana wallet.');onSigningChange(true);
  let signed:string;try{signed=await connection.signCashDeposit(p.review,intent);}finally{onSigningChange(false);}guard();
  setMessage('Submitting your signed purchase…');setPurchase(await request<CashPurchase>(tradeAction('purchase-submit',{id:p.id,signed})));
 }
 async function sell(confirm=false){
  const account=identity();if(pilot?.network!==network||!pilot?.saleId||!pilot.purchaseId||!purchase?.receipt||purchase.state!=='complete')throw Error('Wait for confirmed token delivery.');
  await verifyOwnership(account);
  setMessage('Checking your token balance and return gas…');
  const reviewedSale=sale;
  const s=await request<CashSale>(tradeAction('sale-prepare',{id:pilot.saleId,purchaseId:pilot.purchaseId}));setSale(s);if(s.state!=='prepared'||!confirm)return;
  if(cashSaleReviewDecision(reviewedSale,s)==='review-minimum'){
   setReviewNotice(`The minimum return changed to ${formatUnits(BigInt(s.simulation.route.minimumRaw),6)} USDC. Confirm if you accept this amount.`);return;
  }
  setReviewNotice('');
  const route=s.simulation.route;
  if(s.wallet!==source||route.intent.network!==network||purchase.review.intent.network!==network||route.intent.cashWallet!==source||route.intent.wallet!==account.address||route.intent.token!==purchase.review.intent.token||route.intent.amountRaw!==purchase.receipt.receivedRaw||route.intent.slippageBps!==100||BigInt(s.gas.maxCostWei)>BigInt(pilot.maxGasRaw||(network==='base'?'100000000000000':'0'))||s.gas.expiresAt<=Date.now()||s.gas.transactions.length<1||s.gas.transactions.length>2)throw Error('The sale review differs from your purchased position.');
  const calls=[...(route.approval?[route.approval]:[]),route.sale];
  const signed:string[]=[];
  for(let i=0;i<s.gas.transactions.length;i++){
   const tx=s.gas.transactions[i],call=calls[i];
   if(!call||tx.chainId!==CASH_NETWORKS[network].chainId||tx.from!==account.address||tx.to!==call.to||tx.data!==call.data||tx.value!=='0')throw Error('The sale transaction changed.');
   setMessage(i===0&&route.approval?'Approve only the purchased token amount.':'Confirm the sale back to Solana USDC.');onSigningChange(true);
   let raw:`0x${string}`;
   try{raw=(await signTransaction(cashSaleWalletRequest(tx),{address:account.address})).signature;}finally{onSigningChange(false);}guard();
   await inspectCashWalletSale(tx,raw);
   signed.push(raw);
  }
  setMessage('Submitting the signed sale…');setSale(await request<CashSale>(tradeAction('sale-submit',{id:s.id,signed})));
 }
 if(hidden)return null;
 const allowed=pilot?.network===network&&!!pilot?.executionEnabled&&(pilot.publicAccess||!!pilot.pilotWallet&&pilot.token?.toLowerCase()===token.toLowerCase());
 return <Modal title="Trade with USDC." close={()=>{if(!busy)close();}}>
  <p className="copy-help">Buy on {CASH_NETWORKS[network].name} using your Solana USDC. Sell the received tokens back to the same Solana wallet.</p>
  <p className="network-token-address">{token}</p>
  {!purchase&&<><p>{amount} USDC total. Includes {formatUnits(BigInt(pilot?.gasTopupUsdcRaw||(network==='base'?'100000':'0')),6)} USDC for {CASH_NETWORKS[network].name} gas. Maximum slippage: 1%.</p><p className="copy-help">Solana fees and account rent are separate, capped at 0.00251 SOL. Review the wallet prompt before signing.</p></>}
  {purchase&&<p className="copy-help">{tradeAmount} USDC purchase. This is the saved trade for this token.</p>}
  {purchase&&<p role="status">Purchase: {purchase.state.replaceAll('-',' ')}</p>}
  {purchase?.state==='settling'&&<p className="copy-help">Your USDC payment is confirmed. Waiting for token delivery and final network confirmation. Status updates automatically.</p>}
  {purchase?.state==='delayed'&&<p className="copy-help">Your payment is confirmed, but delivery is delayed. We are checking the existing transfer. No new purchase is needed.</p>}
  {purchase?.state==='expired'&&<p className="copy-help">Finalized history shows no payment. Refresh this purchase for a new wallet confirmation.</p>}
  {purchase?.state==='prepared'&&<p>Minimum received: {formatUnits(BigInt(purchase.review.quote.minimumRaw),purchase.review.quote.outputDecimals)} tokens. Max fee and rent: {formatUnits(BigInt(purchase.review.maxFeeLamports)+BigInt(purchase.review.maxRentLamports),9)} SOL.</p>}
  {purchase?.receipt&&<p className="copy-help">{formatUnits(BigInt(purchase.receipt.receivedRaw),purchase.review.quote.outputDecimals)} tokens received.</p>}
  {sale&&<p role="status">Sale: {sale.state.replaceAll('-',' ')}</p>}
  {sale?.state==='prepared'&&<p>Minimum returned: {formatUnits(BigInt(sale.simulation.route.minimumRaw),6)} USDC on Solana. Gas budget: {formatUnits(BigInt(sale.gas.maxCostWei),18)} {CASH_GAS_POLICY[network].native}.</p>}
  {sale?.state==='prepared'&&reviewNotice&&<p className="copy-help" role="status">{reviewNotice}</p>}
  {sale?.state==='refunded'&&<p className="copy-help">The refund remains in the settlement token on {CASH_NETWORKS[network].name}. It has not returned to Solana.</p>}
  {sale?.state==='complete'&&sale.receipt&&<p>{formatUnits(BigInt(sale.receipt.receivedRaw),6)} USDC returned to your Solana wallet.</p>}
  {sale?.state==='needs-attention'&&<p className="copy-help">The existing sale needs recovery. Do not create a replacement or change its wallet nonce.</p>}
  {(!purchase||purchase.state==='prepared'||purchase.state==='expired')&&<button className="button primary full" disabled={busy||!allowed} onClick={()=>void work(()=>buy(purchase?.state==='prepared'))}>{busy?'Checking…':purchase?.state==='prepared'?'Confirm USDC purchase':purchase?.state==='expired'?'Refresh USDC purchase':'Review USDC purchase'}</button>}
  {purchase?.state==='complete'&&(!sale||sale.state==='prepared')&&<button className="button primary full" disabled={busy||!allowed} onClick={()=>void work(()=>sell(sale?.state==='prepared'))}>{sale?.state==='prepared'?'Confirm sale to USDC':'Review sale to USDC'}</button>}
  {purchase?.signed&&purchase.state==='submitted'&&<button className="word-link" disabled={busy||!allowed} onClick={()=>void work(async()=>{setPurchase(await request<CashPurchase>(tradeAction('purchase-resume',{id:purchase.id})));})}>Resume signed purchase</button>}
  {sale?.signed&&!terminal.has(sale.state)&&<button className="word-link" disabled={busy||!allowed} onClick={()=>void work(async()=>{setSale(await request<CashSale>(tradeAction('sale-resume',{id:sale.id})));})}>Resume signed sale</button>}
  <button className="word-link" disabled={busy} onClick={()=>void work(refresh)}>Check trade status</button>
  {!allowed&&pilot&&<p className="copy-help">Trading is unavailable for this token and network. Existing transfers can still be checked.</p>}
  {message&&<p role="status">{message}</p>}{error&&<p className="error-message" role="alert">{error}</p>}
 </Modal>;
}
