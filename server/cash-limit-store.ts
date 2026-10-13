import canonicalize from 'canonicalize';
import {neon} from '@neondatabase/serverless';
import type {CashLimitJob,CashLimitJournal} from './cash-limit-engine.js';
import type {CashLimitTerms} from '../src/cash-limit-model.js';
import type {OwnerBinding} from './privy-owner.js';
export type CashLimitGrant={proof:{solana:string;evm:string};acceptedAt:number;solana:OwnerBinding;evm:OwnerBinding;solanaPolicyDigest:string;evmPolicyDigest:string};
export type CashLimitRecord<R>=CashLimitJob<R>&{grant:CashLimitGrant;revoked:boolean};
export interface CashLimitStore<R> extends CashLimitJournal<R>{get(id:string):Promise<CashLimitRecord<R>|null>;create(terms:CashLimitTerms,grant:CashLimitGrant):Promise<CashLimitRecord<R>>;stop(id:string,userId:string):Promise<void>;list(wallet:string,userId:string):Promise<CashLimitRecord<R>[]>;due():Promise<string[]>;deliverable():Promise<CashLimitRecord<R>[]>}
export function cashLimitStore<R>(url:string):CashLimitStore<R>{
 const sql=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 const row=(r:any):CashLimitRecord<R>=>({...r.document,revision:Number(r.revision)});
 async function change(j:CashLimitJob<R>,patch:object){
  const rows=await sql()`UPDATE signer_cash_limits SET document=document || ${JSON.stringify(patch)}::jsonb, revision=revision+1,updated_at=clock_timestamp() WHERE id=${j.terms.id} AND revision=${j.revision} AND document->>'state'=${j.state} RETURNING document,revision`;
  if(!rows[0])throw Error('Limit order changed. Refresh its status.');return row(rows[0]);
 }
 const store:CashLimitStore<R>={
  async get(id){const r=await sql()`SELECT document,revision FROM signer_cash_limits WHERE id=${id}`;return r[0]?row(r[0]):null;},
  async create(terms,grant){const document={terms,grant,state:'waiting',revoked:false};const db=sql();await db.transaction([db`SELECT pg_advisory_xact_lock(734920163)`,db`INSERT INTO signer_cash_limits(id,wallet,user_id,document) SELECT ${terms.id},${terms.sourceWallet},${grant.solana.userId},${JSON.stringify(document)}::jsonb WHERE (SELECT count(*) FROM signer_cash_limits WHERE document->>'state' NOT IN ('complete','cancelled','expired'))<100 AND (SELECT count(*) FROM signer_cash_limits WHERE wallet=${terms.sourceWallet} AND document->>'state' NOT IN ('complete','cancelled','expired'))<10 ON CONFLICT(id) DO NOTHING`]);const r=await store.get(terms.id);if(!r)throw Error('Limit order capacity reached. Close an existing order first.');if(canonicalize(r.terms)!==canonicalize(terms)||canonicalize(r.grant)!==canonicalize(grant))throw Error('Limit order identity already used.');return r;},
  async claim(j){const r=await sql()`UPDATE signer_cash_limits SET document=document || '{"state":"preparing"}'::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=${j.terms.id} AND revision=${j.revision} AND document->>'state'='waiting' AND document->>'revoked'='false' AND (document->'terms'->>'expiresAt')::bigint>extract(epoch FROM clock_timestamp())*1000 RETURNING document,revision`;return r[0]?row(r[0]):null;},
  async defer(j){if(j.state!=='preparing')throw Error('Only an unsigned preparation can wait again.');const rows=await sql()`UPDATE signer_cash_limits SET document=document || jsonb_build_object('state',CASE WHEN document->>'revoked'='true' THEN 'cancelled' ELSE 'waiting' END),revision=revision+1,updated_at=clock_timestamp() WHERE id=${j.terms.id} AND revision=${j.revision} AND document->>'state'='preparing' AND NOT(document ? 'signed') RETURNING document,revision`;if(!rows[0])throw Error('Preparation changed before retry.');},
  prepared:(j,review)=>change(j,{review}),
  signing:j=>change(j,{state:'signing'}),
  signed:(j,signed)=>change(j,{state:'submitted',signed}),
  async terminal(j,state){await change(j,{state});},
  async stop(id,userId){await sql()`UPDATE signer_cash_limits SET document=document || jsonb_build_object('revoked',true,'state',CASE WHEN document->>'state'='waiting' THEN 'cancelled' ELSE document->>'state' END),revision=revision+CASE WHEN document->>'state'='waiting' THEN 1 ELSE 0 END,updated_at=clock_timestamp() WHERE id=${id} AND user_id=${userId}`;},
  async list(wallet,userId){return(await sql()`SELECT document,revision FROM signer_cash_limits WHERE wallet=${wallet} AND user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 100`).map(row);},
  async deliverable(){return(await sql()`WITH due AS (SELECT id FROM signer_cash_limits WHERE document->>'state' IN ('signing','submitted','needs-attention') AND document->>'revoked'='false' AND document ? 'signed' AND (document->'terms'->>'expiresAt')::bigint>extract(epoch FROM clock_timestamp())*1000 AND next_delivery_at<=clock_timestamp() ORDER BY next_delivery_at,id LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE signer_cash_limits l SET next_delivery_at=clock_timestamp()+interval '5 seconds' FROM due WHERE l.id=due.id RETURNING l.document,l.revision`).map(row);},
  async due(){
   // A proven unsigned preparation may wait again under the same identity.
   // Advancing its revision fences the old worker before its signing claim.
   await sql()`UPDATE signer_cash_limits SET document=document || jsonb_build_object('state',CASE WHEN document->>'revoked'='true' THEN 'cancelled' ELSE 'waiting' END),revision=revision+1,updated_at=clock_timestamp() WHERE document->>'state'='preparing' AND NOT(document ? 'signed') AND updated_at<clock_timestamp()-interval '5 minutes'`;
   return(await sql()`WITH due AS (SELECT id FROM signer_cash_limits WHERE document->>'state' IN ('waiting','preparing','signing','submitted','needs-attention') AND next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE signer_cash_limits l SET next_check_at=clock_timestamp()+interval '5 seconds' FROM due WHERE l.id=due.id RETURNING l.id`).map(r=>String(r.id));
  },
 };return store;
}
