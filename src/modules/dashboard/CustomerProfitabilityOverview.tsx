import { useEffect, useState } from "react";
import { getCustomerProfitability } from "../../lib/accountingApi";
import type { CustomerProfitabilityReport } from "../../../supabase/functions/_shared/customer-profitability-contract";
import { CustomerProfitability } from "./CustomerProfitability";

export function CustomerProfitabilityOverview({ from, to, refreshedAt, periodLabel }: {
  from?: string; to?: string; refreshedAt: string | null; periodLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ key: string; report?: CustomerProfitabilityReport; error?: string }>();
  const requestKey = JSON.stringify([from, to, refreshedAt, query.trim()]);
  useEffect(() => {
    if (!from || !to || !refreshedAt) return;
    const abort = new AbortController();
    let timeout: number | undefined;
    const debounce = window.setTimeout(() => {
      timeout = window.setTimeout(() => {
        abort.abort();
        setResult({ key: requestKey, error: "La consulta de rentabilidad demoró demasiado. Actualiza el panorama para reintentar." });
      }, 45000);
      getCustomerProfitability(from, to, abort.signal, query)
        .then(report => { if (!abort.signal.aborted) setResult({ key: requestKey, report }); })
        .catch(e => { if (!abort.signal.aborted) setResult({ key: requestKey, error: e instanceof Error ? e.message : "Rentabilidad no disponible." }); })
        .finally(() => window.clearTimeout(timeout));
    }, query.trim() ? 350 : 0);
    return () => { window.clearTimeout(debounce); window.clearTimeout(timeout); abort.abort(); };
  }, [from, to, refreshedAt, query, requestKey]);
  const current = result?.key === requestKey ? result : undefined;
  return <CustomerProfitability report={current?.report} loading={Boolean(from && to && refreshedAt && !current)}
    periodLabel={periodLabel} error={current?.error} query={query} onQueryChange={setQuery} />;
}
