import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";
import { useState } from "react";
import type { AccountingBootstrap } from "../../types/accounting";
import { dashboardDetailRows, dashboardMetrics, exactDocumentLink, type DashboardMetric } from "./dashboardNavigation";
import { reportPeriod } from "./reportNavigation";

const money = (value: number) => value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
export function DashboardDetailView({ data }: { data: AccountingBootstrap }) {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const metric = params.get("metric") as DashboardMetric;
  const valid = Object.prototype.hasOwnProperty.call(dashboardMetrics, metric || "");
  const from = params.get("from") ?? data.dashboard.from, to = params.get("to") ?? data.dashboard.to;
  const period = reportPeriod(new URLSearchParams({ from, to }), "", "");
  const validPeriod = Boolean(period.from && period.to);
  const coveredPeriod = from >= data.dashboard.from && to <= data.dashboard.to;
  const rows = valid && validPeriod && coveredPeriod ? dashboardDetailRows(data.dashboard, metric, from, to) : null;
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const filtered = rows?.filter(row => normalize(`${row.label} ${row.counterpart}`).includes(normalize(search))) || [];
  const change = (key: string, value: string) => { const next = new URLSearchParams(params); next.set(key, value); setParams(next); };
  const countOnly = metric === "cost-missing" || metric === "cost-confirmed";
  return <section className="accounting-dashboard-detail">
    <Link className="overview-chart-link" to={`/dashboard?period=${from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : "year"}`}><ArrowLeft size={17} /> Volver al dashboard</Link>
    <div className="accounting-panel-heading"><div><p>Detalle del indicador · CLP</p><h2>{valid ? dashboardMetrics[metric] : "Indicador no disponible"}</h2><span>{from} al {to}</span></div><strong>{rows ? `${filtered.length} de ${rows.length}` : "No disponible"}</strong></div>
    <div className="accounting-filter-grid"><label>Desde<input aria-label="Desde" type="date" value={from} onChange={event => change("from", event.target.value)} /></label><label>Hasta<input aria-label="Hasta" type="date" value={to} onChange={event => change("to", event.target.value)} /></label><label>Buscar<input value={search} placeholder="Documento, cliente o cuenta" onChange={event => setSearch(event.target.value)} /></label></div>
    {rows === null ? <p role="alert">{!validPeriod ? "Revisa las fechas: el inicio debe ser anterior o igual al fin del período." : !coveredPeriod ? `El detalle disponible cubre del ${data.dashboard.from} al ${data.dashboard.to}.` : "No se pudo obtener el detalle verificado de este indicador."}</p> : <>
      <p className="accounting-detail-total"><strong>{money(filtered.reduce((sum, row) => sum + row.amount, 0))}</strong> {countOnly ? "Venta neta de los documentos seleccionados" : "Total del detalle"}</p>
      <div className="table-scroll"><table><thead><tr>{["Fecha", "Documento / asiento", "Cliente / detalle", "Estado", countOnly ? "Venta neta CLP" : "Importe CLP", "Fuente"].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{filtered.map(row => <tr key={row.key}>
        <td data-label="Fecha">{row.date}</td><td data-label="Documento / asiento"><strong>{row.label}</strong></td><td data-label="Cliente / detalle">{row.counterpart || "Sin identificar"}</td><td data-label="Estado">{row.status}</td><td data-label="Importe CLP" className="accounting-detail-money">{money(row.amount)}</td><td data-label="Fuente">{row.sourceId ? <Link to={exactDocumentLink(row.sourceId, row.issuedOn)} title="Abrir este documento"><ExternalLink size={16} /> Documento</Link> : "Asiento manual"}</td>
      </tr>)}</tbody></table></div>
      {!filtered.length && <p className="accounting-detail-empty"><Search size={20} /> Sin casos para este filtro y período.</p>}
    </>}
  </section>;
}
