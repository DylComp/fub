import { useEffect, useRef, useState } from "react";
import type { ActivityReply, HoldingsReply } from "./portfolio-data";
type Reply = HoldingsReply | ActivityReply;
export function usePortfolio(
  address: string,
  view: "holdings" | "activity",
  live: boolean,
) {
  const [refresh, setRefresh] = useState(0);
  const cache = useRef(new Map<string, Reply>());
  const cooldown = useRef(0);
  const [state, setState] = useState<{
    key: string;
    data: Reply | null;
    loading: boolean;
    error: string;
  }>({ key: "", data: null, loading: false, error: "" });
  const key = `${address}:${view}`;
  useEffect(() => {
    if (!address) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let running = false;
    const cached = cache.current.get(key) || null;
    setState({ key, data: cached, loading: true, error: "" });
    async function read() {
      if (stopped || running || document.hidden) return;
      clearTimeout(timer);
      if (!navigator.onLine || Date.now() < cooldown.current) {
        setState((old) => ({
          ...old,
          loading: false,
          error: !navigator.onLine
            ? "You are offline. Reconnect to refresh this wallet."
            : "Wallet reads are busy. Wait a minute before refreshing.",
        }));
        if (live)
          timer = setTimeout(
            read,
            Math.max(30000, cooldown.current - Date.now()),
          );
        return;
      }
      running = true;
      controller = new AbortController();
      setState((old) => ({ ...old, loading: true, error: "" }));
      try {
        const response = await fetch(
          `/api/portfolio?address=${encodeURIComponent(address)}&view=${view}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (response.status === 429) {
          const seconds = Number(response.headers.get("Retry-After"));
          cooldown.current =
            Date.now() +
            Math.max(
              60000,
              Math.min(
                300000,
                (Number.isFinite(seconds) ? seconds : 60) * 1000,
              ),
            );
        }
        if (!response.ok)
          throw new Error(
            response.status === 429
              ? "Wallet reads are busy. Try again in a minute."
              : "Wallet data could not be refreshed. Try again shortly.",
          );
        const data = (await response.json()) as Reply;
        if (
          data.address !== address ||
          !Number.isFinite(data.fetchedAt) ||
          (view === "holdings"
            ? !("holdings" in data) ||
              !Array.isArray(data.holdings) ||
              !Array.isArray(data.missing)
            : !("transactions" in data) || !Array.isArray(data.transactions))
        )
          throw new Error("The wallet response could not be read.");
        if (stopped) return;
        if (cache.current.size >= 10)
          cache.current.delete(cache.current.keys().next().value!);
        cache.current.set(key, data);
        setState({ key, data, loading: false, error: "" });
      } catch (error) {
        if (!stopped && !controller.signal.aborted)
          setState((old) => ({
            ...old,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Wallet data unavailable.",
          }));
      } finally {
        running = false;
        if (!stopped && live && !document.hidden)
          timer = setTimeout(
            read,
            Math.max(30000, cooldown.current - Date.now()),
          );
      }
    }
    const visibility = () => {
      if (document.hidden) clearTimeout(timer);
      else if (live || !cache.current.has(key)) void read();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
    };
  }, [address, view, live, refresh, key]);
  return {
    data: state.key === key ? state.data : null,
    loading: !!address && (state.key !== key || state.loading),
    error: state.key === key ? state.error : "",
    retry: () => setRefresh((value) => value + 1),
  };
}
