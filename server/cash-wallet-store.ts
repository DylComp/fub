import { neon } from '@neondatabase/serverless';
import type { CashWalletChallenge } from '../src/cash-wallet-model.js';
import type { CashWalletBinding } from './cash-wallet-binding.js';
export function cashWalletStore(url:string){
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 return {
  async challenge(c:CashWalletChallenge){const sql=query();await sql`INSERT INTO fub_cash_wallet_challenges(nonce,wallet,challenge,expires_at) VALUES(${c.nonce},${c.sourceWallet},${JSON.stringify(c)}::jsonb,to_timestamp(${c.expiresAt}/1000.0))`;},
  async pending(nonce:string,wallet:string):Promise<CashWalletChallenge|null>{const sql=query();return (await sql`SELECT challenge FROM fub_cash_wallet_challenges WHERE nonce=${nonce} AND wallet=${wallet} AND consumed_at IS NULL AND expires_at>clock_timestamp()`)[0]?.challenge||null;},
  async consume(c:CashWalletChallenge,binding:CashWalletBinding){
   const sql=query();const rows=await sql`WITH consumed AS (
    UPDATE fub_cash_wallet_challenges SET consumed_at=clock_timestamp() WHERE nonce=${c.nonce} AND wallet=${c.sourceWallet} AND challenge=${JSON.stringify(c)}::jsonb AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING wallet
   ) INSERT INTO fub_cash_wallet_bindings(wallet,network,binding) SELECT wallet,${c.network},${JSON.stringify(binding)}::jsonb FROM consumed
   ON CONFLICT(wallet,network) DO UPDATE SET binding=EXCLUDED.binding RETURNING binding`;
   if(rows.length!==1)throw Error('Wallet verification expired or was already used.');return rows[0].binding as CashWalletBinding;
  },
  async binding(wallet:string,network:string):Promise<CashWalletBinding|null>{const sql=query();return (await sql`SELECT binding FROM fub_cash_wallet_bindings WHERE wallet=${wallet} AND network=${network} AND (binding->>'expiresAt')::bigint>extract(epoch from clock_timestamp())*1000`)[0]?.binding||null;}
 };
}
