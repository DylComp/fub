# Feature scope and verification

Status as documented on **October 13, 2026**. This is an engineering summary, not a live status endpoint or independent audit. Private funded-test journals are not published; public tests use synthetic data. Passing a test does not prove every token, route or provider combination works.

| Feature | Implemented scope | Verification boundary |
| --- | --- | --- |
| Wallet research | Fomo profile lookup; available names, images, holdings, trades and statistics | Matched wallets can be selected while optional stats load. Missing/stale provider data can remain unavailable. A username match is not ownership proof. |
| Wallet import | Same-address Solana import, ownership login and reconnect | Private key enters the browser and Privy SDK. See the full trust model before using it. |
| Solana limit orders | Price/market-cap orders, bounded buys/sales, cancellation and recovery | **Public buys and sells enabled.** Funded curve/PumpSwap buy, sell and cancel workflows passed. Wallet access and signed order limits remain required. |
| Manual cross-chain trading | Solana USDC purchases and sale returns on supported routes across Base, BNB, Monad, Robinhood, Arc and Ethereum | Public manual access is enabled for these six networks on supported routes. Funded buy/return workflows passed on all six; availability, minimums and liquidity vary by token and route. |
| Cross-chain limit orders | Independent signed USDC-price buy/sell orders, wallet-balance checks, durable signing and recovery | Implementation and isolated database workflows pass. Public execution remains disabled pending funded acceptance. These use guaranteed route execution prices, including route costs, rather than chart prices or market cap. |
| Automatic cross-chain copying | Leader detection, scoped signing, budget/inventory tracking and buy/sale recovery | Public automatic copying supports Robinhood on verified routes. Other networks remain outside public automatic admission pending complete acceptance; manual trade tests do not substitute for automatic-copy tests. |
| Phantom copy connection | External Solana connection and applicable ownership/plan messages | Unattended execution still requires same-wallet private signing setup and approvals. Connection alone is insufficient. |
| Pump launches | SOL-paired creation, optional opening buy, recipient selection and fixed fee split | Engineering launch and fee-payout workflows exercised. Custom pair-token launches are not part of the current public flow. |
| Buy and burn | Treasury purchase/burn worker with transaction checks and spending limits | Engineering workflow exercised. Official-mint configuration and activation are separate final steps. |
| Merchant gift cards | Invoice payment from Fomo Solana USDC and private receipt recovery | Funded purchase, delivery and history checks passed. Selecting a merchant brings its details into view. Product/country availability depends on provider terms. |
| Split and Treat | Shared-bill requests and direct Solana USDC payments | Separate exact payment approvals; opening a link does not pay it. |
| Phone top-ups/eSIMs | Links to Bitrefill products | External checkout and receipts; not represented as purchases handled inside Fub. |
| General spending cards | Not included | No issued debit/prepaid card, Apple Pay or automatic merchant checkout debit is claimed. |

## Market charts

Selected-token charts display one-second candles and refresh approximately every five seconds while viewed. Paid streaming is not enabled; one-second candles do not mean one-second delivery or subsecond execution.

## Remaining release work

- Finish automatic-copy acceptance for quick sales, consecutive reuse and the remaining chain-specific buy/return paths. A repaired route verified against a recorded transaction is not a completed funded cycle.
- Verify public admission against the accepted chains and routes. Solana limit buys and sells are already enabled; automatic cross-chain copying is admitted separately by network, currently Robinhood.
- Configure and activate the official token’s buybacks after its mint is supplied and the final policy is approved. Community fee distribution already runs independently of that mint.

## Before the official mint

Complete remaining automatic-copy acceptance, inspect unresolved attempts and positions, and verify the relevant live settings. Configure the official mint and its separate fee arrangement only when that launch is authorized. Do not mistake an engineering token for the official token.

Public-source availability, an unsigned simulation and a successful manual transaction each establish different things. None alone establishes unrestricted production automatic copying. There is no claim of zero defects, zero maintenance, all-token coverage or permanent uptime.

Review the implementation in [src](src/), [server](server/) and [workers](workers/); read the [architecture](ARCHITECTURE.md), [fee model](FEES.md) and [wallet-security explanation](WALLET-SECURITY.md).
