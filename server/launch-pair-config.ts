import {PublicKey} from '@solana/web3.js';
export type CustomPairContext={wallet?:string;quoteMint?:string};
// Test admission only permits the configured owner and pair until expiry.
// Display queries are hints; execution must derive this context from the
// authenticated owner and immutable saved publication.
export function customPairExecutionEnabled(env:NodeJS.ProcessEnv=process.env,context?:CustomPairContext,now=Date.now()){
 // An explicit stop also disables temporary test admission. Recovery is separate.
 if(env.LAUNCH_CUSTOM_PAIRS_ENABLED==='false')return false;
 // Public activation is an operator setting, not a claim of funded acceptance.
 // Each pair still passes on-chain eligibility, exact signing and simulation.
 if(env.LAUNCH_CUSTOM_PAIRS_ENABLED==='true')return true;
 const wallet=env.LAUNCH_CUSTOM_PAIR_TEST_WALLET,mint=env.LAUNCH_CUSTOM_PAIR_TEST_MINT;
 const until=Date.parse(env.LAUNCH_CUSTOM_PAIR_TEST_UNTIL||'');
 if(!wallet||!mint||!Number.isFinite(until)||until<=now||until>now+72*3600000||context?.wallet!==wallet||context?.quoteMint!==mint)return false;
 try{return new PublicKey(wallet).toBase58()===wallet&&PublicKey.isOnCurve(new PublicKey(wallet).toBytes())&&new PublicKey(mint).toBase58()===mint;}catch{return false;}
}
