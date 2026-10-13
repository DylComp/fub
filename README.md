<p align="center"><img src="public/brands/fub-banner-v7.png" alt="Fub — More tools for Fomo" width="100%" /></p>

<h1 align="center">Fub — Fomo Hub</h1>
<p align="center">More tools for Fomo.</p>
<p align="center"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square" /> <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square" /> <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square" /></p>
<p align="center"><a href="https://usefub.app">Website</a> · <a href="https://usefub.app/#docs">Product docs</a> · <a href="https://x.com/FubTool">X</a></p>

Fub brings wallet research, orders, copy trading, token launches and crypto payments into one interface for Fomo users. This repository contains the application and service source code. Fub is an independent product; a Fomo username lookup is not permission to spend from that wallet.

## Read this before importing a wallet

**Private import adds provider signing capability for your existing wallet.** The address stays the same, but the trust model changes. Fub's browser code handles the key during import and passes it to Privy's SDK; backend automation later uses separately delegated signing authority. A browser connection by itself cannot authorize unattended trades.

| Guide | What it explains |
| --- | --- |
| [Wallet import and signing](WALLET-SECURITY.md) | Where the key is processed, what permissions mean, Phantom copying, revocation and remaining risks |
| [Architecture](ARCHITECTURE.md) | Browser, signer, observation, delivery, storage and recovery responsibilities |
| [Feature scope and verification](FEATURE-STATUS.md) | What is implemented, tested, still under acceptance or excluded |
| [Fees and buybacks](FEES.md) | Community 80/20 splits, official-token arrangements and collection costs |
| [Security reports](SECURITY.md) | Private vulnerability reporting, audit limitations and dependency review |

The code is available for inspection, not as proof that no trust is required. No independent security audit is claimed, and automatic cross-chain acceptance is not complete.

## What you can use

As of October 13, 2026, supported Solana limit buys and sells and manual USDC buy/return routes on six EVM networks are enabled publicly. Cross-chain limit execution remains disabled pending funded acceptance. Launches, creator-fee distribution, merchant gift cards, Split/Treat and wallet research are available within their documented scope. Automatic cross-chain copying remains under acceptance and is not presented as an unrestricted public service. See [feature status](FEATURE-STATUS.md) for the distinction between tested workflows and public activation.

## Features

- **Wallets:** search Fomo profiles and public addresses; inspect supported balances, holdings and transaction data. Provider coverage and freshness determine which statistics are available.
- **Limit orders:** place supported Solana limit buys and sells using market-cap or price targets, with signed amounts, expiry, cancellation and transaction recovery. Public activation does not remove wallet-access or order approvals.
- **Copy trading:** observe supported leader trades, verify their source payments and route, enforce signed limits, and reconcile copied positions and returns. Manual cross-chain buy-and-return workflows exist alongside automatic-copy execution.
- **Launches:** create SOL-paired Pump tokens with creator fees split 80% to the selected Fomo recipient and 20% to the Fub buyback treasury. Fee collection, distribution and buybacks are separate transaction workflows.
- **Pay:** pay supported merchant gift-card invoices with Solana USDC, reopen private receipts, and use direct Split/Treat transfers.

## Privy and private-key handling

Fub uses **Privy** for importing the existing wallet and requesting wallet signatures. The import form validates the address locally and passes the entered key to Privy’s SDK. Fub’s intended import path does not send the raw key to its own backend or save it in browser storage. The key still exists in the browser during setup, and importing adds a provider trust dependency.

Background trading requires a separate provider signer delegation and signed order or copy limits. Fub’s service checks those limits before requesting signatures; importing a wallet is not blanket permission to trade. Users can pause plans and revoke background access, but neither action reverses a submitted transaction. Read [the full security model](WALLET-SECURITY.md), including browser exposure, service credentials and revocation limits. No independent security audit or risk-free custody claim is made.

## Wallet model

Pay and trading use a privately imported Fomo Solana wallet. The address and funds stay the same; ownership is verified before Privy imports the wallet. The implemented import path does not send the raw key to a Fub backend endpoint; it passes it to Privy’s SDK in the browser. This does not mean the key never leaves the device or that the browser/provider cannot be compromised. Manual payments require their own confirmation, and automation requires separate bounded permissions.

Phantom and other external Solana wallets can connect for coin launches and copy trading. Automatic copying still requires private signing setup for that same wallet and approved plan limits. Pay and orders use the imported Fomo wallet. SOL and Solana USDC share its address; cross-chain buys spend its USDC and return sale proceeds there, while purchased tokens use a separately linked destination wallet.

## Release status

