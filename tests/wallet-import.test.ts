import { expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import { validateImportKey } from "../src/wallet-import";
function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const pub = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return { address: bs58.encode(pub), bytes: Buffer.concat([seed, pub]) };
}
it("accepts a valid generated key only when it controls the exact expected address", async () => {
  const a = fixture(), b = fixture();
  await expect(validateImportKey(bs58.encode(a.bytes), a.address)).resolves.toBe(a.address);
  await expect(validateImportKey(bs58.encode(a.bytes), b.address)).rejects.toThrow("different wallet");
});
it("does not trust the public half of a 64-byte key when the private seed is different", async () => {
  const a = fixture(), b = fixture();
  const forged = Buffer.concat([a.bytes.subarray(0, 32), b.bytes.subarray(32)]);
  await expect(validateImportKey(bs58.encode(forged), b.address)).rejects.toThrow("not a valid Solana wallet key");
});
it("rejects seed phrases, EVM keys, invalid lengths and addresses without including secrets in errors", async () => {
  const a = fixture();
  for (const secret of ["test words ".repeat(12), "0x" + "a".repeat(64), "1".repeat(88), "", bs58.encode(a.bytes.subarray(0, 32))]) {
    await expect(validateImportKey(secret, a.address)).rejects.toThrow();
  }
  await expect(validateImportKey(bs58.encode(a.bytes), "@alice")).rejects.toThrow("Choose the existing Solana wallet address");
  try { await validateImportKey(bs58.encode(a.bytes), fixture().address); } catch(error) { expect(String(error)).not.toContain(bs58.encode(a.bytes)); }
});

it('uses the import key only for exact current-origin ownership, without a browser wallet',async()=>{
 const {signImportOwnership}=await import('../src/wallet-import');const {verify,sign,createPrivateKey}=await import('node:crypto');
 const a=fixture(),secret=bs58.encode(a.bytes),origin='https://www.usefub.app';
 const message=`www.usefub.app wants you to sign in with your Solana account:\n${a.address}\n\nYou are proving you own ${a.address}.\n\nURI: ${origin}\nVersion: 1\nChain ID: mainnet\nNonce: abcdef123456\nIssued At: ${new Date().toISOString()}\nResources:\n- https://privy.io`;
 const signature=await signImportOwnership(secret,a.address,message,origin);
 expect(verify(null,Buffer.from(message),{key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),a.bytes.subarray(32)]),format:'der',type:'spki'},Buffer.from(signature,'base64'))).toBe(true);
 expect(signature).toBe(sign(null,Buffer.from(message),createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),a.bytes.subarray(0,32)]),format:"der",type:"pkcs8"})).toString("base64"));
 for(const wrong of [message.replace('https://www.usefub.app','https://evil.test'),message+'\nTransfer all funds',message.replace(a.address,fixture().address)])await expect(signImportOwnership(secret,a.address,wrong,origin)).rejects.toThrow();
});
