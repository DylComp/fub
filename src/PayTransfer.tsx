import {finishTask,useCompletedTask} from "./task-completion";
import { DirectPay } from "./DirectPay";
import {useWalletSetup} from './WalletSetup';
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { isMint } from "./assets";
import { USDC } from "./funding-model";
import { solanaPayment } from "./pay-model";
import type { PayRequest } from "./pay-model";
import {
  paymentTerms,
  paymentReference,
  paymentRawAmount,
  validPaymentSignature,
} from "./pay-verification";
import type { PaymentCheck } from "./pay-verification";

export function PayTransfer({
  request,
  index,
  copy,
}: {
  request: PayRequest;
  index: number;
  copy: (text: string) => void;
}) {
  const owner=useWalletSetup().connection.session?.address;
  const [directLocked,setDirectLocked]=useState(false);
  const [completedPayment,setCompletedPayment]=useState<{signature:string;owner:string|undefined}|null>(null);
  useCompletedTask(completedPayment?.owner===owner?completedPayment?.signature||null:null,()=>finishTask({message:"USDC payment confirmed.",destination:"#pay"}));
  useEffect(()=>{setCompletedPayment(null);},[owner]);
  const [reference, setReference] = useState("");
  const [signature, setSignature] = useState("");
  const [check, setCheck] = useState<PaymentCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const terms = request.version === 2 ? paymentTerms(request, index) : null;
  // The parent keys this component by request and share. Cleanup prevents an old
  // share's delayed provider response from appearing under a different person.
  useEffect(() => {
    let active = true;
    if (request.version === 2)
      void paymentReference(paymentTerms(request, index))
        .then((ref) => {
          if (active) setReference(ref);
        })
        .catch(() => {
          if (active)
            setError(
              "Payment reference could not be prepared. Reload and try again.",
            );
        });
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [request, index]);
  async function verify() {
    if (!terms || !reference || busy) return;
    const value = signature.trim();
    setError("");
    setCheck(null);
    if (value && !validPaymentSignature(value)) {
      setError(
        "Enter the full Solana transaction signature, or leave it blank to find the payment.",
      );
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const params = new URLSearchParams(
        Object.entries(terms).map(([k, v]) => [k, String(v)]),
      );
      if (value) params.set("signature", value);
      const response = await fetch(`/api/pay?${params}`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(
          typeof result?.message === "string"
            ? result.message
            : "Payment status is unavailable. Try again shortly.",
        );
      if (result?.status === "verified") {
        if (
          !validPaymentSignature(result.signature) ||
          (value && result.signature !== value) ||
          result.reference !== reference ||
          result.recipient !== terms.recipient ||
          result.mint !== USDC ||
          result.rawAmount !== paymentRawAmount(terms) ||
          !isMint(result.sender) ||
          !Number.isSafeInteger(result.slot) ||
          result.slot < 0 ||
          !(result.blockTime === null || Number.isSafeInteger(result.blockTime))
        )
          throw Error("The payment receipt could not be validated.");
      } else if (
        !["pending", "unverified", "failed"].includes(result?.status) ||
        typeof result.message !== "string"
      )
        throw Error("Payment status is unavailable. Try again shortly.");
      if (!abort.signal.aborted) setCheck(result);
    } catch (e) {
      if (!abort.signal.aborted)
        setError(
          e instanceof Error && e.name !== "TimeoutError"
            ? e.message
            : "The check timed out. Payment status is unknown; try again.",
        );
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  const verified = check?.status === "verified";
  return (
    <>
      {terms && !verified && <DirectPay onLocked={setDirectLocked} terms={terms} onVerified={(receipt,justPaid) => { setCheck(receipt); setSignature(receipt.signature); if(justPaid)setCompletedPayment({signature:receipt.signature,owner}); }} />}
      <div className="pay-request-actions">
        {verified ? (
          <span className="pay-confirmed">
            <Check size={17} /> Payment verified on Solana
          </span>
        ) : directLocked ? (
          <span className="pay-note">Check the recorded payment before sending again.</span>
        ) : request.version === 1 || reference ? (
          <a
            className="button primary"
            href={solanaPayment(request, index, reference)}
          >
            Review in a compatible wallet <ArrowUpRight size={16} />
          </a>
        ) : (
          <button className="button primary" disabled>
            Preparing payment…
          </button>
        )}
        <button
          className="button secondary"
          onClick={() => copy(request.recipient)}
        >
          Copy receiving address
        </button>
      </div>
      <p className="pay-note">
        The external wallet link requires Solana Pay support, which is not verified in the Fomo app. Network fees are additional. Fub adds no fee to this request.
      </p>
      {request.version === 1 ? (
        <p className="pay-note">
          This older link has no payment reference and cannot be verified here.
          Create a new request for payment checks.
        </p>
      ) : (
        <section className="pay-verification" aria-label="Payment verification">
          <div className="pay-verification-heading">
            <h3>{verified ? "Your payment receipt" : "Already paid?"}</h3>
            <button
              className="button secondary compact"
              disabled={!reference || busy}
              onClick={() => void verify()}
            >
              {busy
                ? "Checking Solana…"
                : verified
                  ? "Check again"
                  : "Check payment"}
            </button>
          </div>
          {verified ? (
            <>
              <dl className="pay-details">
                <div>
                  <dt>Confirmation</dt>
                  <dd>Finalized on Solana mainnet</dd>
                </div>
                <div>
                  <dt>From</dt>
                  <dd>{check.sender}</dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd>
                    <a
                      className="word-link"
                      href={`https://solscan.io/tx/${check.signature}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View transaction <ArrowUpRight size={14} />
                    </a>
                  </dd>
                </div>
              </dl>
              <button
                className="word-link"
                onClick={() => copy(check.signature)}
              >
                <Copy size={14} /> Copy transaction signature
              </button>
              <p className="pay-note">
                The transfer matches this share. This does not verify the
                sender’s Fomo identity or confirm delivery of goods.
              </p>
            </>
          ) : (
            <>
              <p className="pay-note">
                Check for a finalized USDC transfer matching this share’s
                amount, receiving wallet and payment reference. Opening your
                wallet does not confirm payment.
              </p>
              <details>
                <summary>Check a specific transaction</summary>
                <label className="field">
                  Solana transaction signature
                  <input
                    value={signature}
                    maxLength={88}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      controller.current?.abort();
                      setBusy(false);
                      setSignature(e.target.value);
                      setCheck(null);
                      setError("");
                    }}
                    placeholder="Optional"
                  />
                </label>
              </details>
            </>
          )}
          {check && !verified && (
            <p className="pay-note" role="status">
              {check.message}
            </p>
          )}
          <p className="pay-note">
            Each check reads Solana. Names and personal notes stay out of the
            verification request. A missing result does not mean a payment
            failed.
          </p>
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
