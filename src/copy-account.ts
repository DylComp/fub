import { isMint } from "./assets.js";
import { operationId } from "./funding-model.js";
import { copyError, saveCopyPlan } from "./copy-model.js";
import type { CopyDraft, CopyPlan } from "./copy-model.js";
export class CopyValidation extends Error {}
export type AccountCopyPlan = CopyPlan & {
  wallet: string;
  version: number;
  archived: boolean;
  enabled: boolean;
};
export function parseCopySave(value: unknown, wallet: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CopyValidation("Invalid copy settings.");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== "draft,id,version" ||
    !operationId(row.id) ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 0 ||
    (row.version as number) > 2147483646
  )
    throw new CopyValidation("Invalid copy plan version.");
  const draft = row.draft as CopyDraft;
  if (
    !draft ||
    typeof draft !== "object" ||
    Object.keys(draft).filter((key) => key !== "identity").sort().join(",") !==
      "address,buyUsd,copySells,dailyUsd,name,slippage" ||
    ![
      draft.address,
      draft.name,
      draft.buyUsd,
      draft.dailyUsd,
      draft.slippage,
    ].every((value) => typeof value === "string" && value.length <= 80) ||
    typeof draft.copySells !== "boolean"
  )
    throw new CopyValidation("Invalid copy settings.");
  if (!isMint(wallet) || draft.address.trim() === wallet)
    throw new CopyValidation("Choose another wallet to follow.");
  const issue = copyError(draft, []);
  if (issue) throw new CopyValidation(issue);
  return {
    id: row.id,
    version: row.version as number,
    plan: { ...saveCopyPlan([], draft)[0], id: row.id },
  };
}
export function proportionalSell(
  ownedRaw: string,
  leaderBeforeRaw: string,
  leaderSoldRaw: string,
) {
  for (const value of [ownedRaw, leaderBeforeRaw, leaderSoldRaw])
    if (
      typeof value !== "string" ||
      !/^(0|[1-9]\d{0,19})$/.test(value) ||
      BigInt(value) > 18446744073709551615n
    )
      throw new CopyValidation("Invalid token units.");
  const owned = BigInt(ownedRaw),
    before = BigInt(leaderBeforeRaw),
    sold = BigInt(leaderSoldRaw);
  if (before === 0n || sold > before)
    throw new CopyValidation("The leader's sell could not be verified.");
  return ((owned * sold) / before).toString();
}
