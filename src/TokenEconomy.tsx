import { useState } from "react";
import { formatSol } from "./creator-fees";
import { launchFeeAllocation } from "./launch-model";
import { creatorFeeAllocation } from "./creator-fees";
export function TokenEconomy() {
  const [source, setSource] = useState<'launchpad'|'official'>('launchpad');
  const [fees, setFees] = useState(""),
    [error, setError] = useState("");
  const [result, setResult] = useState<ReturnType<
    typeof launchFeeAllocation
  > | null>(null);
  return (
    <article className="token-economy" aria-label="Creator fees and buybacks">
      <section className="token-thesis">
        <span className="pay-label">THE PROJECT TOKEN</span>
        <h2>
          Creator fees.
          <br />
          Back into the token.
        </h2>
        <p>
          Coins launched through Fub send 80% of creator fees to their chosen Fomo user and 20% to buying and burning Fub. The separately launched official Fub coin sends 80% to its own buy-and-burn budget and 20% to the development wallet.
        </p>
        <p>
          Orders, Fomo Pay and the launchpad share one platform token. Buybacks use collected creator fees. It does not draw from user trading balances, split
          payments or gifts.
        </p>
      </section>
      <ol className="token-flow">
        <li>
          <span>01</span>
          <h3>Collect</h3>
          <p>
            Record the creator fees actually received. Check the coin’s fee
            recipients and launch settings.
          </p>
        </li>
        <li>
          <span>02</span>
          <h3>Buy</h3>
          <p>
            Use the approved allocation to buy the exact project mint. Keep
            execution costs within its budget.
          </p>
        </li>
        <li>
          <span>03</span>
          <h3>Burn</h3>
          <p>
            Destroy the purchased tokens on Solana. Publish the buy and burn
            transaction records separately.
          </p>
        </li>
      </ol>
      <section className="token-plan-grid">
        <div>
          <h2>Every step should be visible.</h2>
          <p>
            The public record should show collected fees, the allocation, tokens
            bought, tokens burned and transaction links. A purchase is not a
            burn until the chain confirms it.
          </p>
          <dl className="token-status">
            <div>
              <dt>Launch platform</dt>
              <dd>Pump.fun</dd>
            </div>
            <div>
              <dt>Project mint</dt>
              <dd>Not configured</dd>
            </div>
            <div>
              <dt>Fub launchpad coins</dt>
              <dd>80% recipient / 20% platform token</dd>
            </div>
            <div>
              <dt>Official Fub coin</dt>
              <dd>80% buy and burn / 20% development</dd>
            </div>
            <div>
              <dt>Automatic execution</dt>
              <dd>Not activated</dd>
            </div>
          </dl>
          <p className="pay-note">
            The official mint, buyback treasury and development wallet must be
            configured and their on-chain fee split verified before activation.
            A fee allocation is not evidence of a completed purchase or burn.
          </p>
        </div>
        <form
          className="pay-compose"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            try {
              const split=launchFeeAllocation(creatorFeeAllocation(fees, "20").received);
              setResult(source==='official'?{buyback:split.recipient,recipient:split.buyback,dust:split.dust}:split);
            } catch (e) {
              setResult(null);
              setError(
                e instanceof Error ? e.message : "Check the allocation.",
              );
            }
          }}
        >
          <h2>Work out the allocation.</h2>
          <p className="pay-note">
            A calculation using your inputs. It does not save a policy or
            activate buying.
          </p>
          <label className="field">
            Fee source
            <select aria-label="Fee source" value={source} onChange={e=>{setSource(e.target.value as 'launchpad'|'official');setResult(null);setError('');}}>
              <option value="launchpad">Coin launched through Fub</option>
              <option value="official">Official Fub coin</option>
            </select>
          </label>
          <label className="field">
            Collected creator fees in SOL
            <input
              required
              inputMode="decimal"
              value={fees}
              placeholder="0.00"
              onChange={(e) => {
                setFees(e.target.value);
                setResult(null);
              }}
            />
          </label>
          <p className="pay-note">{source==='official'?'Official coin: 80% to Fub buy-and-burn, 20% to the development wallet.':'Launchpad coin: 80% to the selected Fomo user, 20% to Fub buy-and-burn.'}</p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="button secondary full">
            Calculate allocation
          </button>
          {result && (
            <dl className="token-status" aria-live="polite">
              <div>
                <dt>Buyback budget</dt>
                <dd>{formatSol(result.buyback)} SOL</dd>
              </div>
              <div>
                <dt>{source==='official'?'Development wallet':'Fomo recipient'}</dt>
                <dd>{formatSol(result.recipient)} SOL</dd>
              </div>
            </dl>
          )}
          {result && result.dust > 0n && <p className="pay-note">{result.dust.toString()} lamport retained as rounding dust in the fee vault.</p>}
          <p className="pay-note">
            Network and execution costs must fit inside the allocated budget.
            The allocation alone cannot predict how many tokens a swap will buy
            or what their price will do.
          </p>
        </form>
      </section>
    </article>
  );
}
