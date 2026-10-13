import type {CashCopyPlan} from './cash-copy-client';
import { Component, createContext, lazy, useEffect, Suspense, useContext, useState } from "react";
import type { ReactNode } from "react";
import { useWallet } from "./useWallet";
import {isLaunchWalletRoute,isCopyWalletRoute,isExternalWalletRoute,isImportedWallet} from "./wallet-route-policy";
import type {ManagedCashAccount} from './ManagedCashWallet';
import type {CashNetwork} from './cash-route';
import type { CashEvmConnection } from "./EvmCashImport";
import type { WalletConnection } from "./useWallet";
import { Modal } from "./ui";
import { WalletPanel } from "./WalletPanel";
import { WalletModalActive } from "./wallet-modal";
const PrivyImport = lazy(() => import("./PrivyImport"));
const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const Setup = createContext<{ connection: WalletConnection; modalOpen: boolean; canImport: boolean; managedCash?:ManagedCashAccount; openCashPlans:()=>void;openCashCopy:(leaderSource:string,handle?:string)=>void; openManagedCash:(network:CashNetwork)=>void; openCashTrade:(token:string,amount:string,network:CashNetwork)=>void;openCashLimit:(token:string,network:CashNetwork)=>void; cashEvm?:CashEvmConnection; openCashWallet:(address:string)=>void; openConnect: () => void; openImport: () => void; openPermissions: () => void; openDirectExits: (mint?:string) => void } | null>(null);
export function useWalletSetup() {
  const value = useContext(Setup);
  if (!value) throw new Error("Wallet setup is missing.");
  return value;
}
class SetupError extends Component<{ children: ReactNode; reset: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <Modal title="Wallet setup unavailable." close={this.props.reset}><p className="copy-help">The wallet provider could not load. Close this window and try again.</p></Modal>;
    return this.props.children;
  }
}
export function WalletSetup({ children }: { children: ReactNode }) {
  const connection = useWallet({externalLaunchOnly:true});
  const [connectOpen, setConnectOpen] = useState(false);
  useEffect(() => { if (connection.session) setConnectOpen(false); }, [connection.session]);
  const [loaded, setLoaded] = useState(false), [open, setOpen] = useState(false);
  const [providerModal, setProviderModal] = useState(false);
  const [exitMint,setExitMint]=useState('');
  const [cashCopyLeader,setCashCopyLeader]=useState('');
  const [cashCopyPlan,setCashCopyPlan]=useState<CashCopyPlan>();
  const [cashCopyHandle,setCashCopyHandle]=useState<string>();
  const [cashAddress,setCashAddress]=useState('');
  const [cashTrade,setCashTrade]=useState<{token:string;amount:string}>();
  const [cashNetwork,setCashNetwork]=useState<CashNetwork>('base');
  const [managedCash,setManagedCash]=useState<ManagedCashAccount>();
  const [cashWallet,setCashWallet]=useState<{source:string;provider:CashEvmConnection}|null>(null);
  useEffect(()=>{setCashWallet(null);setManagedCash(undefined);},[connection.session?.address]);
  const [mode, setMode] = useState<"import" | "permissions" | "exits" | "cash" | "managed-cash" | "cash-trade" | "cash-limit" | "cash-copy" | "cash-plans">("import");
  const showFomoMode=(next:typeof mode)=>setMode(connection.session&&(isImportedWallet(connection.session.wallet)||(isCopyWalletRoute(location.hash)&&["permissions","cash-copy","cash-plans","managed-cash"].includes(next)))?next:"import");
  return <Setup.Provider value={{ connection, modalOpen: open, canImport: !!appId, openCashPlans:()=>{showFomoMode("cash-plans");setLoaded(true);setOpen(true);},openCashCopy:(leader,handle)=>{setCashCopyPlan(undefined);setCashCopyLeader(leader);setCashCopyHandle(handle);showFomoMode("cash-copy");setLoaded(true);setOpen(true);}, openCashLimit:(token,network)=>{setCashNetwork(network);setCashTrade({token,amount:""});showFomoMode("cash-limit");setLoaded(true);setOpen(true);}, openCashTrade:(token,amount,network)=>{setCashNetwork(network);setCashTrade({token,amount});showFomoMode('cash-trade');setLoaded(true);setOpen(true);}, managedCash:managedCash?.sourceWallet===connection.session?.address?managedCash:undefined, openManagedCash:network=>{setCashNetwork(network);showFomoMode('managed-cash');setLoaded(true);setOpen(true);}, cashEvm:cashWallet?.source===connection.session?.address?cashWallet?.provider:undefined, openCashWallet:(address)=>{setCashAddress(address);showFomoMode('cash');setLoaded(true);setOpen(true);}, openConnect: () => {if(isExternalWalletRoute(location.hash)){setConnectOpen(true);}else{setMode("import");setLoaded(true);setOpen(true);}}, openImport: () => { setMode("import"); setLoaded(true); setOpen(true); }, openPermissions: () => { showFomoMode("permissions"); setLoaded(true); setOpen(true); }, openDirectExits:(mint='')=>{setExitMint(mint);showFomoMode('exits');setLoaded(true);setOpen(true);} }}>
    <WalletModalActive.Provider value={providerModal}>
      {children}
      {connectOpen && <Modal title={isLaunchWalletRoute(location.hash)?"Connect launch wallet.":"Connect copy wallet."} description={isLaunchWalletRoute(location.hash)?"Use Phantom or another Solana wallet to launch a coin.":"Connect Phantom or another Solana wallet to follow a Fomo trader. Automatic copying also requires private signing setup and your plan approval."} close={() => setConnectOpen(false)}>
        <WalletPanel connection={connection} onView={() => setConnectOpen(false)} onImport={appId ? () => { setConnectOpen(false); setMode("import"); setLoaded(true); setOpen(true); } : undefined} />
      </Modal>}
      {loaded && appId && <SetupError reset={() => { setLoaded(false); setOpen(false); setProviderModal(false); }}>
        <Suspense fallback={open ? <Modal title="Loading wallet setup." close={() => setOpen(false)}><p className="copy-help">Connecting to Privy.</p></Modal> : null}>
          <PrivyImport onSetupCopyWallet={()=>setMode("import")} onSetupCopyDestination={()=>{setCashNetwork("base");setMode("managed-cash");}} appId={appId} mode={mode} open={open} close={() => setOpen(false)} connection={connection} onModalChange={setProviderModal} onConnected={() => setOpen(false)} onManageAccess={()=>showFomoMode('permissions')} initialExitMint={exitMint} cashCopyPlan={cashCopyPlan} onOpenCashPlan={plan=>{setCashCopyPlan(plan);setCashCopyLeader(plan.leaderSource);setCashCopyHandle(undefined);showFomoMode("cash-copy");}} cashCopyLeader={cashCopyLeader} cashCopyHandle={cashCopyHandle} cashAddress={cashAddress} cashNetwork={cashNetwork} cashTrade={cashTrade} onManagedCash={setManagedCash} onCashWallet={provider=>{const source=connection.session?.address;if(source)setCashWallet({source,provider});}} />
        </Suspense>
      </SetupError>}
    </WalletModalActive.Provider>
  </Setup.Provider>;
}
