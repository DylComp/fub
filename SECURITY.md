# Security reports

Please report suspected vulnerabilities privately through this repository’s **Security → Report a vulnerability** page, or contact [@FubTool](https://x.com/FubTool) to arrange a private report.

Include the affected feature, reproduction steps and the expected behavior. Do not include private keys, recovery phrases, provider credentials, wallet ownership signatures, gift-card codes or private receipt links.

Public source and automated checks are not an independent security audit. A successful test does not establish that every route, token or provider is supported.

## Dependency review — October 12, 2026

The source-map-js build dependency is patched to 1.2.2. The dependency audit still reports three moderate entries in the Solana web3 → jayson → stream-json dependency chain. The suggested top-level fix is a major SDK upgrade and has not been adopted without route compatibility testing. These entries are not evidence that a specific Fub endpoint is exploitable; they remain dependency-review work.

This snapshot is not represented as free of vulnerabilities or ready for unrestricted automatic cross-chain trading.
