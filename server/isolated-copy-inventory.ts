import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { neon } from "@neondatabase/serverless";
import bs58 from "bs58";
import { address, getTransactionDecoder } from "@solana/kit";
import { USDC } from "../src/funding-model.js";
import { validateSwapIntent, swapRaw } from "../src/copy-swap.js";
import { isolatedSigningIdentity } from "./isolated-signing-budget.js";
import { verifyCopySwapMessageSignature } from "./copy-swap.js";
import { verifyCopyLanded } from "./copy-outcome.js";
import type { CopySigningRequest } from "./copy-dispatch-worker.js";
import type { CopyAttempt } from "./copy-ledger.js";
import type { readCopyInventory } from "./copy-inventory.js";
import type { SwapEvidence } from "../src/copy-feed.js";
export type InventoryEvidence = { request: CopySigningRequest; leaderSignature: string; decimals: number; createdAt: number };
export function inventoryIdentity(e: InventoryEvidence) {
  validateSwapIntent(e.request.review.intent,e.createdAt);
  const i=isolatedSigningIdentity(e.request,e.leaderSignature,e.createdAt,true);
  if(!Number.isInteger(e.decimals)||e.decimals<0||e.decimals>18)throw Error("Unsupported inventory decimals.");
  const side=e.request.review.intent.inputMint===USDC ? "buy" as const : "sell" as const;
  return {...i,side,mint:side==='buy'?e.request.review.intent.outputMint:e.request.review.intent.inputMint,
    inputRaw:e.request.review.intent.inputRaw,decimals:e.decimals,
    requestHash:createHash('sha256').update(canonicalize({requestHash:i.requestHash,decimals:e.decimals,side})!).digest('hex')};
}
export function inventoryAttempt(e: InventoryEvidence,signed:string): CopyAttempt {
  const i=inventoryIdentity(e),r=e.request,p=r.permission.scope;
  verifyCopySwapMessageSignature(r.review,signed);
  const tx=getTransactionDecoder().decode(Buffer.from(signed,'base64'));
  const signature=bs58.encode(tx.signatures[address(r.wallet)]!);
  const attempt:CopyAttempt={id:r.attemptId,planId:p.planId,wallet:r.wallet,mint:i.mint,side:i.side,leaderSignature:e.leaderSignature,state:'submitting',
    reservedCents:i.cents,inputRaw:i.inputRaw,inputDecimals:i.side==='sell'?e.decimals:6,outputDecimals:i.side==='buy'?e.decimals:6,
    minOutputRaw:r.review.intent.minOutputRaw,expiresAt:r.review.expiresAt,signature,messageHash:r.review.messageHash,
    prepared:{review:r.review,savedAt:e.createdAt},execution:{version:1,signed,feeLamports:p.maxNetworkFeeLamports,rentLamports:p.maxRentLamports,
      minContextSlot:Math.max(r.review.lifetime.slot,r.review.routeContextSlot||0,...r.review.lookupTables.map(t=>t.contextSlot))}};
  return attempt;
}
export function verifyInventoryReceipt(e: InventoryEvidence,signed:string,value:unknown) {
  return verifyCopyLanded(inventoryAttempt(e,signed),value);
}
export type InventoryPending = { id: string; hash: string; evidence: InventoryEvidence; signed: string; signature: string };
export function isolatedCopyInventory(url:string) {
  const client=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
  const insert=(db:ReturnType<typeof client>,e:InventoryEvidence)=>{
    const i=inventoryIdentity(e);
    return db`INSERT INTO signer_copy_inventory(attempt_id,wallet,plan_id,mint,side,leader_signature,request_hash,evidence,decimals,input_raw,expires_at,unsigned_recovery)
      VALUES(${i.attemptId},${i.wallet},${i.planId},${i.mint},${i.side},${i.leaderSignature},${i.requestHash},${JSON.stringify(e)}::jsonb,${i.decimals},${i.inputRaw}::numeric,to_timestamp(${i.expiresAt}/1000.0),true)
      ON CONFLICT DO NOTHING RETURNING attempt_id`;
  };
  return {
    async recordBuy(e:InventoryEvidence) {
      const i=inventoryIdentity(e);if(i.side!=='buy'||i.expiresAt<=Date.now())throw Error('Buy archive refused.');
      const rows=await insert(client(),e);if(rows.length!==1)throw Error('Buy archive already exists. Recover the saved request.');
    },
    async minimumSlot(wallet:string,mint:string) {
      const [row]=await client()`SELECT GREATEST(COALESCE((SELECT max(settled_slot) FROM signer_copy_inventory WHERE wallet=${wallet} AND mint=${mint}),0),
        COALESCE((SELECT max(slot) FROM signer_inventory_reviews WHERE wallet=${wallet} AND mint=${mint} AND lane='standard' AND state='applied'),0))::text AS slot`;
      const slot=Number(row.slot);if(!Number.isSafeInteger(slot))throw Error('Invalid inventory slot.');return slot;
    },
    async claimSell(e:InventoryEvidence,leader:SwapEvidence,holdings:Awaited<ReturnType<typeof readCopyInventory>>) {
      const i=inventoryIdentity(e);
      if(i.side!=='sell'||leader.kind!=='swap'||leader.side!=='sell'||leader.mint!==i.mint||leader.tokenDecimals!==e.decimals||
        holdings.wallet!==i.wallet||holdings.mint!==i.mint||holdings.decimals!==e.decimals||!holdings.exists||
        !Number.isSafeInteger(holdings.slot)||holdings.slot<1||!Number.isSafeInteger(holdings.fetchedAt)||Date.now()-holdings.fetchedAt>5000||holdings.fetchedAt>Date.now())throw Error('Sell inventory evidence refused.');
      const sold=swapRaw(leader.tokenRaw),before=swapRaw(leader.leaderTokenBeforeRaw);if(sold>before)throw Error('Invalid leader proportion.');
      const balance=swapRaw(holdings.rawAmount),db=client();
      const [,rows]=await db.transaction([
        db`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:${i.wallet}:${i.mint}`},0))`,
        db`INSERT INTO signer_copy_inventory(attempt_id,wallet,plan_id,mint,side,leader_signature,request_hash,evidence,decimals,input_raw,expires_at,unsigned_recovery)
          SELECT ${i.attemptId},${i.wallet},${i.planId},${i.mint},'sell',${i.leaderSignature},${i.requestHash},${JSON.stringify(e)}::jsonb,${i.decimals},${i.inputRaw}::numeric,to_timestamp(${i.expiresAt}/1000.0),true
          FROM (SELECT COALESCE(sum(CASE WHEN side='buy' THEN credited_raw-corrected_raw WHEN settlement<>'failed' THEN -input_raw ELSE 0 END),0) AS total,
            COALESCE(sum(CASE WHEN plan_id=${i.planId} THEN CASE WHEN side='buy' THEN credited_raw-corrected_raw WHEN settlement<>'failed' THEN -input_raw ELSE 0 END ELSE 0 END),0) AS owned,
            COALESCE(max(settled_slot),0) AS slot,
            count(*) FILTER (WHERE decimals<>${i.decimals}) AS incompatible
            FROM signer_copy_inventory WHERE wallet=${i.wallet} AND mint=${i.mint} AND unsigned_expired_at IS NULL) position
          WHERE NOT EXISTS(SELECT 1 FROM signer_inventory_reviews WHERE wallet=${i.wallet} AND mint=${i.mint} AND lane='standard' AND state='applied' AND slot>${holdings.slot})
          AND position.incompatible=0 AND position.slot<=${holdings.slot} AND position.total>=position.owned AND position.owned>0
            AND position.total<=${balance.toString()}::numeric AND ${i.inputRaw}::numeric<=div(position.owned*${sold.toString()}::numeric,${before.toString()}::numeric)
            AND to_timestamp(${i.expiresAt}/1000.0)>clock_timestamp()
            AND to_timestamp(${holdings.fetchedAt}/1000.0)>clock_timestamp()-interval '5 seconds'
          ON CONFLICT DO NOTHING RETURNING attempt_id`,
      ]);
      if(rows.length)return {kind:'new' as const};
      const cached=await db`SELECT signed_transaction FROM signer_copy_inventory WHERE attempt_id=${i.attemptId} AND request_hash=${i.requestHash}
        AND state='signed' AND unsigned_expired_at IS NULL AND settlement='pending' AND expires_at>clock_timestamp()`;
      if(cached.length)return {kind:'signed' as const,signed:cached[0].signed_transaction as string};
      throw Error('No independently verified sell allocation is available.');
    },
    async complete(e:InventoryEvidence,signed:string) {
      const i=inventoryIdentity(e);verifyCopySwapMessageSignature(e.request.review,signed);
      const signature=bs58.encode(getTransactionDecoder().decode(Buffer.from(signed,'base64')).signatures[address(i.wallet)]!);
      const rows=await client()`UPDATE signer_copy_inventory SET state='signed',signed_transaction=${signed},signature=${signature},updated_at=clock_timestamp()
        WHERE attempt_id=${i.attemptId} AND request_hash=${i.requestHash} AND state IN ('reserved','uncertain') AND signed_transaction IS NULL RETURNING attempt_id,unsigned_expired_at`;
      if(rows.length!==1||rows[0].unsigned_expired_at)throw Error('Inventory signature saved after expiry or persistence unavailable.');
    },
    async uncertain(e:InventoryEvidence) {
      const i=inventoryIdentity(e);await client()`UPDATE signer_copy_inventory SET state='uncertain',updated_at=clock_timestamp()
        WHERE attempt_id=${i.attemptId} AND request_hash=${i.requestHash} AND state='reserved'`;
    },
    async recent(wallet:string,mint:string):Promise<InventoryPending[]> {
      const rows=await client()`SELECT attempt_id,request_hash,evidence,signed_transaction,signature FROM signer_copy_inventory
        WHERE wallet=${wallet} AND mint=${mint} AND state='signed' AND unsigned_expired_at IS NULL AND settlement='pending' ORDER BY created_at DESC,attempt_id LIMIT 4`;
      return rows.map(r=>({id:r.attempt_id as string,hash:r.request_hash as string,evidence:r.evidence as InventoryEvidence,signed:r.signed_transaction as string,signature:r.signature as string}));
    },
    async pending(limit=8):Promise<InventoryPending[]> {
      if(!Number.isInteger(limit)||limit<1||limit>8)throw Error('Invalid recovery batch size.');
      const rows=await client()`SELECT attempt_id,request_hash,evidence,signed_transaction,signature FROM signer_copy_inventory
        WHERE state='signed' AND unsigned_expired_at IS NULL AND settlement='pending' AND next_check_at<=clock_timestamp() ORDER BY next_check_at,attempt_id LIMIT ${limit}`;
      return rows.map(r=>({id:r.attempt_id as string,hash:r.request_hash as string,evidence:r.evidence as InventoryEvidence,signed:r.signed_transaction as string,signature:r.signature as string}));
    },
    async defer(row:InventoryPending) {
      await client()`UPDATE signer_copy_inventory SET next_check_at=clock_timestamp()+interval '30 seconds'
        WHERE attempt_id=${row.id} AND request_hash=${row.hash} AND settlement='pending'`;
    },
    async settle(row:InventoryPending,value:unknown) {
      const i=inventoryIdentity(row.evidence);if(i.requestHash!==row.hash||i.attemptId!==row.id)throw Error('Private evidence changed.');
      const receipt=verifyInventoryReceipt(row.evidence,row.signed,value);
      if(receipt.signature!==row.signature)throw Error('Private signature changed.');
      const credit=receipt.kind==='succeeded'&&i.side==='buy'?receipt.outputRaw:'0';
      const rows=await client()`UPDATE signer_copy_inventory SET settlement=${receipt.kind},credited_raw=${credit}::numeric,
        settled_slot=${receipt.slot},receipt=${JSON.stringify(receipt)}::jsonb,updated_at=clock_timestamp()
        WHERE attempt_id=${i.attemptId} AND request_hash=${i.requestHash} AND signed_transaction=${row.signed} AND unsigned_expired_at IS NULL AND settlement='pending' RETURNING attempt_id`;
      return rows.length===1;
    },
  };
}
export type IsolatedCopyInventory=ReturnType<typeof isolatedCopyInventory>;
