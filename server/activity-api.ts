import type { IncomingMessage, ServerResponse } from "node:http";
import { readActivity } from "./activity-store.js";
import { launchRecoveryHandler } from "./launch-recovery-api.js";
import { validActivity } from "../src/activity-model.js";
import type { ActivityReport } from "../src/activity-model.js";
export function activityHandler(
  load: (wallet: string | null) => Promise<ActivityReport> = (wallet) =>
    readActivity(process.env.DATABASE_URL!, wallet),
) {
  const privateRead = launchRecoveryHandler({
    allowedActions: ["activity"],
    activity: async (wallet) => {
      const result = await load(wallet);
      if (!validActivity(result, wallet)) throw Error();
      return result;
    },
    list: async () => {
      throw Error();
    },
    check: async () => {
      throw Error();
    },
  });
  let inFlight = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST") return privateRead(req, res);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (code: number, data: unknown) => {
      res.statusCode = code;
      res.end(JSON.stringify(data));
    };
    if (req.method !== "GET")
      return send(405, {
        message: "GET or a signed activity request required.",
      });
    if (new URL(req.url || "/", "https://localhost").search)
      return send(400, { message: "Open Activity to load records." });
    if (inFlight >= 4)
      return send(429, { message: "Activity is busy. Try again shortly." });
    inFlight++;
    try {
      const result = await load(null);
      if (
        !validActivity(result, null) ||
        result.records.some((r) => r.kind === "copy" || r.state !== "confirmed")
      )
        throw Error();
      res.setHeader("Cache-Control", "public, max-age=15, s-maxage=15");
      return send(200, result);
    } catch {
      return send(503, {
        message: "Activity could not be loaded. Try again shortly.",
      });
    } finally {
      inFlight--;
    }
  };
}
export const handleActivity = activityHandler();
