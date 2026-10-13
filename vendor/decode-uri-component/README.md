# Wallet URL decoder compatibility patch

Source: https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.5.0.tgz
Upstream index.js SHA-256: `9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa`
Advisory: https://github.com/advisories/GHSA-vcc3-ghjq-m6fr

The decoder body is upstream 0.5.0, which replaces the vulnerable recursive malformed-byte fallback. The MIT license is retained. Only the ESM export is removed and a CommonJS wrapper is appended. The wrapper retains 0.2.x's plus-to-space behavior for existing query-string 7 consumers. No decoding algorithm was rewritten locally.

This local package is pinned via a direct file dependency and the matching npm override. Keep it until the wallet SDK dependency tree supports an upstream fixed decoder with a compatible module interface. Do not replace it with the vulnerable 0.2.x release or blindly force ESM 0.5 into a CommonJS consumer.
