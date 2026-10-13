// The upstream CommonJS SDK loads ESM-only XRP helpers even for Solana/EVM
// order hashes. Bundle this narrow export so Vercel's Node loader never needs
// require(ESM). Keep the official algorithm and pinned dependency unchanged.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
await build({
  stdin: { contents: 'export { getOrderId } from "@relay-protocol/settlement-sdk/dist/order/index.js";', resolveDir: root, sourcefile: 'relay-order-entry.mjs', loader: 'js' },
  outfile: resolve(root, 'vendor/relay-order.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
  minify: true, legalComments: 'eof',
  banner: { js: 'import { createRequire as __fubCreateRequire } from "node:module"; const require = __fubCreateRequire(import.meta.url);' },
});
console.log('Built pinned Relay order verifier for Node.');
