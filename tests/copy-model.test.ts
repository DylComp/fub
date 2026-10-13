import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyError,
  draftFromPlan,
  emptyCopyDraft,
  loadCopyPlans,
  saveCopyPlan,
} from "../src/copy-model";
const address = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const draft = () => ({ ...emptyCopyDraft(), address });
afterEach(() => vi.unstubAllGlobals());
describe("inactive copy plans", () => {
  it("stores exact cents and basis points, preserving identity through edits", () => {
    const plans = saveCopyPlan([], {
      ...draft(),
      buyUsd: "12.34",
      slippage: "0.75",
    });
    expect(plans[0].buyCents).toBe(1234);
    expect(plans[0].slippageBps).toBe(75);
    expect(plans[0].status).toBe("draft");
    const edited = saveCopyPlan(
      plans,
      { ...draftFromPlan(plans[0]), copySells: false, name: "Leader" },
      plans[0].id,
    );
    expect(edited).toHaveLength(1);
    expect(edited[0].id).toBe(plans[0].id);
    expect(edited[0].createdAt).toBe(plans[0].createdAt);
    expect(edited[0].copySells).toBe(false);
  });
  it("rejects handles, duplicate addresses, nonfinite amounts and inconsistent caps", () => {
    for (const patch of [
      { address: "@fomotrader" },
      { address: "0xabc123" },
      { buyUsd: "NaN" },
      { buyUsd: "1e4" },
      { buyUsd: "1.001" },
      { buyUsd: "0" },
      { dailyUsd: "10" },
      { slippage: "5.01" },
      { slippage: "0.09" },
    ])
      expect(copyError({ ...draft(), ...patch }, [])).toBeTruthy();
    const plans = saveCopyPlan([], draft());
    expect(copyError(draft(), plans)).toContain("already");
    expect(() => saveCopyPlan(plans, draft(), "missing")).toThrow();
  });
  it("restores inactive settings and refuses tampered activation or corrupted records", () => {
    const plans = saveCopyPlan([], draft());
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ version: 1, plans }),
    });
    expect(loadCopyPlans().plans).toEqual(plans);
    for (const patch of [
      { status: "active" },
      { buyCents: 1.5 },
      { dailyCents: 0 },
      { copySells: "true" },
    ]) {
      vi.stubGlobal("localStorage", {
        getItem: () =>
          JSON.stringify({ version: 1, plans: [{ ...plans[0], ...patch }] }),
      });
      expect(loadCopyPlans().plans).toEqual([]);
      expect(loadCopyPlans().warning).not.toBe("");
    }
  });
});
