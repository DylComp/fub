import { useEffect, useRef, useState } from "react";
import { shortAddress } from "./assets";
import {
  parseAllocations,
  tokenRaw,
  tokenUnits,
  validateAllocation,
} from "./copy-inventory";
import type {
  InventoryReview,
  InventoryReport,
  InventoryEvent,
  CopyAllocation,
} from "./copy-inventory";
import { TriggerError, triggerRequest } from "./trigger-api";

export function CopyInventory({
  wallet,
  csrf,
  native = false,
}: {
  wallet: string;
  csrf: string;
  native?: boolean;
}) {
  const prefix = native ? "copy-native-inventory" : "copy-inventory";
  const title = native ? "Tokens bought with SOL" : "Copied positions";
  const [report, setReport] = useState<InventoryReport | null>(null);
  const [review, setReview] = useState<InventoryReview | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [contract, setContract] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const retry = useRef<{ id: string; allocations: CopyAllocation[] } | null>(
    null,
  );
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!review) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [review]);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error ? error.message : "The balance check failed.",
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function load(signal: AbortSignal) {
    const result = await triggerRequest<InventoryReport>(
      prefix,
      { wallet },
      csrf,
      signal,
    );
    if (
      result.wallet !== wallet ||
      result.events.some((event) => event.wallet !== wallet)
    )
      throw new Error("Wallet balance response mismatch.");
    if (!signal.aborted) setReport(result);
  }
  async function check(mint: string) {
    await run(async (signal) => {
      setReview(null);
      retry.current = null;
      setUncertain(false);
      setAcknowledged(false);
      const value = await triggerRequest<InventoryReview>(
        `${prefix}-review`,
        { wallet, mint },
        csrf,
        signal,
      );
      if (value.wallet !== wallet || value.mint !== mint)
        throw new Error("Token balance response mismatch.");
      if (signal.aborted) return;
      setReview(value);
      setNow(Date.now());
      setAmounts(
        Object.fromEntries(
          value.positions.map((p) => [p.id, tokenUnits(p.raw, value.decimals)]),
        ),
      );
    });
  }
  let allocations: CopyAllocation[] = [],
    issue = "";
  if (review) {
    try {
      allocations = parseAllocations(
        review.positions.map((p) => ({
          id: p.id,
          raw: tokenRaw(amounts[p.id] || "", review.decimals),
        })),
      );
      validateAllocation(review.positions, allocations, review.balanceRaw);
    } catch (error) {
      issue = error instanceof Error ? error.message : "Check token amounts.";
    }
  }
  const expired = !!review && now >= Date.parse(review.expiresAt);
  async function apply() {
    if (!review || !acknowledged || (!retry.current && (issue || expired)))
      return;
    await run(async (signal) => {
      const body = retry.current || { id: review.id, allocations };
      retry.current = body;
      try {
        const event = await triggerRequest<InventoryEvent>(
          `${prefix}-apply`,
          { wallet, ...body },
          csrf,
          signal,
        );
        if (
          event.wallet !== wallet ||
          event.id !== body.id ||
          event.mint !== review.mint ||
          JSON.stringify(parseAllocations(event.allocations)) !==
            JSON.stringify(body.allocations)
        )
          throw new Error("The correction response could not be verified.");
        if (signal.aborted) return;
        retry.current = null;
        setUncertain(false);
        setReview(null);
        setAcknowledged(false);
        setNotice(
          "Positions corrected. No tokens moved. Buy spending and sale proceeds are unchanged.",
        );
        try {
          await load(signal);
        } catch {
          if (!signal.aborted)
            setError(
              "Correction saved. Refresh positions to reload the record.",
            );
        }
      } catch (error) {
        if (signal.aborted) return;
        if (
          error instanceof TriggerError &&
          [400, 401, 403, 409, 429].includes(error.status)
        ) {
          retry.current = null;
          setUncertain(false);
          if (error.status === 409) setReview(null);
          throw error;
        }
        setUncertain(true);
        throw new Error(
          "The correction result is not confirmed. Retry the same correction to check it before making another change.",
        );
      }
    });
  }
  return (
    <section className="copy-controls copy-inventory" aria-label={title}>
      <div className="section-heading">
        <h3>{title}</h3>
        <button
          className="word-link"
          disabled={busy || uncertain}
          onClick={() => void run(load)}
        >
          {report ? "Refresh positions" : "View positions"}
        </button>
      </div>
      <p className="muted">
        Sold or moved tokens outside this app? Check the balance and reduce what
        each copy plan tracks.
      </p>
      {report && (
        <>
          {!report.tokens.length && (
            <p className="muted">No copied positions in this wallet.</p>
          )}
          {report.tokens.map((token) => (
            <div className="inventory-token" key={token.mint}>
              <div>
                <a
                  className="word-link"
                  href={`https://solscan.io/token/${token.mint}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(token.mint)}
                </a>
                <small>
                  {token.plans} {token.plans === 1 ? "plan" : "plans"}
                </small>
              </div>
              <button
                className="word-link"
                disabled={busy || uncertain}
                onClick={() => void check(token.mint)}
              >
                Check balance
              </button>
            </div>
          ))}
          {report.hasMore && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void check(contract.trim());
              }}
            >
              <label>
                Check another token
                <input
                  value={contract}
                  onChange={(event) => setContract(event.target.value)}
                  placeholder="Exact token contract"
                  disabled={busy || uncertain}
                />
              </label>
              <button
                className="word-link"
                disabled={busy || uncertain || !contract.trim()}
              >
                Check token
              </button>
            </form>
          )}
        </>
      )}
      {review && (
        <div className="inventory-review">
          <h4>Review {shortAddress(review.mint)}</h4>
          <dl className="copy-history-totals">
            <div>
              <dt>Finalized token balance</dt>
              <dd>{tokenUnits(review.balanceRaw, review.decimals)}</dd>
            </div>
            <div>
              <dt>Tracked across copy plans</dt>
              <dd>
                {tokenUnits(
                  review.positions
                    .reduce((sum, p) => sum + BigInt(p.raw), 0n)
                    .toString(),
                  review.decimals,
                )}
              </dd>
            </div>
          </dl>
          <p className="muted">
            This checks your associated token account. A balance cannot tell us
            which plan a manual transfer belonged to. Choose how much each plan
            should keep tracking.
          </p>
          {review.positions.map((p) => (
            <label className="inventory-allocation" key={p.id}>
              <span>
                {p.name || shortAddress(p.id)}
                {p.archived ? " (archived)" : ""}
                <small>
                  Currently {tokenUnits(p.raw, review.decimals)} tokens
                </small>
              </span>
              <input
                aria-label={`Tokens to keep for ${p.name || shortAddress(p.id)}`}
                inputMode="decimal"
                autoComplete="off"
                value={amounts[p.id] || ""}
                disabled={busy || uncertain}
                onChange={(event) => {
                  setAmounts({ ...amounts, [p.id]: event.target.value });
                  setAcknowledged(false);
                }}
              />
            </label>
          ))}
          <p className="copy-help">
            A correction only reduces copied positions. Deposits stay
            unassigned. It does not move tokens, record sale proceeds, or reset
            your daily spending cap.
          </p>
          <label className="inventory-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy || uncertain}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I understand that future proportional sells will use these smaller
            positions.
          </label>
          {expired && !uncertain ? (
            <p role="status" className="muted">
              This review expired. Check the balance again.
            </p>
          ) : (
            !uncertain && issue && <p className="muted small">{issue}</p>
          )}
          <div className="live-order-actions">
            <button
              className="button secondary compact"
              disabled={
                busy || !acknowledged || (!uncertain && (!!issue || expired))
              }
              onClick={() => void apply()}
            >
              {busy
                ? "Checking…"
                : uncertain
                  ? "Retry same correction"
                  : "Save position correction"}
            </button>
            <button
              className="word-link"
              disabled={busy || uncertain}
              onClick={() => void check(review.mint)}
            >
              Check balance again
            </button>
            <button
              className="word-link"
              disabled={busy || uncertain}
              onClick={() => setReview(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {!!report?.events.length && (
        <details className="inventory-audit">
          <summary>Position corrections</summary>
          {report.events.map((event) => (
            <article key={event.id}>
              <p>
                {shortAddress(event.mint)}{" "}
                <time>{new Date(event.createdAt).toLocaleString()}</time>
              </p>
              {event.positions.map((p) => {
                const after = event.allocations.find((a) => a.id === p.id)!;
                return (
                  <p className="muted small" key={p.id}>
                    {p.name || shortAddress(p.id)}:{" "}
                    {tokenUnits(p.raw, event.decimals)} →{" "}
                    {tokenUnits(after.raw, event.decimals)} tokens
                  </p>
                );
              })}
            </article>
          ))}
        </details>
      )}
      {notice && (
        <p role="status" className="copy-save-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  );
}
