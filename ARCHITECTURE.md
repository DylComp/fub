# Architecture and transaction lifecycle

Fub combines a browser application, HTTP APIs, durable storage and hosted workers. This page describes responsibilities, not a guarantee about a live deployment's configuration or uptime.

## Components

| Component | Responsibility | Review entry points |
| --- | --- | --- |
| Browser | Display profiles/quotes, collect exact approvals, connect/import wallets, show saved progress | [WalletSetup](src/WalletSetup.tsx), [PrivyImport](src/PrivyImport.tsx), [CashCopyActivation](src/CashCopyActivation.tsx) |
| Web APIs | Validate requests, retrieve data, prepare workflows and expose results | [api](api/), [server](server/) |
| Private signer | Verify permission, policy and transaction constraints before requesting provider signatures | [signer worker](workers/signer.ts), [provider signing](server/privy-sign-only.ts) |
| Observation | Detect candidate leader events; candidates are not immediately accepted as trades | [observer worker](workers/observer.ts), [cash observer](server/cash-copy-observer.ts) |
| Delivery/recovery | Submit and reconcile saved attempts without treating an unknown result as a clean failure | [copy delivery](server/cash-copy-delivery.ts), [execution store](server/cash-copy-execution-store.ts) |
| Fee/buyback workers | Collect/distribute creator fees; separately purchase and burn the configured token within limits | [workers](workers/), [buyback worker](server/buyback-worker.ts) |
| Databases | Persist plans, budget usage, positions, transactions and private operational records | [application migrations](migrations/), [signer migrations](signer-migrations/) |

## Automatic-copy flow

1. Resolve and select a leader wallet. The follower uses their own wallet and their own budget.
2. Verify follower ownership, provider delegation and the signed plan scope.
3. Observe a candidate leader trade. Verify its network, payment, destination, decoded route and freshness using supported data sources.
4. Obtain and validate the follower's own route. Check remaining budget, balance, slippage, gas and transaction contents.
5. Save the attempt and request a signature through the private signer. Delivery and confirmation remain distinct from signature approval.
6. Reconcile delivered tokens into the plan's inventory. A proportional sale applies to that tracked inventory, not unrelated holdings.
7. For cross-chain sales, reconcile the return to the source wallet's Solana USDC balance. A provider status update alone is not the final balance receipt.

A detected sale may be held while an earlier copied purchase is arriving. This is not permission to execute arbitrarily old signals: expiry and freshness checks still apply. Unsupported routes are rejected rather than treated as equivalent because they use the same token.

Relevant code: [copy service](server/cash-copy-service.ts), [inventory](server/cash-copy-inventory.ts), [permission](server/cash-copy-permission.ts), [journal](server/cash-copy-journal.ts).

## Fast data is not final settlement

Live streams reduce waiting for events. They do not remove transaction validation or replace settlement checks. The status stream accepts only matching, fresh updates and retains fallback verification. A fast leader observation, a submitted copy and a completed USDC return are different measurements.

Review [status stream](server/cash-status-stream.ts) and [status proof](server/cash-status-proof.ts). No subsecond execution or identical leader/follower price is promised.

## Dependencies and operation

Wallet infrastructure, RPCs, route/bridge services, market feeds and payment providers can be delayed or unavailable. Service restarts, rate limits and depleted fee balances also affect execution. Durable state supports recovery; it does not provide continuous availability by itself.

Operators must maintain credentials, signer policy configuration, database migrations, fee balances, backups and runtime health. User disconnection does not stop a hosted worker. Example execution switches are disabled so checking out this repository does not authorize trading.

The public snapshot excludes production configuration and private evidence. It permits review of code paths, not independent verification of every live server setting. See [FEATURE-STATUS.md](FEATURE-STATUS.md) and [WALLET-SECURITY.md](WALLET-SECURITY.md).
