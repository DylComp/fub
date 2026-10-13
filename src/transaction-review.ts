import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import bs58 from "bs58";
import { resolveMessageAccounts } from "./lookup-tables.js";
import { isMint } from "./assets.js";
import { TOKEN_PROGRAM } from "./funding-model.js";
import type { TransferReview } from "./funding-model.js";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111",
  COMPUTE = "ComputeBudget111111111111111111111111111111";
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid transaction encoding.");
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length < 100 || bytes.length > 1232)
    throw new Error("Unsupported transaction size.");
  return bytes;
}
export const toBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));
export async function associated(
  owner: string,
  mint: string,
  program = TOKEN_PROGRAM,
): Promise<string> {
  if (
    ![TOKEN_PROGRAM, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(
      program,
    )
  )
    throw new Error("Unsupported associated token program.");
  const encoder = getAddressEncoder();
  return (
    await getProgramDerivedAddress({
      programAddress: address(ATA_PROGRAM),
      seeds: [
        encoder.encode(address(owner)),
        encoder.encode(address(program)),
        encoder.encode(address(mint)),
      ],
    })
  )[0];
}
// Standard SPL transfers and the observed Jupiter seeded-vault deposit layout.
// Lookup addresses must match the persisted review. Native wrapping, approvals and closes remain blocked.
export async function inspectTransfer(encoded: string, review: TransferReview) {
  const bytes = fromBase64(encoded),
    tx = getTransactionDecoder().decode(bytes);
  if (toBase64(new Uint8Array(getTransactionEncoder().encode(tx))) !== encoded)
    throw new Error("Non-canonical transaction.");
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version === 1)
    throw new Error("Unsupported transaction version.");
  const { keys } = resolveMessageAccounts(message, review.lookupTables);
  if (review.depositAccount)
    return inspectVaultDeposit(tx, message, review, keys);
  if (keys[0] !== review.wallet) throw new Error("Unexpected fee payer.");
  const signers = Object.keys(tx.signatures);
  if (
    !signers.includes(review.wallet) ||
    signers.some(
      (key) =>
        key !== review.wallet &&
        !(review.direction === "withdrawal" && key === review.vault),
    )
  )
    throw new Error("Unexpected transaction signer.");
  const sourceOwner =
    review.direction === "deposit" ? review.wallet : review.vault;
  const destinationOwner =
    review.direction === "deposit" ? review.vault : review.wallet;
  const [source, destination] = await Promise.all([
    associated(sourceOwner, review.mint),
    associated(destinationOwner, review.mint),
  ]);
  let transferred = 0n,
    rent = 0n,
    units = 200000n,
    priority = 0n;
  const seen = new Set<string>();
  for (const instruction of message.instructions) {
    const program = keys[instruction.programAddressIndex],
      accounts = (instruction.accountIndices || []).map((index) => keys[index]);
    const data = new Uint8Array(instruction.data || []),
      view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (program === COMPUTE) {
      if (accounts.length || seen.has(`compute-${data[0]}`))
        throw new Error("Invalid fee instructions.");
      seen.add(`compute-${data[0]}`);
      if (data[0] === 2 && data.length === 5)
        units = BigInt(view.getUint32(1, true));
      else if (data[0] === 3 && data.length === 9)
        priority = view.getBigUint64(1, true);
      else throw new Error("Unsupported compute instruction.");
    } else if (program === ATA_PROGRAM) {
      if (
        seen.has("ata") ||
        !(data.length === 0 || (data.length === 1 && data[0] === 1)) ||
        accounts.length !== 6 ||
        accounts.join("|") !==
          [
            review.wallet,
            destination,
            destinationOwner,
            review.mint,
            SYSTEM,
            TOKEN_PROGRAM,
          ].join("|")
      )
        throw new Error("Unexpected token account creation.");
      seen.add("ata");
      const quotedRent = BigInt(review.tokenAccountRentLamports || "2039280");
      if (quotedRent <= 0n || quotedRent > 2500000n)
        throw new Error("Unsupported token account rent.");
      rent += quotedRent;
    } else if (program === TOKEN_PROGRAM) {
      if (seen.has("transfer"))
        throw new Error("Multiple transfers are not supported.");
      seen.add("transfer");
      const checked = data[0] === 12 && data.length === 10;
      const plain = data[0] === 3 && data.length === 9;
      if (
        !(checked || plain) ||
        accounts.join("|") !==
          (checked
            ? [source, review.mint, destination, sourceOwner]
            : [source, destination, sourceOwner]
          ).join("|") ||
        (checked && data[9] !== review.decimals)
      )
        throw new Error("The token transfer does not match your review.");
      transferred = view.getBigUint64(1, true);
    } else if (program === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") {
      if (
        data.length > 256 ||
        accounts.some((account) => !signers.includes(account))
      )
        throw new Error("Unexpected memo instruction.");
    } else
      throw new Error(
        "Unrecognized transaction instructions. No signature was requested.",
      );
  }
  if (transferred !== BigInt(review.amount) || transferred <= 0n)
    throw new Error("The transfer amount does not match your review.");
  if (
    units < 1n ||
    units > 1400000n ||
    (units * priority + 999999n) / 1000000n > 5000000n
  )
    throw new Error("Priority fee exceeds the supported limit.");
  if (
    !/^\d+$/.test(review.feeLamports) ||
    !/^\d+$/.test(review.rentLamports) ||
    BigInt(review.feeLamports) > 5000000n ||
    BigInt(review.feeLamports) <
      BigInt(signers.length) * 5000n +
        (units * priority + 999999n) / 1000000n ||
    (priority > 0n && !seen.has("compute-2")) ||
    BigInt(review.rentLamports) !== rent
  )
    throw new Error("Transaction costs do not match the review.");
  return { tx, message, source, destination, rent: rent.toString() };
}
export async function verifySignedTransfer(
  unsigned: string,
  signed: string,
  review: TransferReview,
): Promise<string> {
  const original = await inspectTransfer(unsigned, review),
    checked = await inspectTransfer(signed, review);
  if (
    original.tx.messageBytes.length !== checked.tx.messageBytes.length ||
    !original.tx.messageBytes.every(
      (byte, index) => checked.tx.messageBytes[index] === byte,
    )
  )
    throw new Error(
      "The wallet changed the transaction. Nothing was submitted.",
    );
  const signature = checked.tx.signatures[address(review.wallet)];
  if (!signature) throw new Error("Missing wallet signature.");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bs58.decode(review.wallet)),
    "Ed25519",
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature),
      Uint8Array.from(checked.tx.messageBytes),
    ))
  )
    throw new Error("Invalid wallet signature.");
  for (const [signer, existing] of Object.entries(original.tx.signatures)) {
    if (signer === review.wallet || !existing) continue;
    if (
      !existing.every(
        (byte, index) =>
          checked.tx.signatures[address(signer)]?.[index] === byte,
      )
    )
      throw new Error("A provider signature changed.");
  }
  // Fee payer is the wallet, so its signature is the on-chain transaction ID.
  return bs58.encode(Uint8Array.from(signature));
}

