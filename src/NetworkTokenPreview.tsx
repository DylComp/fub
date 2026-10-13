import {cashTradeRequest,type CashPilot} from './cash-trade-client';
import { useEffect, useRef, useState } from 'react';
import type { DiscoveredToken } from './assets';
import {formatUnits} from 'viem';
import { NETWORKS } from './networks';
import type { EvmNetwork } from './networks';
import { cashAmountRaw } from './cash-route';
import type { CashRouteQuote } from './cash-route';
import {useWalletSetup} from './WalletSetup';
import {cashAccountRequest, checkedCashBinding} from './cash-account-client';
import {walletSessionRequest} from './wallet-session-client';

const units = (raw: string, decimals: number) => {
  const value = Number(raw) / 10 ** decimals;
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value) : 'Unavailable';
};
export function NetworkTokenPreview({ token, chain, close }: { token: DiscoveredToken; chain: EvmNetwork; close: () => void }) {
  const {connection, canImport, managedCash, openManagedCash, openConnect, openCashTrade, openCashLimit} = useWalletSetup();
  const [pilot,setPilot]=useState<CashPilot|null>(null);
  const [amount, setAmount] = useState('10');
  const amountEdited = useRef(false);
  const [result, setResult] = useState<CashRouteQuote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const sourceWallet = connection.session?.address;
  const recipient = managedCash?.address;
  const ownershipCurrent = !!sourceWallet && !!recipient && !!managedCash && checkedCashBinding(managedCash.binding, sourceWallet, recipient, chain);
  useEffect(()=>{let current=true;setPilot(null);if(sourceWallet)void cashTradeRequest<CashPilot>({action:'capabilities',network:chain},sourceWallet).then(p=>{if(current)setPilot(p);}).catch(()=>{});return()=>{current=false;};},[sourceWallet,chain,ownershipCurrent]);
  const matchedPilot = pilot?.network===chain && pilot.pilotWallet && pilot.token?.toLowerCase()===token.address.toLowerCase();
  const pilotCap = matchedPilot && /^[1-9]\d{0,8}$/.test(pilot.buyCapRaw || '') ? pilot.buyCapRaw! : null;
  useEffect(() => { amountEdited.current=false; setAmount('10'); }, [sourceWallet,chain,token.address]);
  useEffect(() => {
    if (pilotCap && !amountEdited.current) setAmount(formatUnits(BigInt(pilotCap),6));
  }, [pilotCap]);
  let amountRaw = '', amountError = '';
  try { amountRaw = cashAmountRaw(amount); } catch (e) { amountError = (e as Error).message; }
  const exceedsPilot = !!pilotCap && !!amountRaw && BigInt(amountRaw)>BigInt(pilotCap);
  useEffect(() => {
    setResult(null); setError(''); setBusy(false);
    if (!attempt || !amountRaw) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), 18000);
    setBusy(true);
    void (async () => {
      try {
        let data: CashRouteQuote;
        if (ownershipCurrent) {
          const session = await walletSessionRequest<{address:string|null;csrf?:string}>('status', undefined, controller.signal);
          if (cancelled) return;
          if (session.address !== sourceWallet || !session.csrf) throw Error('Verify your funding wallet again.');
          data = await cashAccountRequest<CashRouteQuote>({action:'quote', network:chain, token:token.address, amount}, session.csrf);
          if (data.sourceWallet !== sourceWallet || data.recipient !== recipient) throw Error('The quote does not match your wallets.');
        } else {
          const response = await fetch(`/api/tokens?chain=${chain}&cash=${encodeURIComponent(token.address)}&amount=${encodeURIComponent(amount)}`, { signal: controller.signal });
          if (!response.ok) throw Error(response.status === 429 ? 'Quotes are busy. Try again in a minute.' : 'A verified USDC quote is unavailable for this token and amount. Try again shortly.');
          data = await response.json() as CashRouteQuote;
        }
        if (data.network !== chain || data.token !== token.address.toLowerCase() || data.amountRaw !== amountRaw ||
          data.executable !== false || data.provider !== 'relay' || data.source !== 'solana-usdc' || data.depositVerified !== true ||
          !Number.isSafeInteger(data.checkedAt) || !Number.isSafeInteger(data.expiresAt) || data.checkedAt > Date.now() + 1000 ||
          data.expiresAt <= Date.now() || data.expiresAt > data.checkedAt + 30000 || data.expiresAt > Date.now() + 31000 ||
          ![data.outputRaw, data.minimumRaw, data.feeUsdcRaw, data.estimatedGasLamports].every(v => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v)) ||
          !Number.isInteger(data.outputDecimals) || data.outputDecimals < 0 || data.outputDecimals > 36 || !Number.isFinite(data.priceImpactPercent))
          throw Error('This quote expired or did not match your amount. Try again.');
        if (!cancelled) { setResult(data); setNow(Date.now()); }
      } catch (e) { if (!cancelled) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Quote timed out. Try again.'); }
      finally { clearTimeout(timeout); if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [attempt, token.address, chain, amount, amountRaw, ownershipCurrent, sourceWallet, recipient]);
  useEffect(() => {
    if (!managedCash) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, managedCash.binding.expiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [managedCash]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, result.expiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [result]);
  const expired = result && now >= result.expiresAt;
  return <section className="network-token-preview" aria-label={`${token.symbol} on ${NETWORKS[chain].name}`}>
    <div className="network-preview-heading"><h3>{token.symbol} · {NETWORKS[chain].name}</h3><button className="word-link" onClick={close}>Back to results</button></div>
    <p className="network-token-address">{token.address}</p>
    <p>Orders and automatic copying on {NETWORKS[chain].name} are not active yet.</p>
    {canImport && <section className="cash-wallet-setup" aria-label="Cross-chain wallet">
      <p className="copy-help">{ownershipCurrent ? 'Your cross-chain wallet is verified. Purchases will use USDC from your connected Solana wallet.' : 'One wallet login. Keep cross-chain holdings in Fub and use your Fomo Solana USDC balance.'}</p>
      {recipient && <p className="network-token-address">{recipient}</p>}
      <button className="word-link" onClick={() => sourceWallet ? openManagedCash(chain) : openConnect()}>{sourceWallet ? ownershipCurrent ? 'Manage cross-chain wallet' : 'Set up cross-chain wallet' : 'Connect your Fomo wallet'}</button>
    </section>}
    <label className="cash-quote-amount">USDC to spend<input aria-label="USDC to spend" inputMode="decimal" value={amount} maxLength={15}
      onChange={event => { amountEdited.current=true; setAmount(event.target.value); setAttempt(0); setResult(null); }} /></label>
    <p className="copy-help">Quote a purchase from Solana USDC. Slippage limit: 1%.</p>
    {amountError && <p role="alert">{amountError}</p>}
    <button className="button secondary full" disabled={busy || !!amountError} onClick={() => setAttempt(n => n + 1)}>{busy ? 'Checking USDC quote…' : result ? 'Refresh USDC quote' : 'Check USDC quote'}</button>
    {exceedsPilot && <p role="alert">This test allows up to {formatUnits(BigInt(pilotCap!),6)} USDC. Lower the amount before reviewing.</p>}
    <button className="button full" disabled={!ownershipCurrent} onClick={()=>openCashLimit(token.address,chain)}>Set a limit order</button>
    {(matchedPilot||pilot?.publicAccess)&&<button className="button primary full" disabled={!ownershipCurrent||!!amountError||(!pilot?.publicAccess&&!pilotCap)||exceedsPilot||!pilot?.executionEnabled} onClick={()=>openCashTrade(token.address,amount,chain)}>{pilot?.publicAccess?'Buy with USDC':'Review cross-chain test'}</button>}
    <div role="status" aria-live="polite">
      {error && <p>{error}</p>}
      {result && <>
        <p>{expired ? 'Quote expired. Refresh for a current price.' : `${units(result.outputRaw, result.outputDecimals)} ${token.symbol} estimated`}</p>
        {!expired && <dl className="cash-quote-details">
          <div><dt>Minimum received</dt><dd>{units(result.minimumRaw, result.outputDecimals)} {token.symbol}</dd></div>
          <div><dt>Routing fee · included</dt><dd>{units(result.feeUsdcRaw, 6)} USDC</dd></div>
          <div><dt>Solana network fee · estimated</dt><dd>{units(result.estimatedGasLamports, 9)} SOL</dd></div>
          <div><dt>Price impact incl. fees</dt><dd>{result.priceImpactPercent.toFixed(2)}%</dd></div>
        </dl>}
        <p className="copy-help">{ownershipCurrent ? 'Quote for your verified wallets. Available funds are not checked and no trade is placed.' : 'Quote only. Wallet funding and destination ownership are not verified. No trade is placed.'}</p>
      </>}
    </div>
  </section>;
}
