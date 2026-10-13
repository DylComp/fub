function amount(raw:bigint,decimals:number){
 const digits=raw.toString().padStart(decimals+1,'0');
 if(!decimals)return digits;
 const fraction=digits.slice(-decimals).replace(/0+$/,'');
 return digits.slice(0,-decimals)+(fraction?'.'+fraction:'');
}
// Only this validated, public balance error is exposed to the client. RPC and
// signing-provider errors still go through the generic recovery response.
export class LaunchQuoteBalanceError extends Error{
 readonly code='insufficient_pair_balance';
 readonly requiredRaw:string;
 readonly availableRaw:string;
 constructor(readonly mint:string,required:bigint,available:bigint,readonly decimals:number){
  if(!Number.isInteger(decimals)||decimals<0||decimals>18||required<=available||available<0n||required>18446744073709551615n)throw Error('Invalid launch balance failure.');
  super(`Your initial buy requires ${amount(required,decimals)} of the selected pair token. This wallet has ${amount(available,decimals)}. Add that token or edit Initial buy to 0. SOL covers rent and network fees.`);
  this.name='LaunchQuoteBalanceError';this.requiredRaw=required.toString();this.availableRaw=available.toString();
 }
}

export class LaunchNotExpiredError extends Error {
 readonly code = 'launch_not_expired';
 constructor(){super('Waiting for the previous unsigned transaction’s expiry before refreshing.');this.name='LaunchNotExpiredError';}
}
