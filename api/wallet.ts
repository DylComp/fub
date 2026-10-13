import type { IncomingMessage, ServerResponse } from "node:http";
import { handleBalance } from "../server/wallet.js";
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handleBalance(req, res);
}
