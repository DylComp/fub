export type CopyControlEvent = {
  wallet: string;
  id: string;
  kind: "pause" | "stop";
  planId: string | null;
  planName: string | null;
  planVersion: number | null;
  affectedPlans: number;
  releasedCount: number;
  releasedCents: string;
  pendingCount: number;
  nativeReleasedCount: number;
  nativeReleasedLamports: string;
  nativePendingCount: number;
  createdAt: string;
};
export type CopyControlReport = {
  wallet: string;
  stoppedAt: string | null;
  activePlans: number;
  reservedCount: number;
  reservedCents: string;
  pendingCount: number;
  nativeReservedCount: number;
  nativeReservedLamports: string;
  nativePendingCount: number;
  events: CopyControlEvent[];
};
