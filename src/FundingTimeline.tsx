import { useEffect, useState } from "react";
import type {
  FundingEvent,
  FundingOperation,
  OperationState,
} from "./funding-model";
import { displayUnits } from "./funding-model";
import { triggerRequest } from "./trigger-api";
const labels: Record<OperationState, string> = {
  preparing: "Preparing transaction",
  prepared: "Ready for your signature",
  submitting: "Submission started",
  submitted: "Awaiting confirmation",
  unknown: "Recovery needed",
  confirmed: "Confirmed",
  failed: "Failed",
  abandoned: "Discarded",
};
export function FundingTimeline({
  operation,
  csrf,
}: {
  operation: FundingOperation;
  csrf: string;
}) {
  const [events, setEvents] = useState<FundingEvent[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError("");
    setEvents(null);
    triggerRequest<{ wallet: string; id: string; events: FundingEvent[] }>(
      "funding-events",
      { wallet: operation.wallet, id: operation.id },
      csrf,
      controller.signal,
    )
      .then((reply) => {
        if (
          reply.wallet !== operation.wallet ||
          reply.id !== operation.id ||
          !Array.isArray(reply.events) ||
          reply.events.length > 50 ||
          reply.events.some(
            (event) =>
              event.operationId !== operation.id ||
              !Object.hasOwn(labels, event.state) ||
              !Number.isFinite(Date.parse(event.recordedAt)),
          )
        )
          throw new Error();
        if (active) setEvents(reply.events);
      })
      .catch(() => {
        if (active)
          setError(
            "Funding history could not be loaded. The recovery request is still saved.",
          );
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    operation.wallet,
    operation.id,
    operation.updatedAt,
    operation.state,
    operation.message,
    csrf,
    revision,
  ]);
  const receipt = operation.receipt;
  function downloadReceipt() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            requestId: operation.id,
            orderId: operation.orderId,
            wallet: operation.wallet,
            direction: operation.kind === "create" ? "deposit" : "withdrawal",
            receipt,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `fomo-funding-${operation.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="funding-timeline" aria-label="Funding history">
      {receipt && (
        <div className="funding-receipt">
          <h3>Verified transfer</h3>
          <p>
            The landed transaction matches the reviewed token, amount and
            destination, and its event appears in Jupiter order history.
          </p>
          <dl className="live-details">
            <dt>Amount</dt>
            <dd>{displayUnits(receipt.amount, receipt.decimals)} tokens</dd>
            <dt>Destination account</dt>
            <dd>{receipt.destination}</dd>
            <dt>Confirmed slot</dt>
            <dd>{receipt.slot.toLocaleString()}</dd>
            <dt>Paid network fee</dt>
            <dd>{displayUnits(receipt.feeLamports, 9)} SOL</dd>
            <dt>Verified</dt>
            <dd>{new Date(receipt.verifiedAt).toLocaleString()}</dd>
          </dl>
          <button className="word-link" onClick={downloadReceipt}>
            Download transfer receipt
          </button>
        </div>
      )}
      <h3>Request timeline</h3>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            className="word-link"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry funding history
          </button>
        </div>
      ) : events === null ? (
        <p className="muted" role="status">
          Loading funding history…
        </p>
      ) : !events.length ? (
        <p className="muted">
          No timeline entries are available for this request.
        </p>
      ) : (
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <div>
                <b>{labels[event.state]}</b>
                <time dateTime={new Date(event.recordedAt).toISOString()}>
                  {new Date(event.recordedAt).toLocaleString()}
                </time>
              </div>
              {event.message && <p>{event.message}</p>}
            </li>
          ))}
        </ol>
      )}
      {events?.length === 50 && (
        <p className="muted">Showing the most recent 50 entries.</p>
      )}
    </section>
  );
}
