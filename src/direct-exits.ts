import { isMint } from './assets.js';
import { USDC, WSOL, TOKEN_PROGRAM } from './funding-model.js';

export const EXIT_TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as const;
// Version 1 approvals retain their exact USDC meaning and signature text.
// Version 2 binds Token-2022 exits explicitly to retained wrapped SOL proceeds.
export type DirectExitTerms = {
  id: string; origin: string; wallet: string; mint: string;
  amountRaw: string; tokenDecimals: number; kind: 'limit' | 'bracket' | 'trailing';
  targetRaw: string | null; stopRaw: string | null; trailingBps: number | null;
  slippageBps: number; maxFeeLamports: string; maxRentLamports: string;
  issuedAt: number; expiresAt: number;
} & ({version:1}|{version:2;outputMint:typeof WSOL}|{version:3|4;outputMint:typeof WSOL;tokenProgram:typeof TOKEN_PROGRAM}|{version:5;outputMint:typeof WSOL;tokenProgram:typeof TOKEN_PROGRAM|typeof EXIT_TOKEN_2022}|{version:6;outputMint:string;tokenProgram:typeof TOKEN_PROGRAM|typeof EXIT_TOKEN_2022});
export const isLimitBuy=(t:DirectExitTerms)=>t.version===6;
export const exitInputMint=(t:DirectExitTerms)=>isLimitBuy(t)?WSOL:t.mint;
export const exitInputDecimals=(t:DirectExitTerms)=>isLimitBuy(t)?9:t.tokenDecimals;
export const exitProceeds=(t:DirectExitTerms)=>isLimitBuy(t)?{mint:t.mint,decimals:t.tokenDecimals,symbol:'tokens'}:t.version>=2?{mint:WSOL,decimals:9,symbol:t.version===5?'SOL / WSOL':'WSOL'}:{mint:USDC,decimals:6,symbol:'USDC'};
export type ExitObservation = { outputRaw: string; minimumRaw: string; slot: number; checkedAt: number };
export type ExitWatermark = { highRaw: string | null; slot: number; checkedAt: number };
export type ExitLeg = 'target' | 'stop' | 'trailing';
const U64 = 18446744073709551615n;
export function exitRaw(value: unknown, zero = false): bigint {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(value) || BigInt(value) > U64) throw Error('Invalid exit amount.');
  return BigInt(value);
}
export function validateExitTerms(t: DirectExitTerms) {
  if (!t || Object.keys(t).sort().join(',') !== `amountRaw,expiresAt,id,issuedAt,kind,maxFeeLamports,maxRentLamports,mint,origin,${t.version>=2?'outputMint,':''}slippageBps,stopRaw,targetRaw,tokenDecimals,${t.version>=3?'tokenProgram,':''}trailingBps,version,wallet` ||
      !(t.version===1||t.version===2&&t.outputMint===WSOL||(t.version===3||t.version===4)&&t.outputMint===WSOL&&t.tokenProgram===TOKEN_PROGRAM||t.version===5&&t.outputMint===WSOL&&[TOKEN_PROGRAM,EXIT_TOKEN_2022].includes(t.tokenProgram)||t.version===6&&t.outputMint===t.mint&&[TOKEN_PROGRAM,EXIT_TOKEN_2022].includes(t.tokenProgram)&&t.kind==='limit') || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(t.id) ||
      new URL(t.origin).origin !== t.origin || !t.origin.startsWith('https://') || !isMint(t.wallet) || !isMint(t.mint) || [USDC, WSOL].includes(t.mint) ||
      !Number.isInteger(t.tokenDecimals) || t.tokenDecimals < 0 || t.tokenDecimals > 18 ||
      !Number.isInteger(t.slippageBps) || t.slippageBps < 10 || t.slippageBps > 500 ||
      !Number.isSafeInteger(t.issuedAt) || t.issuedAt < 1 || !Number.isSafeInteger(t.expiresAt) || t.expiresAt <= t.issuedAt || t.expiresAt > t.issuedAt + 7 * 86400000) throw Error('Invalid direct exit terms.');
  exitRaw(t.amountRaw);
  if(isLimitBuy(t)&&exitRaw(t.amountRaw)>100000000000n)throw Error('A limit buy cannot exceed 100 SOL.');
  if (exitRaw(t.maxFeeLamports) > 5000000n || exitRaw(t.maxRentLamports,true) > 10000000n) throw Error('Exit fee cap is too high.');
  if (t.kind === 'limit') {
    if(t.stopRaw!==null||t.trailingBps!==null)throw Error('Limit orders have one target.');exitRaw(t.targetRaw);
  } else if (t.kind === 'bracket') {
    if (t.trailingBps !== null || exitRaw(t.stopRaw) >= exitRaw(t.targetRaw)) throw Error('Target must exceed stop.');
  } else if (t.kind === 'trailing') {
    if (t.targetRaw !== null || t.stopRaw !== null || !Number.isInteger(t.trailingBps) || t.trailingBps! < 1 || t.trailingBps! > 9900) throw Error('Invalid trailing distance.');
  } else throw Error('Unknown exit kind.');
}
function decimal(raw: string, places: number) {
  const s=raw.padStart(places+1,'0'); return places ? `${s.slice(0,-places)}.${s.slice(-places)}` : s;
}
export function directExitMessage(t: DirectExitTerms): string {
  validateExitTerms(t);
  const proceeds=exitProceeds(t);
  if(isLimitBuy(t))return ['Fub same-wallet limit buy','',`Site: ${t.origin}`,`Order: ${t.id}`,`Wallet: ${t.wallet}`,`Token: ${t.mint}`,
   'Approval version: 6',`Token program: ${'tokenProgram' in t?t.tokenProgram:''}`,`Spend: ${decimal(t.amountRaw,9)} SOL (${t.amountRaw} lamports)`,
   `Minimum tokens received: ${decimal(t.targetRaw!,t.tokenDecimals)} (${t.targetRaw} atomic units)`,`Token decimals: ${t.tokenDecimals}`,
   `Slippage limit: ${t.slippageBps} basis points`,`Network fee cap: ${t.maxFeeLamports} lamports`,`Account rent cap: ${t.maxRentLamports} lamports`,
   `Issued: ${new Date(t.issuedAt).toISOString()}`,`Expires: ${new Date(t.expiresAt).toISOString()}`,'',
   'Authorize one purchase with this fixed SOL amount into this same wallet. Network fees and account rent are additional and bounded above.',
   'Routes: reviewed Raydium CLMM, standard SPL PumpSwap, and supported Pump bonding curves.',
   'Fill only when the encoded minimum token output reaches the signed token minimum. Market cap is converted at review; it is not a live USD trigger.',
   'No sales, external transfers, repeat purchases or copy trading are authorized. A cancelled or expired order cannot obtain a new signature.',
   'A transaction already signed may still confirm. Funds remain in your wallet until execution; a saved order does not reserve them.',
  ].join('\n');
  return ['Fub direct wallet exit order', '', `Site: ${t.origin}`, `Order: ${t.id}`, `Wallet: ${t.wallet}`, `Token: ${t.mint}`,
    `Sell amount: ${decimal(t.amountRaw,t.tokenDecimals)} (${t.amountRaw} atomic units)`, `Token decimals: ${t.tokenDecimals}`,
    ...(t.version!==1?[`Approval version: ${t.version}`, ...('tokenProgram' in t?[`Token program: ${t.tokenProgram}`]:[]), `Proceeds mint: ${t.outputMint}`, t.version===5?'Pool sales return WSOL; Pump bonding-curve sales return native SOL to this same wallet. No external transfers.':'Proceeds stay as wrapped SOL (WSOL). This order does not unwrap or transfer SOL.']:[]),
    ...(t.version===5?['Routes: reviewed Raydium CLMM, standard SPL PumpSwap, and supported Pump bonding curves.']:[]),
    ...(t.version===4?['Routes: one reviewed Raydium CLMM or PumpSwap pool; standard SPL tokens only.']:[]),
    `Strategy: ${t.kind}`, ...(t.kind==='limit' ? [`Minimum sale proceeds: ${decimal(t.targetRaw!,proceeds.decimals)} ${proceeds.symbol}`] : t.kind==='bracket' ? [`Target proceeds: ${decimal(t.targetRaw!,proceeds.decimals)} ${proceeds.symbol}`, `Stop proceeds: ${decimal(t.stopRaw!,proceeds.decimals)} ${proceeds.symbol}`] : [`Trailing distance: ${t.trailingBps} basis points`]),
    `Slippage limit: ${t.slippageBps} basis points`, `Network fee cap: ${t.maxFeeLamports} lamports`, `Account rent cap: ${t.maxRentLamports} lamports`,
    `Issued: ${new Date(t.issuedAt).toISOString()}`, `Expires: ${new Date(t.expiresAt).toISOString()}`, '',
    `Authorize one sale of this amount from this wallet to ${proceeds.symbol} in this same wallet.`,
    ...(t.kind==='limit'?['The limit fills only when minimum swap proceeds reach the target. This authorizes one sale, not buys, transfers or copy trading.']:[
    'The target uses minimum swap proceeds. Stops use the executable quote and can fill below the trigger.',
    'The trailing high starts with the first valid quote after activation. Offline highs are not reconstructed.',
    'Either bracket leg consumes the whole order. This does not authorize buys, transfers or copy trading.']),
    'Expiry and cancellation block new signatures. A transaction already signed can still confirm.',
  ].join('\n');
}
export function evaluateExit(t: DirectExitTerms, prior: ExitWatermark, q: ExitObservation, now=Date.now()): { watermark: ExitWatermark; leg: ExitLeg | null } {
  validateExitTerms(t);
  const output=exitRaw(q.outputRaw), minimum=exitRaw(q.minimumRaw);
  if (t.issuedAt>now || t.expiresAt<=now || !Number.isSafeInteger(q.checkedAt) || q.checkedAt<t.issuedAt || q.checkedAt>now || now-q.checkedAt>10000 ||
      !Number.isSafeInteger(q.slot) || q.slot<1 || !Number.isSafeInteger(prior.slot) || prior.slot<0 || !Number.isSafeInteger(prior.checkedAt) || prior.checkedAt<0 ||
      q.slot<prior.slot || q.checkedAt<=prior.checkedAt || minimum>output || minimum<output*BigInt(10000-t.slippageBps)/10000n) throw Error('Stale or invalid exit quote.');
  const old=prior.highRaw===null ? null : exitRaw(prior.highRaw);
  if ((old===null)!==(prior.slot===0) || (prior.slot===0)!==(prior.checkedAt===0)) throw Error('Invalid trailing history.');
  const high=old===null||output>old?output:old;
  const watermark={highRaw:high.toString(),slot:q.slot,checkedAt:q.checkedAt};
  const leg: ExitLeg|null=t.kind==='limit' ? (minimum>=exitRaw(t.targetRaw)?'target':null) : t.kind==='bracket' ? (minimum>=exitRaw(t.targetRaw)?'target':output<=exitRaw(t.stopRaw)?'stop':null)
    : old!==null && output*10000n<=high*BigInt(10000-t.trailingBps!) ? 'trailing' : null;
  return {watermark,leg};
}
