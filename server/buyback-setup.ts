import { Connection, PublicKey } from '@solana/web3.js';
import { unpackAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { BUYBACK_SETUP as fixed, buybackSetupTransaction, inspectBuybackSetup, verifySignedBuybackSetup } from '../src/buyback-setup.js';
import type { BuybackSetupReview } from '../src/buyback-setup.js';
import {buybackSetupStore} from './buyback-setup-store.js';
import {setTimeout as delay} from 'node:timers/promises';
export function buybackSetupConnection() {
  const endpoint = process.env.BUYBACK_RPC_URL || process.env.LAUNCH_PAYOUT_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!endpoint) throw Error('Setup connection unavailable.');
  return new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }) });
}
async function accounts(c: Connection) {
  if (await c.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('Mainnet required.');
  const result = await c.getMultipleAccountsInfoAndContext([new PublicKey(fixed.owner), new PublicKey(fixed.ata), new PublicKey(fixed.volume)], 'finalized');
  const [owner, ata, volume] = result.value;
  if (!owner) throw Error('Setup owner not found.');
  if (ata) { const token = unpackAccount(new PublicKey(fixed.ata), ata, new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')); if (!token.owner.equals(new PublicKey(fixed.treasury)) || !token.mint.equals(new PublicKey(fixed.mint))) throw Error('Treasury token account mismatch.'); }
  if (volume && !volume.owner.equals(new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))) throw Error('Volume account mismatch.');
  return { owner, ata, volume, slot: result.context.slot };
}
export async function prepareBuybackSetup(c = buybackSetupConnection()) {
  const state = await accounts(c);
  if (state.ata && state.volume) return { complete: true as const };
  const block = await c.getLatestBlockhash('confirmed');
  const tx = buybackSetupTransaction(block.blockhash, !state.ata, !state.volume, true);
  const fee = (await c.getFeeForMessage(tx.message)).value;
  const simulation = await c.simulateTransaction(tx, { sigVerify: false, minContextSlot: state.slot, accounts: { encoding: 'base64', addresses: [fixed.owner] } });
  if (simulation.value.err || !simulation.value.accounts?.[0]) throw Error('Account setup simulation failed.');
  const review: BuybackSetupReview = { unsigned: Buffer.from(tx.serialize()).toString('base64'), ata: !state.ata, volume: !state.volume, debit: state.owner.lamports - simulation.value.accounts[0].lamports, fee: fee!, preparedAt: Date.now(), lastValidBlockHeight: block.lastValidBlockHeight };
  inspectBuybackSetup(review);
  return { complete: false as const, review };
}
export async function submitBuybackSetup(review: BuybackSetupReview, signed: string, c = buybackSetupConnection(), journal=buybackSetupStore()) {
  const tx = await verifySignedBuybackSetup(review, signed), signature = bs58.encode(tx.signatures[0]);
  const [status] = (await c.getSignatureStatuses([signature], { searchTransactionHistory: true })).value;
  if (status) {
    if(status.confirmationStatus==='finalized'){
      const receipt=await c.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
      if(receipt?.meta)await journal.settle(signature,receipt.meta.preBalances[0]-receipt.meta.postBalances[0],!receipt.meta.err,receipt.slot);
    }
    if (status.err) throw Error('Account setup failed on chain. Inspect its receipt before retrying.'); return { signature, state: status.confirmationStatus };
  }
  if (Date.now() - review.preparedAt > 120000 || review.preparedAt > Date.now() + 5000 || await c.getBlockHeight('confirmed') > review.lastValidBlockHeight) throw Error('Account setup expired. Check its status before preparing again.');
  const state = await accounts(c);
  if (state.ata && state.volume) return { complete: true };
  const sim = await c.simulateTransaction(tx, { sigVerify: true, minContextSlot: state.slot, accounts: { encoding: 'base64', addresses: [fixed.owner] } });
  const debit = sim.value.accounts?.[0] && state.owner.lamports - sim.value.accounts[0].lamports;
  const fee = (await c.getFeeForMessage(tx.message)).value;
  if (sim.value.err || !debit || debit > fixed.cap || debit > review.debit || fee !== review.fee) throw Error('Fresh account setup checks failed. Nothing was sent.');
  await journal.save(signature,review,signed);
  const start=Date.now();
  // Same signed bytes only. A lost acknowledgment never creates a replacement.
  // Let the caller resume this packet instead of treating RPC acceptance as a fill.
  do {
    if(await c.getBlockHeight('confirmed')>review.lastValidBlockHeight)return {signature,state:'expired_unresolved'};
    try {
      const sent = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
      if (sent !== signature) throw Error('Unexpected transaction response.');
    } catch { /* Packet is durable; status read decides whether to retry. */ }
    const [observed]=(await c.getSignatureStatuses([signature],{searchTransactionHistory:true})).value;
    if(observed){
      if(observed.confirmationStatus==='finalized'){
        const receipt=await c.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
        if(receipt?.meta)await journal.settle(signature,receipt.meta.preBalances[0]-receipt.meta.postBalances[0],!receipt.meta.err,receipt.slot);
      }
      return {signature,state:observed.err?'failed':observed.confirmationStatus};
    }
    await delay(1500);
  }while(Date.now()-start<18000);
  return {signature,state:'submitted'};
}
