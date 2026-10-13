export const MARKET_MAX_AGE_MS = 45000;
export type MarketMetric = {value:number;checkedAt:number};
export type MarketSupply = {raw:string;decimals:number;slot:number;checkedAt:number};
export function freshMarketSupply(v:unknown,now=Date.now()):v is MarketSupply {
 const s=v as MarketSupply;
 return !!s&&typeof s.raw==='string'&&/^[1-9]\d{0,19}$/.test(s.raw)&&BigInt(s.raw)<=18446744073709551615n&&Number.isInteger(s.decimals)&&s.decimals>=0&&s.decimals<=18&&Number.isSafeInteger(s.slot)&&s.slot>0&&freshMarketTime(s.checkedAt,now);
}
export type TokenMarket = {
 supply?:MarketSupply|null; solUsd?:MarketMetric|null;
 mint:string; fetchedAt:number; refreshDelayed?:boolean; curveUnavailable?:boolean;
 price:{usd:number|null;sol:number|null;source:'pump-curve'|'dexscreener';checkedAt:number;usdCheckedAt:number|null}|null;
 volume24h:MarketMetric|null; liquidity:MarketMetric|null;
 curve:{reservesSol:number;checkedAt:number;slot:number}|null;
 dexPair:string|null;
};
export function freshMarketTime(value:unknown,now=Date.now()):value is number {
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=now+5000&&now-value<=MARKET_MAX_AGE_MS;
}
export function validTokenMarket(value:unknown,mint:string,now=Date.now()):value is TokenMarket {
 if(!value||typeof value!=='object')return false;
 const v=value as TokenMarket,amount=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
 const metric=(m:MarketMetric|null)=>m===null||!!m&&amount(m.value)&&freshMarketTime(m.checkedAt,now);
 return (v.supply===undefined||v.supply===null||freshMarketSupply(v.supply,now))&&(v.solUsd===undefined||v.solUsd===null||metric(v.solUsd)&&v.solUsd.value>0)&&(v.curveUnavailable===undefined||typeof v.curveUnavailable==='boolean')&&(v.refreshDelayed===undefined||typeof v.refreshDelayed==='boolean')&&v.mint===mint&&freshMarketTime(v.fetchedAt,now)&&metric(v.volume24h)&&metric(v.liquidity)&&
  (v.dexPair===null||typeof v.dexPair==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.dexPair))&&
  (v.curve===null||!!v.curve&&amount(v.curve.reservesSol)&&freshMarketTime(v.curve.checkedAt,now)&&Number.isSafeInteger(v.curve.slot)&&v.curve.slot>0)&&
  (v.price===null||!!v.price&&['pump-curve','dexscreener'].includes(v.price.source)&&freshMarketTime(v.price.checkedAt,now)&&
   (v.price.usd===null||amount(v.price.usd)&&v.price.usd>0&&freshMarketTime(v.price.usdCheckedAt,now))&&
   (v.price.sol===null||amount(v.price.sol)&&v.price.sol>0)&&(v.price.usd!==null||v.price.sol!==null));
}
