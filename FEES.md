# Creator fees, payouts and buybacks

## Community launches

For SOL-paired coins launched through Fub, the creator-fee split is:

- **80%** to the Solana wallet selected through the Fomo recipient flow.
- **20%** to the Fub buyback treasury.

These percentages concern creator fees. They are not percentages of total trading volume, the launcher's opening buy or every fee charged by the underlying protocol. Selecting a recipient does not prove that recipient endorsed or created the coin.

## Collection is a transaction

Pump creator fees accumulate in vaults. The intended payout schedule checks once per minute and distributes when at least **0.003 SOL** is available. Configured splits establish the recipients; a distribution transaction releases accrued funds. A one-minute check interval is not a promise that every transfer settles in one minute.

Collection requires an operational worker, available RPC/provider services and network-fee funds. Fees can continue accumulating while distribution is delayed. The buyback worker is a separate process from creator-fee distribution.

## Official Fub token

The official coin is a separate launch with its own intended split:

- **80%** for purchases and burns of the official Fub token.
- **20%** for development.

Community launches' 20% treasury allocation also targets that same official token for buybacks. Treasury funds can accumulate before the official mint is configured. Receipt of fees is not proof that a buy or burn has happened; transaction receipts are needed for each operation.

The official mint must be configured and buybacks activated within their spending/slippage limits. Engineering tokens and their test burns are not the official coin. No official mint is declared by this document.

## Other costs

Launch creation, token-account setup, trades, payments, fee collection and burns can require network fees or account rent. Cross-chain routes can include bridge/routing costs and destination gas. A merchant gift-card invoice can cost more than the card's face value. Review the actual transaction/invoice; the creator-fee split above is not a universal fee schedule for the entire product.

Code: [launch publication](src/launch-publication.ts), [buyback model](server/buyback-model.ts), [buyback worker](server/buyback-worker.ts), [hosted workers](workers/).
