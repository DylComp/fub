import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { Page } from "./navigation";
import type { Kind } from "./model";
import { directorySol, validDirectory } from "./token-directory-model";
import type { DirectoryResult } from "./token-directory-model";
import "./overview.css";
import { HubHeadline } from "./HubHeadline";
export function Overview({
  onNavigate,
  onPlan,
}: {
  onNavigate: (page: Page) => void;
  onPlan: (kind: Kind) => void;
}) {
  const [directory, setDirectory] = useState<DirectoryResult | null>(null),
    [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setFailed(false);
    void fetch("/api/token-directory?view=tokens", {
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(12000)]),
    })
      .then(async (r) => {
        const data: unknown = await r.json();
        if (!r.ok || !validDirectory(data, "tokens")) throw Error();
        if (!c.signal.aborted) setDirectory(data);
      })
      .catch(() => {
        if (!c.signal.aborted) setFailed(true);
      });
    return () => c.abort();
  }, [revision]);
  return (
    <div className="fub-overview">
      <section className="hub-intro" aria-labelledby="hub-title">
        <div>
          <p className="eyebrow">FUB / FOMO HUB</p>
          <HubHeadline />
          <p className="hub-intro-copy">
            More tools for Fomo users. Stay with the wallet and community you
            already use.
          </p>
          <div className="hub-intro-actions">
            <button
              className="button primary"
              onClick={() => onNavigate("Launch")}
            >
              Launch a coin
              <ArrowUpRight size={16} />
            </button>
            <button className="word-link" onClick={() => onNavigate("Orders")}>
              Explore trading tools
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
        <aside className="hub-index" aria-label="Inside Fub">
          {[
            {
              n: "01",
              name: "Trading",
              detail: "Entries, exits and copying",
              page: "Orders",
            },
            {
              n: "02",
              name: "Fomo Pay",
              detail: "Spend, split and treat",
              page: "Pay",
            },
            {
              n: "03",
              name: "Launchpad",
              detail: "Coins for people on Fomo",
              page: "Launch",
            },
          ].map((item) => (
            <button key={item.n} onClick={() => onNavigate(item.page as Page)}>
              <span>{item.n}</span>
              <div>
                <strong>{item.name}</strong>
                <small>{item.detail}</small>
              </div>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </aside>
      </section>
      <div className="hub-section-title">
        <h2>Built around your wallet.</h2>
        <button className="word-link" onClick={() => onNavigate("Docs")}>
          Read the docs
          <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="hub-tools">
        <section className="hub-tool hub-orders" aria-label="Trading tools">
          <div className="hub-tool-heading">
            <span className="hub-label">ORDERS</span>
            <button className="word-link" onClick={() => onNavigate("Orders")}>
              Open Orders
              <ArrowUpRight size={14} />
            </button>
          </div>
          <h2>
            Set the entry.
            <br />
            Plan the exit.
          </h2>
          <p>
            Set a buy or sell limit by market cap or price, choose the amount, and give it an expiry.
          </p>
          <div className="hub-order-options">
            <button onClick={() => onPlan("Limit")}>
              <span><strong>Limit orders</strong><small>Your level. Your size.</small></span>
              <ArrowUpRight size={15} />
            </button>
          </div>
          <p className="hub-feature-note">
            Explore strategies in the planner. Execution requires supported
            wallet permissions.
          </p>
        </section>
        <section
          className="hub-tool hub-copy"
          aria-label="Copy trading overview"
        >
          <div className="hub-tool-heading">
            <span className="hub-label">COPY TRADING</span>
            <button
              className="word-link"
              onClick={() => onNavigate("Copy trading")}
            >
              Find a trader
              <ArrowUpRight size={14} />
            </button>
          </div>
          <h2>
            Their trades.
            <br />
            Your limits.
          </h2>
          <p>
            Save a public Fomo wallet with your own buy size, daily cap,
            slippage limit, and optional proportional sells.
          </p>
          <div className="hub-copy-rules" aria-label="Copy plan controls">
            <div>
              <span>Buy size</span>
              <strong>Your amount</strong>
            </div>
            <div>
              <span>Daily cap</span>
              <strong>Your budget</strong>
            </div>
            <div>
              <span>Slippage</span>
              <strong>Your limit</strong>
            </div>
            <div>
              <span>Proportional sells</span>
              <strong>Your choice</strong>
            </div>
          </div>
          <p className="hub-feature-note">
            Inspect the wallet before following. Automatic copying needs a
            separate trading authorization.
          </p>
        </section>
        <section className="hub-tool hub-pay" aria-label="Fomo Pay overview">
          <div className="hub-pay-copy">
            <div className="hub-tool-heading">
              <span className="hub-label">FOMO PAY</span>
            </div>
            <h2>Beyond the trade.</h2>
            <p>
              Gift cards paid with USDC. A link to split the bill. A treat
              for a friend.
            </p>
            <div className="hub-pay-actions">
              <button className="word-link" onClick={() => onNavigate("Pay")}>
                Explore Fomo Pay
                <ArrowUpRight size={15} />
              </button>
              <a className="word-link" href="#pay-request">
                Create a USDC request
                <ArrowUpRight size={15} />
              </a>
            </div>
            <p className="hub-feature-note">
              Buy supported gift cards, request a share of the bill, or send
              USDC to a friend. Each payment needs your wallet approval.
            </p>
          </div>
          <div className="hub-pay-visual" aria-hidden="true">
            <div className="hub-pay-words">
              <span>Split the bill</span>
              <span>Lunch on me</span>
              <span>
                Send a request <ArrowUpRight size={20} />
              </span>
            </div>
            <img src="/avatars/friends-city.png" alt="" loading="lazy" />
          </div>
        </section>
      </div>
      <section className="hub-launch" aria-labelledby="hub-launch-title">
        <div className="hub-launch-copy">
          <span className="hub-label">THE FUB LAUNCHPAD</span>
          <h2 id="hub-launch-title">
            Launch a coin.
            <br />
            Choose who earns.
          </h2>
          <p>
            Choose a Fomo username, confirm its wallet, and prepare a Pump.fun
            launch. Each coin has its own recipient.
          </p>
          <button
            className="button primary"
            onClick={() => onNavigate("Launch")}
          >
            Create your coin
            <ArrowUpRight size={16} />
          </button>
          <p className="hub-feature-note">
            Review the recipient and permanent 80/20 fee split, then approve
            the launch in your wallet.
          </p>
        </div>
        <div className="hub-fee-flow" aria-label="Creator fee allocation">
          <div className="hub-fee-source">
            Creator fees <span>Every Fub launch</span>
          </div>
          <div className="hub-fee-split">
            <div>
              <strong>
                80<span>%</span>
              </strong>
              <h3>Fomo recipient</h3>
              <p>
                To the wallet chosen
                <br />
                for that coin.
              </p>
            </div>
            <div>
              <strong>
                20<span>%</span>
              </strong>
              <h3>Fub buy & burn</h3>
              <p>
                To buy and burn
                <br />
                the official Fub token.
              </p>
            </div>
          </div>
          <button className="word-link" onClick={() => onNavigate("Activity")}>
            Follow the receipts
            <ArrowRight size={14} />
          </button>
        </div>
      </section>
      <section className="hub-platform" aria-label="Fub platform records">
        <div className="hub-section-title">
          <div>
            <h2>Across Fub.</h2>
            <p>Confirmed launches and recipient payouts.</p>
          </div>
          <button className="word-link" onClick={() => onNavigate("Tokens")}>
            Browse tokens
            <ArrowUpRight size={14} />
          </button>
        </div>
        {failed ? (
          <div className="hub-records-error" role="status">
            Platform records could not be refreshed.
            {directory ? " Last loaded totals are shown." : ""}{" "}
            <button
              className="word-link"
              onClick={() => setRevision((v) => v + 1)}
            >
              Retry
            </button>
          </div>
        ) : null}
        <dl className="hub-platform-stats">
          <div>
            <dt>Coins launched</dt>
            <dd>
              {directory
                ? directory.totals.tokens.toLocaleString()
                : failed
                  ? "Unavailable"
                  : "Loading"}
            </dd>
          </div>
          <div>
            <dt>Fomo recipients</dt>
            <dd>
              {directory
                ? directory.totals.profiles.toLocaleString()
                : failed
                  ? "Unavailable"
                  : "Loading"}
            </dd>
          </div>
          <div>
            <dt>Paid to recipients</dt>
            <dd>
              {directory ? (
                <>
                  {directorySol(directory.totals.recipientSent)}{" "}
                  <small>SOL</small>
                </>
              ) : failed ? (
                "Unavailable"
              ) : (
                "Loading"
              )}
            </dd>
          </div>
        </dl>
      </section>
      <nav className="hub-destinations" aria-label="Explore Fub">
        {[
          {
            page: "Wallets",
            title: "Wallets",
            text: "Inspect holdings and recent transactions.",
          },
          {
            page: "Tokens",
            title: "Tokens & profiles",
            text: "See every launch and the people receiving fees.",
          },
          {
            page: "Activity",
            title: "Activity",
            text: "Follow launches, trades, payouts and burn receipts.",
          },
          {
            page: "Docs",
            title: "Documentation",
            text: "Features, fee routing and wallet permissions.",
          },
        ].map((item) => (
          <button key={item.page} onClick={() => onNavigate(item.page as Page)}>
            <div>
              <strong>{item.title}</strong>
              <span>{item.text}</span>
            </div>
            <ArrowUpRight size={18} />
          </button>
        ))}
      </nav>
    </div>
  );
}
