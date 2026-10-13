import { neon } from "@neondatabase/serverless";
import {
  assertToken22PermissionReview,
  verifyToken22Permission,
} from "./token2022-permission.js";
import type { Raydium22ExecutionReview } from "./token2022-recovery.js";

// Null means an unaccounted engineering journal, never a trading grant.
export async function token22SigningAuthority(
  url: string,
  wallet: string,
  id: string,
  review: Raydium22ExecutionReview,
) {
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(8000) },
  });
  const rows =
    await sql`SELECT g.scope,g.signature,g.scope_hash FROM fomo_token22_reservations r
    JOIN fomo_token22_permissions g ON g.id=r.permission_id WHERE r.execution_id=${id} AND r.wallet=${wallet}`;
  if (!rows[0]) return null;
  const r = rows[0];
  if (verifyToken22Permission(r.scope, r.signature) !== r.scope_hash)
    throw Error("Permission proof changed.");
  assertToken22PermissionReview(r.scope, review);
  return r.scope_hash as string;
}
