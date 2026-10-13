import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, Clock3, RefreshCw, UserRound } from 'lucide-react';
import type { FomoRecipient } from './fomo-recipient';
import type { FomoProfileToken } from './fomo-profile-details';
import { fomoProfileUrl } from './fomo-identity';
import './fomo-wallet-overview.css';

const usd = (value: number | null | undefined, signed = false) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, ...(signed ? { signDisplay: 'exceptZero' as const } : {}) }).format(value);
const count = (value: number | null | undefined) => value == null ? 'Unavailable' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
function duration(seconds: number | null | undefined) {
  if (seconds == null) return 'Unavailable';
  if (seconds < 60) return '< 1 min';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
function Artwork({ image, label }: { image: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  return image && !failed ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="fwp-art-fallback" aria-label="Image unavailable">{label.slice(0, 1) || '?'}</span>;
}
function TokenName({ token }: { token: FomoProfileToken }) {
  return <span className="fwp-token"><Artwork key={token.imageUrl} image={token.imageUrl} label={token.symbol || token.name || ''} /><span><b>{token.symbol || token.name || `${token.address.slice(0, 6)}…`}</b><small>{token.name || token.address.slice(0, 12)} <span>· {token.chain}</span></small></span></span>;
}
export function FomoWalletOverview({ profile: p, busy, onRefresh }: { profile: FomoRecipient; busy: boolean; onRefresh: () => void }) {
  const details = p.profileStats?.details;
  const [network, setNetwork] = useState('all');
  const [filter, setFilter] = useState('');
  const positions = details?.positions;
  const networks = [...new Set(positions?.map(row => row.token.chain) || [])].sort();
  const filtered = positions?.filter(row => (network === 'all' || row.token.chain === network) && `${row.token.symbol || ''} ${row.token.name || ''} ${row.token.address}`.toLowerCase().includes(filter.toLowerCase()));
  const observed = p.profileStats?.observedAt || p.observedAt || p.fetchedAt;
  return <section className="fwp" aria-label="Fomo wallet profile">
    <header className="fwp-header">
      <div className="fwp-identity"><span className="fwp-avatar">{p.avatarUrl ? <Artwork key={p.avatarUrl} image={p.avatarUrl} label={p.displayName} /> : <UserRound size={28} />}</span><div><h2>{p.displayName}</h2><a href={fomoProfileUrl(p.handle)} target="_blank" rel="noreferrer">@{p.handle} <ArrowUpRight size={13} /></a></div></div>
      <div className="fwp-header-actions"><span className="fwp-match"><CheckCircle2 size={14} /> Wallet matched</span><button className="icon-button" disabled={busy} onClick={onRefresh} aria-label="Refresh Fomo profile"><RefreshCw size={15} className={busy ? 'fwp-refreshing' : ''} /></button></div>
    </header>
    {details?.bio && <p className="fwp-bio">{details.bio}</p>}
    <dl className="fwp-social">
      <div><dt>Followers</dt><dd>{count(p.profileStats?.followers)}</dd></div><div><dt>Following</dt><dd>{count(details?.following)}</dd></div><div><dt>Trades</dt><dd>{count(p.profileStats?.trades)}</dd></div><div><dt>Average hold</dt><dd>{duration(details?.averageHoldingSeconds)}</dd></div><div><dt>Joined</dt><dd>{details?.joinedAt ? new Date(details.joinedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Unavailable'}</dd></div>
    </dl>
    <div className="fwp-financials" aria-label="Fomo portfolio stats"><div><span>Portfolio value</span><strong>{usd(details?.portfolioUsd)}</strong></div><div><span>24h change</span><strong className={details?.portfolioChange24hUsd == null ? '' : details.portfolioChange24hUsd < 0 ? 'negative' : 'positive'}>{usd(details?.portfolioChange24hUsd, true)}</strong></div><div><span>Total cash</span><strong>{usd(details?.cashUsd)}</strong></div></div>
    {!!details?.topTrades?.length && <div className="fwp-best"><h3>Top trades</h3><div className="fwp-top-trades">{details.topTrades.map((trade, index) => <article key={`${trade.token.chain}:${trade.token.address}:${index}`}><span className="fwp-rank">#{index + 1}</span><TokenName token={trade.token} /><strong className={trade.pnlUsd != null && trade.pnlUsd < 0 ? 'negative' : 'positive'}>{usd(trade.pnlUsd, true)}</strong><small>{trade.pnlPercent == null ? 'Return unavailable' : `${trade.pnlPercent > 0 ? '+' : ''}${trade.pnlPercent.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`}</small></article>)}</div></div>}
    <div className="fwp-positions"><div className="fwp-section-heading"><div><h3>Fomo positions {positions && <span>{positions.length}</span>}</h3><p>Public positions reported by Fomo across networks.</p></div><div className="fwp-filters"><input aria-label="Search Fomo positions" placeholder="Find a token" value={filter} onChange={event => setFilter(event.target.value)} />{networks.length > 1 && <select aria-label="Filter Fomo positions by network" value={network} onChange={event => setNetwork(event.target.value)}><option value="all">All networks</option>{networks.map(chain => <option key={chain} value={chain}>{chain}</option>)}</select>}</div></div>
    {positions == null ? <p className="fwp-unavailable">{p.profilePending ? 'Updating Fomo positions…' : 'Fomo positions are unavailable for this profile. The matched Solana wallet is shown below.'}</p> : positions.length === 0 ? <p className="fwp-unavailable">No open positions reported by Fomo.</p> : <div className="fwp-table-wrap"><table><thead><tr><th>Token</th><th>Amount</th><th>Value</th><th>Position return</th></tr></thead><tbody>{filtered?.map(row => <tr key={`${row.token.chain}:${row.token.address}`}><td><TokenName token={row.token} /></td><td title={row.amount || undefined}>{row.amount == null ? 'Unavailable' : count(Number(row.amount))}</td><td>{usd(row.valueUsd)}</td><td className={row.pnlPercent == null ? '' : row.pnlPercent < 0 ? 'negative' : 'positive'}>{row.pnlPercent == null ? 'Unavailable' : `${row.pnlPercent > 0 ? '+' : ''}${row.pnlPercent.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`}</td></tr>)}</tbody></table>{filtered?.length === 0 && <p className="fwp-unavailable">No positions match this search.</p>}</div>}
    </div>
    <footer className="fwp-footer"><span><Clock3 size={12} /> Fomo snapshot · {new Date(observed).toLocaleString()}</span><span>{p.profilePending ? 'Refreshing profile…' : 'Profile totals can differ from the Solana-only balances below.'}</span></footer>
  </section>;
}
