import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { CopyConflict, copyStore } from "./copy-store.js";
import {
  makeCopyPermission,
  parseCopyPermission,
  copyPermissionMessage,
  copyPermissionHash,
  verifyCopyPermission,
} from "./copy-permission-model.js";

function permissionRow(row: Record<string, any>) {
  const scope = parseCopyPermission(row.scope);
  if (copyPermissionHash(scope) !== row.scope_hash)
    throw new Error("Stored copy permission does not match its review.");
  return {
    scope,
    message: copyPermissionMessage(scope),
    hash: row.scope_hash as string,
    acceptedAt: row.accepted_at
      ? new Date(row.accepted_at).toISOString()
      : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}
// Internal enrollment only. There is deliberately no public grant, activation,
// resume or signer endpoint until a provider can enforce these rules independently.
export function copyPermissions(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  return {
    async challenge(
      wallet: string,
      request: {
        id: string;
        planId: string;
        planVersion: number;
        durationSeconds: number;
      },
    ) {
      if (
        !isMint(wallet) ||
        !request ||
        Object.keys(request).sort().join(",") !==
          "durationSeconds,id,planId,planVersion" ||
        !operationId(request.id) ||
        !operationId(request.planId) ||
        !Number.isSafeInteger(request.planVersion) ||
        request.planVersion < 1 ||
        request.planVersion > 2147483647 ||
        !Number.isSafeInteger(request.durationSeconds) ||
        request.durationSeconds < 600 ||
        request.durationSeconds > 86400
      )
        throw new Error("Invalid copy permission request.");
      request = {
        ...request,
        id: request.id.toLowerCase(),
        planId: request.planId.toLowerCase(),
      };
      const sql = client();
      const existing =
        await sql`SELECT * FROM fomo_copy_permissions WHERE wallet=${wallet} AND id=${request.id}`;
      if (existing[0]) {
        const old = permissionRow(existing[0]);
        if (
          old.scope.planId !== request.planId ||
          old.scope.planVersion !== request.planVersion ||
          old.scope.expiresAt - old.scope.issuedAt !==
            request.durationSeconds * 1000
        )
          throw new CopyConflict("Permission request ID was already used.");
        return old;
      }
      const plan = (await copyStore(url).list(wallet)).find(
        (p) => p.id === request.planId,
      );
      if (
        !plan ||
        plan.version !== request.planVersion ||
        plan.archived ||
        plan.enabled
      )
        throw new CopyConflict(
          "Pause and refresh this plan before reviewing permission.",
        );
      const scope = makeCopyPermission(
        plan,
        request.id,
        request.durationSeconds,
      );
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`INSERT INTO fomo_copy_permissions(id,plan_id,wallet,plan_version,scope,scope_hash,issued_at,accept_by,expires_at)
          SELECT ${scope.id},p.id,p.wallet,p.version,${JSON.stringify(scope)}::jsonb,${copyPermissionHash(scope)},
            to_timestamp(${scope.issuedAt}/1000.0),to_timestamp(${scope.acceptBy}/1000.0),to_timestamp(${scope.expiresAt}/1000.0)
          FROM fomo_copy_plans p WHERE p.id=${scope.planId} AND p.wallet=${wallet} AND p.version=${scope.planVersion}
            AND p.data=${JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([key]) => !["wallet", "version", "archived", "enabled"].includes(key))))}::jsonb
            AND NOT p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls WHERE wallet=${wallet})
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN ('reserved','submitting','unknown'))
            AND (SELECT count(*) FROM fomo_copy_permissions WHERE plan_id=p.id AND issued_at>statement_timestamp()-interval '1 day')<50
          ON CONFLICT(id) DO NOTHING RETURNING *`,
      ]);
      if (rows[0]) return permissionRow(rows[0]);
      const retry =
        await sql`SELECT * FROM fomo_copy_permissions WHERE wallet=${wallet} AND id=${request.id}`;
      if (retry[0] && copyPermissionHash(scope) === retry[0].scope_hash)
        return permissionRow(retry[0]);
      // Concurrent exact retries may have different issue timestamps.
      if (
        retry[0] &&
        retry[0].plan_id === request.planId &&
        retry[0].plan_version === request.planVersion &&
        retry[0].scope.expiresAt - retry[0].scope.issuedAt ===
          request.durationSeconds * 1000
      )
        return permissionRow(retry[0]);
      throw new CopyConflict(
        "Permission review changed, is stopped, or has unresolved trades.",
      );
    },
    async accept(wallet: string, id: string, signature: string) {
      if (!isMint(wallet) || !operationId(id))
        throw new Error("Invalid copy permission identity.");
      const sql = client();
      const rows =
        await sql`SELECT * FROM fomo_copy_permissions WHERE wallet=${wallet} AND id=${id}`;
      if (!rows[0]) throw new CopyConflict("Permission review is unavailable.");
      const before = permissionRow(rows[0]);
      verifyCopyPermission(before.scope, signature);
      const [, saved] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH accepted AS (
          UPDATE fomo_copy_permissions g SET signature=${signature},accepted_at=statement_timestamp()
          FROM fomo_copy_plans p WHERE g.id=${id} AND g.wallet=${wallet} AND g.scope_hash=${before.hash}
            AND g.accepted_at IS NULL AND g.revoked_at IS NULL AND g.issued_at<=statement_timestamp() AND g.accept_by>statement_timestamp()
            AND g.expires_at>statement_timestamp() AND p.id=g.plan_id AND p.wallet=g.wallet AND p.version=g.plan_version
            AND NOT p.enabled AND NOT p.archived AND p.leader=g.scope->>'leader'
            AND p.data->'buyCents'=g.scope->'buyCents' AND p.data->'dailyCents'=g.scope->'dailyCents'
            AND p.data->'slippageBps'=g.scope->'slippageBps' AND p.data->'copySells'=g.scope->'copySells'
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls WHERE wallet=${wallet})
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN ('reserved','submitting','unknown'))
          RETURNING g.*
        ), superseded AS (
          UPDATE fomo_copy_permissions SET revoked_at=statement_timestamp(),revoke_reason='replaced'
          WHERE wallet=${wallet} AND plan_id IN(SELECT plan_id FROM accepted) AND id<>${id} AND revoked_at IS NULL
        ) SELECT * FROM accepted UNION ALL SELECT * FROM fomo_copy_permissions WHERE wallet=${wallet} AND id=${id} AND accepted_at IS NOT NULL AND signature=${signature}`,
      ]);
      if (!saved[0])
        throw new CopyConflict(
          "Permission expired or the plan changed. Review it again.",
        );
      return permissionRow(saved[0]);
    },
  };
}
