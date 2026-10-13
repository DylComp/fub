import result from './launch-table-result.json';
export function LaunchTableSetup() {
  return <section className="launchpad" aria-label="Launch infrastructure setup"><div className="launch-form">
    <h2>Launch setup complete.</h2>
    <p className="copy-help">The address table is finalized. Launching a coin with an initial buy now fits in one transaction and passes simulation.</p>
    <dl><dt>Wallet</dt><dd>the approved test wallet</dd><dt>Total paid</dt><dd>0.00158996 SOL</dd><dt>Approved cap</dt><dd>0.0016 SOL</dd></dl>
    <p className="copy-help">No coin was launched. Trading permissions are unchanged.</p>
    <a className="word-link" href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noopener noreferrer">View confirmed transaction</a>
    <p><a className="word-link" href="/#launch">Back to launchpad</a></p>
  </div></section>;
}
