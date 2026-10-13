import { Connection } from '@solana/web3.js';
import { inspectTableSetup, setupTransaction } from '../src/launch-table-setup.js';
import type { TableSetup } from '../src/launch-table-setup.js';
export async function prepareLaunchTableSetup() {
  const endpoint = process.env.SOLANA_RPC_URL;
  if (!endpoint) throw Error('Solana connection unavailable.');
  const connection = new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }) });
  if (await connection.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('Mainnet required.');
  const [slot, block, rent] = await Promise.all([connection.getSlot('finalized'), connection.getLatestBlockhash(), connection.getMinimumBalanceForRentExemption(184)]);
  const { transaction, table } = setupTransaction(slot, block.blockhash);
  const fee = (await connection.getFeeForMessage(transaction.compileMessage())).value;
  const plan: TableSetup = { unsigned: transaction.serialize({ requireAllSignatures: false }).toString('base64'), table, slot, preparedAt: Date.now(), lastValidBlockHeight: block.lastValidBlockHeight, rent, fee: fee!, debit: rent + (fee || 0) };
  inspectTableSetup(plan);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw Error('Setup simulation did not pass.');
  return plan;
}
