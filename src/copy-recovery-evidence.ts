export type CopyRecoveryEvidence = {
  kind:
    | "not_indexed"
    | "awaiting_finality"
    | "receipt_unavailable"
    | "inconsistent"
    | "provider_unavailable"
    | "block_receipt"
    | "indexed_receipt";
  checkedAt: number;
  slot?: number;
};
export function recoveryEvidenceText(evidence?: CopyRecoveryEvidence) {
  switch (evidence?.kind) {
    case "not_indexed":
      return "No receipt found yet. This does not prove the trade failed.";
    case "awaiting_finality":
      return "Seen on-chain. Waiting for final confirmation.";
    case "receipt_unavailable":
      return "The signature is finalized, but its complete receipt is unavailable.";
    case "inconsistent":
      return "Returned evidence did not match this trade. Its reservation remains locked.";
    case "provider_unavailable":
      return "The provider could not complete this check.";
    default:
      return "";
  }
}
