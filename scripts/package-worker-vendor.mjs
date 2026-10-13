// Compiled server imports resolve vendor modules relative to .worker-dist.
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('.worker-dist/vendor',{recursive:true});
await copyFile('vendor/relay-order.mjs','.worker-dist/vendor/relay-order.mjs');
