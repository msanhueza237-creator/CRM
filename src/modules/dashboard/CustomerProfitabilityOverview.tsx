import { useEffect, useState } from "react";
import { getCustomerProfitability } from "../../lib/accountingApi";
import type { CustomerProfitabilityReport } from "../../../supabase/functions/_shared/customer-profitability-contract";
import { CustomerProfitability } from "./CustomerProfitability";

export function CustomerProfitabilityOverview({ from, to, refreshedAt, periodLabel }: {
  from?: string; to?: string; refreshedAt: string | null; periodLabel: string;
}) {
  const [report, setReport] = useState<CustomerProfitabilityReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to || !refreshedAt) return;
    const abort = new AbortController();
    setLoading(true); setError(""); setReport(undefined);
    const timeout = window.setTimeout(() => {
      abort.abort();
      setLoading(false);
      setError("La consulta de rentabilidad demoró demasiado. Actualiza el panorama para reintentar.");
    }, 45000);
    getCustomerProfitability(from, to, abort.signal)
      .then(value => { if (!abort.signal.aborted) setReport(value); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Rentabilidad no disponible."); })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => { window.clearTimeout(timeout); abort.abort(); };
  }, [from, to, refreshedAt]);
  return <CustomerProfitability report={report} loading={loading} periodLabel={periodLabel} error={error} />;
}
