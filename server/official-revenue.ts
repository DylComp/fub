import type {Connection} from '@solana/web3.js';
import {validatePayoutRoute,type PayoutRoute} from './launch-payout-model.js';
import {readLaunchFeeVault} from './launch-payout-chain.js';
import {launchPayoutStore} from './launch-payout-store.js';

export function officialRevenueRoute(env:NodeJS.ProcessEnv):PayoutRoute {
  const route:PayoutRoute={kind:'official',mint:env.LAUNCH_PLATFORM_MINT||'',buybackWallet:env.LAUNCH_BURN_WALLET||'',recipient:env.FUB_DEVELOPMENT_WALLET||''};
  validatePayoutRoute(route,env.LAUNCH_PAYOUT_PAYER);
  return route;
}
// Operator-only onboarding of an already launched official coin. A successful
// read verifies finalized Pump ownership and the permanent 80/20 destinations.
// Registration cannot enable payouts, configure a signer or move funds.
export async function inspectOfficialRevenue(connection:Connection,env:NodeJS.ProcessEnv){
  const route=officialRevenueRoute(env);
  const vault=await readLaunchFeeVault(connection,route);
  return {route,vault};
}
export async function registerOfficialRevenue(connection:Connection,env:NodeJS.ProcessEnv){
  if(!env.DATABASE_URL)throw Error('Official revenue storage is required.');
  const inspected=await inspectOfficialRevenue(connection,env);
  await launchPayoutStore(env.DATABASE_URL).register(inspected.route);
  return {...inspected,executionChanged:false as const};
}
