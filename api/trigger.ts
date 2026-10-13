import type { IncomingMessage, ServerResponse } from "node:http";
import { handleTrigger } from "../server/trigger.js";
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handleTrigger(req, res);
}
