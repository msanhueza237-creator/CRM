import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { getCompanyInsights, type CompanyInsights as Insights } from "../../lib/copilotCentralApi";
import type { CustomerProfitabilityRow } from "../../../supabase/functions/_shared/customer-profitability-contract";
import { useAuth } from "../auth/AuthContext";
import "./company-insights.css";

const todayChile = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const money = (value: unknown, currency = "CLP") => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("es-CL", { style: "currency", currency, maximumFractionDigits: currency === "CLP" ? 0 : 2 }) : "Pendiente";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function CompanyInsights({ companyId }: { companyId: string }) {
  const { user } = useAuth();
  const today = todayChile(), year = Number(today.slice(0,4));
  const [period, setPeriod] = useState("this_year");
  const [customFrom, setCustomFrom] = useState(`${year}-01-01`), [customTo, setCustomTo] = useState(today);
  const [metric, setMetric] = useState("net_sales"), [currency, setCurrency] = useState("CLP");
  const [page, setPage] = useState({ scope: "", offset: 0 }), [refresh, setRefresh] = useState(0);
  const from = period === "custom" ? customFrom : period === "last_year" ? `${year-1}-01-01` : period === "all" ? "2000-01-01" : `${year}-01-01`;
  const to = period === "custom" ? customTo : period === "last_year" ? `${year-1}-12-31` : today;
  const scope = JSON.stringify([companyId, user?.id, user?.role, from, to, metric, currency]);
  const offset = page.scope === scope ? page.offset : 0, key = JSON.stringify([scope, offset, refresh]);
  const [result, setResult] = useState<{ key: string; data?: Insights; error?: string }>();
  const current = result?.key === key ? result : undefined;
  useEffect(() => {
    if (!user) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => { abort.abort(); setResult({ key, error: "La consulta demoro demasiado. Vuelve a actualizar." }); }, 60000);
    if (!from || !to || from > to || to > today) { setResult({ key, error: "Selecciona un periodo valido, hasta hoy." }); window.clearTimeout(timer); return; }
    getCompanyInsights(companyId, from, to, metric, currency, offset, abort.signal)
      .then(data => { if (!abort.signal.aborted) setResult({ key, data }); })
      .catch(error => { if (!abort.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "No se pudo cargar el analisis." }); })
      .finally(() => window.clearTimeout(timer));
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [key, companyId, from, to, metric, currency, offset, today, user]);
  return <CompanyInsightsView data={current?.data} loading={!current} error={current?.error} from={from} to={to}
    controls={<div className="company-insight-controls">
      <label>Periodo<select aria-label="Periodo comercial de la empresa" value={period} onChange={e => setPeriod(e.target.value)}>
        <option value="this_year">Este año</option><option value="last_year">Año anterior</option><option value="all">Todo el historial disponible</option><option value="custom">Personalizado</option>
      </select></label>
      {period === "custom" && <><label>Desde<input type="date" aria-label="Desde" value={customFrom} max={to} onChange={e=>setCustomFrom(e.target.value)} /></label>
        <label>Hasta<input type="date" aria-label="Hasta" value={customTo} min={from} max={today} onChange={e=>setCustomTo(e.target.value)} /></label></>}
      <button type="button" className="ghost-button company-insight-icon" aria-label="Actualizar analisis de empresa" title="Actualizar analisis" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={18}/></button>
    </div>}
    productControls={<div className="company-insight-controls"><label>Ordenar por<select aria-label="Orden de productos comprados" value={metric} onChange={e=>setMetric(e.target.value)}><option value="net_sales">Mayor importe de venta</option><option value="units">Más unidades</option></select></label>
      <label>Moneda<select aria-label="Moneda de productos comprados" value={currency} onChange={e=>setCurrency(e.target.value)}><option>CLP</option><option>USD</option><option>EUR</option></select></label></div>}
    pagination={<nav className="company-insight-pagination" aria-label="Paginas de productos comprados">
      <button className="ghost-button company-insight-icon" type="button" title="Productos anteriores" aria-label="Productos anteriores" disabled={!current?.data || offset===0} onClick={()=>setPage({scope,offset:Math.max(0,offset-10)})}><ChevronLeft size={20}/></button>
      <span>Página {Math.floor(offset/10)+1}</span>
      <button className="ghost-button company-insight-icon" type="button" title="Productos siguientes" aria-label="Productos siguientes" disabled={current?.data?.products.coverage.nextOffset===undefined} onClick={()=>setPage({scope,offset:offset+10})}><ChevronRight size={20}/></button>
    </nav>} />;
}

