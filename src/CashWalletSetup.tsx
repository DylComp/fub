import {useEffect,useRef,useState} from 'react';
import {useWalletSetup} from './WalletSetup';
import {walletSessionRequest} from './wallet-session-client';
import {verifyWalletLogin} from './wallet-session-model';
import {cashWalletMessage,type CashWalletChallenge} from './cash-wallet-model';
import {CASH_NETWORKS,type CashNetwork} from './cash-route';
import {isEvmAddress} from './networks';
import type {WalletLogin} from './wallet-session-model';
import type {CashEvmConnection} from './EvmCashImport';
import type {WalletConnection} from './useWallet';
type EvmProvider={request:(input:{method:string;params?:unknown[]})=>Promise<unknown>};
type Session={address:string|null;csrf?:string};
export function CashWalletSetup({network}:{network:CashNetwork}){
 const {connection,openConnect,canImport,openCashWallet,cashEvm}=useWalletSetup();
 return <CashWalletForm network={network} connection={connection} openConnect={openConnect} importedWallet={cashEvm} openImport={canImport?openCashWallet:undefined} />;
}
export function CashWalletForm({network,connection,openConnect,importedWallet,openImport}:{importedWallet?:CashEvmConnection;openImport?:(address:string)=>void;network:CashNetwork;connection:Pick<WalletConnection,'session'|'signWalletSession'|'signCashWallet'>;openConnect:()=>void}){
 const wallet=connection.session?.address;
 const [recipient,setRecipient]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const current=useRef(wallet),generation=useRef(0);current.current=wallet;
 useEffect(()=>{generation.current++;setNotice('');setBusy(false);},[wallet,network]);
 useEffect(()=>()=>{generation.current++;},[]);
 async function connect(){
  if(!wallet){openConnect();return;}
  if(busy||!isEvmAddress(recipient))return;
  const provider=importedWallet?.address.toLowerCase()===recipient.toLowerCase()?importedWallet:(window as unknown as {ethereum?:EvmProvider}).ethereum;
  if(!provider?.request&&openImport){openImport(recipient.toLowerCase());return;}
  if(!provider?.request){setNotice('Open a wallet that exposes your existing Fomo EVM address. Your Solana connection alone cannot sign for it.');return;}
  const id=++generation.current,expected=recipient.toLowerCase();setBusy(true);setNotice('');
  const guard=()=>{if(current.current!==wallet||generation.current!==id)throw Error('Wallet verification changed.');};
  try{
   const accounts=await provider.request({method:'eth_requestAccounts'});guard();
   if(!Array.isArray(accounts)||!accounts.some(a=>typeof a==='string'&&a.toLowerCase()===expected))throw Error('Select the exact Fomo EVM address shown here in your wallet.');
   let session=await walletSessionRequest<Session>('status');guard();
   if(session.address!==wallet||!session.csrf){
    const reply=await walletSessionRequest<{challenge:WalletLogin;message:string}>('challenge',{wallet});guard();
    const challenge=verifyWalletLogin(reply,wallet,location.origin),signature=await connection.signWalletSession(challenge);guard();
    session=await walletSessionRequest<Session>('verify',{wallet,signature});guard();
   }
   if(session.address!==wallet||!session.csrf)throw Error('Solana ownership was not confirmed.');
   async function request(body:object){
    const response=await fetch('/api/wallet-session?action=cash-wallet',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Fomo-Request':'1','X-Fub-Csrf':session.csrf!},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const result=await response.json();guard();if(!response.ok)throw Error(result.message||'Wallet verification failed.');return result;
   }
   const reply=await request({action:'challenge',network,recipient:expected}),challenge=reply.challenge as CashWalletChallenge;
   if(challenge.origin!==location.origin||challenge.sourceWallet!==wallet||challenge.recipient!==expected||challenge.network!==network||challenge.expiresAt<=Date.now()||challenge.issuedAt>Date.now()||cashWalletMessage(challenge)!==reply.message)throw Error('The wallet verification request changed.');
   const message=cashWalletMessage(challenge),encoded='0x'+Array.from(new TextEncoder().encode(message),b=>b.toString(16).padStart(2,'0')).join('');
   const evm=await provider.request({method:'personal_sign',params:[encoded,expected]});guard();
   if(typeof evm!=='string')throw Error('The EVM wallet did not return a signature.');
   const solana=await connection.signCashWallet(challenge);guard();
   const result=await request({action:'verify',nonce:challenge.nonce,evm,solana});
   if(result.binding?.sourceWallet!==wallet||result.binding?.recipient!==expected||result.binding?.network!==network||result.binding?.tradingAuthorized!==false)throw Error('Wallet ownership was not confirmed.');
   setNotice('Both wallet addresses verified. Cross-chain trading permission is not active yet.');
  }catch(e){if(current.current===wallet&&generation.current===id)setNotice(e instanceof Error?e.message:'Wallet verification failed.');}
  finally{if(generation.current===id)setBusy(false);}
 }
 return <details className="cash-wallet-setup"><summary>Connect your {CASH_NETWORKS[network].name} wallet</summary>
  <p className="copy-help">Use the receiving address shown in Fomo for this network. Both wallets confirm ownership. This does not transfer funds or approve trading.</p>
  <label className="cash-quote-amount">Fomo EVM wallet<input aria-label="Fomo EVM wallet" placeholder="0x…" value={recipient} maxLength={42} disabled={busy} onChange={e=>{setRecipient(e.target.value);setNotice('');}} /></label>
  <button className="button secondary full" disabled={busy||!!wallet&&!isEvmAddress(recipient)} onClick={()=>void connect()}>{busy?'Confirm wallet ownership…':wallet?'Verify both wallets':'Connect Solana wallet'}</button>
  {openImport&&wallet&&isEvmAddress(recipient)&&importedWallet?.address.toLowerCase()!==recipient.toLowerCase()&&<button className="word-link" disabled={busy} onClick={()=>openImport(recipient.toLowerCase())}>Use my existing Fomo EVM wallet</button>}
  {notice&&<p role="status" className="copy-help">{notice}</p>}
 </details>;
}
