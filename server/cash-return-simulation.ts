import {verifyLeaderZeroRegistry} from './cash-leader-zero-sale.js';
import {narrowMonadGas} from './cash-monad-gas.js';
import {verifyCashSourcePool} from './cash-source-pool.js';
import {cashReturnNetwork,ZEROX_ALLOWANCE_HOLDER,ZEROX_DEPLOYER,FYND_ROUTER,FYND_CODE_HASH} from './cash-return-networks.js';
import { decodeEventLog, encodeFunctionData, keccak256, parseAbi } from 'viem';
import type { Rpc } from './funding.js';
import { inspectCashReturn, type CashReturnIntent } from './cash-return-route.js';

const erc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);
export const returnDepositEvent = parseAbi([
  'event RelayErc20Deposit(address from,address token,uint256 amount,bytes32 id)',
]);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const hex = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(v);
const hash = (v: unknown): v is `0x${string}` => hex(v) && v.length === 66;
const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) || v.length > 66)
    throw Error('Invalid cash sale chain response.');
  return BigInt(v);
};
const word = (v: unknown) => {
  if (!hash(v)) throw Error('Cash sale balance could not be verified.');
  return BigInt(v);
};

/** Read-only sequential simulation. No state overrides, synthetic funding,
 * private keys, transaction signatures, or broadcasts. This proves source
 * effects at a block, not delivery on Solana or authorization to execute. */
