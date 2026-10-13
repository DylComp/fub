// Engineering probe only. No API route, signer, sender or execution permission.
import {
  address,
  blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";
import {
  associated,
  ATA_PROGRAM,
  toBase64,
} from "../src/transaction-review.js";
import { transferAmounts, tokenUnits } from "../src/token-fees.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import { CLOCK, clockEpoch, inspectTokenFees } from "./token-fees.js";
import {
  inspectToken2022Mint,
  token2022Bytes,
  tokenExtensions,
  verifyToken2022Account,
} from "./token2022-setup.js";
import type { Rpc } from "./funding.js";
const SYSTEM = "11111111111111111111111111111111";
const invalid = (): never => {
  throw Error("Transfer-fee simulation evidence is incomplete or changed.");
};
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
export type FeeProbeRequest = {
  wallet: string;
  recipient: string;
  mint: string;
  grossRaw: string;
};
export async function simulateTokenFeeTransfer(
  request: FeeProbeRequest,
  rpc: Rpc,
) {
  const { wallet, recipient, mint } = request,
    gross = tokenUnits(request.grossRaw);
  if (
    ![wallet, recipient, mint].every(isMint) ||
    wallet === recipient ||
    gross === 0n
  )
    return invalid();
  const [source, destination] = await Promise.all([
    associated(wallet, mint, TOKEN_2022),
    associated(recipient, mint, TOKEN_2022),
  ]);
  const latest = record(
      await rpc("getLatestBlockhash", [{ commitment: "finalized" }]),
    ),
    life = record(latest.value),
    minimumSlot = record(latest.context).slot;
  if (
    !integer(minimumSlot) ||
    minimumSlot < 1 ||
    !isMint(String(life.blockhash)) ||
    !integer(life.lastValidBlockHeight)
  )
    return invalid();
  const reply = record(
    await rpc("getMultipleAccounts", [
      [mint, CLOCK, source, destination, wallet],
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot: minimumSlot,
      },
    ]),
  );
  const slot = record(reply.context).slot;
  if (
    !integer(slot) ||
    slot < minimumSlot ||
    !Array.isArray(reply.value) ||
    reply.value.length !== 5 ||
    reply.value[3] !== null
  )
    return invalid();
  const [mintAccount, clock, sourceAccount, , payer] = reply.value;
  const epoch = clockEpoch(clock, slot),
    config = inspectToken2022Mint(mintAccount, mint),
    fees = inspectTokenFees(mintAccount, mint, epoch),
    amounts = transferAmounts(request.grossRaw, fees.current);
  verifyToken2022Account(sourceAccount, wallet, mint, config);
  const sourceBytes = token2022Bytes(sourceAccount),
    sourceBalance = sourceBytes.readBigUInt64LE(64);
  if (
    sourceBalance < gross ||
    record(payer).owner !== SYSTEM ||
    record(payer).executable !== false ||
    !integer(record(payer).lamports)
  )
    return invalid();
  const data = Buffer.alloc(19); // TransferFeeExtension(26), TransferCheckedWithFee(1).
  data[0] = 26;
  data[1] = 1;
  data.writeBigUInt64LE(gross, 2);
  data[10] = fees.decimals;
  data.writeBigUInt64LE(BigInt(amounts.feeRaw), 11);
  const instructions: Instruction[] = [
    {
      programAddress: address("ComputeBudget111111111111111111111111111111"),
      data: new Uint8Array([2, 64, 13, 3, 0]),
    },
    {
      programAddress: address(ATA_PROGRAM),
      accounts: [
        { address: address(wallet), role: 3 },
        { address: address(destination), role: 1 },
        { address: address(recipient), role: 0 },
        { address: address(mint), role: 0 },
        { address: address(SYSTEM), role: 0 },
        { address: address(TOKEN_2022), role: 0 },
      ],
      data: new Uint8Array([1]),
    },
    {
      programAddress: address(TOKEN_2022),
      accounts: [
        { address: address(source), role: 1 },
        { address: address(mint), role: 0 },
        { address: address(destination), role: 1 },
        { address: address(wallet), role: 2 },
      ],
      data,
    },
  ];
  const transaction = compileTransaction(
    appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(String(life.blockhash)),
          lastValidBlockHeight: BigInt(life.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(wallet),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    ),
  );
  const unsigned = toBase64(
    new Uint8Array(getTransactionEncoder().encode(transaction)),
  );
  const rent = await rpc("getMinimumBalanceForRentExemption", [
    config.accountSize,
    { commitment: "finalized" },
  ]);
  const quoted = record(
    await rpc("getFeeForMessage", [
      toBase64(new Uint8Array(transaction.messageBytes)),
      { commitment: "finalized", minContextSlot: slot },
    ]),
  );
  const feeSlot = record(quoted.context).slot,
    networkFee = quoted.value;
  if (
    !integer(rent) ||
    rent < 1 ||
    rent > 2500000 ||
    !integer(networkFee) ||
    networkFee < 1 ||
    networkFee > 50000 ||
    !integer(feeSlot) ||
    feeSlot < slot ||
    (record(payer).lamports as number) < rent + networkFee
  )
    return invalid();
  const result = record(
    await rpc("simulateTransaction", [
      unsigned,
      {
        encoding: "base64",
        commitment: "finalized",
        sigVerify: false,
        replaceRecentBlockhash: false,
        minContextSlot: slot,
        accounts: {
          encoding: "base64",
          addresses: [source, destination, mint],
        },
      },
    ]),
  );
  const simulatedSlot = record(result.context).slot,
    sim = record(result.value);
  if (
    !integer(simulatedSlot) ||
    simulatedSlot < slot ||
    sim.err !== null ||
    sim.replacementBlockhash != null ||
    !Array.isArray(sim.accounts) ||
    sim.accounts.length !== 3
  )
    return invalid();
  // The mint is returned from the simulation bank. Do not mix a changed fee
  // schedule with earlier assumptions. The checked instruction enforces fee.
  if (inspectToken2022Mint(sim.accounts[2], mint).mintHash !== config.mintHash)
    return invalid();
  const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    ),
    keys = message.staticAccounts.map(String);
  const sourceIndex = keys.indexOf(source),
    destIndex = keys.indexOf(destination);
  if (
    keys[0] !== wallet ||
    sourceIndex < 1 ||
    destIndex < 1 ||
    !Array.isArray(sim.preBalances) ||
    !Array.isArray(sim.postBalances) ||
    sim.preBalances.length !== keys.length ||
    sim.postBalances.length !== keys.length ||
    [...sim.preBalances, ...sim.postBalances].some((n) => !integer(n)) ||
    sim.fee !== networkFee
  )
    return invalid();
  const pre = sim.preBalances as number[],
    post = sim.postBalances as number[];
  if (
    pre[destIndex] !== 0 ||
    post[destIndex] !== rent ||
    BigInt(pre[0]) - BigInt(post[0]) !== BigInt(rent + networkFee) ||
    keys.some((_, n) => n !== 0 && n !== destIndex && pre[n] !== post[n])
  )
    return invalid();
  function tokenBalance(
    value: unknown,
    index: number,
    owner: string,
    missing = false,
  ) {
    if (!Array.isArray(value)) return invalid();
    const rows = value.map(record),
      found = rows.filter((r) => r.accountIndex === index);
    if (
      new Set(rows.map((r) => r.accountIndex)).size !== rows.length ||
      rows.some(
        (r) => !integer(r.accountIndex) || r.accountIndex >= keys.length,
      )
    )
      return invalid();
    if (!found.length && missing) return 0n;
    const row = found[0],
      amount = record(row?.uiTokenAmount);
    if (
      found.length !== 1 ||
      row.owner !== owner ||
      row.mint !== mint ||
      row.programId !== TOKEN_2022 ||
      amount.decimals !== fees.decimals
    )
      return invalid();
    return tokenUnits(amount.amount);
  }
  const before = tokenBalance(sim.preTokenBalances, sourceIndex, wallet),
    after = tokenBalance(sim.postTokenBalances, sourceIndex, wallet),
    received = tokenBalance(sim.postTokenBalances, destIndex, recipient);
  if (
    tokenBalance(sim.preTokenBalances, destIndex, recipient, true) !== 0n ||
    before - after !== gross ||
    before !== sourceBalance ||
    received !== BigInt(amounts.netRaw)
  )
    return invalid();
  verifyToken2022Account(sim.accounts[0], wallet, mint, config);
  verifyToken2022Account(sim.accounts[1], recipient, mint, config);
  const sourceAfter = token2022Bytes(sim.accounts[0]),
    destinationAfter = token2022Bytes(sim.accounts[1]);
  const withheld = (b: Buffer) =>
    tokenExtensions(b, 2).get(2)?.readBigUInt64LE(0) || 0n;
  if (
    sourceAfter.readBigUInt64LE(64) !== after ||
    destinationAfter.readBigUInt64LE(64) !== received ||
    withheld(destinationAfter) !== BigInt(amounts.feeRaw) ||
    withheld(sourceAfter) !== withheld(sourceBytes) ||
    record(sim.accounts[0]).lamports !== post[sourceIndex] ||
    record(sim.accounts[1]).lamports !== rent
  )
    return invalid();
  return {
    wallet,
    recipient,
    mint,
    source,
    destination,
    slot: simulatedSlot,
    epoch,
    ...amounts,
    networkFeeLamports: String(networkFee),
    rentLamports: String(rent),
    signed: false,
    submitted: false,
  };
}
