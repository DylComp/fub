import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSearch } from "../server/discovery.js";
import { handleTokenMarket } from "../server/token-market.js";
import { handleNetworkRoute } from '../server/network-routes.js';
export default function handler(req: IncomingMessage, res: ServerResponse) {
  if(new URL(req.url || "/", "https://localhost").searchParams.has("cash")) return import('../server/cash-route-handler.js').then(module => module.handleCashRoute(req, res));
  if(new URL(req.url || "/", "https://localhost").searchParams.has("route")) return handleNetworkRoute(req, res);
  if(new URL(req.url || "/", "https://localhost").searchParams.has("market")) return handleTokenMarket(req, res);
  return handleSearch(req, res);
}
