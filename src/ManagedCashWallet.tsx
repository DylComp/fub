import {useEffect, useRef, useState} from 'react';
import {useCreateWallet, useExportWallet, useUser, useWallets} from '@privy-io/react-auth';
import {managedCashIdentity, type ManagedCashIdentity} from './managed-cash-wallet';
import {verifyManagedCashAccount} from './cash-account-client';
import type {CashNetwork} from './cash-route';
import type {CashWalletBinding} from '../server/cash-wallet-binding';
import type {WalletConnection} from './useWallet';
import {Modal} from './ui';

export type ManagedCashAccount = ManagedCashIdentity & {sourceWallet: string; userId: string; binding: CashWalletBinding};
type Props = {userId: string; sourceWallet: string; network: CashNetwork; connection: WalletConnection; hidden: boolean;
  isCurrent: () => boolean; close: () => void; onReady: (account: ManagedCashAccount) => void; onSigningChange:(active:boolean)=>void};
export function ManagedCashWallet({userId, sourceWallet, network, connection, hidden, isCurrent, close, onReady, onSigningChange}: Props) {
  const {user, refreshUser} = useUser(), {createWallet} = useCreateWallet(), {wallets, ready} = useWallets(), {exportWallet} = useExportWallet();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [created, setCreated] = useState<ManagedCashIdentity | null>(null);
  const lock = useRef(false), generation = useRef(0), latest = useRef({user, wallets, isCurrent});
  latest.current = {user, wallets, isCurrent};
  useEffect(() => () => {generation.current++; onSigningChange(false);}, [onSigningChange]);
  let identity: ManagedCashIdentity | null = null, identityError = '';
  try {identity = managedCashIdentity(user?.linkedAccounts || []);} catch (e) {identityError = (e as Error).message;}
  async function setup() {
    if (!ready || lock.current || !isCurrent()) return;
    lock.current = true; setBusy(true); setError('');
    const attempt = generation.current;
    const current = () => generation.current === attempt && latest.current.isCurrent() && latest.current.user?.id === userId;
    const guard = () => {if (!current()) throw Error('Your connected wallet changed. Reopen cross-chain setup.');};
    try {
      setMessage('Checking your cross-chain wallet…');
      const fresh = await refreshUser(); guard();
      if (fresh.id !== userId || !fresh.linkedAccounts.some(a => a.type === 'wallet' && a.chainType === 'solana' && a.address === sourceWallet)) throw Error('Use the Solana wallet linked to this account.');
      let selected = managedCashIdentity(fresh.linkedAccounts);
      if (!selected) {
        const marker = `fub.cash-creation.v1:${userId}`;
        if (localStorage.getItem(marker)) throw Error('Wallet creation is still unconfirmed. Check setup again shortly; Fub will not request another wallet while that attempt is unresolved.');
        setMessage('Creating your cross-chain wallet…');
        // Fub uses Privy's user-controlled TEE mode, which rejects HD indices.
        // An imported EVM wallet is preserved; create a separate user wallet.
        const hasImported = fresh.linkedAccounts.some(a => a.type === 'wallet' && a.chainType === 'ethereum' && ['privy', 'privy-v2'].includes(a.walletClientType || '') && a.imported);
        localStorage.setItem(marker, 'pending');
        const result = await createWallet({createAdditional: hasImported}); guard();
        selected = managedCashIdentity([{...result, type: 'wallet'}]);
        if (!selected) throw Error('Wallet creation was not confirmed. Check setup again shortly.');
        setCreated(selected);
        // createWallet already refreshes Privy's user. Wait for its React state
        // instead of hitting the rate-limited refresh endpoint a second time.
        let confirmed = managedCashIdentity(latest.current.user?.linkedAccounts || []);
        for (let tries = 0; !confirmed && tries < 20; tries++) {
          await new Promise(resolve => setTimeout(resolve, 250)); guard();
          confirmed = managedCashIdentity(latest.current.user?.linkedAccounts || []);
        }
        if (confirmed?.walletId !== selected.walletId || confirmed.address !== selected.address) throw Error('Wallet creation is awaiting account confirmation. Refresh and retry.');
      }
      localStorage.removeItem(`fub.cash-creation.v1:${userId}`);
      setCreated(selected);
      // SDK account metadata and signer availability can update separately.
      const findSigner = () => latest.current.wallets.find(w => ['privy', 'privy-v2'].includes(w.walletClientType) && !w.imported && w.address.toLowerCase() === selected.address);
      let connected = findSigner();
      for (let tries = 0; !connected && tries < 20; tries++) {
        await new Promise(resolve => setTimeout(resolve, 250)); guard(); connected = findSigner();
      }
      if (!connected) throw Error('Your wallet is created. Its signer is still loading; continue setup in a moment.');
      const provider = await connected.getEthereumProvider(); guard();
      const account = selected;
      const sign = async <T,>(action:()=>Promise<T>):Promise<T> => {
        guard(); onSigningChange(true);
        try {return await action();} finally {onSigningChange(false);}
      };
      const binding = await verifyManagedCashAccount({sourceWallet, recipient: account.address, network, connection:{
        signWalletSession:c=>sign(()=>connection.signWalletSession(c)),
        signCashWallet:c=>sign(()=>connection.signCashWallet(c)),
      }, current,
        progress: setMessage,
        signEvm: async encoded => {
          guard();
          const result = await sign(()=>provider.request({method: 'personal_sign', params: [encoded, account.address]})); guard();
          if (typeof result !== 'string') throw Error('Wallet ownership was not confirmed.');
          return result;
        },
      }); guard();
      onReady({...account, userId, sourceWallet, binding}); close();
    } catch (e) {if (current()) {setMessage(''); setError(e instanceof Error ? e.message : 'Setup was not confirmed. Refresh and retry.');}}
    finally {lock.current = false; if (generation.current === attempt) setBusy(false);}
  }
  if (hidden) return null;
  const available = identity || created;
  return <Modal title="Your cross-chain wallet." close={() => {if (!busy) close();}}>
    <p className="copy-help">Use your connected Fomo Solana wallet to sign in. Fub creates a wallet you own for cross-chain holdings. These holdings appear in Fub, separate from your existing Fomo EVM holdings.</p>
    <p className="copy-help">Purchases use your original Solana USDC balance. Sales return USDC there. You review and approve each manual trade.</p>
    {available && <p className="fomo-identity-address">{available.address}</p>}
    <button className="button primary full" disabled={busy || !ready || !!identityError} onClick={() => void setup()}>{busy ? 'Setting up…' : available ? 'Verify cross-chain wallet' : 'Create cross-chain wallet'}</button>
    {message && <p role="status" className="copy-help">{message}</p>}
    {(error || identityError) && <p role="alert" className="error-message">{error || identityError}</p>}
    {identity && <button className="word-link" disabled={busy} onClick={() => {void exportWallet({address: identity.address}).catch(() => setError('Wallet export could not open. Try again.'));}}>Export wallet through Privy</button>}
    <p className="copy-help">Setup verifies ownership. It does not move money or authorize automatic trading.</p>
  </Modal>;
}
