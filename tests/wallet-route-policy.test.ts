import {it,expect} from 'vitest';
import {walletMayConnect,walletMaySign} from '../src/wallet-route-policy';
const external={features:{}},imported={features:{'privy:':{}}};
it('allows external launch and copy connection with action-scoped signing',()=>{
 expect(walletMayConnect(external,'#launch')).toBe(true);
 expect(walletMaySign(external,'#launch',true)).toBe(true);
 expect(walletMaySign(external,'#launch')).toBe(false);
 expect(walletMayConnect(external,'#copy-trading')).toBe(true);
 expect(walletMayConnect(external,'#copy-trading?leader=alice')).toBe(true);
 expect(walletMaySign(external,'#copy-trading',false,true)).toBe(true);
 expect(walletMaySign(external,'#copy-trading')).toBe(false);
 expect(walletMaySign(external,'#copy-trading',true)).toBe(false);
 expect(walletMaySign(external,'#launch',false,true)).toBe(false);
 for(const hash of ['#pay','#orders','#copy','#wallets','#overview','#launch/other','#launchpad','#copy-trading/other','']){
  expect(walletMayConnect(external,hash)).toBe(false);
  expect(walletMaySign(external,hash,true,true)).toBe(false);
 }
});
it('allows imported signing without requiring a launch or copy route',()=>{
 for(const hash of ['#pay','#orders','#copy-trading','#wallets','#overview','#launch']){
  expect(walletMayConnect(imported,hash)).toBe(true);
  expect(walletMaySign(imported,hash)).toBe(true);
 }
});
