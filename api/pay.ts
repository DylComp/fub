import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePay } from "../server/pay-api.js";
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handlePay(req, res);
}
