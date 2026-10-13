import {NATIVE_COPY_MAX_BUY_LAMPORTS} from '../src/native-copy-permission.js';
import * as wire from './token2022-recovery.js';
export * from './token2022-recovery.js';

// Wire-format ceiling only, never spending authority. Copy jobs derive sell
// amounts from their credited position and leader fraction. The private ledger
// independently rechecks that allocation before signing. Engineering probes
// still import token2022-recovery directly and retain their smaller default.
export const NATIVE_COPY_MAX_SELL_RAW = '18446744073709551615';
type Review = wire.Raydium22ExecutionReview;
type Execution = wire.Raydium22SignedExecution;
export const verifyRaydium22Review = (r:Review, hash:string) => wire.verifyRaydium22Review(r,hash,NATIVE_COPY_MAX_SELL_RAW,NATIVE_COPY_MAX_BUY_LAMPORTS);
export const verifyRaydium22SignedMessage = (r:Review, hash:string, signed:string) => wire.verifyRaydium22SignedMessage(r,hash,signed,NATIVE_COPY_MAX_SELL_RAW,NATIVE_COPY_MAX_BUY_LAMPORTS);
export const verifyRaydium22Simulation = (r:Review, hash:string, reply:unknown) => wire.verifyRaydium22Simulation(r,hash,reply,NATIVE_COPY_MAX_SELL_RAW,NATIVE_COPY_MAX_BUY_LAMPORTS);
export const verifyRaydium22Landed = (r:Review, hash:string, e:Execution, reply:unknown) => wire.verifyRaydium22Landed(r,hash,e,reply,NATIVE_COPY_MAX_SELL_RAW,NATIVE_COPY_MAX_BUY_LAMPORTS);
export const bindRaydium22Signed = (r:Review, hash:string, signed:string, height:number, now=Date.now()) => wire.bindRaydium22Signed(r,hash,signed,height,now,NATIVE_COPY_MAX_SELL_RAW,NATIVE_COPY_MAX_BUY_LAMPORTS);
export const recoverRaydium22Execution = (r:Review, hash:string, e:Execution, rpc:Parameters<typeof wire.recoverRaydium22Execution>[3]) => wire.recoverRaydium22Execution(r,hash,e,rpc,NATIVE_COPY_MAX_SELL_RAW,NATIVE_COPY_MAX_BUY_LAMPORTS);
