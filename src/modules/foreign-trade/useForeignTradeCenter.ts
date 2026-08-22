import { useCallback, useEffect, useState } from "react";
import { emptyForeignTradeCenterData, getForeignTradeCenterData } from "../../lib/foreignTradeApi";
import type { ForeignTradeCenterData } from "../../types/foreignTrade";

export function useForeignTradeCenter() {
  const [data, setData] = useState<ForeignTradeCenterData>(emptyForeignTradeCenterData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await getForeignTradeCenterData());
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "No se pudo cargar Comercio Exterior.";
      setError(
        /foreign_trade_|import_shipments|does not exist|404/i.test(message)
          ? "Falta ejecutar supabase/foreign_trade_center.sql en Supabase."
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}
