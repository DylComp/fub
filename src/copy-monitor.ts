export type CopyMonitor = {
  available: boolean;
  revision: number;
  enabled: boolean;
  expiresAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  outcome: "idle" | "ready" | "retry" | "gap" | "catching_up" | "busy";
  workerLastStartedAt: string | null;
};
