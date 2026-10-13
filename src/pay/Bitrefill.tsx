import {MerchantLogo} from './MerchantLogo';
import {GiftCheckout} from './GiftCheckout';
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Search } from "lucide-react";

type Product = { id: string; name: string; countries: string[]; currency: string; inStock: boolean; url: string };
type Catalog = { products: Product[]; found: number; page: number };
type Detail = Product & { country:string; recipientType:string; requiresPrepayment:boolean; terms:string; subtitle: string; note: string; paymentMethods: string[]; packages: { value: string; currency: string; price: string; priceCurrency: string }[] };
const countries = ["US", "CA", "GB", "AU", "AT", "BE", "BR", "CH", "DE", "ES", "FR", "IE", "IN", "IT", "JP", "KR", "MX", "NL", "NZ", "PH", "PL", "PT", "SG", "TH", "TR", "AE"];
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const storefront = "https://www.bitrefill.com/?hl=en";
function safeLink(url: string) { try { const u = new URL(url); return u.origin === "https://www.bitrefill.com" && !u.username && !u.password ? u.href : storefront; } catch { return storefront; } }
async function read<T>(params: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/bitrefill?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  if (!response.ok) throw Error(response.status === 429 ? "The catalog is busy. Try again shortly." : "The catalog is unavailable. You can still browse on Bitrefill.");
  return response.json();
}
export function Bitrefill() {
  const [country, setCountry] = useState("US"), [query, setQuery] = useState("");
  const [search, setSearch] = useState({ country: "US", query: "", page: 1, revision: 0 });
  const [catalog, setCatalog] = useState<Catalog | null>(null), [error, setError] = useState("");
  const [selected, setSelected] = useState<Product | null>(null), [detail, setDetail] = useState<Detail | null>(null), [detailError, setDetailError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setCatalog(null); setError(""); setSelected(null);
    read<Catalog>(new URLSearchParams({ country: search.country, q: search.query, page: String(search.page) }), controller.signal)
      .then(value => { if (!controller.signal.aborted) { if (!Array.isArray(value.products) || !Number.isSafeInteger(value.found)) throw Error("Invalid catalog response."); setCatalog(value); } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [search]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setDetailError("");
    if (selected) read<Detail>(new URLSearchParams({ id: selected.id }), controller.signal)
      .then(value => { if (!controller.signal.aborted) { if (value.id !== selected.id || !Array.isArray(value.packages)) throw Error("Product details could not be verified."); setDetail(value); } })
      .catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [selected]);
  return <section className="pay-app bitrefill-page" aria-labelledby="bitrefill-title">
    <a className="word-link" href="#pay"><ArrowLeft size={15} /> Back to Pay</a>
    <header className="bitrefill-heading">
      <p className="bitrefill-provider">BITREFILL</p>
      <h1 id="bitrefill-title">Gift cards. From your wallet.</h1>
      <p>Choose a merchant and amount. Review a Solana USDC payment in Fub, or continue on Bitrefill.</p>
    </header>
    <form className="bitrefill-search" onSubmit={event => { event.preventDefault(); setSearch({ country, query: query.trim(), page: 1, revision: search.revision + 1 }); }}>
      <label>Redeem in<select value={country} onChange={event => { setCountry(event.target.value); setSelected(null); setSearch({ country: event.target.value, query: query.trim(), page: 1, revision: search.revision + 1 }); }}>{countries.map(code => <option key={code} value={code}>{regionNames.of(code)}</option>)}</select></label>
      <label>Merchant<input type="search" placeholder="Search gift cards" maxLength={80} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button className="primary-button" type="submit"><Search size={17} /> Search</button>
    </form>
    {error ? <div className="bitrefill-status"><p role="alert">{error}</p><a href={storefront} target="_blank" rel="noopener noreferrer">Browse on Bitrefill <ArrowUpRight size={14} /></a></div> : !catalog ? <p className="bitrefill-status" role="status">Loading gift cards…</p> : <>
      <p className="bitrefill-count" role="status">{catalog.found ? `${catalog.found} gift ${catalog.found === 1 ? "card" : "cards"} · ${regionNames.of(search.country)}` : "No gift cards found. Try another merchant or country."}</p>
      <div className="bitrefill-products">{catalog.products.map(product => <button type="button" key={product.id} className="bitrefill-product" aria-pressed={selected?.id === product.id} onClick={() => setSelected(product)}><MerchantLogo product={product.id} /><span>{product.name}</span><small>{product.currency} · {product.inStock ? "View amounts" : "Unavailable"}</small><ArrowUpRight size={18} /></button>)}</div>
      {(search.page > 1 || search.page * 12 < catalog.found) && <div className="bitrefill-pagination"><button type="button" disabled={search.page === 1} onClick={() => setSearch({ ...search, page: search.page - 1 })}>Previous</button><span>Page {search.page}</span><button type="button" disabled={search.page * 12 >= catalog.found || search.page >= 99} onClick={() => setSearch({ ...search, page: search.page + 1 })}>Next</button></div>}
    </>}
    {selected && <section className="bitrefill-detail" aria-labelledby="bitrefill-product-title" aria-live="polite">
      <div className="bitrefill-detail-heading"><h2 id="bitrefill-product-title" className="merchant-heading"><MerchantLogo product={selected.id} />{selected.name}</h2><button type="button" onClick={() => setSelected(null)}>Close details</button></div>
      {detailError ? <p role="alert">{detailError}</p> : !detail ? <p role="status">Checking amounts and availability…</p> : <>
        <p>{detail.subtitle}</p>{detail.note && <p className="bitrefill-note">{detail.note}</p>}{detail.terms && <p className="bitrefill-note">{detail.terms}</p>}
        {!detail.inStock ? <p role="status">Currently unavailable.</p> : <>
          {detail.packages.length > 0 && <div className="bitrefill-amounts">{detail.packages.map((pack, i) => <div key={i}><strong>{pack.value} {pack.currency}</strong><span>Price {pack.price} {pack.priceCurrency}</span></div>)}</div>}
          <p>{detail.paymentMethods.length ? `Solana payments offered: ${detail.paymentMethods.map(method => method === "solana" ? "SOL" : "USDC").join(", ")}.` : "Check available payment methods at checkout."} Prices and availability are confirmed at checkout.</p>
          <a className="word-link" href={safeLink(detail.url)} target="_blank" rel="noopener noreferrer">Continue on Bitrefill <ArrowUpRight size={17} /></a>
        </>}
      </>}
    </section>}
    <GiftCheckout product={detail} country={country} onDelivered={()=>setSelected(null)} />
    <nav className="bitrefill-extras" aria-label="More Bitrefill products">
      {[
        ['Gift cards', `https://www.bitrefill.com/${country.toLowerCase()}/en/gift-cards/`],
        ['Phone top-ups', 'https://www.bitrefill.com/refill/?hl=en'],
        ['Travel eSIMs', 'https://www.bitrefill.com/esims/?hl=en'],
        ['All products & countries', storefront],
      ].map(([label, href]) => <a key={label} href={href} target="_blank" rel="noopener noreferrer">{label} <ArrowUpRight size={15} /></a>)}
    </nav>
    <section className="bitrefill-payment" aria-labelledby="bitrefill-checkout"><h2 id="bitrefill-checkout">Pay from your Fomo wallet.</h2><p>Fub checkout uses USDC on Solana and saves purchases to your wallet’s history. Keep a little SOL for the network fee. After payment, open your gift card from its purchase receipt.</p><p>Products that need additional verification use Bitrefill’s checkout. Purchases started there stay on Bitrefill.</p><a className="word-link" href="#pay/wallet">Check your wallet balance <ArrowUpRight size={14} /></a></section>
  </section>;
}
