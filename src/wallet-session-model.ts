import {isMint} from './assets.js';
export type WalletLogin = {version:1;wallet:string;origin:string;nonce:string;issuedAt:number;acceptBy:number;expiresAt:number};
export function walletLoginMessage(c:WalletLogin) {
  if(!c||Object.keys(c).sort().join(',')!=='acceptBy,expiresAt,issuedAt,nonce,origin,version,wallet'||c.version!==1||!isMint(c.wallet)||!/^[a-f0-9]{64}$/.test(c.nonce)||![c.issuedAt,c.acceptBy,c.expiresAt].every(Number.isSafeInteger)||c.issuedAt<=0||c.acceptBy!==c.issuedAt+300000||c.expiresAt!==c.issuedAt+86400000)throw Error('Invalid Fub sign-in message.');
  const u=new URL(c.origin);if(u.origin!==c.origin||u.username||u.password||(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname))))throw Error('Invalid Fub sign-in origin.');
  return ['Sign in to Fub',`Website: ${c.origin}`,`Wallet: ${c.wallet}`,'Network: solana:mainnet','Access: save and manage my copy plans and coin drafts, prepare launches, view activity, and review trading limits.','This signature does not move funds, approve trades, or grant wallet signing access.',`Issued: ${new Date(c.issuedAt).toISOString()}`,`Sign before: ${new Date(c.acceptBy).toISOString()}`,`Session expires: ${new Date(c.expiresAt).toISOString()}`,`Nonce: ${c.nonce}`].join('\n');
}
export function verifyWalletLogin(reply:{challenge:WalletLogin;message:string},wallet:string,origin:string,now=Date.now()) {
  const c=reply?.challenge;if(!c||c.wallet!==wallet||c.origin!==origin||c.issuedAt>now||c.acceptBy<=now||reply.message!==walletLoginMessage(c))throw Error('Sign-in review changed or expired.');return c;
}
