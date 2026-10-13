import {describe,it,expect} from 'vitest';
import {verifyProviderWalletMessage} from '../src/provider-wallet-auth';
const wallet='So11111111111111111111111111111111111111112', origin='https://www.usefub.app', now=Date.now();
const message=`www.usefub.app wants you to sign in with your Solana account:\n${wallet}\n\nYou are proving you own ${wallet}.\n\nURI: ${origin}\nVersion: 1\nChain ID: mainnet\nNonce: abcd1234efgh5678\nIssued At: ${new Date(now).toISOString()}\nResources:\n- https://privy.io`;
describe('provider wallet ownership challenge',()=>{
 it('accepts the exact current same-wallet SDK challenge',()=>expect(()=>verifyProviderWalletMessage(message,wallet,origin,now)).not.toThrow());
 it.each([
 ['foreign host',message.replace('www.usefub.app','attacker.example')],
 ['foreign URI',message.replace(`URI: ${origin}`,'URI: https://attacker.example')],
 ['different wallet',message.replace(wallet,'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN')],
 ['extra authority',message+'\nApprove automatic trades'],
 ['changed statement',message.replace('You are proving you own','Authorize transfers from')],
 ['malformed nonce',message.replace('abcd1234efgh5678','short')],
 ['stale challenge',message.replace(new Date(now).toISOString(),new Date(now-300001).toISOString())],
 ['future challenge',message.replace(new Date(now).toISOString(),new Date(now+10000).toISOString())]
 ])('refuses %s before signing',(_label,value)=>expect(()=>verifyProviderWalletMessage(value,wallet,origin,now)).toThrow());
});
