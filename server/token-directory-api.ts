import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint } from "../src/assets.js";
import { validDirectory } from "../src/token-directory-model.js";
import {
  tokenDirectoryStore,
  directoryCursor,
} from "./token-directory-store.js";
import type { DirectoryQuery } from "./token-directory-store.js";
import type { DirectoryResult } from "../src/token-directory-model.js";
export function tokenDirectoryHandler(
  load: (q: DirectoryQuery) => Promise<DirectoryResult> = (q) =>
    tokenDirectoryStore(process.env.DATABASE_URL!).list(q),
) {
  let pending = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (code: number, data: unknown) => {
      res.statusCode = code;
      res.end(JSON.stringify(data));
    };
    if (req.method !== "GET") return send(405, { message: "GET required." });
    let query: DirectoryQuery;
    try {
      const q = new URL(req.url || "/", "https://localhost").searchParams,
        view = q.get("view") || "tokens",
        search = (q.get("q") || "").trim().replace(/^@/, "");
      if (
        [...q.keys()].some(
          (k) =>
            !["view", "q", "recipient", "cursor", "token"].includes(k) ||
            q.getAll(k).length !== 1,
        ) ||
        !["tokens", "profiles"].includes(view) ||
        (q.has("token") && (view!=="tokens" || !(isMint(q.get("token")!) || /^[a-f0-9]{64}$/.test(q.get("token")!)))) ||
        search.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(search) ||
        (q.has("recipient") && !isMint(q.get("recipient") || "")) ||
        (req.url?.length || 0) > 2048
      )
        throw Error();
      query = {
        view: view as DirectoryQuery["view"],
        ...(q.has("token")?{token:q.get("token")!}:{}),
        q: search,
        recipient: q.get("recipient"),
        cursor: q.get("cursor"),
      };
      directoryCursor(query);
    } catch {
      return send(400, { message: "Check the directory search or page link." });
    }
    if (pending >= 5)
      return send(429, {
        message: "The directory is busy. Try again shortly.",
      });
    pending++;
    try {
      const result = await load(query);
      if (!validDirectory(result, query.view)) throw Error();
      res.setHeader(
        "Cache-Control",
        query.token ? "no-store" : "public, max-age=5, s-maxage=5",
      );
      return send(200, result);
    } catch {
      return send(503, {
        message:
          "Token records are temporarily unavailable. Try again shortly.",
      });
    } finally {
      pending--;
    }
  };
}
export const handleTokenDirectory = tokenDirectoryHandler();
