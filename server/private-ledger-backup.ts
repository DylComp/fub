import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
export const PRIVATE_BACKUP_TABLES=['signer_wallet_epochs','signer_enrollments','signer_copy_requests','signer_copy_inventory','signer_inventory_reviews','signer_native_requests','signer_direct_exits'] as const;
export const PRIVATE_CASH_BACKUP_TABLES=[...PRIVATE_BACKUP_TABLES,'signer_cash_journals','signer_cash_parts'] as const;
type PrivateLedgerRows={createdAt:string;migrations:{name:string;sha256:string}[];tables:{name:string;rows:string;count:number;sha256:string}[]};
export type PrivateLedgerBackup=PrivateLedgerRows&({version:1}|{version:2|3;kind:'fub-private-ledger';schema:string;schemaHash:string});
const aad=Buffer.from('fub-private-ledger-backup:v1');
export function ledgerDigest(value:string){return createHash('sha256').update(value).digest('hex');}
export function validateLedgerBackup(value:PrivateLedgerBackup){
 if(!value||![1,2,3].includes(value.version)||!Number.isFinite(Date.parse(value.createdAt))||!Array.isArray(value.tables)||
  value.tables.map(t=>t.name).join(',')!==(value.version===3?PRIVATE_CASH_BACKUP_TABLES:PRIVATE_BACKUP_TABLES).join(',')||!Array.isArray(value.migrations)||!value.migrations.length)throw Error('Invalid private backup manifest.');
 const seen=new Set<string>();
 for(const m of value.migrations){
  if(!/^\d{3}_[a-z_]+\.sql$/.test(m.name)||!/^[a-f0-9]{64}$/.test(m.sha256)||seen.has(m.name)||Number(m.name.slice(0,3))!==seen.size+1)throw Error('Invalid migration manifest.');seen.add(m.name);
 }
 if(value.version!==1&&(value.kind!=='fub-private-ledger'||typeof value.schema!=='string'||ledgerDigest(value.schema)!==value.schemaHash))throw Error('Private backup schema integrity failed.');
 for(const t of value.tables){
  // rows deliberately stays PostgreSQL-produced text. Parsing and reserializing
  // PostgreSQL numeric/bigint fields through JS would round financial amounts.
  if(typeof t.rows!=='string'||!Number.isSafeInteger(t.count)||t.count<0||ledgerDigest(t.rows)!==t.sha256||!/^\s*\[/.test(t.rows)||!Array.isArray(JSON.parse(t.rows))||JSON.parse(t.rows).length!==t.count)throw Error('Private backup table integrity failed.');
 }
 return value;
}
export function sealLedgerBackup(value:PrivateLedgerBackup,key:Buffer){
 validateLedgerBackup(value);if(key.length!==32)throw Error('Backup key must be 32 bytes.');
 const plaintext=Buffer.from(JSON.stringify(value));if(plaintext.length>32*1024*1024)throw Error('Backup exceeds the reviewed size limit.');
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
 const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 return Buffer.concat([aad,nonce,cipher.getAuthTag(),ciphertext]);
}
export function openLedgerBackup(sealed:Buffer,key:Buffer):PrivateLedgerBackup{
 try{
  if(key.length!==32||sealed.length>33*1024*1024||sealed.length<aad.length+29||!sealed.subarray(0,aad.length).equals(aad))throw Error();
  const nonce=sealed.subarray(aad.length,aad.length+12),tag=sealed.subarray(aad.length+12,aad.length+28),ciphertext=sealed.subarray(aad.length+28);
  const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(aad);decipher.setAuthTag(tag);
  return validateLedgerBackup(JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8')));
 }catch{throw Error('Private backup authentication failed.');}
}
