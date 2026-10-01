import { useEffect, useState } from "react";
import { getCustomerProfitability } from "../../lib/accountingApi";
import type { CustomerProfitabilityReport } from "../../../supabase/functions/_shared/customer-profitability-contract";
import { CustomerProfitability } from "./CustomerProfitability";

export function CustomerProfitabilityOverview({ from, to, refreshedAt, periodLabel }: {
  from?: string; to?: string; refreshedAt: string | null; periodLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [cohort, setCohort] = useState("all");
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState({ scope: "", offset: 0 });
  const scope = JSON.stringify([from, to, query.trim(), cohort]);
  const offset = page.scope === scope ? page.offset : 0;
  const [result, setResult] = useState<{ key: string; report?: CustomerProfitabilityReport; error?: string }>();
  const requestKey = JSON.stringify([scope, offset, refreshedAt, retry]);
  useEffect(() => {
    if (!from || !to || !refreshedAt) return;
    const abort = new AbortController();
    let timeout: number | undefined;
    const debounce = window.setTimeout(() => {
      timeout = window.setTimeout(() => {
        abort.abort();
        setResult({ key: requestKey, error: "La consulta de rentabilidad demoró demasiado. Actualiza el panorama para reintentar." });
      }, 45000);
      getCustomerProfitability(from, to, abort.signal, query, offset, cohort)
        .then(report => { if (!abort.signal.aborted) setResult({ key: requestKey, report }); })
        .catch(e => { if (!abort.signal.aborted) setResult({ key: requestKey, error: e instanceof Error ? e.message : "Rentabilidad no disponible." }); })
        .finally(() => window.clearTimeout(timeout));
    }, query.trim() ? 350 : 0);
    return () => { window.clearTimeout(debounce); window.clearTimeout(timeout); abort.abort(); };
  }, [from, to, refreshedAt, query, offset, requestKey, cohort]);
  const current = result?.key === requestKey ? result : undefined;
  return <CustomerProfitability report={current?.report} loading={Boolean(from && to && refreshedAt && !current)}
    cohort={cohort} onCohortChange={setCohort} onRetry={() => setRetry(n => n + 1)}
    periodLabel={periodLabel} error={current?.error} query={query} onQueryChange={setQuery}
    onPageChange={offset => setPage({ scope, offset })} />;
}
