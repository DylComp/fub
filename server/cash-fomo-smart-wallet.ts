import {decodeEventLog,decodeFunctionData,encodeFunctionData,keccak256,parseAbi,toEventSelector} from 'viem';
import {entryPoint08Abi,entryPoint08Address} from 'viem/account-abstraction';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';

// Fomo's current client uses Simple7702Account with EntryPoint 0.8. These
// are observation anchors, never permission to delegate or sign for a user.
export const FOMO_ACCOUNT='0xe6cae83bde06e4c305530e199d7217f42808555b';
export const FOMO_ENTRYPOINT=entryPoint08Address.toLowerCase();
const ACCOUNT_HASH='0xcc7b633aef4b2543cb8f37522adf1a401f910f0f6b2430c1eecc11f401ccfcf3';
// EntryPoint contains chain-specific immutable domain data.
const ENTRY_HASH={
 base:'0x28f989233f4ffb52e4b168fb74df5dfa52fe0f846141774f5abc56c5604d8e46',
 bnb:'0x9db0e60a88795050d924820a77335fd296a2a77ca6fcccb9c46c760c1fdbed21',
 monad:'0x69515af79b28b62817d26d53e00b136ca7bc5e108ee604e4b6d01bf9f864f1d4',
 robinhood:'0xa4b1c865a4a45b99ebaaf4bd06e0036ad489eb521786f59765e4e6a3c0524b03',
 arc:'0x2280fdb15bcd1a7e84d70d4d0e691ddf4390dffea82e0bc2850a2b03163959f3',
 ethereum:'0x44e632a24c6f2600cbd5b5b8b4c2d372359112c8b5774297f5fd0a9e64f11f86',
};
export const fomoAccountAbi=parseAbi([
 'function execute(address target,uint256 value,bytes data)',
 'function executeBatch((address target,uint256 value,bytes data)[] calls)',
]);
const operationEvent=parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
const topic=toEventSelector(operationEvent[0]);
const beforeExecution=toEventSelector('BeforeExecution()');
const transfer=toEventSelector('Transfer(address,address,uint256)');
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();

/** Unwrap one uniquely owned, successful operation on the pinned deployment.
 * The caller must already have independently finalized the receipt and must
 * still verify every returned call as a supported trade using receiptLogs.
 * This alone is NOT a sale. Receipt bounds and isolated token movements keep
 * another operation's deposits or gifts from becoming this leader's trade. */
