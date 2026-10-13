import { CASH_NETWORKS, isCashNetwork, type CashNetwork } from './cash-route.js';
import { isMint } from './assets.js';
import { isEvmAddress } from './networks.js';
export type CashWalletChallenge = {version:1;origin:string;sourceWallet:string;recipient:string;network:CashNetwork;nonce:string;issuedAt:number;expiresAt:number};
export function cashWalletMessage(c:CashWalletChallenge) {
  let u: URL; try {u=new URL(c.origin);} catch {throw Error('Invalid wallet binding origin.');}
  if (c.version !== 1 || u.origin !== c.origin || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) || !isMint(c.sourceWallet) || !isEvmAddress(c.recipient) ||
    /^0x0{40}$/i.test(c.recipient) || !isCashNetwork(c.network) || !/^[a-f0-9]{64}$/.test(c.nonce) ||
    !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt-c.issuedAt !== 300000)
    throw Error('Invalid cash wallet binding.');
  return `${u.host} wallet ownership\n\nLink these wallets for Fub cash trading.\nThis signature does not authorize a trade, transfer or token allowance.\n\nSolana wallet: ${c.sourceWallet}\n${CASH_NETWORKS[c.network].name} wallet: ${c.recipient.toLowerCase()}\nChain ID: ${CASH_NETWORKS[c.network].chainId}\nURI: ${c.origin}\nNonce: ${c.nonce}\nIssued At: ${new Date(c.issuedAt).toISOString()}\nExpiration Time: ${new Date(c.expiresAt).toISOString()}`;
}
