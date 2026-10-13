import {ArrowRight, ArrowUpRight, BookOpen, Coins, CreditCard, Layers3, Wallet} from 'lucide-react';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {Kind} from './model';
import './docs.css';

const groups = [
 {name:'Get started',items:[['purpose','Fub'],['wallet','Wallet connection'],['wallets','Wallets']]},
 {name:'Trade',items:[['research','Token search and charts'],['orders','Limit orders'],['copy','Copy trading'],['cash','Trade with USDC']]},
 {name:'Pay',items:[['pay','Fomo Pay'],['gifts','Gift cards'],['split','Split'],['treat','Treat'],['travel','Phone top-ups and eSIMs']]},
 {name:'Launch',items:[['launch','Launch'],['fees','Creator fee payouts'],['buybacks','Buy and burn'],['directory','Tokens'],['profiles','Profiles']]},
 {name:'Track',items:[['activity','Activity'],['recovery','Transaction recovery']]},
];
const sectionIds=groups.flatMap(group=>group.items.map(([id])=>id));
function Chapter({id,category,title,children}:{id:string;category:string;title:string;children:ReactNode}){
 return <section className="docs-chapter" id={`docs-${id}`} tabIndex={-1} aria-labelledby={`docs-title-${id}`}><header><span className="docs-kicker">{category}</span><h2 id={`docs-title-${id}`}>{title}</h2></header>{children}</section>;
}
function Detail({title,children}:{title:string;children:ReactNode}){return <div><dt>{title}</dt><dd>{children}</dd></div>;}
function Note({children}:{children:ReactNode}){return <p className="docs-note">{children}</p>;}
export function Docs({onPlan,onCopy,onPay,onToken,onLaunch}:{onPlan:(kind:Kind)=>void;onCopy:()=>void;onPay:()=>void;onToken:()=>void;onLaunch:()=>void}){
 const [active,setActive]=useState('purpose');
 const contents=useRef<HTMLElement>(null);
 useEffect(()=>{
  let frame=0;
  const update=()=>{frame=0;let current=sectionIds[0];for(const id of sectionIds){const element=document.getElementById(`docs-${id}`);if(element&&element.getBoundingClientRect().top<=165)current=id;}setActive(current);};
  const scroll=()=>{if(!frame)frame=requestAnimationFrame(update);};
  update();window.addEventListener('scroll',scroll,{passive:true});window.addEventListener('resize',scroll);
  return()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',scroll);window.removeEventListener('resize',scroll);};
 },[]);
 useEffect(()=>{const nav=contents.current,item=nav?.querySelector<HTMLElement>('[aria-current="location"]');if(!nav||!item||matchMedia('(max-width: 850px)').matches)return;const n=nav.getBoundingClientRect(),r=item.getBoundingClientRect();if(r.top<n.top||r.bottom>n.bottom)nav.scrollTop+=r.top-n.top-nav.clientHeight/2;},[active]);
 function jump(id:string){const section=document.getElementById(`docs-${id}`);setActive(id);section?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});section?.focus({preventScroll:true});}
 return <article className="product-docs" aria-label="Fub documentation">
  <nav ref={contents} className="docs-contents" aria-label="Documentation contents"><div className="docs-nav-label"><BookOpen size={15}/> In these docs</div>{groups.map(group=><div className="docs-group" key={group.name}><span>{group.name}</span>{group.items.map(([id,title])=><button type="button" key={id} aria-current={active===id?'location':undefined} onClick={()=>jump(id)}>{title}<span aria-hidden="true">↗</span></button>)}</div>)}</nav>
  <div className="docs-body">
   <Chapter id="purpose" category="GET STARTED" title="Fub">
    <p className="docs-lead">More tools for Fomo users.</p><p>Trade with limit orders, follow other traders, spend USDC and launch coins that pay a Fomo user. Fub adds these tools around your wallet so you can keep discovering coins and people on Fomo.</p>
    <div className="docs-start-grid">
     {([{id:'orders',icon:Coins,title:'Trade',text:'Orders, copy plans and USDC trades.'},{id:'pay',icon:CreditCard,title:'Pay',text:'Gift cards, shared bills and transfers.'},{id:'launch',icon:Layers3,title:'Launch',text:'Coins with automatic creator-fee payouts.'},{id:'wallets',icon:Wallet,title:'Explore',text:'Fomo profiles, holdings and activity.'}]).map(item=><button type="button" key={item.id} onClick={()=>jump(item.id)}><item.icon size={18}/><strong>{item.title}</strong><span>{item.text}</span><ArrowUpRight size={14} className="docs-card-arrow"/></button>)}
    </div><Note>Fub is independently built and is not affiliated with Fomo. A Fomo username identifies a public profile; it does not grant access to that person’s wallet.</Note>
   </Chapter>
   <Chapter id="wallet" category="GET STARTED" title="Wallet connection">
    <p>Pay, limit orders and copy trading use your existing Fomo Solana wallet through private import. Find your Fomo profile, check its address and import that wallet’s Solana private key through Privy. Your wallet address and balance stay the same.</p>
    <dl><Detail title="Coin launches">On the Launch page, connect Phantom or another supported Solana wallet, or use your imported Fomo wallet. External wallet connections are limited to launches.</Detail><Detail title="Payments and trades">Use your imported Fomo wallet and approve each manual payment or trade. Importing a wallet does not authorize automatic trading.</Detail><Detail title="Automatic trading">Approve background wallet access, then each plan’s amounts, slippage and expiry. These permissions are separate from wallet import and manual payments.</Detail><Detail title="Permissions">Pause a plan or revoke background access when you want to stop new execution. Keep network fees available. A transaction already submitted can still finish.</Detail></dl>
    <p>The import form checks the key against the selected address locally. Privy’s SDK handles the encrypted import; Fub’s server does not receive the private key. Never share a key in chat or a support request.</p>
    <Note>Cross-chain trades use a separate destination wallet created for you in Fub and linked to your Solana wallet. They do not use your existing Fomo EVM address.</Note>
   </Chapter>
   <Chapter id="wallets" category="EXPLORE" title="Wallets">
    <p>Search a Fomo username or public wallet. Review the profile picture, name and matched Solana address, then inspect available performance, holdings and trades in one place.</p>
    <dl><Detail title="Profile statistics">See available portfolio value, cash, followers, trade count, average holding time and top trades. Each profile snapshot shows when it was checked.</Detail><Detail title="Holdings and trades">Fomo positions include available token names, images, networks, values and returns. Filter by network or token. The separate Solana wallet view shows on-chain holdings and transactions, including buy and sell amounts where decoded.</Detail><Detail title="Before selecting">Confirm the full wallet address before using a profile as a copy leader or launch recipient. Matching names alone are not proof of ownership.</Detail></dl>
    <Note>Only retrieved values are shown. Missing statistics remain unavailable; a missing value is not zero. Cached profile data and on-chain balances can have different update times.</Note>
   </Chapter>
   <Chapter id="research" category="TRADE" title="Token search and charts">
    <p>Find a token by name, ticker, contract address or Fomo token link. Search previews show market cap, volume and liquidity when available. Open its chart to inspect price history before choosing an order.</p>
    <p>Search includes Solana, Base, BNB Chain, Monad, Robinhood Chain, Arc and Ethereum. Check the network and full contract address: different tokens can share a name.</p><Note>A searchable token is not necessarily tradable. Execution needs a supported route, liquidity and a valid quote.</Note>
   </Chapter>
   <Chapter id="orders" category="TRADE" title="Limit orders">
    <p>Set a level, amount and expiry for one buy or sell from your existing Solana wallet. Market cap is the default; switch to token price when preferred.</p>
    <dl><Detail title="Buy">Choose a SOL spend and maximum entry level. Your approval sets a minimum token amount after slippage. SOL for network fees and account rent is separate.</Detail><Detail title="Sell">Choose the SOL value to sell. Fub uses a fresh price to convert it into a fixed token quantity for your review. The limit sets minimum proceeds; the size estimate does not guarantee the return.</Detail><Detail title="Market cap">Use values such as 250K or 1.5M. Fub converts the target using verified supply and exchange rates. Those values can change before execution.</Detail><Detail title="Manage">Check the last quote, expiry and transaction status, or cancel before signing begins. Funds stay in your wallet and are not reserved by the order.</Detail></dl>
    <p>Supported Solana routes include Pump bonding curves, standard-token PumpSwap pools and Raydium CLMM. A fill depends on liquidity, slippage, available funds and permission. Sell proceeds can be SOL, wrapped SOL or USDC, depending on the route.</p>
    <button className="word-link" onClick={()=>onPlan('Limit')}>Open limit orders <ArrowRight size={14}/></button>
   </Chapter>
   <Chapter id="copy" category="TRADE" title="Copy trading">
    <p>Choose a Fomo trader, confirm the wallet and set your own buy size, daily cap, slippage and permission expiry. Enable proportional sells if you want Fub to follow the trader’s exits.</p>
    <dl><Detail title="Copy buys">A supported leader trade is checked against your active permission, available balance and remaining buy budget. Sells do not reset that budget.</Detail><Detail title="Proportional sells">If the leader sells 25%, Fub targets 25% of the position tracked by your plan. It does not sell unrelated holdings. Manual transfers or sales may require a position correction.</Detail><Detail title="Fast exits">A detected leader sale can wait for a copied purchase to arrive. Fub verifies the received tokens before selling them. Expired signals stop; submitted transactions remain tracked.</Detail><Detail title="Manage a plan">Reopen your saved plan to check limits, remaining budget and expiry, or pause it. Background execution requires an enabled service and valid permission, not an open browser tab.</Detail></dl>
    <Note>Copies are not instant or guaranteed to match the leader’s price. Supported networks and routes are checked before activation. Automatic cross-chain copying remains under final verification; manual cross-chain trading does not establish automatic-copy availability.</Note>
    <button className="word-link" onClick={onCopy}>Open copy trading <ArrowRight size={14}/></button>
   </Chapter>
   <Chapter id="cash" category="TRADE" title="Trade with USDC">
    <p>Buy on another network using USDC from your Solana wallet. Sell the tokens received by that purchase back to USDC in the original Solana wallet.</p>
    <ol className="docs-steps"><li><strong>Choose a token</strong><span>Confirm its network, address and USDC amount.</span></li><li><strong>Review the purchase</strong><span>Check the minimum received, routing costs and destination gas. Solana network fees are separate.</span></li><li><strong>Return to cash</strong><span>Approve the token allowance and sale. Follow the transaction until USDC arrives in your Solana wallet.</span></li></ol>
    <p>Manual trading supports available routes on Base, BNB Chain, Monad, Robinhood Chain, Arc and Ethereum. Each route must pass balance and transaction checks. Destination gas is included in the purchase review.</p>
   </Chapter>
   <Chapter id="pay" category="PAY" title="Fomo Pay">
    <p>Use your existing Fomo wallet’s Solana USDC for gift cards, shared bills and direct payments.</p>
    <dl><Detail title="Payment balance">Keep USDC for the purchase and SOL for network fees. Tokens and USDC on other networks must be converted or transferred before this payment flow can use them.</Detail><Detail title="Your approval">Review each exact amount and recipient before signing. Sharing a request or opening a receipt does not move funds.</Detail><Detail title="Purchase history">Reopen saved merchant receipts with the wallet that bought them. Gift-card receipt email is separate from wallet sign-in.</Detail></dl>
    <button className="word-link" onClick={onPay}>Open Fomo Pay <ArrowRight size={14}/></button>
   </Chapter>
   <Chapter id="gifts" category="PAY" title="Gift cards">
    <p>Choose the redemption country, merchant and amount. Enter a receipt email and check the merchant’s terms. Fub checks USDC and SOL before creating an invoice.</p>
    <p>Review the exact invoice price and network fee, then approve payment. The purchase price can differ from the gift card’s face value. After delivery, open the code or redemption link in private purchase history.</p>
    <Note>Payment confirmation and gift-card delivery are separate. Interrupted purchases resume from the existing invoice. A provider outage does not erase the saved receipt or authorize a duplicate payment.</Note>
   </Chapter>
   <Chapter id="split" category="PAY" title="Split">
    <p>Divide a group bill into equal shares and send each friend their reimbursement link. Your own share is excluded from the requests.</p><p>Each link names the amount and receiving wallet. Track finalized payments separately. From a completed gift-card receipt, “Split this purchase” uses the actual USDC cost.</p>
   </Chapter>
   <Chapter id="treat" category="PAY" title="Treat">
    <p>Choose a friend’s Solana wallet, add a USDC amount and message, then approve the transfer. Your friend receives USDC directly in that wallet.</p>
   </Chapter>
   <Chapter id="travel" category="PAY" title="Phone top-ups and eSIMs">
    <p>Open Gift cards in Fomo Pay to find links to Bitrefill’s phone top-ups and travel eSIMs. Choose the destination country, then review the product before paying.</p>
    <dl><Detail title="Phone top-ups">Check the recipient’s phone number, country and mobile network. Confirm the amount and delivery instructions on Bitrefill.</Detail><Detail title="Travel eSIMs">Check device compatibility, network coverage, included data, validity and activation instructions for your destination.</Detail><Detail title="Checkout and receipts">These purchases take place on Bitrefill. Check the payment methods and current price there, and keep its receipt and delivery instructions. Purchases started there do not appear in Fub’s purchase history.</Detail></dl>
    <a className="word-link" href="#pay/gift-cards">Open gift cards and travel links <ArrowRight size={14}/></a>
   </Chapter>
   <Chapter id="launch" category="LAUNCH" title="Launch">
    <p>Create a SOL-paired Pump.fun coin with creator fees routed to a Fomo user.</p>
    <ol className="docs-steps"><li><strong>Choose the recipient</strong><span>Find a Fomo username and confirm the profile and wallet.</span></li><li><strong>Add the coin</strong><span>Upload a square image, name and ticker. Description, X and Telegram are optional. An optional SOL opening buy is included in creation.</span></li><li><strong>Approve once</strong><span>Review and sign the launch transaction. After confirmation, the coin appears in Tokens and the flow returns to Launch.</span></li></ol>
    <p>Every coin’s website links to its own Fub token page. The creator-fee split is fixed at 80% to the selected Fomo wallet and 20% to the Fub treasury.</p><Note>The launcher and fee recipient can be different people. Receiving fees does not mean the recipient created or endorsed the coin.</Note>
    <button className="word-link" onClick={onLaunch}>Open Launch <ArrowRight size={14}/></button>
   </Chapter>
   <Chapter id="fees" category="LAUNCH" title="Creator fee payouts">
    <div className="docs-split" aria-label="Community launch creator fee split"><div><strong>80<span>%</span></strong><p>Selected Fomo recipient</p></div><div><strong>20<span>%</span></strong><p>Fub buyback treasury</p></div></div>
    <p>Creator fees accumulate in Pump vaults. The payout service checks every minute and distributes when at least 0.003 SOL is available. Each launch can pay a different Fomo recipient.</p><Note>The split applies to creator fees, not trading volume or the initial buy. Network delays can postpone collection; unclaimed fees remain in the vault.</Note>
   </Chapter>
   <Chapter id="buybacks" category="LAUNCH" title="Buy and burn">
    <p>The treasury receives 20% of creator fees from community launches. The worker uses the configured budget to buy the official Fub token and burn the purchased tokens.</p>
    <p>The official Fub coin has its own separate split: 80% for buybacks and 20% for development. Buybacks from all launches target that one official mint.</p><Note>Treasury funds can accumulate before the official mint exists. Purchases and burns require that mint to be configured and buybacks activated; spending and slippage limits still apply.</Note>
   </Chapter>
   <Chapter id="directory" category="EXPLORE" title="Tokens">
    <p>Browse confirmed community launches with their coin image, mint, Fomo recipient and available market data. Select a coin to open its token page, trading information and transaction receipts.</p><p>Open token pages refresh market checks every 15 seconds. Active SOL curves use on-chain reserves for spot prices; the market feed supplies available volume and pool liquidity. Values older than 45 seconds are not shown as current. Missing data stays unavailable.</p>
    <button className="word-link" onClick={onToken}>Browse Tokens <ArrowRight size={14}/></button>
   </Chapter>
   <Chapter id="profiles" category="EXPLORE" title="Profiles">
    <p>See recorded recipient earnings across all listed coins paying the same Fomo wallet. The total adds those coins together and excludes the treasury share.</p><p>Sent totals count confirmed distributions recorded by Fub. Unclaimed fees appear separately. Claims made outside Fub are not included in recorded sent totals.</p>
   </Chapter>
   <Chapter id="activity" category="TRACK" title="Activity">
    <p>Follow launches, fee distributions, buybacks, supported trades and payments. Open a record to inspect its result and available transaction details.</p><dl><Detail title="Submitted">The transaction has been sent but its required confirmation checks are still pending.</Detail><Detail title="Confirmed">The required chain checks passed. Gift-card delivery has a separate status from its payment.</Detail><Detail title="Needs attention">Open the saved attempt for its specific error or recovery action. Do not assume a missing confirmation means nothing happened.</Detail></dl>
   </Chapter>
   <Chapter id="recovery" category="TRACK" title="Transaction recovery">
    <p>Fub saves submitted attempts and continues checking them after you close the site. An unresolved transaction is checked before a replacement is allowed. Completed tasks return to their page; failed or unfinished tasks keep their recovery controls.</p><p>Automation depends on valid permissions, fee balances and available providers. Expired access, depleted funds or unsupported routes stop new execution. Existing signed transactions remain tracked.</p>
   </Chapter>
  </div>
 </article>;
}
