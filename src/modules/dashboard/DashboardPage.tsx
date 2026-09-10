import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ArrowRight, Bot, CircleDollarSign, Landmark, Ship, Palette, RefreshCw, UsersRound, AlertTriangle, PackageSearch, FileCheck2, Sparkles, BarChart3, ShoppingCart, ChevronDown } from "lucide-react";
import type { AccountingDashboardTotals } from "../../types/accounting";
import { useAuth } from "../auth/AuthContext";
import { incomeReportLink } from "../accounting/reportNavigation";
import { stages, useDashboardOverview } from "./useDashboardOverview";
import "./dashboard.css";

const financial = (view: string) => `/finanzas-contabilidad?view=${view}`;
const number = (value: number | null | undefined) => value == null || !Number.isFinite(Number(value)) ? "No disponible" : Number(value).toLocaleString("es-CL", { maximumFractionDigits: 1 });
const money = (value: number | null | undefined) => value == null || !Number.isFinite(Number(value)) ? "No disponible" : Number(value).toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const date = (value: string | null | undefined) => !value || !Number.isFinite(Date.parse(value)) ? "Sin fecha" : new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
const knownAmount = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : undefined;
const deduction = (value: number | undefined) => money(value == null ? undefined : value === 0 ? 0 : -Math.abs(value));
function purchaseAmounts(totals: AccountingDashboardTotals | null | undefined) {
  const domestic = knownAmount(totals?.purchasesDomestic), international = knownAmount(totals?.purchasesInternational);
  const hasBreakdown = domestic != null && international != null;
  const net = knownAmount(totals?.purchasesNet) ?? (hasBreakdown ? domestic + international : undefined);
  // Scale each visible segment; negative adjustments remain signed in the period detail.
  const height = hasBreakdown ? Math.max(0, domestic) + Math.max(0, international) : Math.max(0, net ?? 0);
  return { domestic, international, net, hasBreakdown, height };
}
function sourceDocumentsLink(from: string | undefined, to: string | undefined, search: string, source?: string) {
  const params = new URLSearchParams({ view: "facto", search });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (source) params.set("source", source);
  if (search === "purchase") {
    params.set("search", "");
    params.set("type", source === "FACTO" ? "domestic" : source === "COMERCIO_EXTERIOR" ? "international" : "purchases");
    params.delete("source");
  }
  return `/finanzas-contabilidad?${params}`;
}

