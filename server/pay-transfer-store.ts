import {neon} from '@neondatabase/serverless';
import {inspectPayTransfer,type PayTransferReview} from '../src/pay-transfer-model.js';
import type {PaymentReceipt} from '../src/pay-verification.js';
export type SavedPayTransfer={review:PayTransferReview;signed:string;signature:string;state:'pending'|'verified'|'failed'|'expired_unresolved';receipt:PaymentReceipt|null};
async function parse(row:any):Promise<SavedPayTransfer|null>{if(!row)return null;const signature=await inspectPayTransfer(row.review,row.sender,row.review.terms,row.signed_transaction,false);if(signature!==row.signature||row.reference!==row.review.reference)throw Error('Stored payment integrity failed.');return {review:row.review,signed:row.signed_transaction,signature:row.signature,state:row.state,receipt:row.receipt};}
export function payTransferStore(url:string){
 // The store survives across requests. A timeout belongs to one query, not to
 // the lifetime of the cached service or the user's wallet confirmation.
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});return {
 async get(reference:string){const sql=query();const rows=await sql`SELECT * FROM fub_pay_transfers WHERE reference=${reference}`;return parse(rows[0]);},
 async bind(review:PayTransferReview,signed:string){const signature=await inspectPayTransfer(review,review.sender,review.terms,signed,false);const sql=query();await sql`INSERT INTO fub_pay_transfers(reference,sender,signature,signed_transaction,review) VALUES(${review.reference},${review.sender},${signature},${signed},${JSON.stringify(review)}::jsonb)
 ON CONFLICT(reference) DO UPDATE SET sender=EXCLUDED.sender,signature=EXCLUDED.signature,signed_transaction=EXCLUDED.signed_transaction,review=EXCLUDED.review,previous_attempts=fub_pay_transfers.previous_attempts || jsonb_build_array(jsonb_build_object('review',fub_pay_transfers.review,'signed',fub_pay_transfers.signed_transaction,'signature',fub_pay_transfers.signature,'state',fub_pay_transfers.state)),state='pending',receipt=NULL,updated_at=clock_timestamp()
 WHERE fub_pay_transfers.state='failed' AND jsonb_array_length(fub_pay_transfers.previous_attempts)<10 AND fub_pay_transfers.signature<>EXCLUDED.signature`;
 const saved=await this.get(review.reference);if(!saved||saved.signature!==signature||saved.signed!==signed)throw Error('Another payment is already recorded for this share. Check its status.');return saved;},
 async settle(reference:string,signature:string,state:SavedPayTransfer['state'],receipt:PaymentReceipt|null=null){
 if((state==='verified')!==!!receipt||receipt&&(receipt.signature!==signature||receipt.reference!==reference))throw Error('Payment receipt identity mismatch.');
 const sql=query();await sql`UPDATE fub_pay_transfers SET state=${state},receipt=${receipt?JSON.stringify(receipt):null}::jsonb,updated_at=clock_timestamp() WHERE reference=${reference} AND signature=${signature} AND state IN('pending','expired_unresolved')`;
 const result=await this.get(reference);if(!result||result.signature!==signature)throw Error('Payment record changed.');return result;}
};}
export type PayTransferStore=ReturnType<typeof payTransferStore>;
