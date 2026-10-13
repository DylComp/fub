import type { CopyMonitor } from "./copy-monitor";
export type SwapEvidence = {
  kind: "swap";
  tokenProgram?: string;
  quoteMode?: "native" | "token";
  route?: string;
  decoderVersion?: number;
  transactionVersion?: 1;
  networkFeeLamports?: string;
  priorityFeeLamports?: string;
  separateQuoteTransferRaw?: string;
  separateNativeTransferLamports?: string;
  side: "buy" | "sell";
  mint: string;
  quoteMint: string;
  tokenRaw: string;
  quoteRaw: string;
  tokenDecimals: number;
  quoteDecimals: number;
  leaderTokenBeforeRaw: string;
};
export type FeedDecision = SwapEvidence | { kind: "ignored"; reason: string };
export type LeaderSignature = {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
};
export type FeedEvent = LeaderSignature & {
  decision: FeedDecision;
  recordedAt: string;
};
export type CopyFeedReport = {
  monitor?: CopyMonitor;
  planId: string;
  leader: string;
  initialized: boolean;
  checkedAt: string | null;
  status: "idle" | "ready" | "retry" | "gap" | "catching_up";
  message: string;
  events: FeedEvent[];
};
