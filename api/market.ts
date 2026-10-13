import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMarket } from "../server/codex.js";
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handleMarket(req, res);
}
