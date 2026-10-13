import {signerExecutionScope} from './signer-execution-scope.js';
// Limit buys have their own admission scope. A final test can admit one wallet
// without changing existing public sell or copy permissions.
export function directLimitBuyPolicy(env:Record<string,string|undefined>){
 if(env.DIRECT_LIMIT_BUY_ENABLED==='true'&&(!/^[a-f0-9]{64}$/.test(env.DIRECT_LIMIT_BUY_POLICY_DIGEST??'')||env.SIGNER_POLICY_DIGEST!==env.DIRECT_LIMIT_BUY_POLICY_DIGEST))throw Error('Limit buys require the verified replacement signing policy.');
 const scope=signerExecutionScope({SIGNER_EXECUTION_SCOPE:env.DIRECT_LIMIT_BUY_SCOPE,SIGNER_PILOT_WALLETS:env.DIRECT_LIMIT_BUY_WALLETS,SIGNER_EXECUTION_ENABLED:env.DIRECT_LIMIT_BUY_ENABLED});
 return {mode:scope.mode,allows:(wallet:string)=>env.DIRECT_LIMIT_BUY_ENABLED==='true'&&scope.allows(wallet)};
}
