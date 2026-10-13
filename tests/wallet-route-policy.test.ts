import {it,expect} from 'vitest';
import {walletMayConnect,walletMaySign} from '../src/wallet-route-policy';
const external={features:{}},imported={features:{'privy:':{}}};
it('allows external wallets only to connect and sign launch actions on the launch route',()=>{
 expect(walletMayConnect(external,'#launch')).toBe(true);expect(walletMaySign(external,'#launch',true)).toBe(true);
 expect(walletMaySign(external,'#launch')).toBe(false);
 for(const hash of ['#pay','#orders','#copy','#wallets','#overview','#launch/other','#launchpad','']){expect(walletMayConnect(external,hash)).toBe(false);expect(walletMaySign(external,hash,true)).toBe(false);}
});
it('allows imported Fomo signing for Pay, ownership and trading without requiring a launch route',()=>{
 for(const hash of ['#pay','#orders','#copy','#wallets','#overview','#launch']){expect(walletMayConnect(imported,hash)).toBe(true);expect(walletMaySign(imported,hash)).toBe(true);}
});
