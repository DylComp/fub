# Security reports

Please report suspected vulnerabilities privately through this repository’s **Security → Report a vulnerability** page, or contact [@FubTool](https://x.com/FubTool) to arrange a private report.

Include the affected feature, reproduction steps and the expected behavior. Do not include private keys, recovery phrases, provider credentials, wallet ownership signatures, gift-card codes or private receipt links.

Public source and automated checks are not an independent security audit. A successful test does not establish that every route, token or provider is supported.

## Dependency review — October 12, 2026

The source-map-js build dependency is patched to 1.2.2. The dependency audit still reports three moderate entries in the Solana web3 → jayson → stream-json dependency chain. The suggested top-level fix is a major SDK upgrade and has not been adopted without route compatibility testing. These entries are not evidence that a specific Fub endpoint is exploitable; they remain dependency-review work.

This snapshot is not represented as free of vulnerabilities or ready for unrestricted automatic cross-chain trading.

## Security model and scope

Read [wallet import and signing](WALLET-SECURITY.md) before importing any wallet. It distinguishes raw wallet keys from provider signer-authorization keys, explains private import and delegated automation, and identifies browser, provider and service compromise risks. [Architecture](ARCHITECTURE.md) describes transaction recovery; [feature status](FEATURE-STATUS.md) records acceptance limits.

Import does not make the wallet risk free. Backend credentials and signing authority must be protected even though the import path does not send the raw wallet key to Fub's server. Pausing a plan, disconnecting a browser and revoking a provider signer are different actions. None reverses a settled transaction.

## Safe reports

Do not test a suspected issue against another person's wallet or live funds. Start with a minimal reproduction, affected source path, expected behavior and redacted output. Report privately when a reproduction would expose a bypass or sensitive data. Do not include active authorization signatures, session cookies, keys, private database exports or redeemable payment material.

If a report concerns a pending financial transaction, preserve its public transaction reference and describe the observed state. Avoid creating replacement transactions merely because an existing one appears delayed. The project's saved attempt and chain receipt must be reconciled first.

## Operational material excluded from source

The public snapshot intentionally excludes production credentials, customer receipts, browser sessions, raw wallet key files and backup recovery material. Access restrictions, encryption and recovery procedures for live records remain operational responsibilities. Public source cannot independently demonstrate those controls or prove that the live deployment matches a particular commit.

No response-time, bounty, formal audit or continuous-availability guarantee is stated here.
