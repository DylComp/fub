import { VersionedTransaction } from '@solana/web3.js';
import { CASH_MINT, CASH_NETWORKS, RELAY_SOLANA } from '../src/cash-route.js';
import type { CashRouteQuote } from '../src/cash-route.js';
import type { CashReceipt } from '../src/cash-recovery.js';
import type { Rpc } from './funding.js';
import type { CashDepositReview } from './cash-deposit.js';
import { MAINNET_GENESIS } from './solana-network.js';
import { inspectSignedCashDeposit } from './cash-deposit.js';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const quantity = (v: unknown): bigint => { if (typeof v !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(v)) throw Error('Invalid EVM quantity.'); return BigInt(v); };
const same = (a:unknown,b:string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const obj = (v:unknown):any => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

// A destination-provider success is not source-payment evidence. Match the
// independently fetched, finalized source transaction to the exact saved bytes.
export async function finalizedCashDeposit(review: CashDepositReview, signed: string, rpc: Rpc): Promise<'pending'|'confirmed'|'reverted'> {
 return cashDepositReceipt(review,signed,rpc,'finalized');
}
export async function confirmedCashDeposit(review:CashDepositReview,signed:string,rpc:Rpc){return cashDepositReceipt(review,signed,rpc,'confirmed');}
async function cashDepositReceipt(review:CashDepositReview,signed:string,rpc:Rpc,commitment:'finalized'|'confirmed'):Promise<'pending'|'confirmed'|'reverted'>{
  const signature = inspectSignedCashDeposit(review,signed);
  if (await rpc('getGenesisHash',[]) !== MAINNET_GENESIS) throw Error('Wrong cash source network.');
  const result = await rpc('getTransaction',[signature,{encoding:'base64',commitment,maxSupportedTransactionVersion:0}]) as any;
  if (!result) return 'pending';
  if (!Array.isArray(result.transaction) || result.transaction[1] !== 'base64' || typeof result.transaction[0] !== 'string' ||
    result.transaction[0].length > 1700 || result.transaction[0] !== signed || !Number.isSafeInteger(result.slot) || result.slot < review.slot || !result.meta)
    throw Error('Cash deposit receipt mismatch.');
  if (result.meta.err !== null) return 'reverted';
  const tx = VersionedTransaction.deserialize(Buffer.from(signed,'base64'));
  const pre = result.meta.preTokenBalances, post = result.meta.postTokenBalances;
  if (!Array.isArray(pre) || !Array.isArray(post)) throw Error('Cash debit receipt missing.');
  const balance = (rows:any[], index:number) => {
    const found = rows.filter(r=>r.accountIndex === index && r.owner === review.quote.sourceWallet && r.mint === CASH_MINT);
    if (found.length !== 1 || found[0].uiTokenAmount?.decimals !== 6 || !/^\d{1,20}$/.test(found[0].uiTokenAmount.amount)) throw Error('Cash debit receipt invalid.');
    return BigInt(found[0].uiTokenAmount.amount);
  };
  const source = pre.find((r:any)=>r.owner===review.quote.sourceWallet && r.mint===CASH_MINT);
  if (!source || balance(pre,source.accountIndex)-balance(post,source.accountIndex)!==BigInt(review.quote.amountRaw) ||
    tx.message.staticAccountKeys[0].toBase58() !== review.quote.sourceWallet || !Number.isSafeInteger(result.meta.fee) ||
    result.meta.fee > Number(review.maxFeeLamports) || !Number.isSafeInteger(result.meta.preBalances?.[0]) || !Number.isSafeInteger(result.meta.postBalances?.[0]) ||
    result.meta.preBalances[0]-result.meta.postBalances[0] < result.meta.fee || result.meta.preBalances[0]-result.meta.postBalances[0] > Number(review.maxFeeLamports)+Number(review.maxRentLamports)) throw Error('Cash debit differs from the saved purchase.');
  if(commitment==='confirmed'){
    const status=obj(await rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]));
    const checked=status.value?.[0];
    if(!checked||checked.err!==null||checked.slot!==result.slot||!['confirmed','finalized'].includes(checked.confirmationStatus))return 'pending';
  }
  return 'confirmed';
}
// RPC endpoint selection belongs to the server's network registry. Neither a
// quote nor a provider status may supply an RPC URL or a receipt body.
export async function readCashDelivery(quote: CashRouteQuote, transaction: string, rpc: Rpc): Promise<CashReceipt | null> {
 return cashDeliveryReceipt(quote,transaction,rpc,'finalized');
}
export async function readCashSpendableDelivery(quote:CashRouteQuote,transaction:string,rpc:Rpc){return cashDeliveryReceipt(quote,transaction,rpc,'latest');}
async function cashDeliveryReceipt(quote:CashRouteQuote,transaction:string,rpc:Rpc,commitment:'finalized'|'latest'):Promise<(CashReceipt&{blockHash?:string;blockNumber?:string})|null>{
  if (!hash(transaction)) throw Error('Invalid cash delivery hash.');
  const chainId = CASH_NETWORKS[quote.network].chainId;
  if (quantity(await rpc('eth_chainId',[])) !== BigInt(chainId)) throw Error('Wrong cash delivery network.');
  const r = obj(await rpc('eth_getTransactionReceipt',[transaction]));
  if (!r.transactionHash) return null;
  if (!same(r.transactionHash,transaction) || !hash(r.blockHash) || quantity(r.status) !== 1n || !Array.isArray(r.logs) || r.logs.length > 2000) return null;
  const block = quantity(r.blockNumber);
  const finalized = obj(await rpc('eth_getBlockByNumber',[commitment,false]));
  if (quantity(finalized.number) < block) return null;
  const canonical = obj(await rpc('eth_getBlockByNumber',[r.blockNumber,false]));
  if (!same(canonical.hash,r.blockHash) || quantity(canonical.number) !== block) return null;
  const topic = '0x' + quote.recipient.slice(2).toLowerCase().padStart(64,'0');
  let net = 0n;
  const seen = new Set<string>();
  for (const log of r.logs) {
    if (!same(log.address,quote.token)) continue;
    if (!Array.isArray(log.topics) || !same(log.topics[0],TRANSFER)) continue;
    if (log.removed !== false || !same(log.transactionHash,transaction) || !same(log.blockHash,r.blockHash) ||
      log.topics.length !== 3 || !log.topics.every(hash) || !hash(log.data)) throw Error('Invalid cash transfer log.');
    const index = quantity(log.logIndex).toString();
    if (seen.has(index)) throw Error('Duplicate cash transfer log.'); seen.add(index);
    const amount = BigInt(log.data);
    if (same(log.topics[2],topic)) net += amount;
    if (same(log.topics[1],topic)) net -= amount;
  }
  if (net <= 0n || net < BigInt(quote.minimumRaw)) return null;
  // Standard ERC-20 balance evidence complements logs. Do not credit a token
  // that emits an inbound event without a corresponding spendable increase.
  if (block === 0n) return null;
  const data = '0x70a08231' + quote.recipient.slice(2).padStart(64,'0');
  const [before,after] = await Promise.all([rpc('eth_call',[{to:quote.token,data},'0x'+(block-1n).toString(16)]),rpc('eth_call',[{to:quote.token,data},r.blockNumber])]);
  if (!hash(before) || !hash(after) || BigInt(after)-BigInt(before) < net) return null;
  if(commitment==='latest'){const again=obj(await rpc('eth_getBlockByNumber',[r.blockNumber,false]));if(!same(again.hash,r.blockHash))return null;const balance=await rpc('eth_call',[{to:quote.token,data},'latest']);if(!hash(balance)||BigInt(balance)<net)return null;}
  return {requestId:quote.requestId,chainId,transaction,recipient:quote.recipient,currency:quote.token,receivedRaw:net.toString(),finalized:commitment==='finalized',successful:true,...(commitment==='latest'?{blockHash:r.blockHash.toLowerCase(),blockNumber:r.blockNumber}: {})};
}
export async function readCashRefund(quote: CashRouteQuote, signature: string, rpc: Rpc): Promise<CashReceipt | null> {
  return readCashSolanaCredit(quote.requestId,quote.refundWallet,signature,rpc,quote.amountRaw);
}
export async function readCashSolanaCredit(requestId:string,recipient:string,signature:string,rpc:Rpc,maximumRaw?:string):Promise<CashReceipt|null>{
  if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) throw Error('Invalid cash refund signature.');
  if (await rpc('getGenesisHash',[]) !== MAINNET_GENESIS) throw Error('Wrong cash refund network.');
  const r = await rpc('getTransaction',[signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]) as any;
  if (!r || r.meta?.err !== null) return null;
  if (r.transaction?.signatures?.[0] !== signature || !Number.isSafeInteger(r.slot) || !Array.isArray(r.meta.preTokenBalances) || !Array.isArray(r.meta.postTokenBalances)) throw Error('Invalid cash refund receipt.');
  let net = 0n;
  const seen = new Set<number>();
  for (const row of r.meta.postTokenBalances) {
    if (row.owner !== recipient || row.mint !== CASH_MINT) continue;
    if (!Number.isSafeInteger(row.accountIndex) || seen.has(row.accountIndex) || row.uiTokenAmount?.decimals !== 6 || !/^\d{1,20}$/.test(row.uiTokenAmount?.amount)) throw Error('Invalid refund balance.');
    seen.add(row.accountIndex);
    const pre = r.meta.preTokenBalances.filter((p:any)=>p.accountIndex===row.accountIndex);
    if (pre.length > 1 || pre.length === 1 && (pre[0].owner !== recipient || pre[0].mint !== CASH_MINT || pre[0].uiTokenAmount?.decimals !== 6 || !/^\d{1,20}$/.test(pre[0].uiTokenAmount?.amount))) throw Error('Invalid refund source balance.');
    net += BigInt(row.uiTokenAmount.amount)-BigInt(pre[0]?.uiTokenAmount.amount||'0');
  }
  if (net <= 0n || maximumRaw !== undefined && net > BigInt(maximumRaw)) return null;
  return {requestId,chainId:RELAY_SOLANA,transaction:signature,recipient:recipient,currency:CASH_MINT,receivedRaw:net.toString(),finalized:true,successful:true};
}
