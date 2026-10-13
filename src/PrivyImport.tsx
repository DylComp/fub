import {CashLimitOrders} from './CashLimitOrders';
import {CashCopyPlans} from './CashCopyPlans';
import type {CashCopyPlan} from './cash-copy-client';
import {CashCopyActivation} from './CashCopyActivation';
import {managedCashIdentity} from './managed-cash-wallet';
import {CashTradePanel} from './CashTradePanel';
import "./wallet-polyfills";
import { useEffect, useRef, useState } from "react";
import { PrivyProvider, useLinkWithSiws, useLoginWithSiws, useModalStatus, usePrivy, useSigners } from "@privy-io/react-auth";
import {cashWalletChains} from './cash-wallet-chains';
import { useImportWallet, useStandardWallets, defaultSolanaRpcsPlugin } from "@privy-io/react-auth/solana";
import { getWallets } from "@wallet-standard/app";
import {isCopyWalletRoute} from "./wallet-route-policy";
import { Modal } from "./ui";
import { FomoLeaderPicker } from "./FomoLeaderPicker";
import type { WalletConnection } from "./useWallet";
import { isMint } from "./assets";
import { validateImportKey, signImportOwnership } from "./wallet-import";
import { SigningPermissions } from "./SigningPermissions";
import type { EnrollmentConfig } from "./enrollment-client";
import {EvmCashImport,type CashEvmConnection} from './EvmCashImport';
import {isEvmAddress} from './networks';
import {DirectExits} from './DirectExits';
import {ManagedCashWallet, type ManagedCashAccount} from './ManagedCashWallet';
import type {CashNetwork} from './cash-route';

