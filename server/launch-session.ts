import type {IncomingMessage} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readWalletSession} from './wallet-session.js';
// Session access only publishes/prepares/reads. The launch still needs both
// transaction signatures, exact instruction validation and spending admission.
export function verifyLaunchSession(req:IncomingMessage,wallet:string,signature:unknown){
 if(signature!=='session')return false;
 const s=readWalletSession(req),csrf=req.headers['x-fomo-csrf'];
 if(!s||s.wallet!==wallet||s.origin!==req.headers.origin||typeof csrf!=='string'||csrf.length!==s.csrf.length||!timingSafeEqual(Buffer.from(csrf),Buffer.from(s.csrf)))throw Error('Sign in with the launch wallet.');
 return true;
}
