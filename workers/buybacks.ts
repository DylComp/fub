import { runBuybackHost } from "../server/buyback-host.js";
runBuybackHost(process.env).catch(() => {
  console.error(
    "Buyback worker startup refused. Check its private configuration.",
  );
  process.exitCode = 1;
});
