import { useEffect, useState } from "react";

export const pages = [
  "Overview",
  "Orders",
  "Copy trading",
  "Wallets",
  "Pay",
  "Launch",
  "Tokens",
  "Activity",
  "Docs",
] as const;
export type Page = (typeof pages)[number];
const paths: Record<Page, string> = {
  Overview: "overview",
  Orders: "orders",
  "Copy trading": "copy-trading",
  Wallets: "wallets",
  Pay: "pay",
  Launch: "launch",
  Tokens: "tokens",
  Activity: "activity",
  Docs: "docs",
};
function pageFromLocation(): Page {
  if (/^#orders\/(planner|plans)$/.test(window.location.hash)) return "Orders";
  if (window.location.hash === "#info") return "Docs";
  if (window.location.hash === "#token" || window.location.hash.startsWith("#tokens/")) return "Tokens";
  if (/^#(?:pay(?:=|\/|-request$)|preview=)/.test(window.location.hash))
    return "Pay";
  return (
    pages.find((page) => `#${paths[page]}` === window.location.hash) ||
    "Overview"
  );
}
export function usePage() {
  const [page, setPage] = useState(pageFromLocation);
  useEffect(() => {
    const restore = () => {
      // The skip link is a document anchor, not a route.
      if (window.location.hash !== "#main") setPage(pageFromLocation());
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, []);
  function navigate(next: Page) {
    const hash = `#${paths[next]}`;
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    setPage(next);
  }
  return [page, navigate] as const;
}
