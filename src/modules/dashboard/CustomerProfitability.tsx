import { useState } from "react";
import { AlertTriangle, TrendingUp, Percent, BarChart3, Search, X, ChevronLeft, ChevronRight } from "lucide-react";
import type { CustomerProfitabilityReport } from "../../../supabase/functions/_shared/customer-profitability-contract";

const money = (value: number | null) => value == null ? "Pendiente" : value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const percent = (value: number | null) => value == null ? "Sin base" : `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`;

export function CustomerProfitability({ report, loading, periodLabel, error, query, onQueryChange, onPageChange }: {
  report?: CustomerProfitabilityReport; loading: boolean; periodLabel: string; error?: string;
  query: string; onQueryChange: (value: string) => void; onPageChange: (offset: number) => void;
}) {
  const [mode, setMode] = useState<"profit" | "margin" | "sales">("sales");
  const [scope, setScope] = useState<"top" | "all">("top");
  const searching = Boolean(query.trim());
  const all = searching || scope === "all";
  const selected = (all ? report?.matches : mode === "sales" ? report?.topSales : mode === "profit" ? report?.topProfit : report?.topMargin) || [];
  const rows = all ? selected : selected.slice(0, 10);
  const offset = all ? report?.offset || 0 : 0;
  const chooseScope = (value: "top" | "all") => {
    setScope(value); onPageChange(0);
    if (value === "top") { onQueryChange(""); setMode("sales"); }
  };
  const max = Math.max(1, ...rows.map(row => Math.abs(mode === "profit" ? row.grossProfit || 0 : row.margin || 0)));
  return <section className="overview-section customer-profitability" aria-label="Rentabilidad por cliente" aria-busy={loading}>
    <div className="overview-heading"><div><h2>{all ? "Rentabilidad de todos los clientes" : mode === "sales" ? "Top 10 clientes por ventas" : mode === "profit" ? "Top 10 por utilidad bruta" : "Top 10 por margen"}</h2><p>{periodLabel} · Utilidad bruta · CLP sin IVA</p></div>
      <div className="profitability-modes" role="group" aria-label="Clientes incluidos">
        <button type="button" aria-pressed={!all} onClick={() => chooseScope("top")}>Top 10</button>
        <button type="button" aria-pressed={all} onClick={() => chooseScope("all")}>Todos los clientes</button>
      </div>
    </div>
      {!all && <div className="profitability-modes profitability-order" role="group" aria-label="Ordenar rentabilidad">
        <button type="button" aria-pressed={mode === "sales"} onClick={() => setMode("sales")}><BarChart3 size={17} /> Ventas $</button>
        <button type="button" aria-pressed={mode === "profit"} onClick={() => setMode("profit")}><TrendingUp size={17} /> Utilidad $</button>
        <button type="button" aria-pressed={mode === "margin"} onClick={() => setMode("margin")}><Percent size={17} /> Margen %</button>
      </div>}
    <div className="profitability-search" role="search" aria-label="Buscar rentabilidad de una empresa">
      <Search size={19} aria-hidden="true" />
      <input type="search" aria-label="Buscar empresa por nombre o RUT" placeholder="Empresa o RUT" maxLength={160}
        value={query} onChange={event => onQueryChange(event.target.value)} />
      {query && <button type="button" onClick={() => onQueryChange("")} aria-label="Limpiar búsqueda de empresa" title="Limpiar búsqueda"><X size={19} /></button>}
    </div>
    {report ? <>
      <p className="profitability-coverage" role="status">{all ? `${rows.length ? offset + 1 : 0}–${offset + rows.length} de ${report.customers} clientes · Mayor venta primero` : mode === "sales" ? `${rows.length} mayores compradores de ${report.salesCustomers} · Ventas netas, de mayor a menor` : `${report.rankedCustomers} de ${report.customers} clientes con costos completos y ventas netas positivas`}{loading ? " · Actualizando" : ""}</p>
      {rows.length > 0 ? <div className="profitability-table-scroll" tabIndex={0} role="region" aria-label="Ranking de rentabilidad por cliente">
        <table className="profitability-table"><thead><tr><th scope="col">Cliente</th><th scope="col">Ventas netas</th><th scope="col">Costo</th><th scope="col">Utilidad bruta</th><th scope="col">Margen</th></tr></thead>
          <tbody>{rows.map((row, index) => {
            const analysis = row.analysis || { status: row.cost === null ? "unavailable" : "verified", sales: row.sales, cost: row.cost, grossProfit: row.grossProfit, margin: row.margin };
            const partial = analysis.status === "partial", provisional = analysis.status === "provisional";
            const label = partial ? "Parcial" : provisional ? "Provisional" : analysis.status === "verified" ? "Verificado" : "Sin evidencia suficiente";
            return <tr key={row.customerKey}>
              <th scope="row"><span className="profitability-rank">{offset + index + 1}</span><span>{row.customer}<small>{row.taxId} · {row.documents} documentos</small>
                <small className={partial || provisional ? "profitability-status-warning" : ""}>{label} · Cobertura documental {percent(row.coverage)}</small>
                {row.status === "unidentified" ? <small>Identidad pendiente</small> : (row.missingCostDocuments > 0 || row.pendingCreditNotes > 0) && <small>{row.missingCostDocuments} costos pendientes · {row.pendingCreditNotes} notas por verificar</small>}
                {partial && <small>Base parcial: {money(analysis.sales)} en ventas con costo documentado. Documentos pendientes excluidos.</small>}
                {provisional && <small>Ventas netas con notas descontadas; reversas de costo pendientes no aplicadas.</small>}
              </span></th>
              <td data-label="Ventas netas">{money(row.sales)}</td>
              <td data-label={partial || provisional ? "Costo documentado" : "Costo"}>{money(analysis.cost)}{(partial || provisional) && <small>Documentado</small>}</td>
              <td data-label={partial ? "Utilidad parcial" : provisional ? "Utilidad provisional" : "Utilidad bruta"} className={!all && mode === "profit" ? "profitability-highlight" : ""}><strong>{money(analysis.grossProfit)}</strong>{(partial || provisional) && <small>{label}</small>}{!all && mode === "profit" && <i aria-hidden="true" className={(row.grossProfit || 0) < 0 ? "negative" : ""} style={{ width: `${Math.abs(row.grossProfit || 0) / max * 100}%` }} />}</td>
              <td data-label={partial ? "Margen parcial" : provisional ? "Margen provisional" : "Margen"} className={!all && mode === "margin" ? "profitability-highlight" : ""}><strong>{analysis.status === "unavailable" ? "Pendiente" : percent(analysis.margin)}</strong>{(partial || provisional) && <small>{label}</small>}{!all && mode === "margin" && <i aria-hidden="true" className={(row.margin || 0) < 0 ? "negative" : ""} style={{ width: `${Math.abs(row.margin || 0) / max * 100}%` }} />}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <p className="overview-empty">{searching ? "No se encontraron documentos de venta válidos para esa empresa en el período seleccionado." : report.pendingCustomers ? "No hay información suficiente para un ranking preciso. Hay costos o reversas pendientes." : "Sin clientes con ventas netas positivas y costos completos en este período."}</p>}
      {all && report.customers > report.limit && <nav className="profitability-pagination" aria-label="Páginas de clientes">
        <button type="button" disabled={loading || offset === 0} onClick={() => onPageChange(Math.max(0, offset - report.limit))} aria-label="Clientes anteriores" title="Clientes anteriores"><ChevronLeft size={20} /></button>
        <span>Página {Math.floor(offset / report.limit) + 1} de {Math.ceil(report.customers / report.limit)}</span>
        <button type="button" disabled={loading || offset + rows.length >= report.customers} onClick={() => onPageChange(offset + report.limit)} aria-label="Clientes siguientes" title="Clientes siguientes"><ChevronRight size={20} /></button>
      </nav>}
      {report.pendingCustomers > 0 && <details className="profitability-pending"><summary><AlertTriangle size={17} /> {report.pendingCustomers} clientes pendientes de verificar</summary>
        <p>{report.missingCostDocuments} documentos sin costo completo · {report.pendingCreditNotes} notas de crédito por revisar</p>
        <ul>{report.pending.map(row => <li key={row.customerKey}><strong>{row.customer}</strong><span>{row.status === "unidentified" ? "Identidad pendiente" : `${row.missingCostDocuments} costos pendientes · ${row.pendingCreditNotes} notas por verificar`} · Cobertura {percent(row.coverage)}</span></li>)}</ul>
        {report.pendingCustomers > report.pending.length && <p>Mostrando {report.pending.length} de {report.pendingCustomers} clientes pendientes.</p>}
      </details>}
      <p className="overview-data-note">Ventas y notas de crédito por fecha de emisión; costos y reversas vinculados registrados hasta {report.to}. Sin gastos generales asignados: no equivale a utilidad final. Los costos faltantes no se consideran cero. Los resultados parciales y provisionales no participan en los rankings de mayor utilidad o margen. El margen histórico no equivale a un descuento autorizado.</p>
      {!!report.excludedDocuments && <p className="overview-data-note">{report.excludedDocuments} documentos excluidos por tipo, validación o importes incompletos.</p>}
    </> : <p className="overview-empty" role="status">{loading ? "Calculando rentabilidad por cliente…" : error || "Rentabilidad no disponible. No se recibió la evidencia completa de costos."}</p>}
  </section>;
}
