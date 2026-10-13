import type {PolicyRuleRequestBody,PolicyCondition} from '@privy-io/api-types/resources/policies';
import {CASH_NETWORKS} from '../src/cash-route.js';
import {cashReturnAbi,CASH_RETURN_BASE} from './cash-return-route.js';
import {LEADER_DEPOSITORY} from './cash-leader-deposit.js';

// Separate additional signers, never an update to the existing spot policy.
// Provider restrictions are a second boundary; exact amounts, recipients,
// deadlines and route internals remain independently checked by our signer.
export function cashSolanaPolicyRules():PolicyRuleRequestBody[]{
 return [{name:'Reviewed USDC bridge deposits',method:'signTransaction',action:'ALLOW',conditions:[{
  field_source:'solana_program_instruction',field:'programId',operator:'in',value:[
   'ComputeBudget111111111111111111111111111111',
   'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',LEADER_DEPOSITORY,
  ],
 }]}];
}
export function cashEvmPolicyRules():PolicyRuleRequestBody[]{
 const limits:PolicyCondition[]=[
  {field_source:'ethereum_transaction',field:'chain_id',operator:'in',value:Object.values(CASH_NETWORKS).map(n=>String(n.chainId))},
  {field_source:'ethereum_transaction',field:'value',operator:'eq',value:'0x0'},
 ];
 const abi=JSON.parse(JSON.stringify(cashReturnAbi.approval));
 return [
  {name:'Exact token allowance for Relay return',method:'eth_signTransaction',action:'ALLOW',conditions:[...limits,
   {field_source:'ethereum_calldata',field:'function_name',operator:'eq',value:'approve',abi},
   {field_source:'ethereum_calldata',field:'approve.spender',operator:'in',value:[CASH_RETURN_BASE.proxy,CASH_RETURN_BASE.depository],abi},
  ]},
  {name:'Reviewed Relay return swap',method:'eth_signTransaction',action:'ALLOW',conditions:[...limits,
   {field_source:'ethereum_transaction',field:'to',operator:'eq',value:CASH_RETURN_BASE.proxy},
   {field_source:'ethereum_calldata',field:'function_name',operator:'eq',value:'transferAndMulticall',abi:JSON.parse(JSON.stringify(cashReturnAbi.proxy))},
  ]},
  {name:'Reviewed settlement deposit',method:'eth_signTransaction',action:'ALLOW',conditions:[...limits,
   {field_source:'ethereum_transaction',field:'to',operator:'eq',value:CASH_RETURN_BASE.depository},
   {field_source:'ethereum_calldata',field:'function_name',operator:'eq',value:'depositErc20',abi:JSON.parse(JSON.stringify(cashReturnAbi.deposit))},
  ]},
 ];
}
