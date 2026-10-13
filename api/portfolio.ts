import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePortfolio } from "../server/portfolio.js";
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handlePortfolio(req, res);
}
