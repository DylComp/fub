import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWhopWebhook } from "../server/whop-webhook.js";
export const config = { api: { bodyParser: false } };
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handleWhopWebhook(req, res);
}