export function DashboardPage() {
  const { user } = useAuth();
  const { data, loading, refresh } = useDashboardOverview(user?.role, user?.id);
  const [period, setPeriod] = useState("year");
  const admin = user?.role === "administrador", financeAccess = admin || user?.role === "finanzas";
  const f = financeAccess ? data.finance : null;
  const analytics = f?.dashboard?.available ? f.dashboard : null;
  const selected = analytics?.monthly.find(month => month.period === period);
  const result = analytics ? (selected || analytics.current) : null;
  const hasPendingSales = (result?.salesPendingDocuments || 0) > 0;
  const grossMarginLabel = hasPendingSales && result?.costs === 0 ? "Por validar"
    : result?.grossMargin == null ? "Sin base" : `${number(result.grossMargin)}%`;
  const recentSales = analytics?.latestSales?.filter(sale => !selected || (sale.issuedOn >= selected.from && sale.issuedOn <= selected.to)) || [];
  const reportTo = incomeReportLink(selected?.from || analytics?.from, selected?.to || analytics?.to);
  const periodLabel = selected ? `${selected.label} ${analytics?.year}` : `${analytics?.year || new Date().getFullYear()} acumulado`;
  const from = selected?.from || analytics?.from, to = selected?.to || analytics?.to;
  const sourcesTo = (search: string, source?: string) => sourceDocumentsLink(from, to, search, source);
  const purchases = purchaseAmounts(result);
  const purchaseDocuments = analytics?.purchaseDocuments?.filter(document => from && to && document.issuedOn.slice(0, 10) >= from && document.issuedOn.slice(0, 10) <= to);
  const salesAdjustments = analytics?.salesAdjustments?.filter(document => from && to && document.recognizedOn >= from && document.recognizedOn <= to) || [];
  const hasUnsplitPurchases = analytics?.monthly.some(month => {
    const amounts = purchaseAmounts(month);
    return amounts.net != null && !amounts.hasBreakdown;
  });
  const counts = data.counts;
  const available = f ? Number(f.summary.bank_clp) + Number(f.summary.bank_usd_clp) : null;
  const chartMax = Math.max(1, ...(analytics?.monthly.flatMap(m => [m.sales, m.costs + m.expenses, purchaseAmounts(m).height]) || []));
  const maxStage = Math.max(1, ...stages.map(stage => counts[stage] || 0));

  return <main className="overview-page">
    <header className="overview-header">
      <div><p className="overview-eyebrow">LATIN CHILE / CLIMACTIVA</p><h1>Panorama del negocio</h1><span>{data.readAt ? `Lectura del CRM · ${date(data.readAt)}` : "Consolidación de fuentes"}{loading ? " · Actualizando" : ""}</span></div>
      <div className="overview-actions"><button type="button" className="overview-icon" title="Actualizar panorama" aria-label="Actualizar panorama" disabled={loading} onClick={() => void refresh()}><RefreshCw size={19} className={loading ? "spin" : ""} /></button><Link className="overview-primary" to="/copiloto"><Sparkles size={18} /> Consultar al Copiloto</Link></div>
    </header>
    {data.warnings.length > 0 && <div className="overview-warning" role="status"><AlertTriangle size={19} /><div><strong>Lectura parcial</strong><p>{data.warnings.join(" ")}</p></div></div>}
    <nav className="overview-modules" aria-label="Módulos del negocio">
      {financeAccess && <Module to={financial("dashboard")} icon={Landmark} title="Finanzas" detail="Cartera, bancos y resultados" />}
      {admin && <Module to="/comercio-exterior" icon={Ship} title="Comercio exterior" detail="Importaciones y costos" />}
      <Module to="/contenido" icon={Palette} title="Centro de contenido" detail="Publicaciones y calendario" />
      <Module to="/copiloto" icon={Bot} title="Copiloto" detail="Consultas y evidencia" />
    </nav>
    {financeAccess && <section className="overview-section" aria-label="Tesorería y cartera">
      <Heading title="Tesorería y cartera" detail={`Saldos al corte disponible · ${date(f?.summary.as_of)}`} to={financial("banks")} />
      <div className="overview-kpis">
        <Kpi to={financial("banks")} icon={Landmark} title="Disponible" value={loading && !f ? "Cargando…" : money(available)} detail={f?.summary.bank_balance_basis === "verified_control" ? "Control bancario verificado · equivalente CLP" : "Saldo informado · equivalente CLP"} tone="teal" />
        <Kpi to={financial("receivables")} icon={CircleDollarSign} title="Por cobrar" value={f?.summary.receivables_suppressed ? "En revisión" : money(f?.summary.receivables)} detail={f?.summary.receivables_data_quality === "verified_full_snapshot" ? "Cartera completa verificada con Facto" : "Cartera operativa · revisar respaldo"} tone="green" />
        <Kpi to={financial("payables")} icon={FileCheck2} title="Por pagar" value={money(f?.summary.payables)} detail="Obligaciones registradas" tone="coral" />
        <Kpi to={financial("checks")} icon={FileCheck2} title="Cheques en cartera" value={money(f?.summary.checks_portfolio)} detail="No incluidos en dinero disponible" tone="violet" />
      </div>
      {f?.bankReality?.asOf && <Link className="overview-chart-link" to={financial("banks")}>Último respaldo bancario: {date(f.bankReality.asOf)} · revisar fecha de cada cuenta <ArrowUpRight size={16} /></Link>}
      {f?.factoFreshness?.stale && <Link className="overview-inline-alert" to={financial("facto")}><AlertTriangle size={16} /> Hay información de Facto pendiente de consolidar <ArrowRight size={16} /></Link>}
    </section>}
    {financeAccess && <section className="overview-section" aria-label="Rendimiento financiero">
      <div className="overview-heading"><div><h2>Rendimiento financiero</h2><p>{analytics ? `${date(selected?.from || analytics.from)} al ${date(selected?.to || analytics.to)} · CLP` : "Información financiera no disponible"}</p></div><label className="overview-period">Período<select aria-label="Período financiero" value={selected ? period : "year"} onChange={event => setPeriod(event.target.value)}><option value="year">{analytics?.year || new Date().getFullYear()} acumulado</option>{analytics?.monthly.map(month => <option key={month.period} value={month.period}>{month.label} {analytics.year}</option>)}</select></label></div>
      <div className="overview-performance">
        <div className="overview-chart"><div className="overview-chart-title"><h3>Ventas, costos y compras por mes</h3><ul className="overview-chart-legend" aria-label="Leyenda del gráfico"><li><i className="legend-sales" /> Ventas netas</li><li><i className="legend-costs" /> Costos + gastos</li><li><i className="legend-purchases-domestic" /> Compras nacionales netas</li><li><i className="legend-purchases-international" /> Compras internacionales (mercadería)</li>{hasUnsplitPurchases && <li><i className="legend-purchases-unsplit" /> Compras sin desglose</li>}</ul></div>
          {analytics?.monthly.length ? <div className="overview-bars-scroll"><div className="overview-bars" aria-label="Comparación mensual de ventas, costos y compras registrados" style={{ minWidth: `${analytics.monthly.length * 36}px` }}>
            {analytics.monthly.map(month => {
              const amounts = purchaseAmounts(month);
              const description = `${month.label}: ventas netas ${money(month.sales)}, costos y gastos ${money(month.costs + month.expenses)}, compras netas ${money(amounts.net)} (nacionales netas ${money(amounts.domestic)}, internacionales solo mercadería ${money(amounts.international)}). Notas de crédito de venta ${deduction(month.salesCreditNotes)}, de compra ${deduction(month.purchaseCreditNotes)}; ya descontadas`;
              return <button type="button" key={month.period} className={selected?.period === month.period ? "selected" : ""} aria-pressed={selected?.period === month.period} aria-label={`${description}. Seleccionar mes`} title={description} onClick={() => setPeriod(month.period)}>
                <span className="overview-bar-group" aria-hidden="true">
                  <i className="sales" style={{ height: `${Math.max(0, month.sales) / chartMax * 100}%`, minHeight: month.sales > 0 ? 2 : 0 }} />
                  <i className="costs" style={{ height: `${Math.max(0, month.costs + month.expenses) / chartMax * 100}%` }} />
                  <span className={`purchases${!amounts.hasBreakdown ? amounts.net == null ? " unavailable" : " unsplit" : ""}`} style={{ height: `${amounts.height / chartMax * 100}%`, minHeight: amounts.height > 0 ? 2 : 0 }}>
                    {amounts.hasBreakdown && <><i className="purchases-domestic" style={{ height: `${Math.max(0, amounts.domestic!) / (amounts.height || 1) * 100}%` }} /><i className="purchases-international" style={{ height: `${Math.max(0, amounts.international!) / (amounts.height || 1) * 100}%` }} /></>}
                  </span>
                </span><span>{month.label}</span>
              </button>;
            })}
          </div></div> : <div className="overview-empty"><BarChart3 size={30} /><p>{loading ? "Cargando tendencia…" : "Sin tendencia disponible. Revisa el estado de Finanzas."}</p><Link to={financial("reports")}>Abrir informes <ArrowRight size={16} /></Link></div>}
          {analytics?.monthly.some(m => m.sales < 0 || m.costs + m.expenses < 0 || (m.purchasesDomestic ?? 0) < 0 || (m.purchasesInternational ?? 0) < 0 || (m.purchasesNet ?? 0) < 0) && <p className="overview-data-note">Hay ajustes negativos; consulta sus importes en el detalle del período.</p>}
          {analytics?.monthly.some(m => purchaseAmounts(m).net == null) && <p className="overview-data-note">Compras no disponibles en algunos meses; no equivalen a cero.</p>}
          <Link className="overview-chart-link" to={reportTo}>Estado de resultados del período <ArrowUpRight size={16} /></Link>
        </div>
        <div className="overview-results"><h3>{periodLabel}</h3><Result to={hasPendingSales ? financial("facto") : reportTo} label="Ventas netas" value={money(result?.sales)} />
          <Result to={salesAdjustments.length ? reportTo : sourcesTo("sales_credit_note")} label="Notas de crédito de venta" value={deduction(result?.salesCreditNotes)} detail="Ya descontadas de ventas netas" />
          {hasPendingSales && <div className="overview-sales-breakdown"><Result to={reportTo} label="Contabilizadas" value={money(result?.salesLedger)} /><Result to={financial("facto")} label={`Sin asiento · ${number(result?.salesPendingDocuments)} documentos`} value={money(result?.salesPending)} /><p>Incluidas en ventas. El costo y el resultado aún requieren revisión contable.</p></div>}
          <Result to={reportTo} label="Costo de ventas" value={money(result?.costs)} /><Result to={reportTo} label="Gastos operacionales" value={money(result?.expenses)} /><Result to={reportTo} label="Margen bruto" value={grossMarginLabel} /><Link className="overview-result-total" to={reportTo}><span>Resultado operativo<br /><small>{hasPendingSales ? "Provisional · base mixta" : "Provisional"}</small></span><strong>{money(result?.operatingProfit)}</strong><ArrowUpRight size={18} /></Link></div>
      </div>
      <div className="overview-purchases">
        <div className="overview-purchases-totals"><h3>Compras · {periodLabel}</h3>
          <Result to={sourcesTo("purchase")} label="Compras netas" value={money(purchases.net)} />
          <Result to={sourcesTo("purchase", "FACTO")} label="Compras nacionales" value={money(purchases.domestic)} />
          <Result to={sourcesTo("purchase", "COMERCIO_EXTERIOR")} label="Compras internacionales" value={money(purchases.international)} detail="Facturas extranjeras netas, sin duplicar recepciones" />
          <Result to={sourcesTo("purchase_credit_note")} label="Notas de crédito de compra" value={deduction(result?.purchaseCreditNotes)} detail="Ya descontadas de compras netas" />
          <p>Compras documentales, distintas del costo de ventas. No se restan nuevamente del resultado operativo.</p>
          <p>Los costos de internación facturados en Chile ya están en compras nacionales. Sin proformas ni duplicar el valor de recepción.</p>
        </div>
        <details className="overview-purchase-documents">
          <summary><ShoppingCart size={19} /><span><strong>Documentos de compras</strong><small>{periodLabel} · {purchaseDocuments == null ? "Detalle no disponible" : `${number(purchaseDocuments.length)} documentos`}</small></span><ChevronDown size={18} /></summary>
          {purchaseDocuments?.length ? <ul>{purchaseDocuments.map(document => <li key={`${document.sourceType || document.kind}:${document.id}`}><Link to={sourcesTo(document.folio || document.counterpart || "purchase", document.sourceType)}>
            <span><strong>Documento {document.folio || "sin folio"}</strong><small>{document.counterpart || "Proveedor sin identificar"}</small><small>Emisión {date(document.issuedOn)} · {document.kind === "international" ? "Internacional" : "Nacional"} · {document.sourceType === "FACTO" ? "Facto" : document.sourceType === "COMERCIO_EXTERIOR" ? "Comercio Exterior" : document.sourceType || "Fuente no informada"}</small></span>
            <strong className="overview-purchase-amount">{money(document.netClp)}<small>netos CLP</small></strong><ArrowUpRight size={16} />
          </Link></li>)}</ul> : <p className="overview-purchase-empty">{purchaseDocuments == null ? "Detalle de documentos de compras no disponible." : "Sin documentos de compras en este período."}</p>}
          <Link className="overview-chart-link" to={sourcesTo("purchase")}>Compras en fuentes financieras <ArrowUpRight size={16} /></Link>
        </details>
      </div>
      {salesAdjustments.length > 0 && <details className="overview-purchase-documents overview-sales-adjustments">
        <summary><FileCheck2 size={19} /><span><strong>Regularizaciones de notas de crédito</strong><small>{salesAdjustments.length} documentos · incluidas en ventas netas</small></span><ChevronDown size={18} /></summary>
        <ul>{salesAdjustments.map(document => <li key={document.id}><Link to={sourceDocumentsLink(document.issuedOn, document.issuedOn, document.folio, "FACTO")}>
          <span><strong>Nota de crédito {document.folio}</strong><small>Emisión {date(document.issuedOn)} · contabilización {date(document.recognizedOn)}</small></span>
          <strong className="overview-purchase-amount">{money(document.netClp)}<small>netos CLP</small></strong><ArrowUpRight size={16} />
        </Link></li>)}</ul>
      </details>}
      {recentSales.length > 0 && <div className="overview-recent-sales"><h3>Últimas ventas registradas</h3>{recentSales.map(sale => <Link key={sale.id} to={financial("facto")}><span><strong>Documento {sale.folio}</strong><small>Emisión {date(sale.issuedOn)} · {sale.posted ? "Contabilizado" : "Sin asiento de ingreso"}</small></span><strong>{money(sale.netClp)} netos</strong><ArrowUpRight size={16} /></Link>)}</div>}
      {analytics && <div className="overview-quality"><Link to={financial("ledger")}><FileCheck2 size={17} /> Costo exacto: {number(analytics.costCoverage.salesWithExactCost)} de {number(analytics.costCoverage.totalSalesDocuments)} facturas <ArrowUpRight size={15} /></Link><span>{analytics.basis === "ledger" ? "Base contable" : "Base documental o mixta"} · No equivale a caja disponible</span></div>}
      {(analytics?.warnings || []).map(warning => <p className="overview-data-note" key={warning}>{warning}</p>)}
    </section>}
    <div className="overview-two">
      <section className="overview-section"><Heading title="Decisiones pendientes" detail="Control operativo" to={financeAccess ? financial("controls") : "/contenido?view=publications"} /><div className="overview-list">
        {financeAccess && <Action to={financial("reconcile")} icon={Landmark} label="Movimientos sin conciliar" value={number(f?.summary.unmatched_bank)} />}
        {admin && <Action to="/agentes/logistics/dashboard" icon={PackageSearch} label="Alertas de inventario" value={number(counts.inventory)} />}
        <Action to="/contenido?view=publications" icon={Palette} label="Publicaciones por aprobar" value={number(counts.approval)} /><Action to="/contenido?view=publications" icon={AlertTriangle} label="Publicaciones con error" value={number(counts.contentErrors)} />
        {admin && <Action to="/agentes" icon={Bot} label="Propuestas de agentes" value={number(counts.proposals)} />}
      </div></section>
      {admin ? <section className="overview-section"><Heading title="Comercio exterior" detail="Operaciones registradas" to="/comercio-exterior?view=operations" /><div className="overview-trade-kpis"><Kpi to="/comercio-exterior?view=operations" icon={Ship} title="Embarques activos" value={number(data.trade?.active_shipments)} detail="Operaciones de embarque" tone="teal" /><Kpi to="/comercio-exterior?view=operations" icon={PackageSearch} title="En preparación" value={number(data.trade?.operations_in_preparation)} detail="Preparación de importaciones" tone="violet" /></div><div className="overview-list"><Action to="/comercio-exterior?view=intelligence" icon={AlertTriangle} label="Alertas abiertas" value={number(data.trade?.open_alerts)} /><Action to="/comercio-exterior?view=suppliers" icon={UsersRound} label="Proveedores" value={number(data.trade?.suppliers)} /></div></section> : <section className="overview-section"><Heading title="Tu asistente de negocio" detail="Datos disponibles según tu rol" to="/copiloto" /><div className="overview-list"><Action to="/copiloto" icon={Bot} label="Productos, stock y ventas" value="Consultar" /><Action to="/copiloto" icon={UsersRound} label="Clientes y seguimiento" value="Consultar" /></div></section>}
    </div>
    <div className="overview-two">
      <section className="overview-section"><Heading title="Cartera comercial" detail={`${number(counts.companies)} empresas · estado actual, no conversión histórica`} to="/empresas" /><div className="overview-funnel">{stages.map((stage, index) => <Link key={stage} to={`/empresas?status=${stage}`}><span>{stage}</span><div><i style={{ width: `${(counts[stage] || 0) / maxStage * 100}%`, opacity: 1 - index * 0.1 }} /></div><strong>{number(counts[stage])}</strong><ArrowUpRight size={14} /></Link>)}</div></section>
      <section className="overview-section"><Heading title="Pulso editorial" detail="Centro de contenido" to="/contenido?view=calendar" /><div className="overview-editorial"><Link to="/contenido?view=publications"><strong>{number(counts.published)}</strong><span>Publicadas · últimos 7 días</span></Link><Link to="/contenido?view=calendar"><strong>{number(counts.scheduled)}</strong><span>Programadas</span></Link></div><div className="overview-list">{data.publications.map((publication, index) => <Action key={publication.id} to="/contenido?view=calendar" icon={Palette} label={`Próxima publicación ${index + 1}`} value={date(publication.scheduled_at)} />)}</div><Link className="overview-chart-link" to="/contenido?view=generator">Crear publicación <ArrowUpRight size={16} /></Link></section>
    </div>
    {admin && <section className="overview-section"><Heading title="Fuentes conectadas" detail="Última sincronización informada por cada fuente" to="/administracion" /><div className="overview-connections">{data.connections.map(connection => <Link key={connection.provider} to="/administracion"><span className={connection.status === "connected" ? "connected" : "disconnected"} /><div><strong>{({ facto: "Facto", tiendanube: "Tiendanube", gmail: "Gmail", meta_social: "Meta Social", meta_whatsapp: "WhatsApp" } as Record<string, string>)[connection.provider] || connection.provider}</strong><small>{date(connection.last_success_at)}</small></div><span>{connection.status === "connected" ? "Conectada" : "Revisar"}</span><ArrowUpRight size={15} /></Link>)}</div></section>}
    <footer className="overview-footer"><span>Lectura de fuentes guardadas. Una factura no implica un pago.</span><Link to="/copiloto">Consultar evidencia con el Copiloto <ArrowRight size={16} /></Link></footer>
  </main>;
}
function Module({ to, icon: Icon, title, detail }: { to: string; icon: typeof Bot; title: string; detail: string }) { return <Link to={to}><Icon size={24} /><div><strong>{title}</strong><small>{detail}</small></div><ArrowUpRight size={17} /></Link>; }
function Heading({ title, detail, to }: { title: string; detail: string; to: string }) { return <div className="overview-heading"><div><h2>{title}</h2><p>{detail}</p></div><Link className="overview-icon" to={to} title={`Abrir ${title}`} aria-label={`Abrir ${title}`}><ArrowUpRight size={20} /></Link></div>; }
function Kpi({ to, icon: Icon, title, value, detail, tone }: { to: string; icon: typeof Bot; title: string; value: string; detail: string; tone: string }) { return <Link className={`overview-kpi ${tone}`} to={to}><div><Icon size={19} /><span>{title}</span><ArrowUpRight size={16} /></div><strong>{value}</strong><small>{detail}</small></Link>; }
function Action({ to, icon: Icon, label, value }: { to: string; icon: typeof Bot; label: string; value: string }) { return <Link to={to}><Icon size={18} /><span>{label}</span><strong>{value}</strong><ArrowUpRight size={15} /></Link>; }
function Result({ label, value, to, detail }: { label: string; value: string; to: string; detail?: string }) { return <Link className="overview-result-row" to={to}><span>{label}{detail && <small>{detail}</small>}</span><strong>{value}</strong></Link>; }
