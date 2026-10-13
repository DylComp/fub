import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import type { PublishedLaunch, LaunchAuthorization } from "../src/launch-publication.js";
export class PublicationLimit extends Error {}
export class PublicationPending extends Error {}
export function launchPublicationStore(url: string) {
  const client = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  return {
    async reserve(a: LaunchAuthorization, signature: string, manifest: string): Promise<PublishedLaunch | null> {
      if (createHash("sha256").update(manifest).digest("hex") !== a.payloadHash) throw Error("Publication manifest mismatch.");
      const sql = client();
      const [, inserted] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('launch-publications',0))`,
        sql`INSERT INTO fomo_launch_publication_requests(owner,nonce,payload_hash,authorization_record,signature,manifest)
          SELECT ${a.wallet},${a.nonce},${a.payloadHash},${JSON.stringify(a)}::jsonb,${signature},${manifest} WHERE
          (SELECT count(*) FROM fomo_launch_publication_requests WHERE created_at>clock_timestamp()-interval '24 hours')<100
          AND (SELECT count(*) FROM fomo_launch_publication_requests WHERE owner=${a.wallet} AND created_at>clock_timestamp()-interval '24 hours')<5
          ON CONFLICT DO NOTHING RETURNING nonce`,
      ]);
      if (inserted.length) return null;
      const rows = await sql`SELECT r.state,r.payload_hash,p.data FROM fomo_launch_publication_requests r LEFT JOIN fomo_launch_publications p ON p.id=r.publication_id
        WHERE r.owner=${a.wallet} AND r.nonce=${a.nonce}`;
      if (rows[0]?.payload_hash === a.payloadHash && rows[0]?.state === "complete") return rows[0].data as PublishedLaunch;
      if (rows.length) throw new PublicationPending("This request is already processing or failed. Reload saved drafts before trying again.");
      throw new PublicationLimit("Publication limit reached. Try again later.");
    },
    async complete(a: LaunchAuthorization, p: PublishedLaunch, image: Buffer, type: string, metadata: string) {
      if (p.owner !== a.wallet || createHash("sha256").update(image).digest("hex") !== p.imageHash || createHash("sha256").update(metadata).digest("hex") !== p.metadataHash) throw Error("Publication integrity mismatch.");
      const sql = client();
      const rows = await sql`WITH pending AS MATERIALIZED (
          SELECT owner,nonce FROM fomo_launch_publication_requests
          WHERE owner=${a.wallet} AND nonce=${a.nonce} AND payload_hash=${a.payloadHash} AND state='pending' FOR UPDATE
        ), image_insert AS (
          INSERT INTO fomo_launch_images(hash,content_type,bytes)
          SELECT ${p.imageHash},${type},decode(${image.toString("base64")},'base64') FROM pending ON CONFLICT DO NOTHING
        ), metadata_insert AS (
          INSERT INTO fomo_launch_metadata(hash,body) SELECT ${p.metadataHash},${metadata} FROM pending ON CONFLICT DO NOTHING
        ), publication_insert AS (
          INSERT INTO fomo_launch_publications(id,owner,data,image_hash,metadata_hash)
          SELECT ${p.id},${p.owner},${JSON.stringify(p)}::jsonb,${p.imageHash},${p.metadataHash} FROM pending ON CONFLICT DO NOTHING
        ) UPDATE fomo_launch_publication_requests r SET state='complete',publication_id=${p.id} FROM pending
          WHERE r.owner=pending.owner AND r.nonce=pending.nonce RETURNING r.nonce`;
      if (rows.length !== 1) throw Error("Publication request no longer pending.");
      const saved = await sql`SELECT data FROM fomo_launch_publications WHERE id=${p.id} AND owner=${p.owner}`;
      return saved[0].data as PublishedLaunch;
    },
    async fail(a: LaunchAuthorization) {
      await client()`UPDATE fomo_launch_publication_requests SET state='failed' WHERE owner=${a.wallet} AND nonce=${a.nonce} AND payload_hash=${a.payloadHash} AND state='pending'`;
    },
    async get(id: string, owner: string) {
      const rows = await client()`SELECT data FROM fomo_launch_publications WHERE id=${id} AND owner=${owner}`;
      return rows[0] ? rows[0].data as PublishedLaunch : null;
    },
    async list(owner: string) {
      const rows = await client()`SELECT data FROM fomo_launch_publications WHERE owner=${owner} ORDER BY created_at DESC,id DESC LIMIT 20`;
      return rows.map(r => r.data as PublishedLaunch);
    },
    async asset(kind: "image" | "metadata", id: string) {
      const sql = client();
      const rows = kind === "image" ? await sql`SELECT content_type,encode(bytes,'base64') AS content FROM fomo_launch_images WHERE hash=${id}`
        : await sql`SELECT 'application/json' AS content_type,encode(convert_to(body,'UTF8'),'base64') AS content FROM fomo_launch_metadata WHERE hash=${id}`;
      if (!rows.length) return null;
      const bytes = Buffer.from(rows[0].content as string, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== id) throw Error("Published content integrity mismatch.");
      return { bytes, type: rows[0].content_type as string };
    },
  };
}
export type LaunchPublicationStore = ReturnType<typeof launchPublicationStore>;
