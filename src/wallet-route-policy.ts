import type {Wallet} from '@wallet-standard/base';
export const isImportedWallet=(wallet:Pick<Wallet,'features'>)=>'privy:' in wallet.features;
export const isLaunchWalletRoute=(hash:string)=>hash.split('?')[0]==='#launch';
export const isCopyWalletRoute=(hash:string)=>hash.split('?')[0]==='#copy-trading';
export const isExternalWalletRoute=(hash:string)=>isLaunchWalletRoute(hash)||isCopyWalletRoute(hash);
export function walletMayConnect(wallet:Pick<Wallet,'features'>,hash:string){return isImportedWallet(wallet)||isExternalWalletRoute(hash);}
export function walletMaySign(wallet:Pick<Wallet,'features'>,hash:string,launchAction=false,copyAction=false){return isImportedWallet(wallet)||(launchAction&&isLaunchWalletRoute(hash))||(copyAction&&isCopyWalletRoute(hash));}