export async function readFomoSmartCalls(b:CashLeaderBalance,rpc:Rpc){
 if(b.target!==FOMO_ENTRYPOINT)return null;
 const decoded=decodeFunctionData({abi:entryPoint08Abi,data:b.input as `0x${string}`});
 if(decoded.functionName!=='handleOps'||!same(encodeFunctionData({abi:entryPoint08Abi,functionName:'handleOps',args:decoded.args}),b.input))throw Error('Unsupported Fomo operation bundle.');
 const [operations]=decoded.args;
 const owned=operations.map((op,index)=>({op,index})).filter(({op})=>same(op.sender,b.leader));
 if(owned.length!==1)throw Error('Ambiguous Fomo operation owner.');
 const {op,index:operationIndex}=owned[0];
 // 7702's factory marker is allowed; arbitrary account deployment is not.
 // EntryPoint accepts the two-byte marker through its 20-byte zero-padded
 // form. Extra initialization calldata is deliberately unsupported here.
 if(op.initCode!=='0x'&&!/^0x7702(?:00){0,18}$/i.test(op.initCode))throw Error('Unsupported Fomo account initialization.');
 if(op.signature.length!==132)throw Error('Unsupported Fomo operation signature.');
 const [account,implementation,entry]=await Promise.all([
  rpc('eth_getCode',[b.leader,b.blockNumber]),rpc('eth_getCode',[FOMO_ACCOUNT,b.blockNumber]),rpc('eth_getCode',[FOMO_ENTRYPOINT,b.blockNumber]),
 ]);
 if(!same(account,'0xef0100'+FOMO_ACCOUNT.slice(2)))throw Error('Fomo account delegation changed.');
 for(const [code,expected] of [[implementation,ACCOUNT_HASH],[entry,ENTRY_HASH[b.network]]]){
  if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==expected)throw Error('Fomo smart-wallet deployment changed.');
 }
 // The immutable EntryPoint computes the exact 7702-aware operation hash at
 // the receipt's block. Never associate an arbitrary success log by sender.
 const operationHash=await rpc('eth_call',[{to:FOMO_ENTRYPOINT,data:encodeFunctionData({abi:entryPoint08Abi,functionName:'getUserOpHash',args:[op]})},b.blockNumber]);
 if(typeof operationHash!=='string'||!/^0x[0-9a-f]{64}$/i.test(operationHash))throw Error('Fomo operation hash unavailable.');
 // The pinned EntryPoint emits BeforeExecution after validation, then one
 // UserOperationEvent after each operation (including its paymaster postOp).
 // Validate ordering and all receipt metadata before using those boundaries.
 let lastIndex=-1n;
 for(const log of b.receipt.logs){
  if(log.removed!==false||!same(log.transactionHash,b.transaction)||!same(log.blockHash,b.blockHash)||log.blockNumber!==b.blockNumber||log.transactionIndex!==b.transactionIndex||typeof log.logIndex!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(log.logIndex)||BigInt(log.logIndex)<=lastIndex)throw Error('Invalid Fomo operation receipt.');
  lastIndex=BigInt(log.logIndex);
 }
 const starts=b.receipt.logs.filter((l:any)=>same(l.address,FOMO_ENTRYPOINT)&&same(l.topics?.[0],beforeExecution));
 const logs=b.receipt.logs.filter((l:any)=>same(l.address,FOMO_ENTRYPOINT)&&same(l.topics?.[0],topic));
 if(starts.length!==1||starts[0].topics.length!==1||starts[0].data!=='0x'||logs.length!==operations.length)throw Error('Ambiguous Fomo operation receipt.');
 const events=logs.map((log:any)=>decodeEventLog({abi:operationEvent,data:log.data,topics:log.topics,strict:true}));
 if(BigInt(starts[0].logIndex)>=BigInt(logs[0].logIndex)||events.some((event:any,i:number)=>!same(event.args.sender,operations[i].sender)||event.args.nonce!==operations[i].nonce)||events.filter((event:any)=>same(event.args.userOpHash,operationHash)).length!==1)throw Error('Fomo operation was not verified.');
 const event=events[operationIndex];
 if(!event.args.success||!same(event.args.userOpHash,operationHash))throw Error('Fomo operation was not verified.');
 const lower=BigInt(operationIndex===0?starts[0].logIndex:logs[operationIndex-1].logIndex),upper=BigInt(logs[operationIndex].logIndex);
 const receiptLogs=b.receipt.logs.filter((log:any)=>BigInt(log.logIndex)>lower&&BigInt(log.logIndex)<upper);
 const owner='0x'+b.leader.slice(2).padStart(64,'0');
 for(const log of b.receipt.logs){
  if(same(log.address,b.token)&&same(log.topics?.[0],transfer)&&(same(log.topics?.[1],owner)||same(log.topics?.[2],owner))&&(BigInt(log.logIndex)<=lower||BigInt(log.logIndex)>=upper))throw Error('Leader token transfer outside Fomo operation.');
 }
 const call=decodeFunctionData({abi:fomoAccountAbi,data:op.callData});
 const canonical=call.functionName==='execute'
  ?encodeFunctionData({abi:fomoAccountAbi,functionName:'execute',args:call.args})
  :encodeFunctionData({abi:fomoAccountAbi,functionName:'executeBatch',args:call.args});
 if(!same(canonical,op.callData))throw Error('Noncanonical Fomo account call.');
 const calls=call.functionName==='execute'?[{target:call.args[0],value:call.args[1],data:call.args[2]}]:[...call.args[0]];
 if(!calls.length||calls.length>3||calls.some(c=>c.value!==0n))throw Error('Unsupported Fomo account calls.');
 return{calls,operationHash,receiptLogs};
}