const solanaRpcPlugin = defaultSolanaRpcsPlugin();
const TARGET = "fomo-orders.import-address.v1";
function previousTarget() {
  try { const value = localStorage.getItem(TARGET) || ""; return isMint(value) ? value : ""; } catch { return ""; }
}
type Props = { onSetupCopyWallet:()=>void; onSetupCopyDestination:()=>void; open: boolean; mode: "import" | "permissions" | "exits" | "cash" | "managed-cash" | "cash-trade" | "cash-limit" | "cash-copy" | "cash-plans"; cashCopyPlan?:CashCopyPlan;onOpenCashPlan?:(plan:CashCopyPlan)=>void;cashCopyLeader?:string; cashCopyHandle?:string; cashTrade?:{token:string;amount:string}; cashNetwork?:CashNetwork; onManagedCash?:(account:ManagedCashAccount)=>void; cashAddress?:string; onCashWallet?:(wallet:CashEvmConnection)=>void; close: () => void; connection: WalletConnection; appId: string; onModalChange: (open: boolean) => void; onConnected: () => void; onManageAccess:()=>void; initialExitMint?:string };
export default function PrivyImport({ appId, ...props }: Props) {
  return <PrivyProvider appId={appId} config={{
    loginMethods: ["wallet"],
    supportedChains: cashWalletChains,
    plugins: [solanaRpcPlugin],
    appearance: { theme: "dark", accentColor: "#5361ff", walletChainType: "solana-only" },
    embeddedWallets: { showWalletUIs: true, ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
  }}><ImportFlow appId={appId} {...props} /></PrivyProvider>;
}
function ImportFlow({ onSetupCopyWallet,onSetupCopyDestination,open, mode, close, connection, onModalChange, onConnected, onManageAccess, initialExitMint, cashAddress, onCashWallet, cashNetwork, onManagedCash, cashTrade, cashCopyLeader, cashCopyHandle, cashCopyPlan,onOpenCashPlan, appId }: Props) {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { addSigners, removeSigners } = useSigners();
  const { isOpen: providerModal } = useModalStatus();
  const [cashSigning,setCashSigning] = useState(false);
  const { wallets } = useStandardWallets();
  const { importWallet } = useImportWallet();
  const latestImport=useRef({importWallet,userId:user?.id});latestImport.current={importWallet,userId:user?.id};
  const awaitingImportAuth=useRef<{owner:string;resolve:()=>void;reject:()=>void}|undefined>(undefined);
  useEffect(()=>{const pending=awaitingImportAuth.current;if(pending&&authenticated&&user?.id===pending.owner){awaitingImportAuth.current=undefined;pending.resolve();}},[authenticated,user?.id]);
  useEffect(() => { onModalChange(providerModal || cashSigning); return () => onModalChange(false); }, [providerModal, cashSigning, onModalChange]);
  const [target, setTarget] = useState(() => connection.session?.address || previousTarget());
  const [accepted, setAccepted] = useState(false);
  const [connectAfterImport,setConnectAfterImport]=useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loginStarting, setLoginStarting] = useState(false);
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws();
  const walletLink = useLinkWithSiws();
  const connectedAddress = connection.session?.address;
  const ownsConnectedImport = !!user?.linkedAccounts.some(account => account.type === 'wallet' && account.chainType === 'solana' && account.address === connectedAddress && account.walletClientType === 'privy');
  const hasWalletLogin = !!user?.linkedAccounts.some(account => account.type === 'wallet' && account.chainType === 'solana' && account.address === connectedAddress && account.walletClientType !== 'privy');
  const externalConnection = !!connection.session && !('privy:' in connection.session.wallet.features);
  const needsWalletLink = authenticated && ownsConnectedImport && !hasWalletLogin && externalConnection;
  const walletClientType = ['phantom', 'solflare', 'backpack'].find(name => connection.session?.wallet.name.toLowerCase().includes(name)) || 'unknown';
  async function linkWalletLogin() {
    const address = connection.session?.address, owner = user?.id;
    if (!ready || !address || !owner || !needsWalletLink || authLock.current) return;
    const id = generation.current;
    authLock.current = true; setLoginStarting(true); setError('');
    const current = () => generation.current === id && currentAddress.current === address && userId.current === owner;
    try {
      const message = await walletLink.generateSiwsMessage({ address });
      if (!current()) return;
      const signature = await connection.signProviderWallet(message, address);
      if (!current()) return;
      const result = await walletLink.linkWithSiws({ message, signature, connectorType: 'injected', walletClientType });
      if (!current()) return;
      if (result.user.id !== owner || !result.user.linkedAccounts.some(account => account.type === 'wallet' && account.chainType === 'solana' && account.address === address && account.walletClientType !== 'privy')) throw new Error('Wallet login not confirmed');
      setNotice('Wallet login enabled. Next time, confirm ownership in this wallet.');
    } catch {
      if (current()) setError('Wallet login was not linked. Confirm ownership in the same wallet and retry. Your existing access has not changed.');
    } finally { authLock.current = false; setLoginStarting(false); }
  }
  const authAttempt = useRef<string | null>(null);
  const authLock = useRef(false);
  const currentAddress = useRef(connection.session?.address);
  currentAddress.current = connection.session?.address;
  async function authenticateWallet() {
    const address = connection.session?.address;
    if (!address || !ready || authenticated || authLock.current) return;
    authLock.current = true; setLoginStarting(true); setError('');
    const id = generation.current;
    try {
      const message = await generateSiwsMessage({ address });
      if (generation.current !== id || currentAddress.current !== address) return;
      const signature = await connection.signProviderWallet(message, address);
      if (generation.current !== id || currentAddress.current !== address) return;
      await loginWithSiws({ message, signature, disableSignup: mode !== 'import' && mode !== 'managed-cash' && !isCopyWalletRoute(location.hash), connectorType: 'injected', walletClientType });
      if (generation.current !== id || currentAddress.current !== address) await logout();
    } catch (failure) {
      if (generation.current === id && currentAddress.current === address) {
        const missing = failure instanceof Error && /user.*does not exist/i.test(failure.message);
        setError(missing ? 'This wallet has no linked trading login. New users can set up this wallet for trading. Existing imported wallets must link wallet login to their original account first.' : 'Wallet verification was not completed. Confirm ownership in your wallet and try again.');
      }
    } finally { authLock.current = false; setLoginStarting(false); }
  }
  useEffect(() => {
    if (!open) { authAttempt.current = null; return; }
    const address = connection.session?.address;
    if (mode === "import" || !ready || authenticated || !address || authAttempt.current === address) return;
    const start = setTimeout(() => {
      authAttempt.current = address;
      void authenticateWallet();
    }, 0);
    return () => clearTimeout(start);
  }, [open, ready, authenticated, connection.session?.address, mode]);
  const keyInput = useRef<HTMLInputElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const userId = useRef(user?.id);
  const previousUserId=useRef(user?.id);
  useEffect(()=>{if(previousUserId.current&&previousUserId.current!==user?.id){generation.current++;awaitingImportAuth.current?.reject();awaitingImportAuth.current=undefined;setConnectAfterImport(false);if(keyInput.current)keyInput.current.value="";}previousUserId.current=user?.id;},[user?.id]);
  userId.current = user?.id;
  const matched = authenticated && isMint(target)
    ? wallets.find(wallet => "privy:" in wallet.features && wallet.accounts.some(account => account.address === target))
    : undefined;
  useEffect(() => {
    if (!matched) return;
    return getWallets().register(matched);
  }, [matched]);
  useEffect(() => {
    if (providerModal) setLoginStarting(false);
  }, [providerModal, authenticated]);
  useEffect(() => {
    if (open) return;
    generation.current++;
    if (keyInput.current) keyInput.current.value = "";
    setAccepted(false); setError(""); setLoginStarting(false);
  }, [open]);
  useEffect(() => {
    // Restore refs when StrictMode replays mount effects before the login task.
    userId.current = user?.id;
    currentAddress.current = connection.session?.address;
    const cancel=()=>{generation.current++;awaitingImportAuth.current?.reject();awaitingImportAuth.current=undefined;if(keyInput.current)keyInput.current.value="";setConnectAfterImport(false);};
    window.addEventListener("hashchange",cancel);
    return () => { cancel();window.removeEventListener("hashchange",cancel);userId.current=undefined;currentAddress.current=undefined; };
  }, []);
  function changeTarget(value: string) {
    generation.current++;
    if (keyInput.current) keyInput.current.value = "";
    setTarget(value); setAccepted(false); setError(""); setNotice("");
  }
  async function doImport() {
    if (busy || authLock.current || !ready || !accepted || !isMint(target) || matched) return;
    let secret = keyInput.current?.value.trim() || "";
    if (keyInput.current) keyInput.current.value = "";
    const id = ++generation.current, expected = target, originalOwner=user?.id;
    authLock.current=true;setBusy(true); setError(""); setNotice("");
    let providerCalled = false;
    try {
      await validateImportKey(secret, expected);
      if (generation.current !== id || originalOwner&&userId.current!==originalOwner) return;
      let owner=user;
      if(!authenticated){
        const message=await generateSiwsMessage({address:expected});
        if(generation.current!==id)return;
        const signature=await signImportOwnership(secret,expected,message,location.origin);
        if(generation.current!==id)return;
        // SDK's headless SIWS accepts the verified signature; no Phantom or email bootstrap.
        owner=await loginWithSiws({message,signature});
        if(generation.current!==id)return;
      }
      if(!owner)throw Error('Wallet ownership could not be verified.');
      const ownerId=owner.id;
      // The SDK import hook captures its render's user. Wait for that authenticated
      // render, then invoke the latest hook instead of the pre-login closure.
      if(latestImport.current.userId!==ownerId){
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>{awaitingImportAuth.current=undefined;reject(Error('Wallet authentication timed out.'));},12000);
          awaitingImportAuth.current={owner:ownerId,resolve:()=>{clearTimeout(timer);resolve();},reject:()=>{clearTimeout(timer);reject(Error('Wallet account changed.'));}};
        });
      }
      if(generation.current!==id||userId.current!==ownerId||latestImport.current.userId!==ownerId)return;
      const alreadyImported=owner.linkedAccounts.some(a=>a.type==='wallet'&&a.chainType==='solana'&&a.address===expected&&['privy','privy-v2'].includes(a.walletClientType||''));
      if(!alreadyImported){
        providerCalled = true;
        // No additional signers. Import alone grants no backend trading authority.
        const result = await latestImport.current.importWallet({ privateKey: secret });
        if (generation.current !== id || userId.current!==ownerId) return;
        if (result.address !== expected) throw new Error("provider-mismatch");
      }
      try { localStorage.setItem(TARGET, expected); } catch { /* Public address only. */ }
      setNotice("Fomo wallet ready. Connecting…");
      setConnectAfterImport(true); setAccepted(false);
    } catch (failure) {
      if (generation.current !== id) return;
      // Provider exceptions may contain request context; never reflect them to the page.
      setError(providerCalled
        ? "Import was not confirmed. Check the wallet list before trying again. Never enter a different key to fix a mismatch."
        : failure instanceof Error && ["This key belongs to a different wallet. Nothing was imported.","This is not a valid Solana wallet key. Nothing was imported.","Enter the base58 private key for this Solana wallet. Seed phrases are not accepted."].includes(failure.message) ? failure.message : "Fomo wallet ownership could not be verified. Your key was not stored by Fub. Try the same wallet again.");
    } finally { secret = "";authLock.current=false;setBusy(false); }
  }
  async function useImported() {
    if (!matched || busy) return;
    setBusy(true);
    try {
      if(connection.session?.wallet===matched&&connection.session.address===target){onConnected();return;}
      if(connection.session)await connection.disconnect();
      const connected = await connection.connect(matched as Parameters<WalletConnection["connect"]>[0], target);
      if (connected) onConnected();
      else setError("The wallet did not connect. Check the provider prompt, then try again.");
    } finally { setBusy(false); }
  }
  useEffect(()=>{
    if(!connectAfterImport||!matched||busy)return;
    setConnectAfterImport(false);void useImported();
  },[connectAfterImport,matched,busy]);
  if (open && (mode === "permissions"||mode==='exits')) {
    const address = connection.session?.address;
    const linked = user?.linkedAccounts.find(account => account.type === "wallet" && account.chainType === "solana" && account.address === address && account.walletClientType === "privy");
    const walletId = linked && "id" in linked && typeof linked.id === "string" ? linked.id : undefined;
    const config: EnrollmentConfig = { appId, serviceOrigin: import.meta.env.VITE_SIGNER_SERVICE_ORIGIN || "", signerId: import.meta.env.VITE_SIGNER_ID || "", policyId: import.meta.env.VITE_SIGNER_POLICY_ID || "", policyDigest: import.meta.env.VITE_SIGNER_POLICY_DIGEST || "" };
    return <Modal title={mode==='exits'?'Fomo wallet limit orders.':'Automatic trading access.'} close={close}>
      {needsWalletLink && <section aria-label="Wallet login"><p className="copy-help">Confirm this wallet once to replace email sign-in for your existing account. This does not move funds or change trading permissions.</p><button className="button primary full" disabled={loginStarting} onClick={() => void linkWalletLogin()}>{loginStarting ? 'Confirm in your wallet…' : 'Enable wallet login'}</button>{error && <p className="error-message" role="alert">{error}</p>}</section>}
      {notice && <p className="wallet-notice" role="status">{notice}</p>}
      {!authenticated ? <><p className="copy-help">{loginStarting ? 'Confirm ownership in your connected wallet. This does not move funds or approve trades.' : 'Use your connected wallet to verify ownership. No email is required.'}</p>{error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full" disabled={!ready || loginStarting || !address} onClick={() => void authenticateWallet()}>{loginStarting ? 'Confirm in your wallet…' : 'Retry wallet verification'}</button></>
        : !address || !walletId || !user ? <><p className="wallet-notice">Automatic access requires this same Solana wallet to be privately imported into your Fub account. Connecting Phantom alone does not authorize background signing.</p>{isCopyWalletRoute(location.hash)&&<button className="button primary full" onClick={onSetupCopyWallet}>Set up this wallet for automatic execution</button>}</>
        : mode==='exits'?<DirectExits key={`${user.id}:${address}:${walletId}:${initialExitMint}`} config={config} origin={location.origin} identity={{wallet:address,walletId,userId:user.id}} getToken={getAccessToken} sign={connection.signDirectExit} manageAccess={onManageAccess} initialMint={initialExitMint}/>
        : <SigningPermissions key={`${user.id}:${address}:${walletId}`} config={config} origin={location.origin} identity={{ wallet: address, walletId, userId: user.id }} getToken={getAccessToken} onDone={close}
          sign={connection.signEnrollment}
          addSigner={async c => { try { await addSigners({ address: c.wallet, signers: [{ signerId: c.signerId, policyIds: [c.policyId] }] }); } catch { throw Error("Provider access was not confirmed. Refresh Fub's status or remove additional signers below before retrying."); } }}
          removeSigners={async () => { try { await removeSigners({ address }); } catch { throw Error("Provider removal was not confirmed. Fub may be stopped, but additional signers may remain. Retry removal when Privy is available."); } }} />}
    </Modal>;
  }
  if(open && (mode==='cash-copy'||mode==='cash-plans'||mode==='cash-limit')) {
    const source=connection.session?.address,owner=user?.id;
    const sol=user?.linkedAccounts.find(a=>a.type==='wallet'&&a.chainType==='solana'&&a.address===source&&['privy','privy-v2'].includes(a.walletClientType||''));
    const walletId=sol&&'id' in sol&&typeof sol.id==='string'?sol.id:undefined;
    let evm;try{evm=managedCashIdentity(user?.linkedAccounts||[]);}catch{evm=null;}
    // Modal yields its native dialog to Privy without unmounting the pending
    // recovery. Unmounting here discards signatures and cancels its continuation.
    if(mode==='cash-limit'&&authenticated&&owner&&source&&walletId&&evm&&cashTrade&&cashNetwork)return <CashLimitOrders key={`${owner}:${source}:${cashNetwork}:${cashTrade.token}`} serviceOrigin={import.meta.env.VITE_SIGNER_SERVICE_ORIGIN||''} wallet={source} walletId={walletId} recipient={evm.address} evmWalletId={evm.walletId} network={cashNetwork} token={cashTrade.token} getToken={getAccessToken} current={()=>userId.current===owner&&currentAddress.current===source} close={close} hidden={providerModal||cashSigning} onSigningChange={setCashSigning} signSolana={connection.signCashLimit} addSigner={async(address,signerId,policyId)=>{await addSigners({address,signers:[{signerId,policyIds:[policyId]}]});}}/>;
    if(mode==='cash-plans'&&authenticated&&owner&&source&&onOpenCashPlan)return <CashCopyPlans key={`${owner}:${source}`} serviceOrigin={import.meta.env.VITE_SIGNER_SERVICE_ORIGIN||''} wallet={source} getToken={getAccessToken} current={()=>userId.current===owner&&currentAddress.current===source} close={close} open={onOpenCashPlan}/>;
    if(mode==='cash-copy'&&authenticated&&owner&&source&&walletId&&evm&&cashCopyLeader)return <CashCopyActivation existingScope={cashCopyPlan?.scope} key={`${owner}:${source}:${evm.address}:${cashCopyLeader}:${cashCopyHandle||''}:${cashCopyPlan?.scope.planId||''}`} serviceOrigin={import.meta.env.VITE_SIGNER_SERVICE_ORIGIN||''} wallet={source} walletId={walletId} recipient={evm.address} evmWalletId={evm.walletId} leaderSource={cashCopyLeader} leaderHandle={cashCopyHandle} getToken={getAccessToken} current={()=>userId.current===owner&&currentAddress.current===source} close={close} hidden={providerModal||cashSigning} onSigningChange={setCashSigning} signSolana={connection.signCashCopy} addSigner={async(address,signerId,policyId)=>{await addSigners({address,signers:[{signerId,policyIds:[policyId]}]});}}/>;
    if(providerModal||cashSigning)return null;
    return <Modal title={mode==='cash-limit'?"Cross-chain limit orders.":"Copy with USDC."} close={close}><p className="copy-help">{!authenticated?'Verify your connected wallet to continue.':'Automatic execution requires this Solana wallet’s private import and a linked cross-chain wallet. Connecting Phantom alone does not grant background signing.'}</p>{!authenticated&&<button className="button primary full" disabled={!ready||loginStarting||!source} onClick={()=>void authenticateWallet()}>{loginStarting?'Confirm in your wallet…':'Verify connected wallet'}</button>}{authenticated&&!walletId&&<button className="button primary full" onClick={onSetupCopyWallet}>Set up this wallet for automatic execution</button>}{authenticated&&walletId&&!evm&&<button className="button primary full" onClick={onSetupCopyDestination}>Set up cross-chain wallet</button>}{error&&<p role="alert" className="error-message">{error}</p>}</Modal>;
  }
  if (open && (mode === 'managed-cash' || mode === 'cash-trade') && cashNetwork && onManagedCash) {
    const sourceWallet = connection.session?.address;
    const linked = user?.linkedAccounts.some(a => a.type === 'wallet' && a.chainType === 'solana' && a.address === sourceWallet);
    if (authenticated && user && sourceWallet && linked) {
      const owner = user.id;
      if(mode==='cash-trade'&&cashTrade)return <CashTradePanel key={`${owner}:${sourceWallet}:${cashNetwork}:${cashTrade.token}`} userId={owner} network={cashNetwork} token={cashTrade.token} amount={cashTrade.amount} connection={connection} hidden={providerModal||cashSigning} close={close} onSigningChange={setCashSigning} isCurrent={()=>userId.current===owner&&currentAddress.current===sourceWallet}/>;
      return <ManagedCashWallet key={`${owner}:${sourceWallet}:${cashNetwork}`} userId={owner} sourceWallet={sourceWallet}
        network={cashNetwork} connection={connection} hidden={providerModal || cashSigning} close={close} onReady={onManagedCash} onSigningChange={setCashSigning}
        isCurrent={() => userId.current === owner && currentAddress.current === sourceWallet} />;
    }
    if (providerModal) return null;
    return <Modal title="Set up cross-chain trading." close={close}>
      <p className="copy-help">Verify your connected Solana wallet. No email or EVM key import is needed.</p>
      {!authenticated && <button className="button primary full" disabled={!ready || loginStarting || !sourceWallet} onClick={() => void authenticateWallet()}>{loginStarting ? 'Confirm in your wallet…' : 'Verify connected wallet'}</button>}
      {authenticated && !linked && <><p className="copy-help">This account belongs to a different wallet. Sign out here, then verify the connected wallet.</p><button className="word-link" onClick={() => void logout()}>Switch wallet account</button></>}
      {error && <p role="alert" className="error-message">{error}</p>}
    </Modal>;
  }
  if (!open || providerModal) return null;
  if (mode === 'cash') {
    const sourceWallet = connection.session?.address;
    const linked = user?.linkedAccounts.some(account => account.type === 'wallet' && account.chainType === 'solana' && account.address === sourceWallet);
    if (authenticated && user && sourceWallet && linked && cashAddress && isEvmAddress(cashAddress) && onCashWallet) {
      const owner = user.id;
      return <EvmCashImport key={`${owner}:${sourceWallet}:${cashAddress}`} address={cashAddress} sourceWallet={sourceWallet} userId={owner} close={close} readyWallet={onCashWallet} isCurrent={()=>userId.current===owner&&currentAddress.current===sourceWallet}/>;
    }
    return <Modal title="Connect your Fomo EVM wallet." close={close}>
      <p className="copy-help">{!authenticated?'Confirm ownership with your connected Solana wallet to continue. No email is required.':'Connect the Solana wallet linked to this account before adding its EVM wallet.'}</p>
      {!authenticated&&<button className="button primary full" disabled={!ready||loginStarting||!sourceWallet} onClick={()=>void authenticateWallet()}>{loginStarting?'Confirm in your wallet…':'Verify connected wallet'}</button>}
      {error&&<p role="alert" className="error-message">{error}</p>}
    </Modal>;
  }
  return <Modal title={isCopyWalletRoute(location.hash)?"Set up copy wallet.":"Connect Fomo wallet."} close={() => { if (!busy) close(); }}>
    <p className="wallet-explanation">{isCopyWalletRoute(location.hash)?"Use your connected Solana wallet to copy Fomo traders. Import this same wallet privately for automatic signing; your address and balance stay the same. Approve background access and plan limits separately.":"Use your existing Fomo Solana wallet for Pay and limit orders. Import it privately once; your address and balance stay the same. Trading permissions and limits are separate."}</p>
    {!isCopyWalletRoute(location.hash)&&<p className="copy-help">Pay uses this Fomo wallet’s USDC balance. No Phantom connection, separate deposit or background trading permission is needed for manual payments.</p>}
    {isCopyWalletRoute(location.hash)?<label className="field"><span>Your Solana wallet address</span><input ref={addressInput} value={target} disabled={busy} autoComplete="off" spellCheck={false} maxLength={44} onChange={event=>changeTarget(event.target.value)}/></label>:<FomoLeaderPicker purpose="owner" address={target} active={!busy} inputRef={addressInput} onChange={changeTarget} />}
    {matched ? <>
      <p className="wallet-notice" role="status">This exact wallet is available through Privy.</p>
      <p className="fomo-identity-address">{target}</p>
      <button className="button primary full" disabled={busy} onClick={() => void useImported()}>Connect imported wallet</button>
    </> : <>
      <p className="copy-help">Export this Solana wallet's private key from its wallet app. Enter it only here. This page checks the address locally, then Privy's SDK encrypts the import to its wallet infrastructure. Our server does not receive the key.</p>
      <label className="field"><span>Solana private key</span><input ref={keyInput} type="password" aria-label="Solana import key" autoComplete="off" spellCheck={false} maxLength={88} disabled={busy || !ready || !isMint(target)} /></label>
      <label className="copy-toggle"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} /><span>I own this Solana wallet and agree to verify ownership and import it into Privy for Fub.</span></label>
      <button className="button primary full" disabled={busy || !accepted || !ready || !isMint(target)} onClick={() => void doImport()}>{busy ? "Verifying wallet…" : "Set up wallet"}</button>
    </>}
    {notice && <p className="wallet-notice" role="status">{notice}</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    <p className="copy-help">Automatic trading stays off. Importing does not grant a background signer access or move funds.</p>
    {authenticated && <button className="word-link" disabled={busy} onClick={() => { generation.current++; if (keyInput.current) keyInput.current.value = ""; void logout(); }}>Sign out of wallet setup</button>}
  </Modal>;
}
