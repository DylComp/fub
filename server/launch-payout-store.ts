import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { PAYOUT_CHECK_SECONDS, rawLamports, validatePayoutAmounts, validatePayoutRoute, verifyPayoutSignature } from "./launch-payout-model.js";
import type { PayoutRoute, PayoutAttempt, PayoutClaim, PayoutOutcome, PayoutReceipt } from "./launch-payout-model.js";
import type { PayoutPilot } from "./launch-payout-pilot.js";
import {validatePayoutNonlanding,type PayoutNonlandingProof} from './payout-nonlanding.js';

export function launchPayoutStore(url: string, schedule: "continuous" | "minute" = "continuous", pilot?: PayoutPilot) {
  const client = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async recordNonlanding(a:PayoutAttempt,proof:PayoutNonlandingProof) {
      validatePayoutNonlanding(a,proof);
      const sql=client();
      const rows=await sql`UPDATE fomo_launch_payout_attempts a SET state='failed',nonlanding_proof=${JSON.stringify(proof)}::jsonb,
        network_fee_lamports=0,finalized_at=clock_timestamp()
        FROM fomo_launch_payouts p WHERE a.id=${a.id} AND a.mint=p.mint AND p.enabled=false
          AND (p.lease_until IS NULL OR p.lease_until<clock_timestamp()) AND a.state='pending'
          AND a.signed_transaction=${a.signed} AND a.unsigned_transaction=${a.unsigned} AND a.signature=${a.signature}
          AND a.payer=${a.payer} AND a.last_valid_block_height=${a.lastValidBlockHeight}
          AND a.reserved_fee_lamports=${a.feeLamports}::bigint RETURNING a.id`;
      if(rows.length!==1)throw Error('Payout nonlanding journal changed or route is active.');
    },
    // Internal registration only, after finalized launch verification. No public
    // endpoint can enable routes or replace a registered destination.
    // Ordinary launches enroll automatically. Official-coin onboarding must
    // remain paused until its separate final release approval, regardless of
    // the table default introduced for recurring launchpad payouts.
    async register(route: PayoutRoute) {
      validatePayoutRoute(route);
      const sql = client();
      const rows = await sql`INSERT INTO fomo_launch_payouts(mint,recipient,buyback_wallet,route_kind,enabled) VALUES(${route.mint},${route.recipient},${route.buybackWallet},${route.kind??"launchpad"},${route.kind!=="official"})
        ON CONFLICT(mint) DO UPDATE SET mint=EXCLUDED.mint
        WHERE fomo_launch_payouts.recipient=EXCLUDED.recipient AND fomo_launch_payouts.buyback_wallet=EXCLUDED.buyback_wallet AND fomo_launch_payouts.route_kind=EXCLUDED.route_kind RETURNING mint`;
      if (rows.length !== 1) throw Error("Registered payout destinations cannot be replaced.");
    },
    async claim(recoveryOnly = false): Promise<PayoutClaim | null> {
      const sql = client(), lease = randomUUID();
      const rows = await sql`WITH due AS (
        SELECT p.mint FROM fomo_launch_payouts p WHERE p.next_run_at<=clock_timestamp()
          AND (${pilot?.mint ?? null}::text IS NULL OR p.mint=${pilot?.mint ?? null})
          AND ((p.enabled AND NOT ${recoveryOnly} AND (${!pilot} OR (clock_timestamp()<to_timestamp(${pilot?.expiresAt ?? 0}::double precision/1000)
            AND NOT EXISTS(SELECT 1 FROM fomo_launch_payout_attempts a WHERE a.mint=p.mint AND a.nonlanding_proof IS NULL)
            AND (SELECT count(*) FROM fomo_launch_payout_attempts a WHERE a.mint=p.mint AND a.nonlanding_proof IS NOT NULL)<=1)))
            OR EXISTS(SELECT 1 FROM fomo_launch_payout_attempts a WHERE a.mint=p.mint AND a.state='pending'))
          AND (p.lease_until IS NULL OR p.lease_until<clock_timestamp())
        ORDER BY p.next_run_at,p.mint FOR UPDATE OF p SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE fomo_launch_payouts p SET lease_id=${lease},lease_until=clock_timestamp()+interval '60 seconds'
          FROM due WHERE p.mint=due.mint RETURNING p.*
      ) SELECT p.*,(${!pilot} OR clock_timestamp()<to_timestamp(${pilot?.expiresAt ?? 0}::double precision/1000)) AS pilot_active,
        a.id,a.payer,a.signature,a.signed_transaction,a.unsigned_transaction,a.last_valid_block_height,a.reserved_fee_lamports
        FROM claimed p LEFT JOIN fomo_launch_payout_attempts a ON a.mint=p.mint AND a.state='pending'`;
      const r = rows[0];
      return r ? { mint: r.mint, recipient: r.recipient, buybackWallet: r.buyback_wallet, kind:r.route_kind, lease, enabled: r.enabled && r.pilot_active,
        attempt: r.id ? { id: r.id, payer: r.payer, signature: r.signature, signed: r.signed_transaction, unsigned: r.unsigned_transaction,
          lastValidBlockHeight: Number(r.last_valid_block_height), feeLamports: String(r.reserved_fee_lamports) } : null } : null;
    },
    async save(claim: PayoutClaim, a: PayoutAttempt, dailyCap: string) {
      validatePayoutRoute(claim, a.payer);
      if (pilot && (a.payer !== pilot.payer || claim.mint !== pilot.mint || rawLamports(a.feeLamports) > 10000n)) throw Error("Payout differs from the approved pilot.");
      if (verifyPayoutSignature(a, a.signed, a.payer) !== a.signature || rawLamports(dailyCap) < rawLamports(a.feeLamports)) throw Error("Invalid payout attempt or budget.");
      const sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`launch-payout:${a.payer}`},0))`,
        sql`INSERT INTO fomo_launch_payout_attempts(id,mint,payer,signature,signed_transaction,unsigned_transaction,last_valid_block_height,reserved_fee_lamports)
          SELECT ${a.id},p.mint,${a.payer},${a.signature},${a.signed},${a.unsigned},${a.lastValidBlockHeight},${a.feeLamports}::bigint
          FROM fomo_launch_payouts p WHERE p.mint=${claim.mint} AND p.recipient=${claim.recipient} AND p.buyback_wallet=${claim.buybackWallet}
            AND p.route_kind=${claim.kind??"launchpad"} AND p.enabled AND p.lease_id=${claim.lease} AND p.lease_until>clock_timestamp()
            AND (${!pilot} OR (p.mint=${pilot?.mint ?? null} AND clock_timestamp()<to_timestamp(${pilot?.expiresAt ?? 0}::double precision/1000)
              AND NOT EXISTS(SELECT 1 FROM fomo_launch_payout_attempts previous WHERE previous.mint=p.mint AND previous.nonlanding_proof IS NULL)
              AND (SELECT count(*) FROM fomo_launch_payout_attempts previous WHERE previous.mint=p.mint AND previous.nonlanding_proof IS NOT NULL)<=1))
            AND COALESCE((SELECT sum(reserved_fee_lamports) FROM fomo_launch_payout_attempts WHERE payer=${a.payer} AND nonlanding_proof IS NULL AND budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date),0)+COALESCE((SELECT sum(reserved_fee_lamports) FROM fomo_quote_fee_attempts WHERE payer=${a.payer} AND budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date),0)+${a.feeLamports}::bigint<=${dailyCap}::numeric
            AND (p.fee_budget_lamports IS NULL OR COALESCE((SELECT sum(reserved_fee_lamports) FROM fomo_launch_payout_attempts previous WHERE previous.mint=p.mint AND previous.nonlanding_proof IS NULL),0)+${a.feeLamports}::bigint<=p.fee_budget_lamports)
          ON CONFLICT DO NOTHING RETURNING id`,
      ]);
      return rows.length === 1;
    },
    async maySend(claim: PayoutClaim, a: PayoutAttempt) {
      const sql = client();
      const rows = await sql`SELECT 1 FROM fomo_launch_payouts p JOIN fomo_launch_payout_attempts a ON p.mint=a.mint
        WHERE p.mint=${claim.mint} AND p.route_kind=${claim.kind??"launchpad"} AND p.enabled AND p.lease_id=${claim.lease} AND p.lease_until>clock_timestamp()
          AND (${!pilot} OR (p.mint=${pilot?.mint ?? null} AND a.payer=${pilot?.payer ?? null} AND clock_timestamp()<to_timestamp(${pilot?.expiresAt ?? 0}::double precision/1000)))
          AND (p.fee_budget_lamports IS NULL OR COALESCE((SELECT sum(reserved_fee_lamports) FROM fomo_launch_payout_attempts previous WHERE previous.mint=p.mint AND previous.nonlanding_proof IS NULL),0)<=p.fee_budget_lamports)
          AND a.id=${a.id} AND a.signature=${a.signature} AND a.state='pending'`;
      return rows.length === 1;
    },
    async settle(claim: PayoutClaim, a: PayoutAttempt, receipt: PayoutReceipt | null) {
      if (receipt && (!Number.isSafeInteger(receipt.slot) || receipt.slot < 0 ||
          rawLamports(receipt.networkFeeLamports) > rawLamports(a.feeLamports))) throw Error("Invalid payout receipt.");
      if (receipt) validatePayoutAmounts(claim,receipt.recipientLamports,receipt.buybackLamports);
      const sql = client();
      const rows = await sql`WITH settled AS (
        UPDATE fomo_launch_payout_attempts a SET state=${receipt ? "confirmed" : "failed"},finalized_at=clock_timestamp(),
          slot=${receipt?.slot ?? null},recipient_lamports=${receipt?.recipientLamports ?? null},buyback_lamports=${receipt?.buybackLamports ?? null},network_fee_lamports=${receipt?.networkFeeLamports ?? null}
        FROM fomo_launch_payouts p WHERE a.id=${a.id} AND a.mint=p.mint AND p.mint=${claim.mint}
          AND p.route_kind=${claim.kind??"launchpad"} AND p.recipient=${claim.recipient} AND p.buyback_wallet=${claim.buybackWallet}
          AND a.state='pending' AND a.signature=${a.signature} AND p.lease_id=${claim.lease} AND p.lease_until>clock_timestamp() RETURNING a.mint
      ) UPDATE fomo_launch_payouts p SET enabled=CASE WHEN ${!!pilot} THEN false ELSE p.enabled END, last_paid_at=CASE WHEN ${!!receipt} THEN clock_timestamp() ELSE last_paid_at END
        FROM settled s WHERE p.mint=s.mint RETURNING p.mint`;
      if (rows.length !== 1) throw Error("Payout settlement lease lost.");
    },
    async health() {
      const sql = client();
      const rows = await sql`SELECT
        (SELECT count(*)::integer FROM fomo_launch_payouts WHERE enabled AND next_run_at<clock_timestamp()-interval '60 seconds') AS overdue,
        (SELECT count(*)::integer FROM fomo_launch_payouts WHERE outcome IN('expired_unresolved','budget_exhausted') OR (outcome='retry' AND failures>=3)) AS blocked,
        (SELECT count(*)::integer FROM fomo_launch_payout_attempts WHERE state='pending' AND created_at<clock_timestamp()-interval '2 minutes') AS unresolved`;
      return rows[0] as { overdue: number; blocked: number; unresolved: number };
    },
    async complete(claim: PayoutClaim, outcome: PayoutOutcome) {
      const sql = client(), failure = ["retry", "failed", "expired_unresolved"].includes(outcome);
      await sql`UPDATE fomo_launch_payouts SET lease_id=NULL,lease_until=NULL,last_checked_at=clock_timestamp(),outcome=${outcome},
        next_run_at=CASE WHEN ${outcome === "budget_exhausted"} THEN clock_timestamp()+interval '5 minutes'
          WHEN ${failure} THEN clock_timestamp()+LEAST(${PAYOUT_CHECK_SECONDS}*power(2,failures),120)*interval '1 second'
          WHEN ${schedule === "minute"} THEN date_trunc('minute',clock_timestamp())+interval '60 seconds'
          ELSE clock_timestamp()+${PAYOUT_CHECK_SECONDS}*interval '1 second' END,
        failures=CASE WHEN ${failure} THEN LEAST(failures+1,6) ELSE 0 END
        WHERE mint=${claim.mint} AND lease_id=${claim.lease} AND lease_until>clock_timestamp()`;
    },
  };
}
export type LaunchPayoutStore = ReturnType<typeof launchPayoutStore>;
