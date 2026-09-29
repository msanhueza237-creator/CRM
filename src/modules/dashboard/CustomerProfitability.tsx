import { useState } from "react";
import { AlertTriangle, TrendingUp, Percent, BarChart3, Search, X } from "lucide-react";
import type { CustomerProfitabilityReport } from "../../../supabase/functions/_shared/customer-profitability-contract";

const money = (value: number | null) => value == null ? "Pendiente" : value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const percent = (value: number | null) => value == null ? "Sin base" : `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`;

export function CustomerProfitability({ report, loading, periodLabel, error, query, onQueryChange }: {
  report?: CustomerProfitabilityReport; loading: boolean; periodLabel: string; error?: string;
  query: string; onQueryChange: (value: string) => void;
}) {
  const [mode, setMode] = useState<"profit" | "margin" | "sales">("profit");
  const searching = Boolean(query.trim());
  const rows = (searching ? report?.matches : mode === "sales" ? report?.topSales : mode === "profit" ? report?.topProfit : report?.topMargin) || [];
  const max = Math.max(1, ...rows.map(row => Math.abs(mode === "profit" ? row.grossProfit || 0 : row.margin || 0)));
  return <section className="overview-section customer-profitability" aria-label="Rentabilidad por cliente">
    <div className="overview-heading"><div><h2>{searching ? "Rentabilidad de empresas" : mode === "sales" ? "Rentabilidad de los 10 mayores compradores" : "Top 10 clientes más rentables"}</h2><p>{periodLabel} · Utilidad bruta · CLP sin IVA</p></div>
      {!searching && <div className="profitability-modes" role="group" aria-label="Ordenar rentabilidad">
        <button type="button" aria-pressed={mode === "profit"} onClick={() => setMode("profit")}><TrendingUp size={17} /> Utilidad $</button>
        <button type="button" aria-pressed={mode === "margin"} onClick={() => setMode("margin")}><Percent size={17} /> Margen %</button>
        <button type="button" aria-pressed={mode === "sales"} onClick={() => setMode("sales")}><BarChart3 size={17} /> Ventas $</button>
      </div>}
    </div>
    <div className="profitability-search" role="search" aria-label="Buscar rentabilidad de una empresa">
      <Search size={19} aria-hidden="true" />
      <input type="search" aria-label="Buscar empresa por nombre o RUT" placeholder="Empresa o RUT" maxLength={160}
        value={query} onChange={event => onQueryChange(event.target.value)} />
      {query && <button type="button" onClick={() => onQueryChange("")} aria-label="Limpiar búsqueda de empresa" title="Limpiar búsqueda"><X size={19} /></button>}
    </div>
    {report ? <>
      <p className="profitability-coverage" role="status">{searching ? `${rows.length} de ${report.customers} empresas encontradas` : `${report.rankedCustomers} de ${report.customers} clientes con costos completos y ventas netas positivas`}{loading ? " · Actualizando" : ""}</p>
      {rows.length > 0 ? <div className="profitability-table-scroll" tabIndex={0} role="region" aria-label="Ranking de rentabilidad por cliente">
        <table className="profitability-table"><thead><tr><th scope="col">Cliente</th><th scope="col">Ventas netas</th><th scope="col">Costo</th><th scope="col">Utilidad bruta</th><th scope="col">Margen</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={row.customerKey}>
            <th scope="row"><span className="profitability-rank">{index + 1}</span><span>{row.customer}<small>{row.taxId} · {row.documents} documentos</small>
              {(searching || mode === "sales") && <small>{row.status === "complete" ? "Costo verificado" : row.status === "no_positive_sales" ? "Sin ventas netas positivas; margen no aplicable" : row.status === "unidentified" ? "Identidad pendiente" : `${row.missingCostDocuments} costos pendientes · ${row.pendingCreditNotes} notas por verificar`} · Cobertura documental {percent(row.coverage)}</small>}
            </span></th>
            <td data-label="Ventas netas">{money(row.sales)}</td><td data-label="Costo">{money(row.cost)}</td>
            <td data-label="Utilidad bruta" className={mode === "profit" ? "profitability-highlight" : ""}><strong>{money(row.grossProfit)}</strong>{mode === "profit" && <i aria-hidden="true" className={row.grossProfit! < 0 ? "negative" : ""} style={{ width: `${Math.abs(row.grossProfit || 0) / max * 100}%` }} />}</td>
            <td data-label="Margen" className={mode === "margin" ? "profitability-highlight" : ""}><strong>{row.margin === null && ["pending", "unidentified"].includes(row.status) ? "Pendiente" : percent(row.margin)}</strong>{mode === "margin" && <i aria-hidden="true" className={row.margin! < 0 ? "negative" : ""} style={{ width: `${Math.abs(row.margin || 0) / max * 100}%` }} />}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="overview-empty">{searching ? "No se encontraron documentos de venta válidos para esa empresa en el período seleccionado." : report.pendingCustomers ? "No hay información suficiente para un ranking preciso. Hay costos o reversas pendientes." : "Sin clientes con ventas netas positivas y costos completos en este período."}</p>}
      {searching && report.customers > rows.length && <p className="overview-data-note">Hay más coincidencias. Precisa el nombre o RUT de la empresa.</p>}
      {report.pendingCustomers > 0 && <details className="profitability-pending"><summary><AlertTriangle size={17} /> {report.pendingCustomers} clientes pendientes de verificar</summary>
        <p>{report.missingCostDocuments} documentos sin costo completo · {report.pendingCreditNotes} notas de crédito por revisar</p>
        <ul>{report.pending.map(row => <li key={row.customerKey}><strong>{row.customer}</strong><span>{row.status === "unidentified" ? "Identidad pendiente" : `${row.missingCostDocuments} costos pendientes · ${row.pendingCreditNotes} notas por verificar`} · Cobertura {percent(row.coverage)}</span></li>)}</ul>
        {report.pendingCustomers > report.pending.length && <p>Mostrando {report.pending.length} de {report.pendingCustomers} clientes pendientes.</p>}
      </details>}
      <p className="overview-data-note">Ventas y notas de crédito por fecha de emisión; costos y reversas vinculados registrados hasta {report.to}. Sin gastos generales asignados: no equivale a utilidad final. Los costos faltantes no se consideran cero. El margen histórico no equivale a un descuento autorizado.</p>
      {!!report.excludedDocuments && <p className="overview-data-note">{report.excludedDocuments} documentos excluidos por tipo, validación o importes incompletos.</p>}
    </> : <p className="overview-empty" role="status">{loading ? "Calculando rentabilidad por cliente…" : error || "Rentabilidad no disponible. No se recibió la evidencia completa de costos."}</p>}
  </section>;
}
