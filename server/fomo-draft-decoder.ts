import { createHash } from 'node:crypto';
import { address, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, isOffCurveAddress } from '@solana/kit';
import { associated, ATA_PROGRAM, fromBase64, toBase64 } from '../src/transaction-review.js';
import { resolveMessageAccounts } from '../src/lookup-tables.js';
import { TOKEN_PROGRAM } from '../src/funding-model.js';
import { isMint } from '../src/assets.js';
import { resolveFundingLookups } from './funding-lookups.js';
import type { Rpc } from './funding.js';

export const RESOLVER_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const RESOLVER_AMOUNT = 2_000_000n;
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid draft evidence');
  return v as Record<string, unknown>;
};
const onCurve = (v: string) => isMint(v) && !isOffCurveAddress(address(v));

// Discovery only. This module has no signer, sendTransaction, or simulation call.
// It accepts only the fixed USDC draft requested by our trusted browser worker.
// Browser-supplied bytes alone are NOT proof of a handle/address association.
export async function decodeFomoDraft(raw: unknown, operator: string, rpc: Rpc) {
  if (!onCurve(operator)) throw Error('Invalid operator');
  const r = record(raw), encoded = r.transaction;
  if (typeof encoded !== 'string' || r.feeToken !== RESOLVER_USDC || typeof r.feeUsd !== 'number' || !Number.isFinite(r.feeUsd)) throw Error('Unsupported draft fee');
  const scaled = r.feeUsd * 1e6, fee = Math.round(scaled);
  if (Math.abs(scaled - fee) > 1e-7 || fee < 0 || fee >= Number(RESOLVER_AMOUNT)) throw Error('Invalid draft fee');
  const wanted = RESOLVER_AMOUNT - BigInt(fee);
  const tx = getTransactionDecoder().decode(fromBase64(encoded));
  if (toBase64(new Uint8Array(getTransactionEncoder().encode(tx))) !== encoded) throw Error('Non-canonical draft');
  if (!(operator in tx.signatures) || tx.signatures[operator as keyof typeof tx.signatures]?.some(v => v !== 0)) throw Error('Expected unsigned operator');
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version === 1) throw Error('Unsupported draft version');
  let calls = 0;
  const read: Rpc = (method, params) => {
    if (!['getAccountInfo', 'getMultipleAccounts'].includes(method) || ++calls > 6) throw Error('Unsupported discovery RPC');
    return rpc(method, params);
  };
  const proofs = await resolveFundingLookups(message, read);
  const { keys } = resolveMessageAccounts(message, proofs);
  const source = await associated(operator, RESOLVER_USDC);
  const transfers: { destination: string; amount: bigint }[] = [];
  const creates: { destination: string; owner: string }[] = [];
  for (const ix of message.instructions) {
    const program = keys[ix.programAddressIndex], a = (ix.accountIndices || []).map(i => keys[i]), d = ix.data || new Uint8Array();
    if (program === TOKEN_PROGRAM) {
      const checked = d[0] === 12;
      if (!((checked && d.length === 10 && a.length === 4 && a[1] === RESOLVER_USDC && d[9] === 6) || (d[0] === 3 && d.length === 9 && a.length === 3))) throw Error('Unsupported token instruction');
      if (a[0] !== source || a[checked ? 3 : 2] !== operator) throw Error('Unexpected transfer source');
      const amount = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(1, true);
      if (amount <= 0n) throw Error('Empty transfer');
      transfers.push({ destination: a[checked ? 2 : 1], amount });
    } else if (program === ATA_PROGRAM) {
      if (!(d.length === 0 || (d.length === 1 && [0, 1].includes(d[0]))) || a.length !== 6 || a[3] !== RESOLVER_USDC || a[4] !== SYSTEM || a[5] !== TOKEN_PROGRAM || !onCurve(a[2]) || a[1] !== await associated(a[2], RESOLVER_USDC)) throw Error('Invalid associated account');
      creates.push({ destination: a[1], owner: a[2] });
    } else if (program === COMPUTE) {
      if (!((d[0] === 2 && d.length === 5) || (d[0] === 3 && d.length === 9)) || a.length) throw Error('Unsupported compute instruction');
    } else {
      throw Error('Unsupported draft program');
    }
  }
  if (transfers.length < 1 || transfers.length > 2 || transfers.reduce((sum, t) => sum + t.amount, 0n) !== RESOLVER_AMOUNT) throw Error('Draft amount mismatch');
  const matches = transfers.filter(t => t.amount === wanted);
  if (matches.length !== 1) throw Error('Ambiguous recipient');
  const destination = matches[0].destination;
  if (transfers.some(t => t !== matches[0] && t.destination === destination)) throw Error('Recipient and fee destination overlap');
  const declarations = creates.filter(c => c.destination === destination);
  if (declarations.length > 1) throw Error('Ambiguous associated account');
  const result = record(await read('getAccountInfo', [destination, { encoding: 'jsonParsed', commitment: 'finalized' }]));
  const slot = record(result.context).slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < 1) throw Error('Missing chain context');
  let owner: string;
  if (result.value === null) {
    if (declarations.length !== 1) throw Error('Recipient account unavailable');
    owner = declarations[0].owner;
  } else {
    const account = record(result.value), parsed = record(record(account.data).parsed), info = record(parsed.info);
    if (account.owner !== TOKEN_PROGRAM || account.executable !== false || parsed.type !== 'account' || info.mint !== RESOLVER_USDC || info.state !== 'initialized' || typeof info.owner !== 'string' || !onCurve(info.owner)) throw Error('Invalid recipient token account');
    owner = info.owner;
    if (declarations.length && declarations[0].owner !== owner) throw Error('Conflicting recipient owner');
  }
  if (destination !== await associated(owner, RESOLVER_USDC)) throw Error('Unexpected recipient owner');
  return { address: owner, destination, contextSlot: slot as number, draftHash: createHash('sha256').update(Buffer.from(tx.messageBytes)).digest('hex'), method: 'unsigned-usdc-draft' as const };
}

