import { useEffect, useState } from "react";
import PayWorkspace from "./pay/PayWorkspace";
import { PaymentRequests } from "./PaymentRequests";
import "./pay/styles.css";
import { PayHistory } from "./PayHistory";
import { Bitrefill } from "./pay/Bitrefill";
import {useWalletSetup} from "./WalletSetup";
import {displayUnits} from "./funding-model";
import type {CardWalletSnapshot} from "./card-allowance";
import {checkedSnapshot} from "./PayWallet";
import {GiftCheckout} from "./pay/GiftCheckout";
import { PayWallet } from "./PayWallet";

export function Pay() {
  const {connection,openConnect}=useWalletSetup(),owner=connection.session?.address;
  const [balance,setBalance]=useState<CardWalletSnapshot|null>(null),[balanceError,setBalanceError]=useState(false);
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const restore = () => setHash(location.hash);
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, []);
  useEffect(()=>{
    setBalance(null);setBalanceError(false);if(!owner||hash!=='#pay')return;
    const controller=new AbortController();let loading=false;
    async function read(){if(loading||document.visibilityState==='hidden')return;loading=true;try{
      const r=await fetch(`/api/pay-wallet?wallet=${encodeURIComponent(owner!)}`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});if(!r.ok)throw Error();
      const next=await checkedSnapshot(await r.json(),owner!);if(!controller.signal.aborted){setBalance(next);setBalanceError(false);}
    }catch{if(!controller.signal.aborted)setBalanceError(true);}finally{loading=false;}}
    void read();const timer=setInterval(()=>void read(),30000);const visible=()=>void read();document.addEventListener('visibilitychange',visible);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[owner,hash]);
  if (hash === "#pay/purchases") return <section className="pay-app"><a className="word-link pay-back" href="#pay">← Back to Fomo Pay</a><GiftCheckout product={null} country="US" /></section>;
  if (hash === "#pay/gift-cards") return <Bitrefill />;
  if (hash === "#pay/history") return <PayHistory />;
  if (hash === "#pay/wallet") return <PayWallet />;
  if (hash === "#pay-request" || hash === "#pay/split" || hash === "#pay/treat" || hash.startsWith("#pay="))
    return (
      <>
        <a className="word-link pay-back" href="#pay">
          ← Back to Fomo Pay
        </a>
        <PaymentRequests key={hash === '#pay/treat' ? 'treat' : 'split'} initialMode={hash === '#pay/treat' ? 'treat' : 'split'} />
      </>
    );
  if (hash.startsWith('#pay/preview') || hash.startsWith('#preview=')) return <PayWorkspace />;
  return <section className="pay-app pay-live-home">
    <header className="bitrefill-heading"><p className="eyebrow">FOMO PAY</p><h1>Spend. Split. Treat.</h1><p>Use USDC from your Fomo wallet. Approve each payment yourself.</p></header>
    <section className="pay-wallet-panel" aria-label="Pay balance">
      {owner?<><span>In your connected wallet</span><div className="pay-wallet-balance"><strong>{balance?.wallet===owner&&!balanceError?displayUnits(balance.usdcRaw,6):balanceError?'Unavailable':'Checking…'}</strong><span>USDC</span></div><p className="pay-note">{balanceError?'Could not refresh the balance. Review payment to check your available funds.':'Payments use this balance directly. Keep SOL in the wallet for network fees.'}</p></>:<button className="button primary" onClick={openConnect}>Connect your Fomo wallet</button>}
    </section>
    <div className="pay-live-options">
      <a href="#pay/gift-cards"><span>Gift cards</span><h2>Put your balance to use.</h2><p>Choose a merchant and amount. Pay with USDC and get your gift-card code in your private purchase history.</p><strong>Browse gift cards →</strong></a>
      <a href="#pay/split"><span>Split with Fomo</span><h2>Get everyone’s share.</h2><p>Create a group reimbursement request, share the links and check confirmed payments.</p><strong>Create a split →</strong></a>
      <a href="#pay/treat"><span>Treat a friend</span><h2>Lunch is on you.</h2><p>Choose your friend’s wallet, add an amount and message, then approve a direct USDC transfer.</p><strong>Send a treat →</strong></a>
    </div>
    <div className="pay-live-links"><a className="word-link" href="#pay/wallet">Check wallet balance →</a><a className="word-link" href="#pay/purchases">Purchase history →</a></div>
  </section>;
}
