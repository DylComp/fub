import {CASH_NETWORKS,type CashNetwork} from '../src/cash-route.js';
// Pinned from Relay's public chain registry, independently of any quote.
const shared={proxy:'0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',router:'0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',depository:'0x4cd00e387622c35bddb9b4c962c136462338bc31',solver:'0xf70da97812cb96acdf810712aa562db8dfa3dbef',kyber:'0x6131b5fae19ea4f9d964eac0408e4408b66337b5',executor:'0x8f10b468b06c6fd214b65f87778827f7d113f996'} as const;
const settlement={
 base:{usdc:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',decimals:6},
 bnb:{usdc:'0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',decimals:18},
 monad:{usdc:'0x754704bc059f8c67012fed69bc8a327a5aafb603',decimals:6},
 robinhood:{usdc:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',decimals:6},
 arc:{usdc:'0x3600000000000000000000000000000000000000',decimals:6},
 ethereum:{usdc:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',decimals:6},
} as const;
// `usdc` is the legacy storage field for the source settlement asset. On
// Robinhood it is USDG; only the verified Solana destination is cash USDC.
export function cashReturnNetwork(network:CashNetwork){
 if(!Object.hasOwn(settlement,network))throw Error('Unsupported cash return network.');
 return {...shared,...CASH_NETWORKS[network],...settlement[network]};
}
export const ZEROX_ALLOWANCE_HOLDER='0x0000000000001ff3684f28c67538d4d072c22734';
export const ZEROX_DEPLOYER='0x00000000000004533fe15556b1e086bb1a72ceae';

// Robinhood verified TychoRouterV3 source/ABI on robin.etherscan.io, checked
// against its runtime bytecode. A changed deployment must be reviewed again.
export const FYND_ROUTER='0x09215a470bd585e59eb3f4b612fbd2678131ff9e';
export const FYND_CODE_HASH='0x07e295731e03b5b2560069e1e3ce4dfaa0c2b557cc689b13671bece90eb09335';

// Base TychoRouterV3 verified source on basescan.org, matched to the runtime
// at the observed Fomo sale. Observation only; this does not select our route.
export function cashLeaderFynd(network:CashNetwork){
 if(network==='base')return {router:'0xaba5b53b03eafad1c5fc8bd5fc765fc85bb3de67',codeHash:'0xf8c8c80c5f75fe8a3d91d994309a921248c43031c229ef3220bbb0aed9f1ea35'};
 if(network==='robinhood')return {router:FYND_ROUTER,codeHash:FYND_CODE_HASH};
 return null;
}
