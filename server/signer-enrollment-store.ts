import { neon } from "@neondatabase/serverless";
import type { EnrollmentChallenge } from "../src/signer-enrollment-model.js";
import { EnrollmentRefused } from "./privy-owner.js";
export type EnrollmentRecord = { challenge: EnrollmentChallenge; state: "pending" | "active" | "revoked"; signature: string | null; activatedAt: number | null };
function record(row: Record<string, any>): EnrollmentRecord {
  return { challenge: row.challenge, state: row.state, signature: row.signature,
    activatedAt: row.activated_at ? new Date(row.activated_at).getTime() : null };
}
export function signerEnrollmentStore(databaseUrl: string) {
  const sql = () => neon(databaseUrl, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async issue(challenge: Omit<EnrollmentChallenge, "epoch">): Promise<EnrollmentChallenge> {
      const db = sql();
      const [, , rows] = await db.transaction([
        db`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment:${challenge.wallet}`},0))`,
        db`INSERT INTO signer_wallet_epochs(wallet) VALUES(${challenge.wallet}) ON CONFLICT DO NOTHING`,
        db`INSERT INTO signer_enrollments(id,wallet,user_id,wallet_id,epoch,challenge,challenge_expires_at,expires_at)
          SELECT ${challenge.id},${challenge.wallet},${challenge.userId},${challenge.walletId},epoch,
            ${JSON.stringify(challenge)}::jsonb || jsonb_build_object('epoch',epoch),
            to_timestamp(${challenge.challengeExpiresAt}/1000.0),to_timestamp(${challenge.expiresAt}/1000.0)
          FROM signer_wallet_epochs WHERE wallet=${challenge.wallet}
          AND to_timestamp(${challenge.challengeExpiresAt}/1000.0)>clock_timestamp()
          AND (SELECT count(*) FROM signer_enrollments WHERE wallet=${challenge.wallet}
            AND created_at>clock_timestamp()-interval '1 minute')<20 RETURNING challenge`,
      ]);
      if (rows.length !== 1) throw new EnrollmentRefused();
      return rows[0].challenge as EnrollmentChallenge;
    },
    async get(id: string, userId: string): Promise<EnrollmentRecord> {
      const rows = await sql()`SELECT * FROM signer_enrollments WHERE id=${id} AND user_id=${userId}`;
      if (rows.length !== 1) throw new EnrollmentRefused();
      return record(rows[0]);
    },
    async list(wallet: string, userId: string): Promise<EnrollmentRecord[]> {
      // Return the active grant first even after many abandoned reviews. Never
      // return another owner's grants or their signatures through the API.
      const rows = await sql()`SELECT * FROM signer_enrollments WHERE wallet=${wallet} AND user_id=${userId}
        ORDER BY (state='active') DESC,created_at DESC,id DESC LIMIT 20`;
      return rows.map(record);
    },
    async activate(c: EnrollmentChallenge, signature: string): Promise<void> {
      const db = sql();
      const [, , , rows] = await db.transaction([
        db`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment:${c.wallet}`},0))`,
        db`UPDATE signer_wallet_epochs SET epoch=epoch+1 WHERE wallet=${c.wallet} AND epoch=${c.epoch}
          AND EXISTS(SELECT 1 FROM signer_enrollments WHERE id=${c.id} AND wallet=${c.wallet} AND user_id=${c.userId}
            AND state='pending' AND challenge=${JSON.stringify(c)}::jsonb AND challenge_expires_at>clock_timestamp())`,
        db`UPDATE signer_enrollments SET state='revoked',stopped_at=clock_timestamp()
          WHERE wallet=${c.wallet} AND id<>${c.id} AND state IN ('active','pending')
          AND EXISTS(SELECT 1 FROM signer_wallet_epochs e JOIN signer_enrollments g ON g.wallet=e.wallet
            WHERE g.id=${c.id} AND g.state='pending' AND e.epoch=${c.epoch + 1} AND g.epoch=${c.epoch})`,
        db`UPDATE signer_enrollments SET state='active',signature=${signature},activated_at=clock_timestamp()
          WHERE id=${c.id} AND wallet=${c.wallet} AND user_id=${c.userId} AND state='pending'
            AND challenge=${JSON.stringify(c)}::jsonb AND challenge_expires_at>clock_timestamp()
            AND EXISTS(SELECT 1 FROM signer_wallet_epochs WHERE wallet=${c.wallet} AND epoch=${c.epoch + 1}) RETURNING id`,
      ]);
      if (rows.length === 1) return;
      // A lost success response may be retried, but cannot reactivate a stopped grant.
      const retry = await db`SELECT id FROM signer_enrollments g JOIN signer_wallet_epochs e USING(wallet)
        WHERE g.id=${c.id} AND g.state='active' AND g.signature=${signature}
          AND g.challenge=${JSON.stringify(c)}::jsonb AND e.epoch=g.epoch+1 AND g.expires_at>clock_timestamp()`;
      if (retry.length !== 1) throw new EnrollmentRefused();
    },
    async stop(id: string, userId: string): Promise<void> {
      const found = await this.get(id, userId), wallet = found.challenge.wallet;
      const db = sql();
      await db.transaction([
        db`SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment:${wallet}`},0))`,
        db`UPDATE signer_wallet_epochs e SET epoch=e.epoch+1 WHERE e.wallet=${wallet}
          AND EXISTS(SELECT 1 FROM signer_enrollments g WHERE g.id=${id} AND g.user_id=${userId}
            AND g.wallet=e.wallet AND ((g.state='pending' AND g.epoch=e.epoch) OR (g.state='active' AND g.epoch+1=e.epoch)))`,
        db`UPDATE signer_enrollments g SET state='revoked',stopped_at=clock_timestamp()
          WHERE g.wallet=${wallet} AND g.state IN ('pending','active')
          AND EXISTS(SELECT 1 FROM signer_wallet_epochs e WHERE e.wallet=g.wallet
            AND ((g.state='pending' AND g.epoch<e.epoch) OR (g.state='active' AND g.epoch+1<e.epoch)))`,
      ]);
      const after = await this.get(id, userId);
      if (after.state !== "revoked") throw new EnrollmentRefused();
    },
    async active(wallet: string): Promise<EnrollmentRecord> {
      const rows = await sql()`SELECT g.* FROM signer_enrollments g JOIN signer_wallet_epochs e USING(wallet)
        WHERE g.wallet=${wallet} AND g.state='active' AND g.expires_at>clock_timestamp() AND e.epoch=g.epoch+1`;
      if (rows.length !== 1) throw new EnrollmentRefused();
      return record(rows[0]);
    },
  };
}
export type SignerEnrollmentStore = ReturnType<typeof signerEnrollmentStore>;
