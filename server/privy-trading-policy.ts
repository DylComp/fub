// Provider defense in depth. Exact routes, recipients, spend caps, owner grants
// and positions are enforced separately by the isolated signing service.
export const TRADING_POLICY_NAME='Fub isolated spot trading v2';
export function tradingPolicyRules(){
 return [
  {name:'Reviewed swap and account setup programs',method:'signTransaction',conditions:[{field_source:'solana_program_instruction',field:'programId',operator:'in',value:['ComputeBudget111111111111111111111111111111','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']}],action:'ALLOW'},
  {name:'Wrapped SOL synchronization and account cleanup',method:'signTransaction',conditions:[{field_source:'solana_token_program_instruction',field:'instructionName',operator:'in',value:['SyncNative','CloseAccount']}],action:'ALLOW'},
  {name:'SOL wrapping within the native pilot ceiling',method:'signTransaction',conditions:[{field_source:'solana_system_program_instruction',field:'instructionName',operator:'eq',value:'Transfer'},{field_source:'solana_system_program_instruction',field:'Transfer.lamports',operator:'lte',value:'10000000'}],action:'ALLOW'},
 ];
}

// Prepared separately; never mutate an enrolled policy in place. Activating
// this policy requires fresh owner delegation and the matching pinned digest.
export const LIMIT_BUY_POLICY_NAME='Fub isolated spot trading v3';
export function limitBuyPolicyRules(){
 return tradingPolicyRules().map(rule=>rule.name==='SOL wrapping within the native pilot ceiling'?{
  ...rule,name:'SOL wrapping within signed direct-order ceiling',conditions:rule.conditions.map(condition=>condition.field==='Transfer.lamports'?{...condition,value:'100000000000'}:condition),
 }:rule);
}