Supported Solana limit buys and sells are publicly enabled; funded buy/sell/cancel workflows have acceptance evidence. Manual cross-chain purchase/return workflows also have acceptance evidence, separately from their public admission settings. Automatic cross-chain copying is still under acceptance: rapid consecutive cycles and several chain-specific buy/sale routes remain release gates. A working route or a successful simulation does not establish support for every token or every provider route.

The official Fub mint and its buyback configuration are separate from engineering-test tokens. Community launches use the 80/20 split above; the intended official-token split is 80% for buybacks and 20% for development. No official mint address or production signing credentials are supplied by this repository.

Execution is disabled in the example configuration. Applicable provider access, country/product restrictions, wallet permissions, RPC capacity and operating balances remain deployment requirements. General-purpose spending cards are not part of this release. The repository is not a promise of unattended operation or subsecond trading.

## Architecture

| Directory | Purpose |
| --- | --- |
| `src/` | React interface, wallet integrations and shared models |
| `api/` | HTTP entry points for the web deployment |
| `server/` | Validation, storage, transaction preparation, provider adapters and recovery |
| `workers/` | Long-running observer, signer, execution, fee, lookup and recovery processes |
| `migrations/` | Application database schema migrations |
| `signer-migrations/` | Private signer database schema migrations |
| `vendor/` | Compatibility adapters and the Relay order-verifier type declaration |
| `tests/` | Selected synthetic regression tests; no customer receipts or funded-test journals |
| `scripts/` | Build and local runtime-verification scripts |

The web application, private signer and transaction delivery workers have distinct responsibilities. Wallet ownership, signing permissions and per-plan spending limits are checked separately. Signed attempts are journaled before delivery; an uncertain result is reconciled before a replacement can be considered. Secret values and private account records are not browser configuration.

## Run locally

Use Node.js 24 or newer and npm.

```sh
npm ci
cp .env.example .env.local
npm run build
npm test
npm run dev
```

The interface can build without production credentials. Provider-backed features require valid server-side configuration and migrated databases. Missing configuration is not replaced with invented balances or successful transactions. `vite preview` serves the built frontend only; production API and worker deployment are separate.

Worker build and read-only startup checks:

```sh
npm run build:worker
npm run check:workers:runtime
```

`build` regenerates the pinned Relay verifier from the dependency lockfile before checking TypeScript and native Node imports. Configure each worker deliberately; do not start execution processes against funded wallets merely to try the interface.

## Source checks

The included tests use synthetic inputs and can be run with `npm test`. They do not import real wallets, place trades, create coins, fund workers or deploy the app. Funded acceptance is a separate process and is not implied by passing source checks.

## Configuration

`.env.example` lists configuration names with credentials and deployment-specific values removed. Execution switches default to `false`. Supply only the services you intend to run:

| Area | Configuration families |
| --- | --- |
| Markets and identities | `CODEX_*`, `FOMO_*`, `FOMOSCAN_*`, `SOLANA_*` |
| Storage and sessions | `DATABASE_*`, `FUB_SESSION_*`, `TRIGGER_*` |
| Wallet signing | `PRIVY_*`, `SIGNER_*`, `COPY_SIGNER_*` |
| Trading and recovery | `COPY_*`, `DIRECT_EXIT_*`, `CASH_*`, `JUPITER_*` |
| Launches and buybacks | `LAUNCH_*`, `BUYBACK_*`, `CRON_*` |
| Pay | `PAY_*`, `BITREFILL_*`, `WHOP_*` |

Only explicitly public client configuration belongs in a `VITE_*` variable. Never put provider secrets, wallet keys, database URLs or receipt-access tokens in frontend variables. Database migrations belong to separately configured deployment databases, not to the public source tree.

## Public-source boundary

This is a clean source snapshot, not the private development repository's history. It excludes credentials, browser sessions, customer/provider records, production backups, operator deployment settings, local test-wallet files and funded-test evidence. `PUBLIC_EXPORT.json` records exported file hashes and intentional export-only adjustments.

Public protocol addresses and constants required by transaction verification remain in the code. Historical engineering setup modules are retained as code for review; their existence does not authorize running their transactions. Operator display names are replaced with generic labels in this snapshot.

The deployed font binaries are omitted because their redistribution rights were not established for this export; the public build uses system fonts. Logos and other brand assets are not a trademark license. Third-party packages retain their own licenses. No additional license grant for Fub's source is asserted here.

## Reporting an issue

Open an issue with reproduction steps, the affected feature and a redacted error. Public transaction links may help. Do not post private keys, API credentials, signed wallet messages, gift-card codes or private receipt links. Use [GitHub private vulnerability reporting](https://github.com/DylComp/fub/security/advisories/new), or contact [@FubTool](https://x.com/FubTool) to arrange a private report.
