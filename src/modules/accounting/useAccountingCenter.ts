import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountingBootstrap, syncAccountingFacto } from "../../lib/accountingApi";
import type { AccountingBootstrap } from "../../types/accounting";

const AUTOMATIC_REFRESH_MS = 2 * 60 * 1000;
const FACTO_HISTORY_START = "2026-01-01";

export function useAccountingCenter() {
  const [data, setData] = useState<AccountingBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const synchronizedMarkerRef = useRef("");

  const load = useCallback(async (background = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
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
      setData(next);
    } catch (caught) {
      if (!background) setError(caught instanceof Error ? caught.message : "No se pudo cargar el centro financiero.");
    } finally {
      loadingRef.current = false;
      if (!background) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    void load(false);
    const interval = window.setInterval(() => void load(true), AUTOMATIC_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  return { data, loading, error, refresh };
}
