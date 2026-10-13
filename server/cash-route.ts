import { createHash } from 'node:crypto';
import { getOrderId } from '../vendor/relay-order.mjs';
import type { Order } from '@relay-protocol/settlement-sdk';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CASH_MINT, CASH_NETWORKS, RELAY_SOLANA, validateCashIntent } from '../src/cash-route.js';
import type { CashRouteIntent, CashRouteQuote } from '../src/cash-route.js';
import {CASH_GAS_POLICY} from '../src/cash-network-policy.js';
import {cashRelay} from './cash-relay.js';

// Independently pinned from Relay /chains and its SVM deposit_token reference.
// Never accept a program/vault supplied by the quote as its own trust anchor.
const DEPOSITORY = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const CONFIG = 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc';
const VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
const SYSTEM = '11111111111111111111111111111111';
const CHAIN_VMS = { solana: 'solana-vm', base: 'ethereum-vm', bnb: 'ethereum-vm', monad: 'ethereum-vm', robinhood: 'ethereum-vm', arc: 'ethereum-vm', ethereum: 'ethereum-vm' } as const;
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid cash quote.');
  return v as Record<string, unknown>;
};
const array = (v: unknown, min: number, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw Error('Unexpected cash quote steps.');
  return v;
};
const raw = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(v) || BigInt(v) >= 2n ** 256n) throw Error('Invalid cash quote amount.');
  return BigInt(v);
};
const evmSame = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
// Leave one basis point of headroom for the provider's atomic-unit rounding.
// The independently checked minimum still enforces the caller's full limit.
const providerSlippage = (intent: CashRouteIntent) => Math.max(1, intent.slippageBps - 1);
function currency(value: unknown, chainId: number, address: string, decimals?: number) {
  const token = obj(value);
  const same = chainId === RELAY_SOLANA ? token.address === address : evmSame(token.address, address);
  if (token.chainId !== chainId || !same || !Number.isInteger(token.decimals) || Number(token.decimals) < 0 || Number(token.decimals) > 36 ||
    (decimals !== undefined && token.decimals !== decimals)) throw Error('Cash quote currency changed.');
  return token;
}

export function cashQuoteRequest(intent: CashRouteIntent) {
  validateCashIntent(intent);
  return { user: intent.sourceWallet, recipient: intent.recipient, originChainId: RELAY_SOLANA,
    destinationChainId: CASH_NETWORKS[intent.network].chainId, originCurrency: CASH_MINT,
    destinationCurrency: intent.token, amount: intent.amountRaw, tradeType: 'EXACT_INPUT',
    slippageTolerance: String(providerSlippage(intent)), refundTo: intent.sourceWallet,
    includeProtocolData: true, useDepositAddress: false, explicitDeposit: true,
    disableOriginSwaps: true, topupGas: !!intent.gasTopupUsdcRaw, ...(intent.gasTopupUsdcRaw?{topupGasAmount:intent.gasTopupUsdcRaw}:{}) };
}

