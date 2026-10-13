import {encodeFunctionData,parseAbi} from 'viem';
import type {Rpc} from './funding.js';
import type {CashNetwork} from '../src/cash-route.js';
// Independently pinned Pancake V1/V2 and BabySwap BSC factories:
// github.com/pancakeswap/pancake-farm (deployed contracts)
// developer.pancakeswap.finance/contracts/v2/addresses
// bscscan.com/address/0x86407bEa2078ea5f5EB5A52B2caA963bC1F889Da (verified factory)
const factories:Partial<Record<CashNetwork,ReadonlySet<string>>>={bnb:new Set(['0xbcfccbde45ce874adcb698cc183debcf17952812','0xca143ce32fe78f1f7019d7d551a6402fc5350c73','0x86407bea2078ea5f5eb5a52b2caa963bc1f889da']),
 // https://github.com/sushiswap/v2-core/blob/master/deployments/base/UniswapV2Factory.json
 base:new Set(['0x71524b4f93c58fcbf659783284e38825f0622859'])};
// Independently pinned Base Aerodrome deployment and stable/volatile lookup:
// https://github.com/aerodrome-finance/contracts#contracts
// https://github.com/aerodrome-finance/contracts/blob/main/contracts/interfaces/factories/IPoolFactory.sol
const aerodromeFactory='0x420dd381b31aef6683db6b902084cb0ffece40da';
export const cashSourcePoolAbi=parseAbi(['function stable() view returns (bool)','function getPool(address,address,bool) view returns (address)','function factory() view returns (address)','function token0() view returns (address)','function token1() view returns (address)','function getPair(address,address) view returns (address)']);
function address(v:unknown){if(typeof v!=='string'||!/^0x0{24}[0-9a-f]{40}$/i.test(v)||/^0x0{64}$/i.test(v))throw Error('Cash sale source pool could not be verified.');return '0x'+v.slice(-40).toLowerCase();}
export async function verifyCashSourcePool(network:CashNetwork,pool:string,token:string,block:string,rpc:Rpc){
 const allowed=factories[network];
 if(!allowed||!/^0x[0-9a-f]+$/i.test(block))throw Error('Cash sale source pool is unsupported.');
 const [factory,t0,t1]=await Promise.all((['factory','token0','token1'] as const).map(functionName=>rpc('eth_call',[{to:pool,data:encodeFunctionData({abi:cashSourcePoolAbi,functionName})},block]).then(address)));
 const aerodrome=network==='base'&&factory===aerodromeFactory;
 if((!allowed.has(factory)&&!aerodrome)||t0===t1||![t0,t1].includes(token.toLowerCase()))throw Error('Cash sale source pool changed.');
 let stable=false;
 if(aerodrome){
  const result=await rpc('eth_call',[{to:pool,data:encodeFunctionData({abi:cashSourcePoolAbi,functionName:'stable'})},block]);
  if(typeof result!=='string'||!/^0x0{63}[01]$/i.test(result))throw Error('Cash sale source pool type could not be verified.');
  stable=result.endsWith('1');
 }
 const canonical=address(await rpc('eth_call',[{to:factory,data:aerodrome?encodeFunctionData({abi:cashSourcePoolAbi,functionName:'getPool',args:[t0 as `0x${string}`,t1 as `0x${string}`,stable]}):encodeFunctionData({abi:cashSourcePoolAbi,functionName:'getPair',args:[t0 as `0x${string}`,t1 as `0x${string}`]})},block]));
 if(canonical!==pool.toLowerCase())throw Error('Cash sale source pool is not canonical.');
}
