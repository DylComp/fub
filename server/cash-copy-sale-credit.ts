import {confirmedCashEvm} from './cash-return-transaction.js';
import {inspectCashSaleReceipt,cashSaleReceiptMinimum} from './cash-return-receipt.js';
import {readCashSolanaCredit} from './cash-receipt.js';
import {cashRelay} from './cash-relay.js';
import {saleHashes,type CashSale} from './cash-return-store.js';
import {CASH_NETWORKS,RELAY_SOLANA,CASH_MINT} from '../src/cash-route.js';
import type {CashReceipt} from '../src/cash-recovery.js';
import type {Rpc} from './funding.js';

export type CashSaleCredit={sourceTransaction:string;sourceBlockHash:string;sourceBlockNumber:string;debitRaw:string;cash:CashReceipt};
/** A mined token sale plus independently finalized returned cash can release
 * inventory for the next cycle. The sale itself still awaits EVM finality. */
export async function cashCopySaleCredit(sale:CashSale,solana:Rpc,evm:Rpc,fetcher:typeof fetch=fetch):Promise<CashSaleCredit|null>{
 if(!sale.signed||!sale.hashes||!['submitted','settling','delayed'].includes(sale.state))return null;
 const hashes=await saleHashes(sale,sale.signed);
 if(JSON.stringify(hashes)!==JSON.stringify(sale.hashes))throw Error('Sale credit signatures changed.');
 const receipts=await Promise.all(sale.signed.map((signed,i)=>confirmedCashEvm(sale.gas.transactions[i],signed,evm)));
 if(receipts.some(r=>r.state!=='confirmed'))return null;
 if(receipts.reduce((n,r)=>n+BigInt(r.feeWei!),0n)>BigInt(sale.gas.maxCostWei))throw Error('Sale credit gas exceeded its limit.');
 const route=sale.simulation.route,source=receipts.at(-1)!.receipt;
 const debit=inspectCashSaleReceipt(route,source,cashSaleReceiptMinimum(sale.simulation));
 const status=await cashRelay(fetcher).status(route.requestId) as any;
 if(status.status!=='success')return null;
 if(status.originChainId!==CASH_NETWORKS[route.intent.network].chainId||status.destinationChainId!==RELAY_SOLANA||!Array.isArray(status.inTxHashes)||status.inTxHashes.length<1||status.inTxHashes.length>4||!status.inTxHashes.every((h:unknown)=>typeof h==='string'&&/^0x[0-9a-f]{64}$/i.test(h))||!status.inTxHashes.includes(hashes.at(-1))||!Array.isArray(status.txHashes)||status.txHashes.length!==1||typeof status.txHashes[0]!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(status.txHashes[0]))throw Error('Sale credit route changed.');
 const cash=await readCashSolanaCredit(route.requestId,sale.wallet,status.txHashes[0],solana);
 if(!cash||!cash.finalized||!cash.successful||cash.chainId!==RELAY_SOLANA||cash.currency!==CASH_MINT||cash.recipient!==sale.wallet||BigInt(cash.receivedRaw)<BigInt(route.minimumRaw))return null;
 // Reject a reorg occurring while the cash receipt was read.
 for(const r of receipts){const b=await evm('eth_getBlockByNumber',[r.receipt.blockNumber,false]) as any;if(b?.hash?.toLowerCase()!==r.receipt.blockHash.toLowerCase())return null;}
 return{sourceTransaction:hashes.at(-1)!,sourceBlockHash:source.blockHash.toLowerCase(),sourceBlockNumber:source.blockNumber,debitRaw:debit.sourceDebitRaw,cash};
}