export async function simulateCashReturn(quote: unknown, intent: CashReturnIntent, rpc: Rpc, now = Date.now(), gasLimits?: readonly string[]) {
  const route = inspectCashReturn(quote, intent, now), cfg = cashReturnNetwork(intent.network);
  const direct=route.adapter==='direct';
  const block: any = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block || !hash(block.hash) || quantity(block.number) <= 0n ||
    quantity(block.timestamp) * 1000n < BigInt(now - 30000) ||
    quantity(block.timestamp) * 1000n > BigInt(now + 10000)) throw Error('Refresh the cash sale block.');
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(cfg.chainId)) throw Error('Wrong cash sale network.');
  const blockTag = block.number;
  // This adapter supports EOAs. Contract wallets need their account-specific
  // execution simulation and must not be impersonated as an EOA here.
  if (await rpc('eth_getCode', [intent.wallet, blockTag]) !== '0x') throw Error('This cash sale requires the contract-wallet adapter.');
  if(route.sourcePool)await verifyCashSourcePool(intent.network,route.sourcePool,intent.token,blockTag,rpc);
  const contracts = [...new Set([...(route.sourcePool?[route.sourcePool]:[]),intent.token,cfg.usdc,cfg.depository,...(direct?[]:[cfg.proxy,cfg.router,...(route.adapter==='0x'?[ZEROX_ALLOWANCE_HOLDER,ZEROX_DEPLOYER,route.settler!]:route.adapter==='fynd-hosted'?[FYND_ROUTER]:[cfg.kyber,cfg.executor])])])];
  if(route.adapter==='0x'){
    await verifyLeaderZeroRegistry(route.settler!,blockTag,rpc);
  }
  const codeHashes: Record<string, string> = {};
  await Promise.all(contracts.map(async address => {
    const code = await rpc('eth_getCode', [address, blockTag]);
    if (!hex(code) || code.length < 4) throw Error('Cash sale contract is unavailable.');
    codeHashes[address.toLowerCase()] = keccak256(code);
  }));
  if(route.adapter==='fynd-hosted'&&codeHashes[FYND_ROUTER]!==FYND_CODE_HASH)throw Error('Cash sale Tycho deployment changed.');
  const read = (to: string, data: `0x${string}`) => ({ from: intent.wallet, to, data, value: '0x0', gas: '0x186a0' });
  const balance = (token: string, owner: string) => read(token, encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [owner as `0x${string}`] }));
  const allowance = read(intent.token, encodeFunctionData({ abi: erc20, functionName: 'allowance', args: [intent.wallet as `0x${string}`, (direct?cfg.depository:cfg.proxy) as `0x${string}`] }));
  const checks = [balance(intent.token, intent.wallet), balance(cfg.usdc, intent.wallet), balance(cfg.usdc, cfg.depository), allowance];
  const transactions = [...(route.approval ? [route.approval] : []), route.sale];
  if (gasLimits && (gasLimits.length !== transactions.length || gasLimits.some(gas => !/^[1-9]\d{0,6}$/.test(gas) || BigInt(gas) > 2700000n)))
    throw Error('Invalid saved sale gas limits.');
  const calls = [...checks, ...transactions.map((tx, index) => ({ from: tx.from, to: tx.to, data: tx.data, value: '0x0', gas: gasLimits ? '0x' + BigInt(gasLimits[index]).toString(16) : '0x1e8480' })), ...checks];
  const narrowed=intent.network==='monad'&&!gasLimits?await narrowMonadGas(rpc,calls,blockTag,4,transactions.length):null;
  const result: any = narrowed?.result||await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: intent.network==='monad', traceTransfers: false }, blockTag]);
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]?.calls) || result[0].calls.length !== calls.length ||
    quantity(result[0].number) !== quantity(blockTag) + 1n) throw Error('Incomplete cash sale simulation.');
  const outputs = result[0].calls;
  for (const output of outputs.slice(0, 4)) {
    if (output.status !== '0x1' || output.error) throw Error('Cash sale balance could not be verified.');
  }
  const before: bigint[] = outputs.slice(0, 4).map((v: any) => word(v.returnData));
  const spend = BigInt(intent.amountRaw);
  if (before[0] < spend) throw Error('The wallet does not hold enough of this token to sell.');
  for (const output of outputs) {
    if (output.status !== '0x1' || output.error || !hex(output.returnData) || !Array.isArray(output.logs))
      throw Error('Cash sale simulation failed.');
    if (quantity(output.gasUsed) > 2000000n) throw Error('Cash sale simulation exceeds the gas limit.');
  }
  if (gasLimits && gasLimits.some((limit, index) => quantity(outputs[4 + index].gasUsed) > BigInt(limit)))
    throw Error('Cash sale simulation exceeds the saved gas limit.');
  const after: bigint[] = outputs.slice(-4).map((v: any) => word(v.returnData));
  if (before[0] - after[0] !== spend || (direct?before[1]-after[1]!==spend:before[1]!==after[1]))
    throw Error('Cash sale source debit changed.');
  // Do not leave an existing broader allowance behind. A quote without an
  // approval is accepted only when the existing allowance is already exact.
  if ((!route.approval && before[3] !== spend) || after[3] !== 0n)
    throw Error('Cash sale would leave an unexpected allowance.');
  const approvalOutput = route.approval ? outputs[4] : null;
  if (approvalOutput && approvalOutput.returnData !== '0x' && word(approvalOutput.returnData) !== 1n)
    throw Error('Cash sale approval was not accepted.');
  const sale = outputs[3 + transactions.length];
  const deposits: { from: string; token: string; amount: bigint; id: string }[] = [];
  for (const log of sale.logs) {
    if (!same(log.address, cfg.depository)) continue;
    if (log.removed === true) throw Error('Cash sale deposit log was removed.');
    try {
      const decoded = decodeEventLog({ abi: returnDepositEvent, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === 'RelayErc20Deposit') deposits.push(decoded.args);
    } catch { throw Error('Unexpected cash sale deposit log.'); }
  }
  const deposit = deposits[0];
  const bridgeMinimum = BigInt((quote as any).details.route.origin.outputCurrency.minimumAmount);
  if (deposits.length !== 1 || !same(deposit.from, intent.wallet) || !same(deposit.token, cfg.usdc) ||
    !same(deposit.id, route.orderId) || deposit.amount < bridgeMinimum || after[2] - before[2] !== deposit.amount)
    throw Error('Cash sale deposit does not match the order.');
  const canonical: any = await rpc('eth_getBlockByNumber', [blockTag, false]);
  if (!canonical || !same(canonical.hash, block.hash)) throw Error('Cash sale block changed. Simulate again.');
  return {
    executable: false as const, simulated: true as const, route, blockNumber: blockTag,
    blockHash: block.hash as string, codeHashes, sourceDebitRaw: spend.toString(),
    depositedUsdcRaw: deposit.amount.toString(),
    approvalGasUsed: approvalOutput ? quantity(approvalOutput.gasUsed).toString() : '0',
    saleGasUsed: quantity(sale.gasUsed).toString(),
    ...(intent.network==='monad'?{verifiedGasLimits:narrowed?.limits||[...gasLimits!]}:{}),
    checkedAt: now, expiresAt: now + 30000,
  };
}
