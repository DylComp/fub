import { ArrowUpRight } from 'lucide-react';
import { TokenIcon } from './TokenSearch';
import { ADDRESSES, idFor, shortAddress } from './assets';
import { exactAmount } from './portfolio-data';
import type { WalletTransaction } from './portfolio-data';
const labels = { buy: 'Bought', sell: 'Sold', swap: 'Swapped', send: 'Sent', receive: 'Received', activity: 'Wallet activity', failed: 'Failed' };
export function WalletTransactionRow({ transaction: t }: { transaction: WalletTransaction }) {
  const movements = t.movements || [];
  const primary = movements.find(m => m.mint !== ADDRESSES.SOL && m.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') || movements[0];
  return <a className="wallet-transaction wallet-trade-row" href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer">
    <span className="wallet-trade-art"><TokenIcon token={{ id: primary ? idFor(primary.mint) : '', symbol: primary?.symbol || '', image: primary?.image }} /><img className="wallet-chain-badge" src="/tokens/sol.png" alt="Solana" title="Solana" /></span>
    <span className="wallet-trade-description">
      <b className={t.kind === 'buy' ? 'positive' : t.kind === 'sell' || t.failed ? 'negative' : ''}>{labels[t.kind || (t.failed ? 'failed' : 'activity')]}{primary ? ` ${primary.symbol || shortAddress(primary.mint)}` : ''}</b>
      {primary?.name && <span className="wallet-trade-token-name">{primary.name}</span>}
      <small>{t.blockTime === null ? 'Time unavailable' : new Date(t.blockTime * 1000).toLocaleString()}</small>
      {!t.failed && !t.detailsAvailable && <small>Transaction details unavailable</small>}
    </span>
    <span className="wallet-trade-amounts">
      {movements.map(m => <span className={m.direction === 'in' ? 'positive' : 'muted'} key={m.mint} title={`${m.mint === ADDRESSES.SOL ? 'Net SOL movement, excluding the network fee and token-account rent' : m.name || m.mint}: ${exactAmount(m.rawAmount, m.decimals)}`}>
        {m.mint === ADDRESSES.SOL && <img src="/tokens/sol.png" alt="" />}
        <b>{m.direction === 'in' ? '+' : '−'}{exactAmount(m.rawAmount, m.decimals)} {m.symbol || shortAddress(m.mint)}</b>
      </span>)}
      <small>{t.failed ? 'Failed' : t.confirmation === 'finalized' ? 'Finalized' : 'Confirmed'}</small>
    </span>
    <ArrowUpRight size={14} aria-hidden="true" />
  </a>;
}
