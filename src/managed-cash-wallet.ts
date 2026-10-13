import {isEvmAddress} from './networks';

type Account = {type: string; chainType?: string; walletClientType?: string; imported?: boolean; walletIndex?: number | null; address?: string; id?: string | null};
export type ManagedCashIdentity = {address: string; walletId: string};

// TEE wallets have no HD index. Require a single user-created EVM account;
// never substitute an imported Fomo wallet or pick arbitrarily among matches.
export function managedCashIdentity(accounts: readonly Account[]): ManagedCashIdentity | null {
  const matches = accounts.filter(a => a.type === 'wallet' && a.chainType === 'ethereum' &&
    ['privy', 'privy-v2'].includes(a.walletClientType || '') && a.imported === false);
  if (matches.length > 1) throw Error('More than one primary cross-chain wallet was returned. Refresh your account before continuing.');
  const wallet = matches[0];
  if (!wallet) return null;
  if (!wallet.address || !isEvmAddress(wallet.address) || /^0x0{40}$/i.test(wallet.address) || !wallet.id || !/^[a-z0-9]{20,40}$/.test(wallet.id))
    throw Error('Your cross-chain wallet details are incomplete. Refresh your account before continuing.');
  return {address: wallet.address.toLowerCase(), walletId: wallet.id};
}
