import {simulateCurveSwap} from './pump-curve-execution.js';
import {curveNativeResult} from './token2022-recovery.js';
import {nativeSellWithoutSetup} from './native-pilot-policy.js';
import {nativePriorityPrice} from './native-priority.js';
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { COPY_SWAP_PROGRAM, decodeCopyRoute } from '../src/copy-swap.js';
import { ATA_PROGRAM } from '../src/transaction-review.js';
import { WSOL } from '../src/funding-model.js';
import { record } from '../src/live-orders.js';
import { simulateRaydium22Swap,simulateStandardNativeSwap,simulatePumpNativeSwap } from './token2022-raydium-simulation.js';
import { verifyRaydium22Review, type Raydium22ExecutionReview } from './token2022-recovery.js';
import type { Rpc } from './funding.js';
// Recover only quote/route data from the wire. All setup instructions, account
// privileges, pool state and simulation are reconstructed independently below.
export function nativeReviewBuild(r: Raydium22ExecutionReview, hash: string, maxSellRaw?: string,maxBuyRaw?:string) {
    verifyRaydium22Review(r, hash, maxSellRaw,maxBuyRaw);
    if(r.version===4){const c=r.curve!;return{blockhash:c.blockhash,request:{...c.request,minOutputRaw:c.minimumRaw},build:{inAmount:c.request.inputRaw,outAmount:c.quotedRaw,otherAmountThreshold:c.minimumRaw}};}
    const buy = r.accounts.direction === 'buy', inputMint = buy ? WSOL : r.accounts.mint, outputMint = buy ? r.accounts.mint : WSOL;
    const tx = getTransactionDecoder().decode(Buffer.from(r.unsigned, 'base64'));
    const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (m.version !== 0)
        throw Error('Unsupported native message version.');
    const ix = m.instructions.at(-1)!;
    if (m.staticAccounts[ix.programAddressIndex] !== COPY_SWAP_PROGRAM || !ix.data || !ix.accountIndices)
        throw Error('Unsupported native route.');
    const route = decodeCopyRoute(new Uint8Array(ix.data)), keys = Array.from(ix.accountIndices, i => String(m.staticAccounts[i]));
    const v2=route.steps[0]?.variant===40,pump=[3,5].includes(r.version),pumpV4=r.version===5;
    const badVariant=pump?route.steps[0]?.variant!==(pumpV4?(buy?193:194):(buy?99:100)):r.version===1?!v2:!v2&&route.steps[0]?.variant!==26;
    const badLength=pump?keys.length!==(pumpV4?30:(buy?39:37)):keys.length<(v2?26:22)||keys.length>(v2?35:31);
    if (route.kind !== 'direct' || route.steps.length !== 1 || badVariant || badLength)
        throw Error('Unsupported native route.');
    const minimum = (route.output * BigInt(10000 - route.slippageBps) / 10000n).toString();
    return { blockhash: String(m.lifetimeToken), request: { wallet: r.accounts.wallet, mint: r.accounts.mint, direction: r.accounts.direction, inputRaw: r.accounts.inputRaw, minOutputRaw: r.accounts.minimum, slippageBps: route.slippageBps }, build: {
            inputMint, outputMint, swapMode: 'ExactIn', inAmount: route.input.toString(), outAmount: route.output.toString(), otherAmountThreshold: minimum, slippageBps: route.slippageBps,
            routePlan: [{ bps: route.steps[0].bps, swapInfo: { label: pump?'Pump.fun Amm':'Raydium CLMM', ammKey: keys[pump?11:13], inputMint, outputMint, inAmount: route.input.toString(), outAmount: route.output.toString() } }],
            swapInstruction: { programId: COPY_SWAP_PROGRAM, data: Buffer.from(ix.data).toString('base64'), accounts: keys.map((pubkey, i) => ({ pubkey, isSigner: i === 0 || pump&&i===(pumpV4?28:10+22+(buy?2:0)), isWritable: i < 10 ? [1, 2].includes(i) : i !== keys.length - 1 && (pump?(pumpV4?[1,2,6,7,8,9,13,15,18]:[1,2,6,7,8,9,11,18,22+(buy?2:0),25+(buy?2:0),...(buy?[20,21]:[])]).includes(i-10):!(v2?[0, 1, 2, 9, 10, 11, 12, 13]:[0,1,2,9]).includes(i - 10)) })) },
        } };
}
// Infer this variant from the wire, never from a caller's cost claim. The
// reconstructed transaction must still match every byte of the submitted one.
export function nativeBuyReusesWrapped(r: Raydium22ExecutionReview) {
    if (r.version === 4 || r.accounts.direction !== 'buy' || r.wrappedCreated) return false;
    const tx = getTransactionDecoder().decode(Buffer.from(r.unsigned, 'base64'));
    const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    return m.version === 0 && !m.instructions.some(ix =>
        m.staticAccounts[ix.programAddressIndex] === ATA_PROGRAM &&
        ix.accountIndices?.[1] !== undefined && m.staticAccounts[ix.accountIndices[1]] === r.accounts.source);
}
export async function rebuildNativeReview(r: Raydium22ExecutionReview, hash: string, rpc: Rpc, maxSellRaw?: string, authorizedSlippageBps?:number,maxBuyRaw?:string) {
    verifyRaydium22Review(r,hash,maxSellRaw,maxBuyRaw);
    if(r.version===4)return curveNativeResult(await simulateCurveSwap(r.curve!.request,rpc,r.curve,5000,maxBuyRaw));
    const input = nativeReviewBuild(r, hash, maxSellRaw,maxBuyRaw);
    const slippageBps=authorizedSlippageBps??input.request.slippageBps;
    if(!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500||input.request.slippageBps>slippageBps)
        throw Error('Native route exceeds authorized slippage.');
    const valid = record(await rpc('isBlockhashValid', [input.blockhash, { commitment: 'finalized', minContextSlot: r.minContextSlot }]));
    const slot = record(valid.context).slot;
    if (valid.value !== true || !Number.isSafeInteger(slot) || (slot as number) < r.minContextSlot)
        throw Error('Native blockhash is no longer valid.');
    const height = await rpc('getBlockHeight', [{ commitment: 'finalized', minContextSlot: slot }]);
    if (!Number.isSafeInteger(height) || (height as number) < 1 || (height as number) > r.lastValidBlockHeight)
        throw Error('Native block height is invalid.');
    // Preserve the reviewed lifetime while rebuilding. Fresh blockhash validity is
    // checked above; this override cannot reach the network or alter any accounts.
    const simulated = await ([3,5].includes(r.version)?simulatePumpNativeSwap:r.version===2?simulateStandardNativeSwap:simulateRaydium22Swap)(input.build, input.request, (method, params) => method === 'getLatestBlockhash'
        ? Promise.resolve({ context: { slot }, value: { blockhash: input.blockhash, lastValidBlockHeight: r.lastValidBlockHeight } }) : rpc(method, params), maxSellRaw, nativeSellWithoutSetup(r),nativePriorityPrice(r.unsigned),nativeBuyReusesWrapped(r),maxBuyRaw);
    const fresh = simulated.executionReview;
    // A caller cannot make the slippage percentage meaningless by supplying an
    // artificially low quote. Anchor the minimum to independently simulated net output
    // using the authenticated permission ceiling. The wire may deliberately be stricter.
    const minimumAtCurrentOutput = BigInt(simulated.receivedRaw) * BigInt(10000 - slippageBps) / 10000n;
    if (BigInt(r.accounts.minimum) < minimumAtCurrentOutput)
        throw Error('Native minimum exceeds the allowed slippage from current simulated output.');
    const fixed = (v: Raydium22ExecutionReview) => ({ version:v.version,pumpTracker:v.pumpTracker,unsigned: v.unsigned, messageHash: v.messageHash, accounts: v.accounts, feeLamports: v.feeLamports, wrappedCreated: v.wrappedCreated, tokenCreated: v.tokenCreated, wrappedReserve: v.wrappedReserve, vaultReserve: v.vaultReserve, tokenRent: v.tokenRent });
    // JSONB property order must not change this comparison.
    const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    if (JSON.stringify(canonical(fixed(fresh))) !== JSON.stringify(canonical(fixed(r))) || fresh.minContextSlot < r.minContextSlot)
        throw Error('Native transaction changed during independent review.');
    return simulated;
}
