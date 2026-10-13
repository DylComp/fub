import {freshMarketSupply,freshMarketTime,type TokenMarket} from './token-market-model';

function fraction(text:string) {
 const match=/^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(text.trim());
 if(!match)throw Error('Enter a positive amount.');
 const denominator=10n**BigInt((match[2]||'').length);
 const numerator=BigInt(match[1]+(match[2]||''));
 if(numerator<=0n)throw Error('Enter a positive amount.');
 return {numerator,denominator};
}
export function parseMarketCap(text:string):string {
 const match=/^\$?\s*(\d{1,30}(?:\.\d{1,12})?)\s*([kmb])?$/i.exec(text.trim());
 if(!match)throw Error('Enter a market cap such as 250000, 250K or 1.5M.');
 const f=fraction(match[1]),scale=({k:1000n,m:1000000n,b:1000000000n})[match[2]?.toLowerCase() as 'k'|'m'|'b']||1n;
 return decimal(f.numerator*scale,f.denominator,12);
}
function decimal(numerator:bigint,denominator:bigint,places:number) {
 // Round upward by at most one output atom; never silently understate a target.
 const raw=(numerator*10n**BigInt(places)+denominator-1n)/denominator;
 const digits=raw.toString().padStart(places+1,'0');
 return places?`${digits.slice(0,-places)}.${digits.slice(-places)}`.replace(/\.?0+$/,''):digits;
}
export function marketCapValue(cap:string,market:TokenMarket,mint:string,options:{quote?:'USD'|'SOL';quantity?:string;places?:number}={},now=Date.now()) {
 if(market.mint!==mint||!freshMarketSupply(market.supply,now))throw Error('Fresh token supply is required for market cap entry.');
 const supply=market.supply,mc=fraction(parseMarketCap(cap)),quantity=fraction(options.quantity||'1');
 let fx={numerator:1n,denominator:1n};
 if(options.quote==='SOL'){
  if(!market.solUsd||!freshMarketTime(market.solUsd.checkedAt,now)||!Number.isFinite(market.solUsd.value)||market.solUsd.value<=0)throw Error('A fresh SOL/USD rate is required.');
  fx=fraction(String(market.solUsd.value));
 }
 const places=options.places??18;
 if(!Number.isInteger(places)||places<0||places>18)throw Error('Invalid output precision.');
 const value=decimal(mc.numerator*quantity.numerator*10n**BigInt(supply.decimals)*fx.denominator,mc.denominator*quantity.denominator*BigInt(supply.raw)*fx.numerator,places);
 if(!Number.isFinite(Number(value))||Number(value)<=0)throw Error('Market cap cannot be represented as an order value.');
 return value;
}

export function limitBuyTokens(spend:string,price:string,decimals:number){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Invalid token precision.');
 const a=fraction(spend),p=fraction(price);
 return decimal(a.numerator*p.denominator,a.denominator*p.numerator,decimals);
}
export function marketCapBuyTokens(cap:string,spend:string,market:TokenMarket,mint:string,decimals:number,now=Date.now()){
 if(market.mint!==mint||!freshMarketSupply(market.supply,now)||market.supply.decimals!==decimals)throw Error('Fresh matching token supply is required.');
 if(!market.solUsd||!freshMarketTime(market.solUsd.checkedAt,now)||!Number.isFinite(market.solUsd.value)||market.solUsd.value<=0)throw Error('A fresh SOL/USD rate is required.');
 const mc=fraction(parseMarketCap(cap)),a=fraction(spend),fx=fraction(String(market.solUsd.value));
 // Round received tokens UP, so rounding can never increase the buy price.
 return decimal(a.numerator*fx.numerator*BigInt(market.supply.raw)*mc.denominator,a.denominator*fx.denominator*10n**BigInt(decimals)*mc.numerator,decimals);
}
