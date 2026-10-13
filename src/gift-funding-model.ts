export type GiftFundingReadiness={
 wallet:string;checkedAt:number;slot:number;ready:boolean;
 requiredUsdcRaw:string;balanceUsdcRaw:string;missingUsdcRaw:string;
 requiredSolLamports:string;balanceSolLamports:string;missingSolLamports:string;
 // Before an invoice exists, reserve enough rent for a new receiving account.
 rentLamports:string;feeLamports:string;estimate:boolean;
};
export function giftFundingAmount(raw:string,decimals=6){
 const n=BigInt(raw),scale=10n**BigInt(decimals);
 const fraction=(n%scale).toString().padStart(decimals,'0').replace(/0+$/,'');
 return `${n/scale}${fraction?'.'+fraction:''}`;
}
