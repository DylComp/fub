import {handleGiftCheckout} from './server/gift-checkout-api';
import {handlePayTransfer} from "./server/pay-transfer-api";
import { handleBitrefill } from "./server/bitrefill-api";
import handleWalletSession from './api/wallet-session';
import { handlePayHistory } from "./server/pay-history-api";
import { handlePayIssuerWebhook } from "./server/pay-issuer-webhook";
import { handleActivity } from "./server/activity-api";
import { defineConfig, loadEnv } from "vite";
import { handlePayWallet } from "./server/pay-wallet-api";
import { handlePay } from "./server/pay-api";
import { handleLaunchPublication } from "./server/launch-publication-api";
import { handleLaunch } from "./server/launch-api";
import { handleLaunchRecovery } from "./server/launch-recovery-api";
import { handleTokenDirectory } from "./server/token-directory-api";
import react from "@vitejs/plugin-react";
import { handlePortfolio } from "./server/portfolio";
import { handleBalance } from "./server/wallet";
import { handleMarket } from "./server/codex";
import { handleSearch } from "./server/discovery";
import { handleNetworkRoute } from './server/network-routes';
import { handleCashRoute } from './server/cash-route-handler';
import { handleCopyMonitor } from "./server/copy-monitor-worker";
import { handleTrigger } from "./server/trigger";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), [
    "CODEX_",
    "SOLANA_",
    "JUPITER_",
    "DATABASE_",
    "TRIGGER_",
    "COPY_",
    "CRON_",
    "FOMO_LOOKUP_",
  ]);
  for (const key of [
    "DATABASE_URL",
    "SOLANA_RPC_URL",
    "TRIGGER_SESSION_SECRET",
    "FUB_SESSION_SECRET",
    "JUPITER_KEYLESS_ENABLED",
    "COPY_MONITOR_ENABLED",
    "CRON_SECRET",
    "FOMO_LOOKUP_API_KEY",
  ])
    if (env[key]) process.env[key] = env[key];
  return {
    plugins: [
      react(),
      {
        name: "local-market-api",
        configureServer(server) {
          server.middlewares.use("/api/wallet-session", (req,res) => { void handleWalletSession(req,res); });
          server.middlewares.use("/api/launch-execute", async (req, res) => {
        const {handleLaunchExecution}=await import("./server/launch-execution-api");
        await handleLaunchExecution(req,res);
      });
      server.middlewares.use("/api/launch-history", (req, res) => { void handleLaunchRecovery(req, res); });
          server.middlewares.use("/api/launch-assets", (req, res) => { void handleLaunchPublication(req, res); });
          server.middlewares.use("/m", (req, res) => { req.url = `/m${req.url}`; void handleLaunchPublication(req, res); });
          server.middlewares.use("/api/launch", (req, res) => { void handleLaunch(req, res); });
          server.middlewares.use("/api/pay-issuer-webhook", (req,res) => { void handlePayIssuerWebhook(req,res); });
          server.middlewares.use("/api/pay-history", (req,res) => { void handlePayHistory(req,res); });
          server.middlewares.use("/api/gift-checkout", (req,res) => { void handleGiftCheckout(req,res); });
          server.middlewares.use("/api/bitrefill", (req,res) => { void handleBitrefill(req,res); });
          server.middlewares.use("/api/pay-transfer", (req,res) => { void handlePayTransfer(req,res); });
          server.middlewares.use("/api/pay-wallet", (req,res) => { void handlePayWallet(req,res); });
          server.middlewares.use("/api/pay", (req, res) => {
            void handlePay(
              req,
              res,
              env.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL,
            );
          });
          server.middlewares.use("/api/copy-monitor", (req, res) => {
            void handleCopyMonitor(req, res);
          });
          server.middlewares.use("/api/trigger", (req, res) => {
            void handleTrigger(
              req,
              res,
              env.JUPITER_API_KEY || process.env.JUPITER_API_KEY,
            );
          });
          server.middlewares.use("/api/portfolio", (req, res) => {
            void handlePortfolio(
              req,
              res,
              env.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL,
            );
          });
          server.middlewares.use("/api/wallet", (req, res) => {
            void handleBalance(
              req,
              res,
              env.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL,
            );
          });
          server.middlewares.use("/api/activity", (req,res) => { void handleActivity(req,res); });
          server.middlewares.use("/api/token-directory", (req,res) => { void handleTokenDirectory(req,res); });
          server.middlewares.use("/api/tokens", (req, res) => {
            if (new URL(req.url || '/', 'https://localhost').searchParams.has('cash')) { void handleCashRoute(req, res); return; }
            if (new URL(req.url || '/', 'https://localhost').searchParams.has('route')) { void handleNetworkRoute(req, res); return; }
            void handleSearch(req, res);
          });
          server.middlewares.use("/api/market", (req, res) => {
            void handleMarket(
              req,
              res,
              env.CODEX_API_KEY || process.env.CODEX_API_KEY,
            );
          });
        },
      },
    ],
  };
});
