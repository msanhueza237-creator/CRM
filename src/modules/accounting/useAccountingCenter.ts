import { useCallback, useEffect, useState } from "react";
import { getAccountingBootstrap } from "../../lib/accountingApi";
import type { AccountingBootstrap } from "../../types/accounting";

export function useAccountingCenter() {
  const [data, setData] = useState<AccountingBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await getAccountingBootstrap());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cargar el centro financiero.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { data, loading, error, refresh };
}
