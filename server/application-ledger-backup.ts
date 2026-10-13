import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
export const APPLICATION_BACKUP_TABLES_V1=["fomo_buyback_attempts", "fomo_buyback_treasuries", "fomo_copy_attempts", "fomo_copy_budgets", "fomo_copy_control_events", "fomo_copy_controls", "fomo_copy_dispatch", "fomo_copy_dispatch_control", "fomo_copy_feed", "fomo_copy_feed_events", "fomo_copy_inventory_events", "fomo_copy_inventory_reviews", "fomo_copy_monitor_worker", "fomo_copy_monitors", "fomo_copy_permissions", "fomo_copy_plans", "fomo_copy_positions", "fomo_copy_proceeds", "fomo_copy_recovery_jobs", "fomo_copy_recovery_worker", "fomo_copy_service", "fomo_copy_signing_requests", "fomo_funding_events", "fomo_funding_operations", "fomo_launch_executions", "fomo_launch_fee_checks", "fomo_launch_fee_snapshots", "fomo_launch_images", "fomo_launch_metadata", "fomo_launch_payout_attempts", "fomo_launch_payouts", "fomo_launch_publication_requests", "fomo_launch_publications", "fomo_provider_budget", "fomo_resolver_attempts", "fomo_resolver_control", "fomo_resolver_jobs", "fomo_token22_budgets", "fomo_token22_executions", "fomo_token22_inventory_events", "fomo_token22_inventory_reviews", "fomo_token22_jobs", "fomo_token22_outcomes", "fomo_token22_permissions", "fomo_token22_positions", "fomo_token22_reservations", "fomo_token22_submissions", "fomo_whop_events", "fub_pay_cards", "fub_pay_discovery", "fub_pay_events", "fub_pay_resources"] as const;
export const APPLICATION_BACKUP_TABLES_V2 = [...APPLICATION_BACKUP_TABLES_V1, 'fomo_buyback_policy_history', 'fomo_buyback_setup_attempts', 'fomo_graduated_setup_attempts'].sort();
export const APPLICATION_BACKUP_TABLES_V3 = [...APPLICATION_BACKUP_TABLES_V2, 'fub_pay_transfers'].sort();
export const APPLICATION_BACKUP_TABLES_V4 = [...APPLICATION_BACKUP_TABLES_V3, 'fub_gift_purchases'].sort();
export const APPLICATION_BACKUP_TABLES_V5 = [...APPLICATION_BACKUP_TABLES_V4, 'fomo_quote_fee_routes', 'fomo_quote_fee_attempts', 'fomo_quote_treasury_credits', 'fomo_launch_pair_tables'].sort();
export const APPLICATION_BACKUP_TABLES_V6=[...APPLICATION_BACKUP_TABLES_V5,'fomo_quote_conversion_policies','fomo_quote_conversion_attempts','fomo_quote_conversion_credits'].sort();
export const APPLICATION_BACKUP_TABLES=[...APPLICATION_BACKUP_TABLES_V6,'fub_cash_purchases','fub_cash_wallet_challenges','fub_cash_wallet_bindings','fub_cash_sales'].sort();
export function applicationBackupTables(version: 1 | 2 | 3 | 4 | 5 | 6 | 7): readonly string[] {
 if (version === 1) return APPLICATION_BACKUP_TABLES_V1;
 if (version === 2) return APPLICATION_BACKUP_TABLES_V2;
 if (version === 3) return APPLICATION_BACKUP_TABLES_V3;
 if (version === 4) return APPLICATION_BACKUP_TABLES_V4;
 if (version === 5) return APPLICATION_BACKUP_TABLES_V5;
 if (version === 6) return APPLICATION_BACKUP_TABLES_V6;
 if (version === 7) return APPLICATION_BACKUP_TABLES;
 throw Error('Unsupported application backup version.');
}
export type ApplicationBackup={version:1|2|3|4|5|6|7;kind:'fub-application-ledger';createdAt:string;schema:string;schemaHash:string;migrations:{name:string;sha256:string}[];tables:{name:string;rows:string;count:number;sha256:string}[];sequences:{name:string;table:string;column:string;lastValue:string;isCalled:boolean}[]};
const aad=Buffer.from('fub-application-ledger-backup:v1'),limit=32*1024*1024;
export const appDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function validateApplicationBackup(v:ApplicationBackup){
 if(!v||(v.version!==1&&v.version!==2&&v.version!==3&&v.version!==4&&v.version!==5&&v.version!==6&&v.version!==7)||v.kind!=='fub-application-ledger'||!Number.isFinite(Date.parse(v.createdAt))||typeof v.schema!=='string'||appDigest(v.schema)!==v.schemaHash||!Array.isArray(v.tables)||v.tables.map(t=>t.name).join(',')!==applicationBackupTables(v.version).join(',')||!Array.isArray(v.migrations)||!v.migrations.length||!Array.isArray(v.sequences))throw Error('Invalid application backup manifest.');
 const seen=new Set<string>();
 for(const m of v.migrations){if(!/^\d{3}_[a-z0-9_]+\.sql$/.test(m.name)||!/^[a-f0-9]{64}$/.test(m.sha256)||seen.has(m.name)||Number(m.name.slice(0,3))!==seen.size+1)throw Error('Invalid migration manifest.');seen.add(m.name);}
 for(const t of v.tables){if(typeof t.rows!=='string'||!Number.isSafeInteger(t.count)||t.count<0||appDigest(t.rows)!==t.sha256)throw Error('Application table integrity failed.');const a=JSON.parse(t.rows);if(!Array.isArray(a)||a.length!==t.count)throw Error('Application table integrity failed.');}
 seen.clear();for(const s of v.sequences){if(!/^[a-z_][a-z0-9_]*$/.test(s.name)||!applicationBackupTables(v.version).includes(s.table)||!/^[a-z_][a-z0-9_]*$/.test(s.column)||typeof s.lastValue!=='string'||!/^[1-9][0-9]{0,18}$/.test(s.lastValue)||BigInt(s.lastValue)>9223372036854775807n||typeof s.isCalled!=='boolean'||seen.has(s.name))throw Error('Invalid application sequence manifest.');seen.add(s.name);}
 return v;
}
export function sealApplicationBackup(value:ApplicationBackup,key:Buffer){
 validateApplicationBackup(value);if(key.length!==32)throw Error('Backup key must be 32 bytes.');const raw=Buffer.from(JSON.stringify(value));if(raw.length>limit)throw Error('Application backup exceeds size limit.');
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);const body=Buffer.concat([cipher.update(raw),cipher.final()]);return Buffer.concat([aad,nonce,cipher.getAuthTag(),body]);
}
export function openApplicationBackup(value:Buffer,key:Buffer):ApplicationBackup{
 try{if(key.length!==32||value.length<aad.length+29||value.length>limit+aad.length+28||!value.subarray(0,aad.length).equals(aad))throw Error();const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(aad.length,aad.length+12));cipher.setAAD(aad);cipher.setAuthTag(value.subarray(aad.length+12,aad.length+28));return validateApplicationBackup(JSON.parse(Buffer.concat([cipher.update(value.subarray(aad.length+28)),cipher.final()]).toString('utf8')));}catch{throw Error('Application backup authentication failed.');}
}
// Derived exclusively from validated schema names, not from row data.
export function applicationRestoreOrder(edges:{child:string;parent:string}[],version:1|2|3|4|5|6|7=7){
 const pending=new Set<string>(applicationBackupTables(version)),order:string[]=[];
 if(edges.some(e=>!pending.has(e.child)||!pending.has(e.parent)))throw Error('Unrecognized application table dependency.');
 while(pending.size){const next=[...pending].find(t=>!edges.some(e=>e.child===t&&e.parent!==t&&pending.has(e.parent)));if(!next)throw Error('Cyclic application table dependency.');order.push(next);pending.delete(next);}return order;
}