// This verifies a quote's deposit instructions, not ownership, funding or a
// signature. The sanitized result is deliberately not executable.
export function inspectCashQuote(value: unknown, intent: CashRouteIntent, now = Date.now()): CashRouteQuote {
  validateCashIntent(intent);
  const q = obj(value), d = obj(q.details), input = obj(d.currencyIn), output = obj(d.currencyOut);
  const { chainId, protocol } = CASH_NETWORKS[intent.network];
  currency(input.currency, RELAY_SOLANA, CASH_MINT, 6);
  const outputToken = currency(output.currency, chainId, intent.token);
  if (!['swap', 'bridge'].includes(String(d.operation)) || d.sender !== intent.sourceWallet || !evmSame(d.recipient, intent.recipient) ||
    input.amount !== intent.amountRaw || obj(d.slippageTolerance).total !== String(providerSlippage(intent))) throw Error('Cash quote does not match the request.');
  let gasTopup:CashRouteQuote['gasTopup'];
  if(intent.gasTopupUsdcRaw){
    const topup=obj(d.currencyGasTopup);currency(topup.currency,chainId,'0x'+'0'.repeat(40),18);
    // amountUsd is a moving USD valuation of the quoted native currency, not
    // the USDC units requested for gas. Allow 1% valuation drift; the pinned
    // deposit still spends exactly intent.amountRaw and the request keeps the
    // original gas budget. Verify actual delivered gas separately before sale.
    const usd=String(topup.amountUsd);
    const budget=BigInt(intent.gasTopupUsdcRaw);
    if(!/^(0|[1-9]\d{0,8})\.\d{6}$/.test(usd)||BigInt(usd.replace('.',''))*100n<budget*99n||BigInt(usd.replace('.',''))*100n>budget*101n||raw(topup.amount)<=0n||raw(topup.amount)>BigInt(CASH_GAS_POLICY[intent.network].maxNativeRaw)||topup.minimumAmount!==topup.amount)throw Error('Destination gas top-up changed.');
    gasTopup={budgetUsdcRaw:intent.gasTopupUsdcRaw,promisedWei:String(topup.amount),committed:false};
  }else if(d.currencyGasTopup && raw(obj(d.currencyGasTopup).amount)>0n)throw Error('Unexpected destination gas purchase.');
  const expected = raw(output.amount), minimum = raw(output.minimumAmount);
  if (expected === 0n || minimum === 0n || minimum > expected || minimum < expected * BigInt(10000 - intent.slippageBps) / 10000n)
    throw Error('Cash quote exceeds slippage limits.');

  const p = obj(obj(q.protocol).v2), order = obj(p.orderData), out = obj(order.output);
  const first = obj(array(order.inputs, 1, 1)[0]), payment = obj(first.payment), delivery = obj(array(out.payments, 1, 1)[0]);
  if (p.hubType !== 'onchain' || order.version !== 'v1' || order.solverChainId !== 'base' ||
    !evmSame(order.solver, '0xf70da97812cb96acdf810712aa562db8dfa3dbef') ||
    payment.chainId !== 'solana' || payment.currency !== CASH_MINT || payment.amount !== intent.amountRaw || payment.weight !== '1' ||
    out.chainId !== protocol || !evmSame(delivery.recipient, intent.recipient) || !evmSame(delivery.currency, intent.token) ||
    delivery.minimumAmount !== minimum.toString() || delivery.expectedAmount !== expected.toString()) throw Error('Protocol order does not match the cash quote.');
  array(out.calls, 0, 0); array(order.fees, 0, 0);
  if (!Number.isSafeInteger(out.deadline) || Number(out.deadline) * 1000 <= now + 30000 || Number(out.deadline) * 1000 > now + 8 * 86400000)
    throw Error('Cash order deadline is invalid.');
  const refunds = array(first.refunds, 1, 2).map(obj);
  // The protocol can include an alternate destination-chain refund. It must
  // still belong to the same recipient, and must never be called cash returned.
  if (!refunds.some(r => r.chainId === 'solana' && r.recipient === intent.sourceWallet && r.currency === CASH_MINT))
    throw Error('A refund to the original USDC wallet is required.');
  for (const refund of refunds) {
    if ((refund.chainId === 'solana' ? refund.recipient !== intent.sourceWallet || refund.currency !== CASH_MINT :
      refund.chainId !== protocol || !evmSame(refund.recipient, intent.recipient) || typeof refund.currency !== 'string' || !/^0x[0-9a-f]{40}$/i.test(refund.currency)) ||
      refund.deadline !== out.deadline || raw(refund.minimumAmount) !== 0n) throw Error('Unexpected refund destination.');
  }
  if (!hash(p.orderId) || getOrderId(order as unknown as Order, CHAIN_VMS).toLowerCase() !== p.orderId.toLowerCase())
    throw Error('Cash order commitment mismatch.');
  const deposit = obj(p.paymentDetails);
  if (deposit.chainId !== 'solana' || deposit.depository !== DEPOSITORY || deposit.currency !== CASH_MINT || deposit.amount !== intent.amountRaw)
    throw Error('Cash deposit does not match the order.');
  const step = obj(array(q.steps, 1, 1)[0]), item = obj(array(step.items, 1, 1)[0]), check = obj(item.check), data = obj(item.data);
  if (step.id !== 'deposit' || step.kind !== 'transaction' || step.depositAddress || !hash(step.requestId) ||
    (q.requestId !== undefined && q.requestId !== step.requestId) || check.method !== 'GET' ||
    check.endpoint !== `/intents/status/v3?requestId=${step.requestId}`) throw Error('Unexpected cash deposit step.');
  const instruction = obj(array(data.instructions, 1, 1)[0]);
  if (instruction.programId !== DEPOSITORY || typeof instruction.data !== 'string' || !/^[0-9a-f]{96}$/i.test(instruction.data))
    throw Error('Unsupported USDC deposit instruction.');
  const bytes = Buffer.from(instruction.data, 'hex');
  const discriminator = createHash('sha256').update('global:deposit_token').digest().subarray(0, 8);
  if (!bytes.subarray(0, 8).equals(discriminator) || bytes.readBigUInt64LE(8) !== BigInt(intent.amountRaw) ||
    `0x${bytes.subarray(16).toString('hex')}` !== p.orderId.toLowerCase()) throw Error('Deposit instruction does not commit to this order and amount.');
  const ata = (owner: string) => getAssociatedTokenAddressSync(new PublicKey(CASH_MINT), new PublicKey(owner), true).toBase58();
  const accounts = [CONFIG, intent.sourceWallet, intent.sourceWallet, VAULT, CASH_MINT, ata(intent.sourceWallet), ata(VAULT),
    TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SYSTEM];
  array(instruction.keys, accounts.length, accounts.length).forEach((v, i) => {
    const k = obj(v);
    if (k.pubkey !== accounts[i] || k.isSigner !== (i === 1) || k.isWritable !== [1, 5, 6].includes(i)) throw Error('Cash deposit account substitution.');
  });
  // Any future transaction builder must compile the verified instructions
  // itself. Provider-supplied serialized transactions/lookup tables are unused.
  const fees = obj(q.fees), relay = obj(fees.relayer), app = obj(fees.app), gas = obj(fees.gas);
  currency(relay.currency, RELAY_SOLANA, CASH_MINT, 6); currency(app.currency, RELAY_SOLANA, CASH_MINT, 6);
  currency(gas.currency, RELAY_SOLANA, SYSTEM, 9);
  if (raw(app.amount) !== 0n || raw(relay.amount) >= BigInt(intent.amountRaw) || raw(gas.amount) > 10000000n) throw Error('Unexpected cash-route fees.');
  const impact = Number(obj(d.totalImpact).percent);
  if (!Number.isFinite(impact)) throw Error('Cash-route price impact is unavailable.');
  return { provider: 'relay', executable: false, source: 'solana-usdc', network: intent.network,
    token: intent.token.toLowerCase(), amountRaw: intent.amountRaw, outputRaw: expected.toString(), minimumRaw: minimum.toString(),
    outputDecimals: Number(outputToken.decimals), feeUsdcRaw: String(relay.amount), estimatedGasLamports: String(gas.amount),
    priceImpactPercent: impact, orderId: p.orderId, requestId: step.requestId, sourceWallet: intent.sourceWallet,
    recipient: intent.recipient.toLowerCase(), refundWallet: intent.sourceWallet, depositVerified: true,
    checkedAt: now, expiresAt: now + 30000, ...(gasTopup?{gasTopup}:{}) };
}

export async function quoteCashRoute(intent: CashRouteIntent, fetcher: typeof fetch = fetch): Promise<CashRouteQuote> {
  const body = cashQuoteRequest(intent);
  return inspectCashQuote(await cashRelay(fetcher).quote(body), intent);
}
