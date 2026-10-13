import type {Wallet} from '@wallet-standard/base';
export const isImportedWallet=(wallet:Pick<Wallet,'features'>)=>'privy:' in wallet.features;
export const isLaunchWalletRoute=(hash:string)=>hash.split('?')[0]==='#launch';
export function walletMayConnect(wallet:Pick<Wallet,'features'>,hash:string){return isImportedWallet(wallet)||isLaunchWalletRoute(hash);}
export function walletMaySign(wallet:Pick<Wallet,'features'>,hash:string,launchAction=false){return isImportedWallet(wallet)||(launchAction&&isLaunchWalletRoute(hash));}
