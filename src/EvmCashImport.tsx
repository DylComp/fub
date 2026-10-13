import {useEffect,useRef,useState} from 'react';
import {useImportWallet,useWallets} from '@privy-io/react-auth';
import {Modal} from './ui';
import {isEvmAddress} from './networks';
export type CashEvmConnection={address:string;request:(input:{method:string;params?:unknown[]})=>Promise<unknown>};
export function EvmCashImport({address,userId,sourceWallet,close,readyWallet,isCurrent}:{address:string;userId:string;sourceWallet:string;close:()=>void;readyWallet:(wallet:CashEvmConnection)=>void;isCurrent:()=>boolean}){
 const {wallets,ready}=useWallets(),{importWallet}=useImportWallet();
 const input=useRef<HTMLInputElement>(null),generation=useRef(0);
 const [busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false),[message,setMessage]=useState('');
 const matched=wallets.find(w=>w.walletClientType==='privy'&&w.address.toLowerCase()===address.toLowerCase());
 useEffect(()=>{generation.current++;if(input.current)input.current.value='';setAccepted(false);setMessage('');return()=>{generation.current++;if(input.current)input.current.value='';};},[address,userId,sourceWallet]);
 async function connect(){
  if(!matched||busy)return;const id=generation.current;setBusy(true);
  try{const provider=await matched.getEthereumProvider();if(id!==generation.current||!isCurrent())return;readyWallet({address:matched.address.toLowerCase(),request:async args=>{
    if(!isCurrent())throw Error('Reconnect your EVM wallet.');
    if(args.method==='eth_requestAccounts'||args.method==='eth_accounts')return [matched.address.toLowerCase()];
    // This connection currently exposes ownership signing only. No transaction
    // or allowance can be requested until the trading integration is released.
    if(args.method!=='personal_sign'||typeof args.params?.[0]!=='string'||String(args.params?.[1]).toLowerCase()!==matched.address.toLowerCase())throw Error('Unsupported cash wallet request.');
    const signature=await provider.request({method:'personal_sign',params:[args.params[0],matched.address]});
    if(!isCurrent())throw Error('Reconnect your EVM wallet.');
    return signature;
   }});close();
  }catch{setMessage('The imported wallet did not connect. Try again.');}finally{setBusy(false);}
 }
 async function importExact(){
  if(!accepted||busy||!ready||!isEvmAddress(address))return;
  let secret=input.current?.value.trim()||'';if(input.current)input.current.value='';
  const id=generation.current;setBusy(true);setMessage('');let called=false;
  try{
   if(!/^(0x)?[a-f0-9]{64}$/i.test(secret))throw Error('Enter the EVM wallet key exported from Fomo.');
   const {privateKeyToAccount}=await import('viem/accounts');
   const normalized=(secret.startsWith('0x')?secret:'0x'+secret) as `0x${string}`;
   let derived:string;try{derived=privateKeyToAccount(normalized).address.toLowerCase();}catch{throw Error('The EVM key is invalid. Nothing was imported.');}
   if(derived!==address.toLowerCase())throw Error('This key does not control the receiving address shown in Fomo. A separate smart-account integration may be required. Nothing was imported.');
   if(id!==generation.current||!isCurrent())return;
   called=true;const result=await importWallet({privateKey:normalized});
   if(id!==generation.current||!isCurrent())return;
   if(result.address.toLowerCase()!==address.toLowerCase())throw Error();
   setMessage('The existing EVM wallet is imported. Connect it to verify ownership.');setAccepted(false);
  }catch(e){if(id===generation.current)setMessage(called?'Import was not confirmed. Check the wallet list before trying again.':e instanceof Error?e.message:'The key could not be checked.');}
  finally{secret='';if(id===generation.current)setBusy(false);}
 }
 return <Modal title="Connect your existing Fomo EVM wallet." close={()=>{if(!busy)close();}}>
  <p className="fomo-identity-address">{address}</p>
  {matched?<><p className="copy-help">This exact wallet is already available in your Fub account.</p><button className="button primary full" disabled={busy} onClick={()=>void connect()}>Connect this wallet</button></>:<>
   <p className="copy-help">Import the EVM key for this address from Fomo once. It is checked in your browser and passed directly to Privy. Fub’s server does not receive the key. Your purchases will still spend USDC.</p>
   <label className="field"><span>EVM private key</span><input ref={input} type="password" aria-label="Fomo EVM import key" autoComplete="off" spellCheck={false} maxLength={66} disabled={busy||!ready} /></label>
   <label className="copy-toggle"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} disabled={busy}/><span>I own this address and agree to import it into Privy for Fub.</span></label>
   <button className="button primary full" disabled={busy||!ready||!accepted} onClick={()=>void importExact()}>{busy?'Checking and importing…':'Import this exact wallet'}</button>
  </>}
  {message&&<p role="status" className="copy-help">{message}</p>}
  <p className="copy-help">This step does not move money or authorize automatic trading.</p>
 </Modal>;
}
