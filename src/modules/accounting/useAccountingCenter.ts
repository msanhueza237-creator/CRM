import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountingBootstrap, syncAccountingFacto } from "../../lib/accountingApi";
import type { AccountingBootstrap } from "../../types/accounting";
import { LatestReadQueue } from "./latestReadQueue";

const AUTOMATIC_REFRESH_MS = 2 * 60 * 1000;
const FACTO_HISTORY_START = "2026-01-01";

export function useAccountingCenter() {
  const [data, setData] = useState<AccountingBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const queue = useRef(new LatestReadQueue<AccountingBootstrap>());
  const synchronizedMarkerRef = useRef("");

  const load = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      await queue.current.request(async () => {
        let next = await getAccountingBootstrap();
        const marker = next.factoFreshness.integrationUpdatedAt || "";
        const canSynchronize = next.profile.permissions.includes("import");
        if (canSynchronize && next.factoFreshness.stale && marker && marker !== synchronizedMarkerRef.current) {
          synchronizedMarkerRef.current = marker;
          try {
            await syncAccountingFacto({
              fromDate: FACTO_HISTORY_START,
              toDate: new Date().toISOString().slice(0, 10),
            });
            next = await getAccountingBootstrap();
          } catch {
            synchronizedMarkerRef.current = "";
          }
        }
        return next;
      }, setData, !background);
    } catch (caught) {
      if (!background) setError(caught instanceof Error ? caught.message : "No se pudo cargar el centro financiero.");
      if (!background) throw caught;
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    void load(false).catch(() => undefined);
    const interval = window.setInterval(() => void load(true), AUTOMATIC_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(true); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { data, loading, error, refresh };
}
