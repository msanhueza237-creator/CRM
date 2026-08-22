import { useCallback, useEffect, useState } from "react";
import { getForeignTradeOperationDetail } from "../../lib/foreignTradeApi";
import type { ForeignTradeOperationDetail } from "../../types/foreignTrade";

export function useForeignTradeOperation(operationId: string) {
  const [detail, setDetail] = useState<ForeignTradeOperationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDetail(await getForeignTradeOperationDetail(operationId));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "No se pudo cargar la operación.";
      setError(/foreign_trade_center_phase2|does not exist|404/i.test(message)
        ? "Falta ejecutar supabase/foreign_trade_center_phase2.sql en Supabase."
        : message);
    } finally {
      setLoading(false);
    }
  }, [operationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { detail, error, loading, refresh };
}