export function CompanyInsightsView({ data, loading, error, from, to, controls, productControls, pagination }: {
  data?: Insights; loading: boolean; error?: string; from: string; to: string; controls?: React.ReactNode; productControls?: React.ReactNode; pagination?: React.ReactNode;
}) {
  const financial = record(data?.profitability.data);
  const row = (Array.isArray(financial.ranking) ? financial.ranking[0] : undefined) as CustomerProfitabilityRow | undefined;
  const analysis = row?.analysis;
  const status = analysis?.status === "verified" ? "Verificado" : analysis?.status === "provisional" ? "Provisional" : analysis?.status === "partial" ? "Parcial" : "Sin evidencia suficiente";
  const history = record(record(data?.profile.data).purchaseHistory);
  const products = data?.products.table?.rows || [];
  return <section className="company-insights" aria-label="Analisis comercial de la empresa" aria-busy={loading}>
    <div className="company-insight-heading"><div><h2>Ventas y rentabilidad</h2><p>{from} al {to} · CLP sin IVA</p></div>{controls}</div>
    {loading ? <p role="status">Consultando historial y costos…</p> : error ? <p role="alert">{error}</p> : <>
      {typeof history.invoiceCount === "number" && <p className="company-insight-history">{history.invoiceCount > 0 ? `Cliente con ${history.invoiceCount} facturas verificadas · Primera compra: ${history.firstPurchase} · Última compra: ${history.lastPurchase}` : String(history.basis)}</p>}
      {row ? <>
        <div className="company-insight-kpis">
          <div><span>Ventas netas</span><strong>{money(row.sales)}</strong></div>
          <div><span>Costo documentado</span><strong>{money(analysis?.cost)}</strong></div>
          <div><span>Utilidad bruta</span><strong>{money(analysis?.grossProfit)}</strong><small>{status}</small></div>
          <div><span>Margen sobre venta</span><strong>{analysis?.margin == null ? "Pendiente" : `${analysis.margin.toLocaleString("es-CL",{maximumFractionDigits:1})}%`}</strong><small>{status}</small></div>
        </div>
        {analysis?.status !== "verified" && <p className="company-insight-warning">{analysis?.status === "partial" ? `Base parcial: ${money(analysis.sales)} de ventas con costo documentado, no el total del cliente.` : analysis?.status === "provisional" ? "Notas descontadas de las ventas; reversas de costo pendientes no aplicadas." : "No hay evidencia suficiente para calcular utilidad y margen."} {row.missingCostDocuments} costos pendientes · {row.pendingCreditNotes} notas por verificar.</p>}
        <p className="company-insight-note">Utilidad bruta, sin gastos generales asignados. No es utilidad final ni un descuento autorizado. Los costos faltantes no se consideran cero.</p>
      </> : <p className="company-insight-note">{data?.profitability.status === "forbidden" ? "Tu perfil no tiene acceso a utilidad y margenes." : ["ok","empty"].includes(data?.profitability.status || "") ? "Sin documentos de venta verificados en este periodo." : data?.profitability.summary || "Rentabilidad no disponible."}</p>}
      <div className="company-insight-heading company-products-heading"><div><h3>Productos más comprados</h3><p>Ventas facturadas sin IVA · Descuentos aplicados · Antes de devoluciones pendientes</p></div>{productControls}</div>
      {products.length ? <>
        <div className="company-products-scroll" role="region" aria-label="Productos comprados por la empresa" tabIndex={0}><table>
          <thead><tr><th>Producto o concepto</th><th>Unidades</th><th>Precio medio sin IVA</th><th>Importe de venta sin IVA</th><th>Facturas</th></tr></thead>
          <tbody>{products.map((p,i)=><tr key={`${p.sku || p.name}-${i}`}><th scope="row">{String(p.name || "Sin descripcion")}<small>{String(p.sku || "SKU sin confirmar")}</small></th>
            <td data-label="Unidades">{Number(p.units_sold).toLocaleString("es-CL")}</td><td data-label="Precio medio sin IVA">{typeof p.average_net_unit_price === "number" ? p.average_net_unit_price.toLocaleString("es-CL",{minimumFractionDigits:0,maximumFractionDigits:2}) : "Pendiente"} {String(p.currency || "")}</td><td data-label="Importe de venta sin IVA">{money(p.net_sales,String(p.currency || "CLP"))} {String(p.currency || "")}</td><td data-label="Facturas">{String(p.document_count)}</td></tr>)}</tbody>
        </table></div><p className="company-insight-note">Precio medio ponderado, después de descuentos. El importe conserva el total facturado; el precio medio se muestra redondeado. Fuente: facturas de Facto.</p>{pagination}
      </> : <p className="company-insight-note">{data?.products.status === "forbidden" ? "Tu perfil no tiene acceso al historial de ventas." : ["ok","empty","partial"].includes(data?.products.status || "") ? "Sin productos documentados para este periodo y moneda. Esto no confirma ausencia de compras." : data?.products.summary || "Historial de productos no disponible."}</p>}
      {!!data?.products.warnings.length && <details className="company-insight-evidence"><summary>{data.products.status === "partial" ? "Cobertura parcial: revisar evidencia" : "Fuentes y alcance del historial"}</summary><ul>{data.products.warnings.map(w=><li key={w}>{w}</li>)}</ul></details>}
    </>}
  </section>;
}
