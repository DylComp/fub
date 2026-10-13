import { runPayoutHost } from "../server/launch-payout-host.js";
runPayoutHost(process.env).catch(() => {
  console.error(JSON.stringify({ event: "launch_payout_stopped", reason: "Payout configuration, signer, database or provider unavailable." }));
  process.exitCode = 1;
});
