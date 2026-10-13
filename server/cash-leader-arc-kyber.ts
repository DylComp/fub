import {decodeEventLog,encodeAbiParameters,keccak256,parseAbiParameters,toEventSelector} from 'viem';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';
import {cashReturnAbi} from './cash-return-route.js';
import {cashReturnNetwork} from './cash-return-networks.js';
import {cashZeroMonadAbi} from './cash-leader-zero-monad-sale.js';
import {ARC_RECEIPT,arcDecode,arcLogs,arcPins,arcPoolId,arcSame,arcTransfers,cashArcAbi} from './cash-leader-arc-receipt.js';

const zero='0x0000000000000000000000000000000000000000';
const pins={
 '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f':'0xde894e5c12e9513d50613c8fff375ecbf19b5d9a53bec0662e2b9667e3ec8f15',
 '0x6131b5fae19ea4f9d964eac0408e4408b66337b5':'0xcfc4b72d96b3a4da0e5bd31270b05a8958367adc456845ebd74e5c15f4807399',
 '0x8f10b468b06c6fd214b65f87778827f7d113f996':'0x738f9b12983256e24b7ec81a7bf5a3f4fd1328a926beef4aa6a6a0d56d09e307',
 '0x8366a39cc670b4001a1121b8f6a443a643e40951':'0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
};

/** Destination evidence only. The caller verifies the outer scope/cleanup;
 * source ownership still requires the exact signed Solana deposit and status
 * binding. A solver address (which can rotate) is never ownership evidence. */
export async function readArcKyberFill(b:CashLeaderBalance,rpc:Rpc,swap:{target:string;value:bigint;callData:string},metadata:string){
 const a=ARC_RECEIPT,cfg=cashReturnNetwork(b.network),[s]=arcDecode(cashReturnAbi.kyber,swap.callData),d=s.desc,output=BigInt(b.deltaRaw);
 if(b.network!=='arc'||!arcSame(swap.target,cfg.kyber)||!arcSame(s.callTarget,cfg.executor)||!arcSame(s.approveTarget,zero)||!arcSame(d.srcToken,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')||!arcSame(d.dstToken,b.token)||!arcSame(d.dstReceiver,a.router)||d.amount!==swap.value||d.amount<=0n||d.srcReceivers.length||d.srcAmounts.length||d.feeReceivers.length||d.feeAmounts.length||d.permit!=='0x'||![0n,512n].includes(d.flags)||d.minReturnAmount<=0n||d.minReturnAmount>output)throw Error('Arc native Kyber scope differs.');
 const [tx]:any[]=await Promise.all([rpc('eth_getTransactionByHash',[b.transaction]),arcPins(rpc,b,pins)]);
 if(!tx||!arcSame(tx.hash,b.transaction)||!arcSame(tx.blockHash,b.blockHash)||tx.blockNumber!==b.blockNumber||tx.transactionIndex!==b.transactionIndex||!arcSame(tx.from,b.sender)||!arcSame(tx.to,b.target)||!arcSame(tx.input,b.input)||typeof tx.value!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(tx.value)||BigInt(tx.value)!==swap.value)throw Error('Arc native Kyber funding differs.');
 const logs=arcLogs(b),swaps=logs.filter((l:any)=>arcSame(l.address,a.manager)&&arcSame(l.topics?.[0],toEventSelector(cashZeroMonadAbi.v4Swap[0]))).map((l:any)=>(decodeEventLog({abi:cashZeroMonadAbi.v4Swap,data:l.data,topics:l.topics,strict:true}) as any).args);
 const stablePool=keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),[a.middle as `0x${string}`,cfg.usdc as `0x${string}`,1500,15,zero]));
 if(swaps.length!==2)throw Error('Arc native Kyber pools differ.');
 const [first,last]=swaps,middle=BigInt(first.amount0),input=-BigInt(first.amount1);
 if(!arcSame(first.id,stablePool)||!arcSame(last.id,arcPoolId(b.token))||swaps.some((v:any)=>!arcSame(v.sender,cfg.executor))||input<=0n||middle<=0n||input*1000000000000n!==swap.value||last.amount0!==-middle||last.amount1!==output||first.fee<1500||first.fee>2098||last.fee<2500||last.fee>3498)throw Error('Arc native Kyber settlement differs.');
 arcTransfers(logs,[
  [a.native,b.sender,a.router,swap.value],[a.native,a.router,cfg.kyber,swap.value],
  [a.native,cfg.kyber,cfg.executor,swap.value],[a.native,cfg.executor,a.manager,swap.value],
  [cfg.usdc,cfg.executor,a.manager,input],[a.middle,a.manager,cfg.executor,middle],
  [a.middle,cfg.executor,a.manager,middle],[b.token,a.manager,cfg.executor,output],
  [b.token,cfg.executor,a.router,output],[b.token,a.router,b.leader,output],
 ]);
 const movements=logs.filter((l:any)=>arcSame(l.address,a.router)&&arcSame(l.topics?.[0],toEventSelector(cashArcAbi.movement[0]))).map((l:any)=>(decodeEventLog({abi:cashArcAbi.movement,data:l.data,topics:l.topics,strict:true}) as any).args);
 if(movements.length!==2||!arcSame(movements[0].from,b.sender)||!arcSame(movements[0].to,a.router)||!arcSame(movements[0].currency,zero)||movements[0].amount!==swap.value||!arcSame(movements[1].from,a.router)||!arcSame(movements[1].to,b.leader)||!arcSame(movements[1].currency,b.token)||movements[1].amount!==output||movements.some((m:any)=>!arcSame(m.metadata,metadata)))throw Error('Arc native Kyber request differs.');
 return{swapVerified:true as const,tradeVerified:false as const,sourceAssociation:'unverified' as const,adapter:'arc-native-kyber' as const,network:b.network,recipient:b.leader,token:b.token,transaction:b.transaction,blockHash:b.blockHash,inputRaw:swap.value.toString(),inputDecimals:18,inputCurrency:zero,roundingDustRaw:'0',outputRaw:b.deltaRaw,minimumRaw:d.minReturnAmount.toString(),minimumEvidence:'decoded' as const,orderIdHint:'0x'+b.input.slice(-64),requestId:'0x'+metadata.slice(2,-2).toLowerCase().split('').reverse().join('')};
}
