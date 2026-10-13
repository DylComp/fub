import type {IncomingMessage,ServerResponse} from 'node:http';
import {handleWalletSession} from '../server/wallet-session.js';
export default async function handler(req:IncomingMessage,res:ServerResponse){
 if(new URL(req.url||'/','https://local.invalid').searchParams.get('action')==='cash-trade'){
  const {handleCashTrade}=await import('../server/cash-trade-api.js');return handleCashTrade(req,res);
 }
 if(new URL(req.url||'/','https://local.invalid').searchParams.get('action')==='cash-wallet'){
  const {handleCashWallet}=await import('../server/cash-wallet-api.js');return handleCashWallet(req,res);
 }
 return handleWalletSession(req,res);
}