// Observed in an unsigned Trigger V2 deposit on 2026-09-21.
// A provider signer rotation must be reviewed; never accept arbitrary extra signers.
export const JUPITER_TRANSFER_COSIGNER =
  "trfb53BmkHNeoqaa3REgqnrbwUZqAFYdjTkivkJ6aWg";
type DecodedTx = ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
type DecodedMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]
>;
async function inspectVaultDeposit(
  tx: DecodedTx,
  message: DecodedMessage,
  review: TransferReview,
  keys: string[],
) {
  if (message.version === 1)
    throw new Error("Unsupported Jupiter transaction version.");
  if (
    review.direction !== "deposit" ||
    !review.depositAccount ||
    !isMint(review.depositAccount) ||
    !review.outputMint ||
    !isMint(review.outputMint) ||
    review.outputMint === review.mint
  )
    throw new Error("Invalid Jupiter deposit review.");
  const signers = Object.keys(tx.signatures);
  if (
    keys[0] !== review.wallet ||
    signers.join("|") !==
      [review.wallet, review.vault, JUPITER_TRANSFER_COSIGNER].join("|") ||
    message.header.numSignerAccounts !== 3 ||
    message.header.numReadonlySignerAccounts !== 2
  )
    throw new Error("Unexpected Jupiter deposit signers.");
  const rentEach = BigInt(review.tokenAccountRentLamports || "0");
  if (rentEach <= 0n || rentEach > 2500000n)
    throw new Error("Unsupported token account rent.");
  const source = await associated(review.wallet, review.mint);
  const outputs = new Map(
    await Promise.all(
      [review.wallet, review.vault].map(
        async (owner) =>
          [await associated(owner, review.outputMint!), owner] as const,
      ),
    ),
  );
  const seen = new Set<string>();
  let rent = 0n,
    units = 0n,
    priority = 0n;
  let step = 0;
  for (const instruction of message.instructions) {
    const program = keys[instruction.programAddressIndex];
    const accounts = (instruction.accountIndices || []).map(
      (index) => keys[index],
    );
    const data = new Uint8Array(instruction.data || []);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (program === COMPUTE) {
      if (step || accounts.length || seen.has(`compute-${data[0]}`))
        throw new Error("Invalid compute instructions.");
      seen.add(`compute-${data[0]}`);
      if (data[0] === 2 && data.length === 5)
        units = BigInt(view.getUint32(1, true));
      else if (data[0] === 3 && data.length === 9)
        priority = view.getBigUint64(1, true);
      else throw new Error("Unsupported compute instruction.");
    } else if (program === ATA_PROGRAM) {
      const owner = outputs.get(accounts[1]);
      if (
        step ||
        !owner ||
        seen.has(accounts[1]) ||
        data.length !== 1 ||
        data[0] !== 1 ||
        accounts.join("|") !==
          [
            review.wallet,
            accounts[1],
            owner,
            review.outputMint,
            SYSTEM,
            TOKEN_PROGRAM,
          ].join("|")
      )
        throw new Error("Unexpected output token account creation.");
      seen.add(accounts[1]);
      rent += rentEach;
    } else if (program === SYSTEM) {
      // System CreateAccountWithSeed: opcode, base, u64 seed length, seed,
      // lamports, account size, owner program. No transfers or other allocations.
      if (
        step ||
        data.length < 92 ||
        view.getUint32(0, true) !== 3 ||
        accounts.join("|") !==
          [review.wallet, review.depositAccount, review.vault].join("|")
      )
        throw new Error("Unexpected seeded account creation.");
      const length = view.getBigUint64(36, true);
      if (length !== 32n || data.length !== 124)
        throw new Error("Unsupported deposit seed.");
      const base = bs58.encode(data.slice(4, 36));
      const seed = data.slice(44, 76);
      const owner = bs58.encode(data.slice(92, 124));
      if (
        base !== review.vault ||
        owner !== TOKEN_PROGRAM ||
        !/^[0-9a-f]{32}$/.test(new TextDecoder().decode(seed)) ||
        view.getBigUint64(76, true) !== rentEach ||
        view.getBigUint64(84, true) !== 165n
      )
        throw new Error(
          "The deposit account ownership or rent does not match.",
        );
      const derivation = Uint8Array.from([
        ...bs58.decode(base),
        ...seed,
        ...bs58.decode(owner),
      ]);
      const derived = bs58.encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", derivation)),
      );
      if (derived !== review.depositAccount)
        throw new Error("Deposit account seed does not match its address.");
      rent += rentEach;
      step = 1;
    } else if (program === TOKEN_PROGRAM && data[0] === 18) {
      // InitializeAccount3 binds the new standard SPL account to this vault.
      if (
        step !== 1 ||
        data.length !== 33 ||
        bs58.encode(data.slice(1)) !== review.vault ||
        accounts.join("|") !== [review.depositAccount, review.mint].join("|")
      )
        throw new Error("Unexpected deposit account initialization.");
      step = 2;
    } else if (program === TOKEN_PROGRAM && data[0] === 12) {
      if (
        step !== 2 ||
        data.length !== 10 ||
        data[9] !== review.decimals ||
        view.getBigUint64(1, true) !== BigInt(review.amount) ||
        BigInt(review.amount) <= 0n ||
        accounts.join("|") !==
          [
            source,
            review.mint,
            review.depositAccount,
            review.wallet,
            JUPITER_TRANSFER_COSIGNER,
          ].join("|")
      )
        throw new Error(
          "The Jupiter deposit transfer does not match your review.",
        );
      step = 3;
    } else throw new Error("Unrecognized Jupiter deposit instruction.");
  }
  if (step !== 3) throw new Error("Incomplete Jupiter deposit transaction.");
  const priorityFee = (units * priority + 999999n) / 1000000n;
  if (
    !seen.has("compute-2") ||
    units < 1n ||
    units > 1400000n ||
    priorityFee > 5000000n ||
    !/^\d+$/.test(review.feeLamports) ||
    !/^\d+$/.test(review.rentLamports) ||
    BigInt(review.feeLamports) < 15000n + priorityFee ||
    BigInt(review.feeLamports) > 5000000n ||
    BigInt(review.rentLamports) !== rent
  )
    throw new Error("Jupiter deposit costs do not match the review.");
  return {
    tx,
    message,
    source,
    destination: review.depositAccount,
    rent: rent.toString(),
  };
}
