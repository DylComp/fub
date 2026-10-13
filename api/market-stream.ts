import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMarketStream } from '../server/codex-stream.js';
export const config = { maxDuration: 60 };
export default function handler(req: IncomingMessage,res: ServerResponse){return handleMarketStream(req,res);}
