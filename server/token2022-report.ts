import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { CopyValidation } from "../src/copy-account.js";
import { verifyToken22Permission } from "./token2022-permission.js";
import type { NativeCopyReport } from "../src/native-copy.js";

// Owner-authenticated caller only. Never return consent signatures or signed bytes.
export async function nativeCopyReport(
  url: string,
  wallet: string,
): Promise<NativeCopyReport> {
  if (!isMint(wallet)) throw new CopyValidation("Invalid wallet.");
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(10000) },
  });
  const rows =
    await sql`SELECT p.id,p.wallet,p.leader,p.version,p.enabled,p.archived,p.data->>'name' AS name,
    g.scope,g.scope_hash,g.signature,g.revoked_at,g.expires_at,
    EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet) AS stopped,
    statement_timestamp() AS checked_at,
    COALESCE(b.spent_lamports,0)::text AS spent,COALESCE(b.reserved_lamports,0)::text AS reserved,
    (SELECT COALESCE(sum(r.reserved_lamports),0)::text FROM fomo_token22_reservations r WHERE r.plan_id=p.id AND r.state='reserved') AS held,
    (SELECT count(*)::int FROM fomo_token22_reservations r WHERE r.plan_id=p.id AND r.state='reserved') AS pending
    FROM fomo_copy_plans p
    JOIN LATERAL (SELECT * FROM fomo_token22_permissions g WHERE g.plan_id=p.id AND g.wallet=p.wallet ORDER BY created_at DESC,id DESC LIMIT 1) g ON true
    LEFT JOIN fomo_token22_budgets b ON b.plan_id=p.id AND b.day=(statement_timestamp() AT TIME ZONE 'UTC')::date
    WHERE p.wallet=${wallet} ORDER BY p.updated_at DESC,p.id LIMIT 26`;
  return {
    wallet,
    checkedAt: new Date(rows[0]?.checked_at ?? Date.now()).toISOString(),
    hasMore: rows.length > 25,
    plans: rows.slice(0, 25).map((row) => {
      const s = row.scope;
      if (
        verifyToken22Permission(s, row.signature) !== row.scope_hash ||
        s.wallet !== wallet ||
        s.planId !== row.id
      )
        throw Error("Saved SOL limits could not be verified.");
      const status = row.revoked_at
        ? "revoked"
        : new Date(row.expires_at).getTime() <=
            new Date(row.checked_at).getTime()
          ? "expired"
          : row.version !== s.planVersion || row.leader !== s.leader
            ? "changed"
            : !row.enabled || row.archived || row.stopped
              ? "paused"
              : "accepted";
      return {
        id: row.id,
        name: row.name || "",
        leader: row.leader,
        status,
        ...((s.version===2||s.version===4||s.version===6||s.version===8||s.version===10)?{mint:s.mint}:{}),
        buyLamports: s.buyLamports,
        dailySpendLamports: s.dailySpendLamports,
        maxFeeLamports: s.maxFeeLamports,
        maxRentLamports: s.maxRentLamports,
        slippageBps: s.slippageBps,
        copySells: s.copySells,
        expiresAt: new Date(row.expires_at).toISOString(),
        spentTodayLamports: row.spent,
        reservedTodayLamports: row.reserved,
        heldLamports: row.held,
        pendingCount: row.pending,
      };
    }),
  };
}
