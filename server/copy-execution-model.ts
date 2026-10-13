import type { ReviewedCopySwap } from "./copy-swap.js";
export type CopyPrepared = { review: ReviewedCopySwap; savedAt: number };
export type CopyExecution = {
  version: 1;
  signed: string;
  feeLamports: string;
  rentLamports: string;
  minContextSlot: number;
};