export const RESOLVER_SOL = 'So11111111111111111111111111111111111111112';
export const RESOLVER_SOL_AMOUNT = 20_000_000n;
export type ResolverCurrency = 'usdc' | 'sol';

// Native SOL drafts expose the destination directly. Accept only the observed
// zero-fee, exact-amount system transfer; never infer a recipient from its size.
export async function decodeFomoSolDraft(raw: unknown, operator: string, rpc: Rpc) {
  if (!onCurve(operator)) throw Error('Invalid operator');
  const r = record(raw);
  if (typeof r.transaction !== 'string' || r.feeUsd !== 0 || ![undefined, null, RESOLVER_SOL].includes(r.feeToken as string | null | undefined)) throw Error('Unsupported SOL draft fee');
  const tx = getTransactionDecoder().decode(fromBase64(r.transaction));
  if (toBase64(new Uint8Array(getTransactionEncoder().encode(tx))) !== r.transaction) throw Error('Non-canonical draft');
  if (!(operator in tx.signatures) || tx.signatures[operator as keyof typeof tx.signatures]?.some(v => v !== 0)) throw Error('Expected unsigned operator');
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version === 1) throw Error('Unsupported draft version');
  let calls = 0;
  const read: Rpc = (method, params) => {
    if (!['getAccountInfo', 'getMultipleAccounts'].includes(method) || ++calls > 6) throw Error('Unsupported discovery RPC');
    return rpc(method, params);
  };
  const proofs = await resolveFundingLookups(message, read);
  const { keys } = resolveMessageAccounts(message, proofs);
  let destination: string | undefined;
  for (const ix of message.instructions) {
    const program = keys[ix.programAddressIndex], a = (ix.accountIndices || []).map(i => keys[i]), d = ix.data || new Uint8Array();
    if (program === SYSTEM) {
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      if (destination || a.length !== 2 || d.length !== 12 || view.getUint32(0, true) !== 2 || view.getBigUint64(4, true) !== RESOLVER_SOL_AMOUNT || a[0] !== operator || !onCurve(a[1])) throw Error('Unexpected SOL transfer');
      destination = a[1];
    } else if (program === COMPUTE) {
      if (!((d[0] === 2 && d.length === 5) || (d[0] === 3 && d.length === 9)) || a.length) throw Error('Unsupported compute instruction');
    } else throw Error('Unsupported SOL draft program');
  }
  if (!destination) throw Error('Missing SOL destination');
  const result = record(await read('getAccountInfo', [destination, { encoding: 'base64', commitment: 'finalized' }]));
  const slot = record(result.context).slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < 1) throw Error('Missing chain context');
  if (result.value !== null) {
    const account = record(result.value);
    if (account.owner !== SYSTEM || account.executable !== false || !Array.isArray(account.data) || account.data[0] !== '' || account.data[1] !== 'base64') throw Error('Unexpected SOL recipient account');
  }
  return { address: destination, destination, contextSlot: slot as number, draftHash: createHash('sha256').update(Buffer.from(tx.messageBytes)).digest('hex'), method: 'unsigned-sol-draft' as const };
}
