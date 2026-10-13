import {useEffect,useRef,useState} from 'react';
import {useSignTransaction,useUser} from '@privy-io/react-auth';
import {createPublicClient,formatUnits,http,keccak256} from 'viem';
import {cashWalletChains} from './cash-wallet-chains';
import {CASH_NETWORKS} from './cash-route';
import {managedCashIdentity} from './managed-cash-wallet';
import {cashSaleWalletRequest,inspectCashWalletSale} from './cash-sale-signing';
import {cashCopyClient} from './cash-copy-client';
import type {CashCopyTrade} from './cash-copy-history';
import type {CashSale} from '../server/cash-return-store';
export function CashCopyRecovery(p:{trade:CashCopyTrade;serviceOrigin:string;wallet:string;planId:string;getToken:()=>Promise<string|null>;current:()=>boolean;refresh:()=>void}){
 const {user}=useUser(),{signTransaction}=useSignTransaction(),lock=useRef(false),[sale,setSale]=useState<CashSale|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const latest=useRef(p);latest.current=p;
 const current=()=>alive.current&&latest.current.wallet===p.wallet&&latest.current.planId===p.planId&&latest.current.trade.id===p.trade.id&&latest.current.current();
 async function run(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('Checking the saved sale…');
  try{
   const account=managedCashIdentity(user?.linkedAccounts||[]);if(!account)throw Error('Connect your existing cross-chain wallet.');
   const client=cashCopyClient(p.serviceOrigin,p.getToken,current),fields={wallet:p.wallet,planId:p.planId,id:p.trade.id};
   const prior=sale,s=await client('owner-sale-review',fields,new AbortController().signal) as CashSale;setSale(s);
   const i=s.simulation.route.intent;
   if(s.id!==p.trade.id||s.wallet!==p.wallet||i.cashWallet!==p.wallet||i.wallet!==account.address||i.token!==p.trade.token||i.network!==p.trade.network||i.amountRaw!==p.trade.amountRaw||i.slippageBps>100||i.slippageBps<1||s.gas.transactions.length<1||s.gas.transactions.length>2)throw Error('The recovery differs from this copied position.');
   if(!s.signed&&(!prior||BigInt(s.simulation.route.minimumRaw)<BigInt(prior.simulation.route.minimumRaw))){setMessage('Review the minimum return, then confirm the sale.');return;}
   let bound=s;
   if(!s.signed){
    const signed:string[]=[],calls=[...(s.simulation.route.approval?[s.simulation.route.approval]:[]),s.simulation.route.sale];
    for(let n=0;n<s.gas.transactions.length;n++){
     if(!current())throw Error('Connected wallet changed.');const tx=s.gas.transactions[n],call=calls[n];
     if(!call||tx.chainId!==CASH_NETWORKS[i.network].chainId||tx.from!==account.address||tx.to!==call.to||tx.data!==call.data||tx.value!=='0')throw Error('Recovery transaction changed.');
     setMessage(n===0&&s.simulation.route.approval?'Confirm the exact token approval.':'Confirm the sale to USDC.');
     const result=await signTransaction(cashSaleWalletRequest(tx),{address:account.address});
     await inspectCashWalletSale(tx,result.signature);signed.push(result.signature);
    }
    bound=await client('owner-sale-submit',{...fields,signed},new AbortController().signal) as CashSale;setSale(bound);
   }
   if(!bound.signed||!bound.hashes)throw Error('The signed sale was not saved.');
   const chain=cashWalletChains.find(c=>c.id===CASH_NETWORKS[i.network].chainId);if(!chain)throw Error('Unsupported recovery network.');
   const rpc=createPublicClient({chain,transport:http(chain.rpcUrls.default.http[0],{retryCount:0,timeout:10000})});
   if(await rpc.getChainId()!==chain.id)throw Error('Recovery network changed.');
   setMessage('Submitting the saved sale…');
   for(let n=0;n<bound.signed.length;n++){
    if(!current())throw Error('Connected wallet changed.');const raw=bound.signed[n] as `0x${string}`,hash=keccak256(raw);
    await inspectCashWalletSale(bound.gas.transactions[n],raw);if(hash!==bound.hashes[n])throw Error('Saved sale signature changed.');
    const receipt=await rpc.getTransactionReceipt({hash}).catch(()=>null);
    if(receipt){if(receipt.status!=='success')throw Error('The saved sale needs review.');continue;}
    if(await rpc.sendRawTransaction({serializedTransaction:raw})!==hash)throw Error('Check the saved sale status before retrying.');
   }
   setMessage('Sale submitted. Your trade history will show the USDC return.');p.refresh();
  }catch(e){setError(e instanceof Error?e.message:'Check the saved sale before retrying.');setMessage('');}
  finally{lock.current=false;setBusy(false);}
 }
 return <div className="copy-help">
  {sale&&!sale.signed&&<p>Sell only this copied position. Minimum return: {formatUnits(BigInt(sale.simulation.route.minimumRaw),6)} USDC. Maximum gas: {formatUnits(BigInt(sale.gas.maxCostWei),18)} {cashWalletChains.find(c=>c.id===CASH_NETWORKS[p.trade.network].chainId)?.nativeCurrency.symbol}.</p>}
  <button className="word-link" disabled={busy} onClick={()=>void run()}>{busy?'Checking sale…':sale?.signed?'Resume saved sale':sale?'Confirm sale to USDC':'Recover this sale'}</button>
  {message&&<p role="status">{message}</p>}{error&&<p role="alert" className="error-message">{error}</p>}
 </div>;
}
