import { neon } from "@neondatabase/serverless";
import type {
  FundingOperation,
  OperationState,
  FundingEvent,
} from "../src/funding-model.js";
export interface FundingStore {
  insert(
    operation: FundingOperation,
  ): Promise<{ operation: FundingOperation; inserted: boolean }>;
  get(wallet: string, id: string): Promise<FundingOperation | null>;
  events(wallet: string, id: string): Promise<FundingEvent[]>;
  list(wallet: string): Promise<FundingOperation[]>;
  update(
    wallet: string,
    id: string,
    from: OperationState[],
    patch: Partial<FundingOperation>,
  ): Promise<FundingOperation | null>;
}
export function postgresStore(url: string): FundingStore {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  return {
    async insert(operation) {
      const sql = client();
      const rows = await sql`WITH inserted AS (
          INSERT INTO fomo_funding_operations (id,wallet,state,data)
          VALUES (${operation.id},${operation.wallet},${operation.state},${JSON.stringify(operation)}::jsonb)
          ON CONFLICT DO NOTHING RETURNING id,wallet,state,data
        ), logged AS (
          INSERT INTO fomo_funding_events(operation_id,wallet,state,details)
          SELECT id,wallet,state,jsonb_strip_nulls(jsonb_build_object('message',data->'message','signature',data->'signature','receipt',data->'receipt')) FROM inserted
          RETURNING operation_id
        ) SELECT operation_id AS id FROM logged`;
      const found = await this.get(operation.wallet, operation.id);
      if (!found)
        throw new Error(
          "Another funding request needs recovery. Refresh the recovery list before continuing.",
        );
      return { operation: found, inserted: rows.length === 1 };
    },
    async get(wallet, id) {
      const sql = client();
      const rows =
        await sql`SELECT data FROM fomo_funding_operations WHERE id=${id} AND wallet=${wallet}`;
      return (rows[0]?.data as FundingOperation) || null;
    },
    async list(wallet) {
      const sql = client();
      const rows =
        await sql`SELECT data FROM fomo_funding_operations WHERE wallet=${wallet} ORDER BY (state IN ('preparing','prepared','submitting','submitted','unknown')) DESC, updated_at DESC LIMIT 30`;
      return rows.map((row) => row.data as FundingOperation);
    },
    async events(wallet, id) {
      const sql = client();
      const rows =
        await sql`SELECT e.id::text,e.operation_id::text,e.state,e.recorded_at::text,e.details
        FROM fomo_funding_events e JOIN fomo_funding_operations o ON o.id=e.operation_id AND o.wallet=e.wallet
        WHERE e.wallet=${wallet} AND e.operation_id=${id} ORDER BY e.id DESC LIMIT 50`;
      return rows.map(
        (row) =>
          ({
            ...row.details,
            id: row.id,
            operationId: row.operation_id,
            state: row.state,
            recordedAt: row.recorded_at,
          }) as FundingEvent,
      );
    },
    async update(wallet, id, from, patch) {
      const sql = client();
      const rows = await sql`WITH changed AS (
          UPDATE fomo_funding_operations SET state=COALESCE(${patch.state || null},state),
            data=data || ${JSON.stringify({ ...patch, updatedAt: Date.now() })}::jsonb,updated_at=now()
          WHERE id=${id} AND wallet=${wallet} AND state=ANY(${from}::text[])
            AND NOT data @> ${JSON.stringify(patch)}::jsonb
          RETURNING id,wallet,state,data
        ), logged AS (
          INSERT INTO fomo_funding_events(operation_id,wallet,state,details)
          SELECT id,wallet,state,jsonb_strip_nulls(jsonb_build_object('message',data->'message','signature',data->'signature','receipt',data->'receipt')) FROM changed
          RETURNING operation_id
        ) SELECT changed.data FROM changed JOIN logged ON changed.id=logged.operation_id`;
      return (rows[0]?.data as FundingOperation) || null;
    },
  };
}
export const fundingInfrastructureConfigured = () =>
  !!process.env.DATABASE_URL && !!process.env.SOLANA_RPC_URL;
export const fundingConfigured = () =>
  fundingInfrastructureConfigured() &&
  process.env.FUNDING_EXECUTION_ENABLED === "true";
export function fundingStore(): FundingStore {
  if (!process.env.DATABASE_URL)
    throw new Error("Order recovery storage is not configured.");
  return postgresStore(process.env.DATABASE_URL);
}
