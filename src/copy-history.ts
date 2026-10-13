import { recoveryEvidenceText } from "./copy-recovery-evidence.js";
import type { CopyRecoveryEvidence } from "./copy-recovery-evidence.js";
export type CopyTradeRecord = {
  id: string;
  side: "buy" | "sell";
  state:
    | "reserved"
    | "submitting"
    | "unknown"
    | "confirmed"
    | "failed"
    | "released"
    | "skipped";
  mint: string;
  inputRaw: string;
  inputDecimals: number;
  minimumOutputRaw: string;
  outputDecimals: number;
  outputRaw?: string;
  signature?: string;
  recoveryEvidence?: CopyRecoveryEvidence;
  releaseReason?: "paused" | "stopped" | "edited" | "archived" | "expired";
  signing?: {
    state: "requested" | "signed" | "uncertain" | "abandoned";
    requestedAt: string;
    updatedAt: string;
  };
  recovery?: {
    checkedAt: string | null;
    nextCheckAt: string;
    checks: number;
    outcome: "waiting" | "busy" | "unknown" | "retry" | "confirmed" | "failed";
  };
  updatedAt: string;
};

export function signingStatus(attempt: CopyTradeRecord) {
  if (attempt.state !== "reserved" || !attempt.signing) return "";
  return {
    requested: "Signature requested. No submission recorded.",
    signed: "Signature received. No submission recorded.",
    uncertain:
      "Signing response unavailable. This request will not be repeated automatically.",
    abandoned: "Signing stopped before a provider request was sent.",
  }[attempt.signing.state];
}
export type CopyHistoryReport = {
  wallet: string;
  planId: string;
  day: string;
  buySpentCents: string;
  buyReservedCents: string;
  sellProceedsRaw: string;
  attempts: CopyTradeRecord[];
  hasMore: boolean;
  checkedAt: number;
  backgroundRecovery?: {
    available: boolean;
    workerStartedAt: string | null;
    workerFinishedAt: string | null;
  };
};

function backgroundStatus(
  attempt: CopyTradeRecord,
  background: CopyHistoryReport["backgroundRecovery"],
  now = Date.now(),
) {
  if (!["submitting", "unknown"].includes(attempt.state)) return "";
  if (!background?.available)
    return "Background checks are paused. You can check confirmation here.";
  const heartbeat = Date.parse(background.workerStartedAt || "");
  if (
    !Number.isFinite(heartbeat) ||
    heartbeat > now + 5000 ||
    now - heartbeat > 180000
  )
    return "Background checks are overdue. You can check confirmation here.";
  const recovery = attempt.recovery;
  if (!recovery) return "Queued for a background confirmation check.";
  if (recovery.outcome === "retry")
    return "The last background check could not verify the result. The trade remains locked and will be checked again.";
  const next = Date.parse(recovery.nextCheckAt);
  if (Number.isFinite(next) && next > now)
    return `Still awaiting a finalized receipt. Another background check is scheduled after ${new Date(next).toLocaleTimeString()}.`;
  return "Waiting for the next background confirmation check.";
}

export function recoveryStatus(
  attempt: CopyTradeRecord,
  background: CopyHistoryReport["backgroundRecovery"],
  now = Date.now(),
) {
  if (!["submitting", "unknown"].includes(attempt.state)) return "";
  return [
    recoveryEvidenceText(attempt.recoveryEvidence),
    backgroundStatus(attempt, background, now),
  ]
    .filter(Boolean)
    .join(" ");
}
