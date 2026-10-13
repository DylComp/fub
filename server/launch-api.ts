import {customPairExecutionEnabled} from './launch-pair-config.js';
import { waitForLaunchRecipient } from "./launch-recipient-wait.js";
import { isFubWebOrigin } from './fub-web-origin.js';
import { getLaunchPairs } from "./launch-pairs.js";
import { getPumpPair, pairFailure } from './pump-pair-resolver.js';
import { SOL_PAIR, SOL_PAIR_MINT, CUSTOM_PAIR_BLOCKER, pairAmount } from "../src/launch-pairs.js";
import { launchExecutionConfig } from "./launch-execution-config.js";
import { launchPublicationStore } from "./launch-publication-store.js";
import type { PublishedLaunch } from "../src/launch-publication.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { address, isOffCurveAddress } from "@solana/kit";
import { isMint } from "../src/assets.js";
import { launchDraft, launchShares } from "../src/launch-model.js";
import type { FomoLookup } from "../src/fomo-identity.js";
export async function freshLaunchRecipient(handle: string): Promise<FomoLookup> {
  const { recipients } = await import("./fomo-recipient.js");
  let first=true;
  return waitForLaunchRecipient(handle, () => {const enqueue=first;first=false;return enqueue?recipients.refresh(handle):recipients.profile(handle,true);});
}
export function launchReviewHandler(options: {
  lookup?: typeof freshLaunchRecipient;
  pairs?: typeof getLaunchPairs;
  pair?: typeof getPumpPair;
  getBurnWallet?: () => string | undefined;
  getPublication?: (id: string, owner: string) => Promise<PublishedLaunch | null>;
} = {}) {
  let start = 0, calls = 0, pending = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const query = new URL(req.url || '/', 'https://localhost').searchParams;
    if (req.method === 'GET' && query.get('view') === 'pair') {
      if(process.env.LAUNCH_CUSTOM_PAIRS_ENABLED==='false')return send(409,{message:'Launches use SOL. Custom pairing is no longer available.'});
      if (Array.from(query.keys()).sort().join() !== 'mint,view') return send(400, {message:'Provide one pair mint.'});
      if (Date.now() - start >= 60000) { start = Date.now(); calls = 0; }
      if (calls >= 20 || pending >= 3) { res.setHeader('Retry-After','60'); return send(429,{message:'Pair checks are busy. Try again in a minute.'}); }
      calls++; pending++;
      try { return send(200, await (options.pair || getPumpPair)(query.get('mint') || '')); }
      catch (error) { const failure = pairFailure(error); return send(failure.code === 'unavailable' ? 503 : 422, {code:failure.code,message:failure.message}); }
      finally { pending--; }
    }
    if (req.method === "GET" && query.get('view') === 'pairs') {
      const keys=[...query.keys()].sort().join();
      if(keys!=='view'&&keys!=='mint,view,wallet')return send(400,{message:'Invalid pair catalog request.'});
      const wallet=query.get('wallet')||undefined,quoteMint=query.get('mint')||undefined;
      if(keys!=='view'&&(!isMint(wallet||'')||!isMint(quoteMint||'')))return send(400,{message:'Invalid pair catalog context.'});
      if(!customPairExecutionEnabled(process.env,{wallet,quoteMint}))return send(200,{checkedAt:Date.now(),pairs:[SOL_PAIR],customPairsEnabled:false});
      // This is a public UI hint, never permission to prepare or sign a launch.
      try { return send(200, {...await (options.pairs || getLaunchPairs)(),customPairsEnabled:customPairExecutionEnabled(process.env,{wallet,quoteMint})}); }
      catch { return send(200, {checkedAt:Date.now(),pairs:[SOL_PAIR],catalogUnavailable:true,customPairsEnabled:customPairExecutionEnabled(process.env,{wallet,quoteMint})}); }
    }
    if(req.method==='GET'&&req.url?.split('?')[1]?.startsWith('view=pair-rent&')){
      const query=new URL(req.url,'https://localhost').searchParams,count=Number(query.get('count'));
      if([...query.keys()].sort().join()!=='count,view'||!Number.isInteger(count)||count<1||count>24)return send(400,{message:'Invalid pair address count.'});
      if(Date.now()-start>=60000){start=Date.now();calls=0;}
      if(calls>=20||pending>=3)return send(429,{message:'Setup checks are busy.'});calls++;pending++;
      try{
       const {Connection}=await import('@solana/web3.js');
       const c=new Connection(process.env.SOLANA_RPC_URL!,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(8000)})});
       if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error();
       const rentLamports=await c.getMinimumBalanceForRentExemption(56+32*count);
       if(!Number.isSafeInteger(rentLamports)||rentLamports<=0||rentLamports>5000000)throw Error();
       return send(200,{count,rentLamports});
      }catch{return send(503,{message:'Pair setup costs could not be checked.'});}finally{pending--;}
    }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, { message: "POST required." }); }
    const origin = req.headers.origin;
    if (!isFubWebOrigin(origin)) return send(403, { message: "Open launch review on Fub." });
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") return send(415, { message: "JSON required." });
    if (new URL(req.url || "/", "https://localhost").search) return send(400, { message: "Invalid review request." });
    if (Date.now() - start >= 60000) { start = Date.now(); calls = 0; }
    if (calls >= 10 || pending >= 3) { res.setHeader("Retry-After", "60"); return send(429, { message: "Launch reviews are busy. Try again in a minute." }); }
    calls++; pending++;
    try {
      let size = 0; const chunks: Buffer[] = [];
      const timer = setTimeout(() => req.destroy(), 5000);
      let raw: unknown;
      try {
        const parsed = (req as IncomingMessage & { body?: unknown }).body;
        if (parsed !== undefined) {
          const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
          if (Buffer.byteLength(text) > 8192) return send(413, { message: "Launch review is too large." });
          raw = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
        } else {
          for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 8192) return send(413, { message: "Launch review is too large." }); chunks.push(b); }
          raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
      } catch { return send(400, { message: "Invalid launch review." }); }
      finally { clearTimeout(timer); }
      let d, recipient: string, publicationId: string | undefined, owner: string | undefined;
      try {
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !["draft,recipient", "draft,publicationId,recipient,wallet"].includes(Object.keys(raw).sort().join())) throw Error();
        const body = raw as { draft: unknown; recipient: string; publicationId?: string; wallet?: string };
        publicationId = body.publicationId; owner = body.wallet;
        if (publicationId !== undefined && (!/^[a-f0-9]{64}$/.test(publicationId) || !owner || !isMint(owner))) throw Error();
        d = launchDraft(body.draft); recipient = body.recipient;
        if (typeof recipient !== "string" || !isMint(recipient) || isOffCurveAddress(address(recipient))) throw Error();
      } catch { return send(400, { message: "Check the coin fields and recipient address." }); }
      const customPair = !!d.quoteMint && d.quoteMint !== SOL_PAIR_MINT;
      if (customPair && process.env.LAUNCH_CUSTOM_PAIRS_ENABLED==='false') return send(409,{message:"Launches use SOL. Start a new SOL draft; saved pair amounts are not converted."});
      if (customPair) {
        let pair;
        try {
          const pairs = await (options.pairs || getLaunchPairs)().catch(() => null);
          pair = pairs?.pairs.find(p => p.mint === d.quoteMint) || (await (options.pair || getPumpPair)(d.quoteMint!)).pair;
        } catch (error) { const failure = pairFailure(error); return send(failure.code === 'unavailable' ? 503 : 409, { message: failure.message }); }
        try { pairAmount(d.initialBuy, pair.decimals); }
        catch { return send(400, { message: `Check the initial buy. ${pair.ticker} supports ${pair.decimals} decimal places.` }); }
      }
      let match: FomoLookup;
      try { match = await (options.lookup || freshLaunchRecipient)(d.handle); }
      catch { return send(503, { message: "The recipient could not be checked. No launch was prepared." }); }
      if (match.address !== recipient || match.handle !== d.handle) return send(409, { message: "The indexed wallet changed. Find and confirm the recipient again." });
      let publication: PublishedLaunch | null = null;
      if (publicationId && owner) {
        try {
          publication = await (options.getPublication || ((id, wallet) => launchPublicationStore(process.env.DATABASE_URL!).get(id, wallet)))(publicationId, owner);
        } catch { return send(503, { message: "Saved draft verification is unavailable." }); }
        if (!publication || publication.owner !== owner || publication.recipient !== recipient ||
            [...new Set([...Object.keys(d), ...Object.keys(publication.draft)])].some(k => d[k as keyof typeof d] !== publication!.draft[k as keyof typeof d])) return send(409, { message: "This saved draft does not match the coin fields. Publish the updated draft before review." });
      }
      const treasury = (options.getBurnWallet || (() => process.env.LAUNCH_BURN_WALLET))();
      let split = null;
      try { if (treasury && isMint(treasury) && !isOffCurveAddress(address(treasury))) split = launchShares(recipient, treasury); } catch { /* Never substitute another destination. */ }
      const readiness=launchExecutionConfig(process.env,publication?{wallet:publication.owner,publicationId:publication.id,quoteMint:publication.draft.quoteMint}:undefined);
      const executable=!!publication&&!!split&&readiness.enabled&&(!customPair||readiness.customPairsEnabled);
      const blockers=[...(customPair&&!readiness.customPairsEnabled?[CUSTOM_PAIR_BLOCKER]:[]),...(!split?["Configure a dedicated buy-and-burn wallet distinct from the Fomo recipient."]:[]),...(!publication?["Publish the coin image and metadata before preparing the transaction."]:[]),...readiness.reasons];
      return send(200, { handle: d.handle, recipient, split, initialBuy: d.initialBuy || "0", source: match.source, checkedAt: Date.now(), executable, blockers, ...(publication ? { metadataUrl: publication.metadataUrl, publicationId: publication.id } : {}) });
    } finally { pending--; }
  };
}
export const handleLaunch = launchReviewHandler();
