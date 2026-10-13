import {defineChain, type Chain} from 'viem';
import {base, bsc, mainnet, monad} from 'viem/chains';

// Explicit SDK configuration also covers networks absent from Privy's
// defaults. These public RPCs contain no server credentials. Transactions
// are signed first and checked by Fub. Owner-initiated recovery can resend
// its durably saved, checked bytes through these fixed public endpoints.
export const cashWalletChains: Chain[] = [
  base, bsc, monad,
  defineChain({id:4663,name:'Robinhood Chain',
    nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
    rpcUrls:{default:{http:['https://robinhood.drpc.org']}},
    blockExplorers:{default:{name:'Robinhood Explorer',url:'https://robin.etherscan.io'}}}),
  defineChain({id:5042,name:'Arc',
    nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},
    rpcUrls:{default:{http:['https://rpc.drpc.mainnet.arc.io']}},
    blockExplorers:{default:{name:'Arc Explorer',url:'https://explorer.arc.io'}}}),
  mainnet,
];
