import './wallet-polyfills';
import { useState } from 'react';
import bs58 from 'bs58';
import type { WalletConnection } from './useWallet';
import { BUYBACK_SETUP, verifySignedBuybackSetup } from './buyback-setup';
import type { BuybackSetupReview } from './buyback-setup';
const STORAGE = 'fub.buyback-setup.signature.v1';
const PACKET = 'fub.buyback-setup.packet.v1';
function savedSignature() { try { return localStorage.getItem(STORAGE) || ''; } catch { return ''; } }
async function request(body: unknown) {
  const response = await fetch('/api/launch-execute', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fomo-Request': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const result = await response.json();
  if (!response.ok) throw Error(result.message || 'Setup could not be checked.');
  return result;
}
export function BuybackSetup({ connection, onConnect }: { connection: WalletConnection; onConnect: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [signature, setSignature] = useState(savedSignature), [complete, setComplete] = useState(false);
  async function run(sign: boolean) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('Checking accounts and simulating the exact setup…');
    try {
      if(!sign){
        const saved=localStorage.getItem(PACKET);
        if(saved){
          const pending=JSON.parse(saved);
          const tx=await verifySignedBuybackSetup(pending.review,pending.signed);
          const id=bs58.encode(tx.signatures[0]);
          if(id!==signature)throw Error('Stored setup does not match its transaction ID.');
          const resumed=await request({action:'submit-buyback-setup',review:pending.review,signed:pending.signed});
          if(resumed.state==='failed')throw Error('Setup failed on chain. Keep this receipt for review.');
          if(resumed.state==='expired_unresolved')throw Error('Setup expired without a known receipt. Its packet is saved for recovery; do not sign a replacement yet.');
        }
      }
      const result = await request({ action: 'prepare-buyback-setup' });
      if (result.complete) { setComplete(true); setMessage('Both treasury accounts are finalized. Account setup is complete.'); return; }
      if (!sign) { setMessage('Account setup is not finalized yet. Check the saved transaction before retrying.'); return; }
      if (signature) throw Error('A setup transaction was already signed. Check its receipt before creating another transaction.');
      const review: BuybackSetupReview = result.review;
      setMessage(`Confirm account setup in your wallet. Simulated cost: ${(review.debit / 1e9).toFixed(8)} SOL.`);
      const signed = await connection.signBuybackSetup(review);
      const transaction = await verifySignedBuybackSetup(review, signed), id = bs58.encode(transaction.signatures[0]);
      // Save the signature before submission so an interrupted response cannot
      // encourage an accidental new transaction while this one is unresolved.
      localStorage.setItem(PACKET,JSON.stringify({review,signed}));
      localStorage.setItem(STORAGE, id); setSignature(id);
      const sent = await request({ action: 'submit-buyback-setup', review, signed });
      if (sent.complete) { setComplete(true); setMessage('Both treasury accounts are finalized.'); }
      else if(sent.state==='failed')throw Error('Setup failed on chain. Keep this receipt for review.');
      else if(sent.state==='expired_unresolved')throw Error('Setup expired without a known receipt. Its packet is saved for recovery; do not sign a replacement yet.');
      else setMessage('Setup submitted. Check confirmation in a few seconds. This retries only the same signed packet. No tokens were bought.');
    } catch (e) { setMessage(''); setError(e instanceof Error ? e.message : 'Setup could not complete.'); }
    finally { setBusy(false); }
  }
  return <section className="launchpad" aria-label="Treasury account setup"><div className="launch-form">
    <h2>{complete ? 'Treasury accounts ready.' : 'Prepare the treasury.'}</h2>
    <p className="copy-help">Create the token account and Pump volume account for the approved FUBTEST engineering check.</p>
    <dl><dt>Paying wallet</dt><dd>the approved test wallet</dd><dt>Maximum setup cost</dt><dd>0.00288 SOL</dd><dt>Purchase and burn</dt><dd>Separate test, not started by this setup.</dd></dl>
    {message && <p role="status" className="copy-help">{message}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {!complete && !signature && (connection.session?.address === BUYBACK_SETUP.owner
      ? <button className="button primary" disabled={busy} onClick={() => void run(true)}>{busy ? 'Checking setup…' : 'Approve account setup'}</button>
      : <button className="button primary" onClick={onConnect}>Connect the approved test wallet</button>)}
    <button className="button secondary" disabled={busy} onClick={() => void run(false)}>Check confirmation</button>
    {signature && <p><a className="word-link" href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noopener noreferrer">View setup transaction</a></p>}
    <p><a className="word-link" href="/#launch">Back to launchpad</a></p>
  </div></section>;
}
