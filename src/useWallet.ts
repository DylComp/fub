import { useEffect, useRef, useState } from "react";
import {walletMayConnect,walletMaySign} from "./wallet-route-policy";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import { isMint } from "./assets";
import type { SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { validChallenge } from "./live-orders";
import { triggerRequest } from "./trigger-api";

type SupportedWallet = Wallet & {
  features: StandardConnectFeature &
    StandardEventsFeature &
    Partial<StandardDisconnectFeature>;
};
type Session = {
  wallet: SupportedWallet;
  accounts: readonly WalletAccount[];
  address: string;
};
function supported(wallet: Wallet): wallet is SupportedWallet {
  const connect = wallet.features["standard:connect"] as
    StandardConnectFeature["standard:connect"] | undefined;
  const events = wallet.features["standard:events"] as
    StandardEventsFeature["standard:events"] | undefined;
  return (
    wallet.chains.includes("solana:mainnet") &&
    connect?.version === "1.0.0" &&
    events?.version === "1.0.0" &&
    typeof connect.connect === "function" &&
    typeof events.on === "function"
  );
}
const mainnetAccounts = (accounts: readonly WalletAccount[]) =>
  accounts.filter(
    (account) =>
      account.chains.includes("solana:mainnet") && isMint(account.address),
  );
export const walletName = (wallet: Wallet) => wallet.name.slice(0, 64);
export function walletIcon(wallet: Wallet): string | undefined {
  return wallet.icon.length < 100000 &&
    /^data:image\/(png|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(
      wallet.icon,
    )
    ? wallet.icon
    : undefined;
}

export function useWallet({externalLaunchOnly=false}:{externalLaunchOnly?:boolean}={}) {
  const [wallets, setWallets] = useState<SupportedWallet[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<SupportedWallet | null>(null);
  const [error, setError] = useState("");
  const active = useRef<Session | null>(null);
  const attempt = useRef(0);
  const listener = useRef<(() => void) | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connecting = useRef<SupportedWallet | null>(null);

  function endOrderSession(address: string) {
    void triggerRequest("logout", { wallet: address }).catch(() => {
      if (!active.current || active.current.address === address)
        setError(
          "Could not clear wallet sign-in. Reconnect and sign out again.",
        );
    });
  }

  function clearAttempt() {
    attempt.current++;
    clearTimeout(timeout.current);
    connecting.current = null;
    setPending(null);
  }
  function clearSession() {
    if (active.current) endOrderSession(active.current.address);
    listener.current?.();
    listener.current = undefined;
    active.current = null;
    setSession(null);
  }
  useEffect(() => {
    const registry = getWallets();
    const refresh = () => {
      const found = registry.get().filter(supported).filter(w=>!externalLaunchOnly||walletMayConnect(w,location.hash));
      setWallets(found);
      if (connecting.current && !found.includes(connecting.current)) {
        clearAttempt();
        setError("That wallet is no longer available in this browser.");
      }
      if (active.current && !found.includes(active.current.wallet))
        clearSession();
    };
    refresh();
    window.addEventListener("hashchange",refresh);
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      attempt.current++;
      clearTimeout(timeout.current);
      listener.current?.();
      window.removeEventListener("hashchange",refresh);
      offRegister();
      offUnregister();
    };
  }, []);

  async function connect(wallet: SupportedWallet, expectedAddress?: string) {
    if(externalLaunchOnly&&!walletMayConnect(wallet,location.hash)){setError("Set up your Fomo wallet to use this feature. External wallets are available for launches.");return false;}
    if (connecting.current || active.current) return false;
    const id = ++attempt.current;
    connecting.current = wallet;
    setPending(wallet);
    setError("");
    timeout.current = setTimeout(() => {
      if (attempt.current !== id) return;
      clearAttempt();
      setError(
        "The connection timed out. Close the wallet request, then try again.",
      );
    }, 60000);
    try {
      const result = await wallet.features["standard:connect"].connect();
      if (attempt.current !== id || externalLaunchOnly&&!walletMayConnect(wallet,location.hash)) return false;
      const accounts = mainnetAccounts(result.accounts);
      if (!accounts.length || (expectedAddress && !accounts.some(account => account.address === expectedAddress))) throw new Error("no-mainnet-account");
      const next = { wallet, accounts, address: expectedAddress || accounts[0].address };
      active.current = next;
      setSession(next);
      listener.current = wallet.features["standard:events"].on(
        "change",
        (change) => {
          if (active.current?.wallet !== wallet) return;
          if (change.chains && !change.chains.includes("solana:mainnet")) {
            clearSession();
            setError("This wallet no longer exposes a Solana mainnet account.");
            return;
          }
          if (!change.accounts) return;
          const accounts = mainnetAccounts(change.accounts);
          if (!accounts.length) {
            clearSession();
            return;
          }
          const address = accounts.some(
            (account) => account.address === active.current!.address,
          )
            ? active.current.address
            : accounts[0].address;
          const updated = { wallet, accounts, address };
          if (address !== active.current.address)
            endOrderSession(active.current.address);
          active.current = updated;
          setSession(updated);
        },
      );
      return true;
    } catch (err) {
      if (attempt.current !== id) return false;
      clearSession();
      setError(
        err instanceof Error && err.message === "no-mainnet-account"
          ? "No supported Solana mainnet account was shared. Check the account selected in your wallet."
          : "Wallet connection was declined or unavailable. You can try again.",
      );
      return false;
    } finally {
      if (attempt.current === id) {
        clearTimeout(timeout.current);
        connecting.current = null;
        setPending(null);
      }
    }
  }
  async function disconnect() {
    const wallet = active.current?.wallet;
    clearAttempt();
    clearSession();
    setError("");
    const id = attempt.current;
    try {
      await wallet?.features["standard:disconnect"]?.disconnect();
    } catch {
      if (attempt.current !== id) return;
      setError(
        "Disconnected here. Remove this site's permission in your wallet if you also want to revoke access.",
      );
    }
  }
  function select(address: string) {
    const current = active.current;
    if (
      !current ||
      !current.accounts.some((account) => account.address === address)
    )
      return;
    if (current.address !== address) endOrderSession(current.address);
    active.current = { ...current, address };
    setSession(active.current);
  }
  function cancel() {
    clearAttempt();
    setError("Stopped waiting. Close the pending request in your wallet too.");
  }
  function signingSession(launchAction=false){
    const value=active.current;
    if(value&&externalLaunchOnly&&!walletMaySign(value.wallet,location.hash,launchAction))throw Error("Set up your Fomo wallet to use this feature. External wallets can sign launches only.");
    return value;
  }
  async function signTriggerChallenge(message: string, address: string) {
    const current = signingSession();
    const account = current?.accounts.find((item) => item.address === address);
    const feature = current?.wallet.features["solana:signMessage"] as
      SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (
      !current ||
      current.address !== address ||
      !account ||
      !account.features.includes("solana:signMessage") ||
      !feature ||
      !["1.0.0", "1.1.0"].includes(feature.version) ||
      typeof feature.signMessage !== "function"
    )
      throw new Error(
        "This wallet cannot sign the Jupiter login message. Use a wallet with message signing.",
      );
    if (
      !validChallenge(message, address) ||
      bs58.encode(new Uint8Array(account.publicKey)) !== address
    )
      throw new Error(
        "The login message or wallet account could not be verified.",
      );
    const bytes = new TextEncoder().encode(message);
    const result = await feature.signMessage({ account, message: bytes });
    if (signingSession() !== current)
      throw new Error("Wallet changed. Start sign-in again.");
    const signed = result[0];
    if (
      result.length !== 1 ||
      !signed ||
      signed.signature.length !== 64 ||
      (signed.signatureType && signed.signatureType !== "ed25519") ||
      signed.signedMessage.length !== bytes.length ||
      !bytes.every((byte, index) => signed.signedMessage[index] === byte)
    )
      throw new Error(
        "The wallet changed the login message. Nothing was authorized.",
      );
    return bs58.encode(signed.signature);
  }
  async function signLaunchAuthorization(authorization: import("./launch-publication").LaunchAuthorization) {
    const current = signingSession(true), account = current?.accounts.find(a => a.address === authorization.wallet);
    const feature = current?.wallet.features["solana:signMessage"] as SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (!current || current.address !== authorization.wallet || !account || !account.features.includes("solana:signMessage") ||
        !feature || !["1.0.0", "1.1.0"].includes(feature.version) || bs58.encode(new Uint8Array(account.publicKey)) !== authorization.wallet) throw Error("Connect a wallet that supports message signing.");
    const { launchAuthorizationMessage } = await import("./launch-publication");
    const message = new TextEncoder().encode(launchAuthorizationMessage(authorization));
    const results = await feature.signMessage({ account, message });
    const result = results[0];
    if (signingSession(true) !== current || results.length !== 1 || !result || result.signature.length !== 64 ||
        (result.signatureType && result.signatureType !== "ed25519") || result.signedMessage.length !== message.length ||
        !message.every((b, i) => result.signedMessage[i] === b)) throw Error("Wallet changed or altered the message. Nothing was published.");
    return bs58.encode(result.signature);
  }
  async function signLaunchRecovery(authorization: import("./launch-recovery").LaunchRecoveryAuthorization) {
    const current = signingSession(true), account = current?.accounts.find(a => a.address === authorization.wallet);
    const feature = current?.wallet.features["solana:signMessage"] as SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (!current || current.address !== authorization.wallet || !account || !account.features.includes("solana:signMessage") ||
        !feature || !["1.0.0", "1.1.0"].includes(feature.version) || bs58.encode(new Uint8Array(account.publicKey)) !== authorization.wallet) throw Error("Connect a wallet that supports message signing.");
    const { launchRecoveryMessage } = await import("./launch-recovery");
    const message = new TextEncoder().encode(launchRecoveryMessage(authorization));
    const results = await feature.signMessage({ account, message });
    const result = results[0];
    if (signingSession(true) !== current || results.length !== 1 || !result || result.signature.length !== 64 ||
        (result.signatureType && result.signatureType !== "ed25519") || result.signedMessage.length !== message.length ||
        !message.every((b, i) => result.signedMessage[i] === b)) throw Error("Wallet changed or altered the message. The launch check was canceled.");
    return bs58.encode(result.signature);
  }
  async function signEnrollment(authorization: import("./signer-enrollment-model").EnrollmentChallenge) {
    const current = signingSession(), account = current?.accounts.find(a => a.address === authorization.wallet);
    const feature = current?.wallet.features["solana:signMessage"] as SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (!current || current.address !== authorization.wallet || !account || !account.features.includes("solana:signMessage") ||
        !feature || !["1.0.0", "1.1.0"].includes(feature.version) || bs58.encode(new Uint8Array(account.publicKey)) !== authorization.wallet) throw Error("Connect this wallet to review background access.");
    const { enrollmentMessage } = await import("./signer-enrollment-model");
    if (authorization.origin !== location.origin || authorization.challengeExpiresAt <= Date.now()) throw Error("Permission review expired or belongs to another site.");
    const message = new TextEncoder().encode(enrollmentMessage(authorization));
    const results = await feature.signMessage({ account, message });
    const result = results[0];
    if (signingSession() !== current || results.length !== 1 || !result || result.signature.length !== 64 ||
        (result.signatureType && result.signatureType !== "ed25519") || result.signedMessage.length !== message.length ||
        !message.every((b, i) => result.signedMessage[i] === b)) throw Error("Wallet changed or altered the permission message.");
    return bs58.encode(result.signature);
  }
  async function signDirectExit(terms: import('./direct-exits').DirectExitTerms) {
    const current=signingSession(),account=current?.accounts.find(a=>a.address===terms.wallet);
    const feature=current?.wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage']|undefined;
    if(!current||current.address!==terms.wallet||!account||!account.features.includes('solana:signMessage')||!feature||!['1.0.0','1.1.0'].includes(feature.version)||bs58.encode(new Uint8Array(account.publicKey))!==terms.wallet)throw Error('Connect the wallet shown in this exit review.');
    if(terms.origin!==location.origin||terms.issuedAt>Date.now()||Date.now()-terms.issuedAt>60000||terms.expiresAt<=Date.now())throw Error('The exit review expired or belongs to another site.');
    const {directExitMessage}=await import('./direct-exits');
    const message=new TextEncoder().encode(directExitMessage(terms));
    const results=await feature.signMessage({account,message}),result=results[0];
    if(signingSession()!==current||results.length!==1||!result||result.signature.length!==64||(result.signatureType&&result.signatureType!=='ed25519')||result.signedMessage.length!==message.length||!message.every((b,i)=>result.signedMessage[i]===b))throw Error('Wallet changed or altered the exit approval.');
    return bs58.encode(result.signature);
  }
  async function signProviderWallet(message: string, address: string) {
    const current = signingSession(), account = current?.accounts.find(a => a.address === address);
    const feature = current?.wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage'] | undefined;
    if (!current || current.address !== address || !account || !account.features.includes('solana:signMessage') || !feature || !['1.0.0', '1.1.0'].includes(feature.version) || bs58.encode(new Uint8Array(account.publicKey)) !== address) throw Error('Connect a wallet that supports ownership verification.');
    const { verifyProviderWalletMessage } = await import('./provider-wallet-auth');
    verifyProviderWalletMessage(message, address, location.origin);
    const bytes = new TextEncoder().encode(message);
    const results = await feature.signMessage({ account, message: bytes });
    const result = results[0];
    if (signingSession() !== current || results.length !== 1 || !result || result.signature.length !== 64 || (result.signatureType && result.signatureType !== 'ed25519') || result.signedMessage.length !== bytes.length || !bytes.every((b, i) => result.signedMessage[i] === b)) throw Error('Wallet changed or altered the ownership message.');
    return btoa(String.fromCharCode(...result.signature));
  }
  async function signWalletSession(challenge: import('./wallet-session-model').WalletLogin) {
    const current=signingSession(true),account=current?.accounts.find(a=>a.address===challenge.wallet);
    const feature=current?.wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage']|undefined;
    if(!current||current.address!==challenge.wallet||!account||!account.features.includes('solana:signMessage')||!feature||!['1.0.0','1.1.0'].includes(feature.version)||bs58.encode(new Uint8Array(account.publicKey))!==challenge.wallet)throw Error('Connect this wallet to sign in.');
    if(challenge.origin!==location.origin||challenge.issuedAt>Date.now()||challenge.acceptBy<=Date.now())throw Error('Sign-in expired or belongs to another site.');
    const {walletLoginMessage}=await import('./wallet-session-model');
    const message=new TextEncoder().encode(walletLoginMessage(challenge));
    const results=await feature.signMessage({account,message}),result=results[0];
    if(signingSession(true)!==current||results.length!==1||!result||result.signature.length!==64||(result.signatureType&&result.signatureType!=='ed25519')||result.signedMessage.length!==message.length||!message.every((b,i)=>result.signedMessage[i]===b))throw Error('Wallet changed or altered the sign-in message.');
    return bs58.encode(result.signature);
  }
  async function signCashCopy(scope: import('./cash-copy-model').CashCopyScope) {
    const current=signingSession(),account=current?.accounts.find(a=>a.address===scope.sourceWallet);
    const feature=current?.wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage']|undefined;
    if(!current||current.address!==scope.sourceWallet||!account||!account.features.includes('solana:signMessage')||!feature||!['1.0.0','1.1.0'].includes(feature.version)||bs58.encode(new Uint8Array(account.publicKey))!==scope.sourceWallet)throw Error('Connect the funding wallet shown in these copy limits.');
    if(scope.origin!==location.origin||scope.issuedAt>Date.now()||scope.acceptBy<=Date.now())throw Error('Review fresh copy limits before signing.');
    const {cashCopyPermissionMessage}=await import('./cash-copy-model');
    const message=new TextEncoder().encode(cashCopyPermissionMessage(scope));
    const results=await feature.signMessage({account,message}),result=results[0];
    if(signingSession()!==current||results.length!==1||!result||result.signature.length!==64||(result.signatureType&&result.signatureType!=='ed25519')||result.signedMessage.length!==message.length||!message.every((b,i)=>result.signedMessage[i]===b))throw Error('Wallet changed or altered the copy limits.');
    return bs58.encode(result.signature);
  }
  async function signCashWallet(challenge: import('./cash-wallet-model').CashWalletChallenge) {
    const current=signingSession(),account=current?.accounts.find(a=>a.address===challenge.sourceWallet);
    const feature=current?.wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage']|undefined;
    if(!current||current.address!==challenge.sourceWallet||!account||!account.features.includes('solana:signMessage')||!feature||bs58.encode(new Uint8Array(account.publicKey))!==challenge.sourceWallet)throw Error('Connect the Solana wallet shown in this verification.');
    if(challenge.origin!==location.origin||challenge.issuedAt>Date.now()||challenge.expiresAt<=Date.now())throw Error('Wallet verification expired or belongs to another site.');
    const {cashWalletMessage}=await import('./cash-wallet-model');
    const message=new TextEncoder().encode(cashWalletMessage(challenge));
    const results=await feature.signMessage({account,message}),result=results[0];
    if(signingSession()!==current||results.length!==1||!result||result.signature.length!==64||(result.signatureType&&result.signatureType!=='ed25519')||result.signedMessage.length!==message.length||!message.every((b,i)=>result.signedMessage[i]===b))throw Error('Wallet changed or altered the verification message.');
    return bs58.encode(result.signature);
  }
  async function signNativeCopy(terms: import('./native-copy-permission').Token22Permission) {
    const current=signingSession(),account=current?.accounts.find(a=>a.address===terms.wallet);
    const feature=current?.wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage']|undefined;
    if(!current||current.address!==terms.wallet||!account||!account.features.includes('solana:signMessage')||!feature||!['1.0.0','1.1.0'].includes(feature.version)||bs58.encode(new Uint8Array(account.publicKey))!==terms.wallet)throw Error('Connect the wallet shown in these copy limits.');
    if(terms.origin!==location.origin||terms.issuedAt>Date.now()||terms.acceptBy<=Date.now()||terms.expiresAt<=Date.now())throw Error('The copy review expired or belongs to another site.');
    const {token22PermissionMessage}=await import('./native-copy-permission');
    const message=new TextEncoder().encode(token22PermissionMessage(terms));
    const results=await feature.signMessage({account,message}),result=results[0];
    if(signingSession()!==current||results.length!==1||!result||result.signature.length!==64||(result.signatureType&&result.signatureType!=='ed25519')||result.signedMessage.length!==message.length||!message.every((b,i)=>result.signedMessage[i]===b))throw Error('Wallet changed or altered the copy approval.');
    return bs58.encode(result.signature);
  }
  async function signPayHistory(authorization: import("./pay-history-auth").PayHistoryAuthorization) {
    const current = signingSession(), account = current?.accounts.find(a => a.address === authorization.wallet);
    const feature = current?.wallet.features["solana:signMessage"] as SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (!current || current.address !== authorization.wallet || !account || !account.features.includes("solana:signMessage") ||
        !feature || !["1.0.0", "1.1.0"].includes(feature.version) || bs58.encode(new Uint8Array(account.publicKey)) !== authorization.wallet) throw Error("Connect a wallet that supports message signing.");
    const { payHistoryMessage } = await import("./pay-history-auth");
    const message = new TextEncoder().encode(payHistoryMessage(authorization));
    const results = await feature.signMessage({ account, message });
    const result = results[0];
    if (signingSession() !== current || results.length !== 1 || !result || result.signature.length !== 64 ||
        (result.signatureType && result.signatureType !== "ed25519") || result.signedMessage.length !== message.length ||
        !message.every((b, i) => result.signedMessage[i] === b)) throw Error("Wallet changed or altered the message. The card history request was canceled.");
    return bs58.encode(result.signature);
  }
  async function signLaunchExecution(authorization: import("./launch-execution-request").LaunchExecutionAuthorization) {
    const current = signingSession(true), account = current?.accounts.find(a => a.address === authorization.wallet);
    const feature = current?.wallet.features["solana:signMessage"] as SolanaSignMessageFeature["solana:signMessage"] | undefined;
    if (!current || current.address !== authorization.wallet || !account || !account.features.includes("solana:signMessage") ||
        !feature || !["1.0.0", "1.1.0"].includes(feature.version) || bs58.encode(new Uint8Array(account.publicKey)) !== authorization.wallet) throw Error("Connect a wallet that supports message signing.");
    const { launchExecutionMessage } = await import("./launch-execution-request");
    const message = new TextEncoder().encode(launchExecutionMessage(authorization));
    const results = await feature.signMessage({ account, message });
    const result = results[0];
    if (signingSession(true) !== current || results.length !== 1 || !result || result.signature.length !== 64 ||
        (result.signatureType && result.signatureType !== "ed25519") || result.signedMessage.length !== message.length ||
        !message.every((b, i) => result.signedMessage[i] === b)) throw Error("Wallet changed or altered the message. The launch request was canceled.");
    return bs58.encode(result.signature);
  }
  async function signCashDeposit(review:import('../server/cash-deposit').CashDepositReview,intent:import('./cash-route').CashRouteIntent){
    const current=signingSession(),account=current?.accounts.find(a=>a.address===intent.sourceWallet);
    const feature=current?.wallet.features['solana:signTransaction'] as import('@solana/wallet-standard-features').SolanaSignTransactionFeature['solana:signTransaction']|undefined;
    if(!current||current.address!==intent.sourceWallet||!account||bs58.encode(new Uint8Array(account.publicKey))!==intent.sourceWallet||!account.features.includes('solana:signTransaction')||feature?.version!=='1.0.0'||!feature.supportedTransactionVersions.includes(0))throw Error('Connect the funding wallet shown in this purchase.');
    const {verifyCashDepositReview,inspectCashDepositMessage,cashDepositLayout}=await import('./cash-deposit-signing');
    const {fromBase64,toBase64}=await import('./transaction-review');
    verifyCashDepositReview(review,intent);
    if(signingSession()!==current)throw Error('Wallet changed.');
    const results=await feature.signTransaction({account,transaction:fromBase64(review.unsigned),chain:'solana:mainnet',options:{preflightCommitment:'finalized'}});
    if(signingSession()!==current||results.length!==1)throw Error('Wallet changed during signing.');
    const {VersionedTransaction}=await import('@solana/web3.js');const signed=VersionedTransaction.deserialize(results[0].signedTransaction);
    try{inspectCashDepositMessage(review,signed);}catch(error){
      try{sessionStorage.setItem('fub.cash-deposit-layout.v1',JSON.stringify({checkedAt:Date.now(),...cashDepositLayout(review,signed)}));}catch{/* Diagnostics must never affect validation. */}
      throw error;
    }
    try{sessionStorage.removeItem('fub.cash-deposit-layout.v1');}catch{/* Optional local diagnostic. */}
    return toBase64(results[0].signedTransaction);
  }
  async function signLaunchTransaction(transaction:string,plan:import('../server/launch-execution-model').LaunchExecutionPlan,intent:import('./launch-signing').LaunchSigningIntent) {
    const current=signingSession(true),account=current?.accounts.find(a=>a.address===intent.publication.owner);
    const feature=current?.wallet.features['solana:signTransaction'] as import('@solana/wallet-standard-features').SolanaSignTransactionFeature['solana:signTransaction']|undefined;
    if(!current||current.address!==intent.publication.owner||!account||bs58.encode(new Uint8Array(account.publicKey))!==intent.publication.owner||!account.features.includes('solana:signTransaction')||feature?.version!=='1.0.0'||!feature.supportedTransactionVersions.includes(0))throw Error('Connect a wallet that supports Solana versioned transaction signing.');
    const {verifyMintSignedLaunch,verifySignedLaunch}=await import('./launch-signing');
    const {fromBase64,toBase64}=await import('./transaction-review');
    await verifyMintSignedLaunch(plan,intent,transaction);
    if(signingSession(true)!==current)throw Error('Wallet changed before signing.');
    const results=await feature.signTransaction({account,transaction:fromBase64(transaction),chain:'solana:mainnet',options:{preflightCommitment:'confirmed'}});
    if(signingSession(true)!==current||results.length!==1||!results[0])throw Error('Wallet changed while signing. No submission was made.');
    const signed=toBase64(results[0].signedTransaction);
    await verifySignedLaunch(plan,intent,signed);
    if(signingSession(true)!==current)throw Error('Wallet changed. No submission was made.');
    return signed;
  }
  async function signPairTable(plan:import('./pump-pair-table').PumpPairTablePlan,quoteMint:string,rentLamports:number){
    const current=signingSession(true),account=current?.accounts.find(a=>a.address===plan.owner);
    const feature=current?.wallet.features['solana:signTransaction'] as import('@solana/wallet-standard-features').SolanaSignTransactionFeature['solana:signTransaction']|undefined;
    if(!current||current.address!==plan.owner||!account||bs58.encode(new Uint8Array(account.publicKey))!==plan.owner||!account.features.includes('solana:signTransaction')||feature?.version!=='1.0.0'||!feature.supportedTransactionVersions.includes(0))throw Error('Connect the wallet that started this launch.');
    const {inspectPairTable,verifySignedPairTable}=await import('./pump-pair-table'),{fromBase64,toBase64}=await import('./transaction-review');
    inspectPairTable(plan,current.address,quoteMint,rentLamports);
    if(signingSession(true)!==current)throw Error('Wallet changed before signing.');
    const results=await feature.signTransaction({account,transaction:fromBase64(plan.unsigned),chain:'solana:mainnet',options:{preflightCommitment:'confirmed'}});
    if(signingSession(true)!==current||results.length!==1||!results[0])throw Error('Wallet changed. No setup submission was made.');
    const signed=toBase64(results[0].signedTransaction);await verifySignedPairTable(plan,current.address,quoteMint,rentLamports,signed);
    return signed;
  }
  async function signBuybackSetup(plan: import('./buyback-setup').BuybackSetupReview) {
    const { BUYBACK_SETUP, inspectBuybackSetup, verifySignedBuybackSetup } = await import('./buyback-setup');
    const { fromBase64, toBase64 } = await import('./transaction-review');
    const current = signingSession(), account = current?.accounts.find(a => a.address === BUYBACK_SETUP.owner);
    const feature = current?.wallet.features['solana:signTransaction'] as import('@solana/wallet-standard-features').SolanaSignTransactionFeature['solana:signTransaction'] | undefined;
    if (!current || current.address !== BUYBACK_SETUP.owner || !account || bs58.encode(new Uint8Array(account.publicKey)) !== BUYBACK_SETUP.owner || !account.features.includes('solana:signTransaction') || feature?.version !== '1.0.0' || !feature.supportedTransactionVersions.includes(0)) throw Error('Connect the approved the approved test wallet wallet.');
    inspectBuybackSetup(plan);
    if (Date.now() - plan.preparedAt > 60000 || plan.preparedAt > Date.now() + 5000) throw Error('Refresh the setup review before signing.');
    const results = await feature.signTransaction({ account, transaction: fromBase64(plan.unsigned), chain: 'solana:mainnet', options: { preflightCommitment: 'confirmed' } });
    if (signingSession() !== current || results.length !== 1 || !results[0]) throw Error('Wallet changed. Nothing was submitted.');
    const signed = toBase64(results[0].signedTransaction);
    await verifySignedBuybackSetup(plan, signed);
    if (signingSession() !== current) throw Error('Wallet changed. Nothing was submitted.');
    return signed;
  }
  async function signGraduatedSetup(plan: import('./graduated-setup').GraduatedSetupReview) {
    const { GRADUATED_SETUP, inspectGraduatedSetup, verifySignedGraduatedSetup } = await import('./graduated-setup');
    const { fromBase64, toBase64 } = await import('./transaction-review');
    const current = signingSession(), account = current?.accounts.find(a => a.address === GRADUATED_SETUP.owner);
    const feature = current?.wallet.features['solana:signTransaction'] as import('@solana/wallet-standard-features').SolanaSignTransactionFeature['solana:signTransaction'] | undefined;
    if (!current || current.address !== GRADUATED_SETUP.owner || !account || bs58.encode(new Uint8Array(account.publicKey)) !== GRADUATED_SETUP.owner || !account.features.includes('solana:signTransaction') || feature?.version !== '1.0.0' || !feature.supportedTransactionVersions.includes(0)) throw Error('Connect the approved the approved test wallet wallet.');
    inspectGraduatedSetup(plan);
    if (Date.now() - plan.preparedAt > 60000 || plan.preparedAt > Date.now() + 5000) throw Error('Refresh the setup review before signing.');
    const results = await feature.signTransaction({ account, transaction: fromBase64(plan.unsigned), chain: 'solana:mainnet', options: { preflightCommitment: 'confirmed' } });
    if (signingSession() !== current || results.length !== 1 || !results[0]) throw Error('Wallet changed. Nothing was submitted.');
    const signed = toBase64(results[0].signedTransaction);
    await verifySignedGraduatedSetup(plan, signed);
    if (signingSession() !== current) throw Error('Wallet changed. Nothing was submitted.');
    return signed;
  }
  async function signPayTransfer(review: import('./pay-transfer-model').PayTransferReview, terms: import('./pay-verification').TransferTerms) {
    const current=signingSession(), account=current?.accounts.find(a=>a.address===review.sender);
    const feature=current?.wallet.features['solana:signTransaction'] as import('@solana/wallet-standard-features').SolanaSignTransactionFeature['solana:signTransaction']|undefined;
    if(!current||current.address!==review.sender||!account||bs58.encode(new Uint8Array(account.publicKey))!==review.sender||!account.features.includes('solana:signTransaction')||feature?.version!=='1.0.0'||!feature.supportedTransactionVersions.includes(0))throw Error('Connect a wallet that supports Solana transaction signing.');
    const {inspectPayTransfer}=await import('./pay-transfer-model');const {fromBase64,toBase64}=await import('./transaction-review');
    await inspectPayTransfer(review,current.address,terms);
    if(signingSession()!==current)throw Error('Wallet changed before signing.');
    const results=await feature.signTransaction({account,transaction:fromBase64(review.unsigned),chain:'solana:mainnet',options:{preflightCommitment:'confirmed'}});
    if(signingSession()!==current||results.length!==1)throw Error('Wallet changed while signing. No payment was submitted.');
    const signed=toBase64(results[0].signedTransaction);await inspectPayTransfer(review,current.address,terms,signed,false);
    if(signingSession()!==current)throw Error('Wallet changed. No payment was submitted.');return signed;
  }
  async function signFundingTransaction(
    transaction: string,
    review: import("./funding-model").TransferReview,
  ) {
    const current = signingSession(),
      account = current?.accounts.find(
        (item) => item.address === review.wallet,
      );
    const feature = current?.wallet.features["solana:signTransaction"] as
      | import("@solana/wallet-standard-features").SolanaSignTransactionFeature["solana:signTransaction"]
      | undefined;
    if (
      !current ||
      current.address !== review.wallet ||
      !account ||
      bs58.encode(new Uint8Array(account.publicKey)) !== review.wallet ||
      !account.features.includes("solana:signTransaction") ||
      !feature ||
      feature.version !== "1.0.0"
    )
      throw new Error(
        "This wallet does not support transaction signing for this account.",
      );
    const { inspectTransfer, verifySignedTransfer, fromBase64, toBase64 } =
      await import("./transaction-review");
    const checked = await inspectTransfer(transaction, review);
    if (
      signingSession() !== current ||
      !feature.supportedTransactionVersions.includes(checked.message.version)
    )
      throw new Error(
        "The wallet account or supported transaction version changed.",
      );
    const [result] = await feature.signTransaction({
      account,
      transaction: fromBase64(transaction),
      chain: "solana:mainnet",
      options: { preflightCommitment: "confirmed" },
    });
    if (signingSession() !== current || !result)
      throw new Error("Wallet changed while signing. No submission was made.");
    const signed = toBase64(result.signedTransaction);
    await verifySignedTransfer(transaction, signed, review);
    if (signingSession() !== current)
      throw new Error("Wallet changed. No submission was made.");
    return signed;
  }
  return {
    wallets,
    session,
    pending,
    error,
    connect,
    disconnect,
    select,
    cancel,
    signTriggerChallenge,
    signFundingTransaction,
    signPayTransfer,
    signBuybackSetup,
    signPairTable,
    signGraduatedSetup,
    signLaunchAuthorization,
    signLaunchRecovery,
    signPayHistory,
    signEnrollment,
    signDirectExit,
    signNativeCopy,
    signWalletSession,
    signCashWallet,
    signCashCopy,
    signCashDeposit,
    signProviderWallet,
    signLaunchExecution,
    signLaunchTransaction,
  };
}
export type WalletConnection = ReturnType<typeof useWallet>;
