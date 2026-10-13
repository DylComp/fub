import {walletSessionRequest} from './wallet-session-client';
import {verifyWalletLogin, type WalletLogin} from './wallet-session-model';
import {cashWalletMessage, type CashWalletChallenge} from './cash-wallet-model';
import type {CashNetwork} from './cash-route';
import type {WalletConnection} from './useWallet';
import type {CashWalletBinding} from '../server/cash-wallet-binding';

type Session = {address: string | null; csrf?: string};
type Connection = Pick<WalletConnection, 'signWalletSession' | 'signCashWallet'>;
export async function cashAccountRequest<T>(body: object, csrf: string): Promise<T> {
  const response = await fetch('/api/wallet-session?action=cash-wallet', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: {'Content-Type': 'application/json', 'X-Fomo-Request': '1', 'X-Fub-Csrf': csrf},
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.message || 'Cross-chain wallet verification failed.');
  return result;
}
export function checkedCashBinding(value: CashWalletBinding | null, sourceWallet: string, recipient: string, network: CashNetwork): value is CashWalletBinding {
  return !!value && value.sourceWallet === sourceWallet && value.recipient === recipient.toLowerCase() && value.network === network &&
    value.tradingAuthorized === false && ['eoa', 'contract'].includes(value.accountType) &&
    Number.isSafeInteger(value.verifiedAt) && value.verifiedAt <= Date.now() && Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > Date.now() && value.expiresAt <= value.verifiedAt + 3600000;
}
export async function verifyManagedCashAccount(input: {
  sourceWallet: string; recipient: string; network: CashNetwork; connection: Connection;
  signEvm: (encoded: string) => Promise<string>; current: () => boolean; progress: (message: string) => void;
  minValidityMs?: number;
}): Promise<CashWalletBinding> {
  const {sourceWallet, network, connection} = input, recipient = input.recipient.toLowerCase();
  const guard = () => {if (!input.current()) throw Error('Your connected wallet changed. Reopen cross-chain setup.');};
  guard();
  let session = await walletSessionRequest<Session>('status'); guard();
  if (session.address !== sourceWallet || !session.csrf) {
    input.progress('Confirm ownership in your Solana wallet.');
    const reply = await walletSessionRequest<{challenge: WalletLogin; message: string}>('challenge', {wallet: sourceWallet}); guard();
    const challenge = verifyWalletLogin(reply, sourceWallet, location.origin);
    const signature = await connection.signWalletSession(challenge); guard();
    session = await walletSessionRequest<Session>('verify', {wallet: sourceWallet, signature}); guard();
  }
  if (session.address !== sourceWallet || !session.csrf) throw Error('Your funding wallet was not verified.');
  const status = await cashAccountRequest<{binding: CashWalletBinding | null}>({action: 'status', network}, session.csrf); guard();
  if (checkedCashBinding(status.binding, sourceWallet, recipient, network) &&
    status.binding.expiresAt > Date.now() + (input.minValidityMs || 0)) return status.binding;
  const reply = await cashAccountRequest<{challenge: CashWalletChallenge; message: string}>({action: 'challenge', network, recipient}, session.csrf); guard();
  const c = reply.challenge;
  if (c.origin !== location.origin || c.sourceWallet !== sourceWallet || c.recipient !== recipient || c.network !== network ||
    c.expiresAt <= Date.now() || c.issuedAt > Date.now() || cashWalletMessage(c) !== reply.message) throw Error('The wallet ownership request changed.');
  input.progress('Confirm the link between your funding wallet and cross-chain wallet.');
  const encoded = '0x' + Array.from(new TextEncoder().encode(reply.message), b => b.toString(16).padStart(2, '0')).join('');
  const evm = await input.signEvm(encoded); guard();
  const solana = await connection.signCashWallet(c); guard();
  const result = await cashAccountRequest<{binding: CashWalletBinding}>({action: 'verify', nonce: c.nonce, evm, solana}, session.csrf); guard();
  if (!checkedCashBinding(result.binding, sourceWallet, recipient, network)) throw Error('The wallet link was not verified.');
  return result.binding;
}
