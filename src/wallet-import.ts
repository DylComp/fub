import bs58 from "bs58";
import { createKeyPairFromBytes, getAddressFromPublicKey } from "@solana/kit";
import { isMint } from "./assets";

// Client-only. No network, logging, storage, or key material in error messages.
export async function validateImportKey(secret: string, expected: string): Promise<string> {
  if (!isMint(expected)) throw new Error("Choose the existing Solana wallet address first.");
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(secret)) throw new Error("Enter the base58 private key for this Solana wallet. Seed phrases are not accepted.");
  let bytes: Uint8Array | undefined;
  try {
    bytes = bs58.decode(secret);
    if (bytes.length !== 64) throw new Error();
    // This verifies that the public half really corresponds to the private seed.
    const pair = await createKeyPairFromBytes(bytes);
    const actual = await getAddressFromPublicKey(pair.publicKey);
    if (actual !== expected) throw new Error("mismatch");
    return actual;
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "mismatch"
      ? "This key belongs to a different wallet. Nothing was imported."
      : "This is not a valid Solana wallet key. Nothing was imported.");
  } finally { bytes?.fill(0); }
}

// The import itself authenticates ownership without an injected browser wallet.
// Only the exact short-lived Privy SIWS challenge is signed; raw bytes are cleared.
export async function signImportOwnership(secret:string,expected:string,message:string,origin:string):Promise<string>{
 const {verifyProviderWalletMessage}=await import('./provider-wallet-auth');
 const {signBytes}=await import('@solana/kit');
 verifyProviderWalletMessage(message,expected,origin);
 await validateImportKey(secret,expected);
 let bytes:Uint8Array|undefined;
 try{bytes=bs58.decode(secret);const pair=await createKeyPairFromBytes(bytes);return btoa(String.fromCharCode(...await signBytes(pair.privateKey,new TextEncoder().encode(message))));}
 finally{bytes?.fill(0);}
}
