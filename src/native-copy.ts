export type NativeCopyReport = {
  wallet: string;
  checkedAt: string;
  hasMore: boolean;
  plans: {
    id: string;
    name: string;
    leader: string;
    status: "accepted" | "revoked" | "expired" | "changed" | "paused";
    mint?: string;
    buyLamports: string;
    dailySpendLamports: string;
    maxFeeLamports: string;
    maxRentLamports: string;
    slippageBps: number;
    copySells: boolean;
    expiresAt: string;
    spentTodayLamports: string;
    reservedTodayLamports: string;
    heldLamports: string;
    pendingCount: number;
  }[];
};
