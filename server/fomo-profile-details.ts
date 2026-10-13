import {fomoTokenImage, type FomoProfileDetails, type FomoProfileToken, type FomoProfilePosition, type FomoProfileTrade} from '../src/fomo-profile-details.js';
const rec=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const num=(v:unknown,signed=false):number|null=> (typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Math.abs(Number(v))<=1e15&&(signed||Number(v)>=0)?Number(v):null;
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim()?v.trim().replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):null;
const chain=(v:unknown)=>({1399811149:'solana',1:'ethereum',8453:'base',56:'bnb',143:'monad',4663:'robinhood',5042:'arc'}[Number(v)]|| (Number.isSafeInteger(v)&&Number(v)>0?String(v):null));
function token(value:unknown,addressOverride?:unknown):FomoProfileToken|null {
 const t=rec(value),address=addressOverride??t.address,network=chain(t.networkId),info=rec(t.info);
 if(typeof address!=='string'||!/^[A-Za-z0-9:_-]{1,150}$/.test(address)||!network)return null;
 return {address,chain:network,name:text(t.name??info.name,100),symbol:text(t.symbol??info.symbol,40),imageUrl:fomoTokenImage(info.imageSmallUrl??info.imageLargeUrl??t.imageLargeUrl)};
}
/** Match Fomo's public trade calculation, retaining null when any required input is absent. */
function tradePnl(raw:unknown,price:number|null) {
 const t=rec(raw),amount=num(t.humanTokenAmount,true),open=num(t.sumSwapOpen),incoming=num(t.sumTransferIn),entry=num(t.avgEntryPrice),incomingPrice=num(t.avgTransferInPrice),realized=num(t.realizedPnlUsd,true);
 const cost=open!==null&&incoming!==null&&(open===0||entry!==null)&&(incoming===0||incomingPrice!==null)?open*(entry??0)+incoming*(incomingPrice??0):null;
 const quantity=open!==null&&incoming!==null?open+incoming:null;
 const pnlUsd=cost!==null&&quantity!==null&&amount!==null&&realized!==null&&(amount===0||price!==null)?realized+amount*((price??0)-(quantity>0?cost/quantity:0)):null;
 return {pnlUsd:num(pnlUsd,true),pnlPercent:pnlUsd!==null&&cost!==null&&cost>0?num(pnlUsd/cost*100,true):null};
}
export function parseFomoProfileDetails(profile:unknown,balancesRaw?:unknown,spotlightRaw?:unknown,now=Date.now(),snapshotRaw?:unknown):FomoProfileDetails {
 const p=rec(profile),b=rec(balancesRaw),spotlight=rec(spotlightRaw);
 const following=num(p.following),joined=typeof p.createdAt==='string'?Date.parse(p.createdAt):NaN;
 const details:FomoProfileDetails={bio:text(p.description,1000),following:following!==null&&Number.isSafeInteger(following)?following:null,joinedAt:Number.isSafeInteger(joined)&&joined>0&&joined<=now?joined:null,averageHoldingSeconds:num(p.averageHoldTimeSeconds),portfolioUsd:null,portfolioChange24hUsd:null,cashUsd:null,positions:null,topTrades:null};
 if(Array.isArray(b.balances)&&b.balances.length<=5000){
  let total=0,complete=true,cash:number|null=null,totalPnl=0,pnlComplete=true;
  const positions:FomoProfilePosition[]=[];
  for(const raw of b.balances){
   const r=rec(raw),balance=rec(r.balance),filter=rec(r.tokenFilterResult),valuation=rec(r.valuation),t=token(filter.token),amount=num(balance.shiftedBalance);
   if(!t||balance.tokenAddress!==t.address||amount===null){complete=false;pnlComplete=false;continue;}
   const price=valuation.useLivePrice===false?0:num(filter.priceUSD),value=price!==null?num(amount*price):null;
   const isCash=t.chain==='solana'&&t.address==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
   if(isCash){cash=amount;total+=amount;continue;}
   if(valuation.includeInEquity!==false){if(value===null)complete=false;else total+=value;}

   let pnl={pnlUsd:null as number|null,pnlPercent:null as number|null};
   if(r.activeTrade)pnl=tradePnl(r.activeTrade,price);
   else {const u=rec(r.userToken),held=num(u.humanAmountRemaining),entry=num(u.averageEntryPriceUsd),realized=num(u.currentRealizedPnlUsd,true),cost=num(u.currentCostBasisUsd);if(held!==null&&entry!==null&&realized!==null&&price!==null){const gain=realized+held*(price-entry);pnl={pnlUsd:num(gain,true),pnlPercent:cost!==null&&cost>0?num(gain/cost*100,true):null};}}
   const realized=rec(r.activeTrade||r.userToken)[r.activeTrade?'realizedPnlUsd':'currentRealizedPnlUsd'];
   const realizedValue=num(realized,true);
   const includedRealized=valuation.includeRealizedPnl!==false,includedUnrealized=valuation.includeUnrealizedPnl!==false;
   if(includedRealized||includedUnrealized){
    if(pnl.pnlUsd===null||realizedValue===null)pnlComplete=false;
    else totalPnl+=(includedRealized?realizedValue:0)+(includedUnrealized?pnl.pnlUsd-realizedValue:0);
   }
   if(amount<=0)continue;
   positions.push({token:t,amount:amount.toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:20}),valueUsd:value,...pnl});
  }
  const other=num(b.otherEquity);details.portfolioUsd=complete&&other!==null?num(total+other):null;
  const previous=rec(snapshotRaw),snapshotValue=Number(previous.snapshotId),snapshotAt=snapshotValue>1e11?snapshotValue:snapshotValue*1000;
  const historical=num(previous.pnl,true),otherPnl=num(b.otherPnlV2,true),perpPnl=num(b.livePerpPnl,true);
  if(pnlComplete&&historical!==null&&otherPnl!==null&&perpPnl!==null&&Number.isSafeInteger(snapshotAt)&&snapshotAt<=now-86400000&&snapshotAt>=now-90000000)
    details.portfolioChange24hUsd=num(totalPnl+otherPnl+perpPnl-historical,true);
  details.cashUsd=cash;details.positions=positions.sort((a,b)=>(b.valueUsd??-1)-(a.valueUsd??-1)).slice(0,100);
 }
 if(Array.isArray(spotlight.bestTrades)&&spotlight.bestTrades.length<=20){
  const top:FomoProfileTrade[]=[];
  for(const raw of spotlight.bestTrades.slice(0,5)){
   const row=rec(raw),trade=rec(row.trade),metadata=rec(trade.tokenMetadata),t=token(metadata,trade.tokenAddress);
   if(row.userId!==p.id||!t)continue;
   top.push({token:t,...tradePnl(trade,num(metadata.currentPrice))});
  }
  details.topTrades=top;
 }
 return details;
}
