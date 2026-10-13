import {freshMarketTime,validTokenMarket,type TokenMarket} from './token-market-model';
function ratio(value:string){
 const m=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
 if(!m||value.length>80)throw Error('Enter a positive amount.');
 const exponent=Number(m[3]||0)-(m[2]||'').length;if(Math.abs(exponent)>100)throw Error('Amount is out of range.');
 const n=BigInt(m[1]+(m[2]||''));return exponent>=0?{n:n*10n**BigInt(exponent),d:1n}:{n,d:10n**BigInt(-exponent)};
}
function text(raw:bigint,places:number){const s=raw.toString().padStart(places+1,'0');return places?`${s.slice(0,-places)}.${s.slice(-places)}`.replace(/\.?0+$/,''):s;}
export function tokenSolRate(m:TokenMarket,mint:string,now=Date.now()):number{
 if(!validTokenMarket(m,mint,now)||!m.price||!freshMarketTime(m.price.checkedAt,now))throw Error('A fresh SOL price is needed to size this sale.');
 const rate=m.price.sol??(m.price.usd&&m.solUsd&&freshMarketTime(m.solUsd.checkedAt,now)?m.price.usd/m.solUsd.value:null);
 if(!rate||!Number.isFinite(rate)||rate<=0)throw Error('A fresh SOL price is needed to size this sale.');return rate;
}
export function tokensForSol(amount:string,rate:number,decimals:number):string{
 if(!/^\d+(\.\d{1,9})?$/.test(amount)||!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Enter a SOL amount with at most 9 decimal places.');
 const a=ratio(amount),p=ratio(String(rate));if(a.n<=0n||p.n<=0n)throw Error('Enter an amount greater than zero.');
 const raw=a.n*p.d*10n**BigInt(decimals)/(a.d*p.n);if(raw<1n||raw>18446744073709551615n)throw Error('The amount is outside this token’s supported size.');
 return text(raw,decimals);
}
export function solForTokens(amount:string,rate:number):string{
 const a=ratio(amount),p=ratio(String(rate));if(p.n<=0n)throw Error('Price unavailable.');return text(a.n*p.n*1000000000n/(a.d*p.d),9);
}
