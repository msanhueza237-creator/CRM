import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  BarChart3,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FileSpreadsheet,
  FileText,
  Filter,
  MailCheck,
  MessageSquareText,
  PackageCheck,
  PlugZap,
  Printer,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  TrendingUp,
  UsersRound,
  XCircle,
} from "lucide-react";
import {
  getCopilotReport,
  type CopilotReportBreakdown,
  type CopilotReportFilters,
  type CopilotReportSnapshot,
} from "../../lib/copilotApi";
import { exportReportExcel, exportReportPdf } from "../../lib/reportExport";
import type { Company, Interaction } from "../../types/crm";
import { useCompanyStore } from "../companies/CompanyStore";

const periodOptions = [
  { value: 30, label: "30 dias" },
  { value: 90, label: "90 dias" },
  { value: 180, label: "6 meses" },
  { value: 365, label: "12 meses" },
  { value: 0, label: "Historico" },
];

const chartColors = ["#087f8c", "#d39a2c", "#4381c1", "#d8674c", "#55a56d", "#8c6cc4", "#5c7a80", "#b65c87"];

export function ReportsPage() {
  const { companies, interactions } = useCompanyStore();
  const [filters, setFilters] = useState<CopilotReportFilters>(reportFiltersFromLocation);
  const [report, setReport] = useState<CopilotReportSnapshot>(() => buildLocalReport(companies, interactions, reportFiltersFromLocation()));
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "excel" | null>(null);
  const [error, setError] = useState("");

  const loadReport = useCallback(async (nextFilters: CopilotReportFilters = filters) => {
    setLoading(true);
    setError("");
    try {
      setReport(await getCopilotReport(nextFilters));
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "No se pudo actualizar el informe.";
      setError(`${message} Se muestra una lectura parcial con los datos disponibles en el navegador.`);
      setReport(buildLocalReport(companies, interactions, nextFilters));
    } finally {
      setLoading(false);
    }
  }, [companies, filters, interactions]);

  useEffect(() => {
    void loadReport(filters);
    // La primera carga usa un corte estable; los cambios posteriores se aplican con el boton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxFunnel = useMemo(() => Math.max(...report.funnel.map((item) => item.value), 1), [report.funnel]);
  const agentIntelligence = report.agentIntelligence ?? emptyAgentIntelligence();
  const financialOnly = filters.reportKind === "financial";

  function updateFilter<Key extends keyof CopilotReportFilters>(key: Key, value: CopilotReportFilters[Key]) {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  }

  async function exportReport(format: "pdf" | "excel") {
    setExporting(format);
    setError("");
    try {
      if (format === "pdf") await exportReportPdf(report);
      else await exportReportExcel(report);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "No se pudo generar el archivo solicitado.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <section className="page-stack reports-page">
      <div className="page-heading reports-heading">
        <div>
          <p>Analitica verificada</p>
          <h1>{financialOnly ? "Informe financiero" : "Informes CRM"}</h1>
          <span>{financialOnly ? "Ventas, compras, tendencia mensual y rentabilidad contable disponible." : "Indicadores de cartera, campanas y todos los agentes preparados con datos reales."}</span>
        </div>
        <div className="heading-actions reports-actions">
          <button className="ghost-button" type="button" onClick={() => window.print()}>
            <Printer size={18} /> Imprimir
          </button>
          <button className="ghost-button" type="button" onClick={() => void exportReport("pdf")} disabled={Boolean(exporting)}>
            <FileText size={18} /> {exporting === "pdf" ? "Generando..." : "PDF"}
          </button>
          <button className="ghost-button" type="button" onClick={() => void exportReport("excel")} disabled={Boolean(exporting)}>
            <FileSpreadsheet size={18} /> {exporting === "excel" ? "Generando..." : "Excel"}
          </button>
          <button className="primary-button" type="button" onClick={() => void loadReport()} disabled={loading}>
            <RefreshCw size={18} className={loading ? "spin-icon" : ""} />
            {loading ? "Actualizando..." : "Actualizar"}
          </button>
        </div>
      </div>

      {!financialOnly ? <section className="report-filter-band" aria-label="Filtros del informe">
        <div className="report-filter-title"><Filter size={18} /><strong>Filtros</strong></div>
        <div className="report-period-control" role="group" aria-label="Periodo de actividad">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={filters.periodDays === option.value ? "active" : ""}
              onClick={() => updateFilter("periodDays", option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="report-campaign-filter">
          <span>Campana especifica</span>
          <select value={filters.campaignId ?? ""} onChange={(event) => updateFilter("campaignId", event.target.value)}>
            <option value="">Todas las campanas</option>
            {(report.filterOptions.campaigns ?? []).map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </label>
        <label>
          <span>Origen</span>
          <select value={filters.source ?? ""} onChange={(event) => updateFilter("source", event.target.value)}>
            <option value="">Todos</option>
            {report.filterOptions.sources.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Tipo de empresa</span>
          <select value={filters.companyType ?? ""} onChange={(event) => updateFilter("companyType", event.target.value)}>
            <option value="">Todos</option>
            {report.filterOptions.companyTypes.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </select>
        </label>
        <label>
          <span>Region</span>
          <select value={filters.region ?? ""} onChange={(event) => updateFilter("region", event.target.value)}>
            <option value="">Todas</option>
            {report.filterOptions.regions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button className="primary-button report-apply-button" type="button" onClick={() => void loadReport()} disabled={loading}>
          <BarChart3 size={18} /> Aplicar
        </button>
      </section> : null}

      {error ? <div className="notice-banner info" role="status"><AlertCircle size={18} /><span>{error}</span></div> : null}
      {report.warnings.length ? <div className="notice-banner info"><strong>Alcance:</strong> {report.warnings.join(" ")}</div> : null}

      <section className="report-title-band">
        <div>
          <span className="eyebrow">{report.periodLabel}</span>
          <h2>{report.title}</h2>
          <p>{report.subtitle}</p>
        </div>
        <div className="report-freshness"><CheckCircle2 size={17} /><span>Actualizado</span><strong>{formatDateTime(report.generatedAt)}</strong></div>
      </section>

      {report.campaignAnalysis ? (
        <section className="panel campaign-analysis-panel" aria-labelledby="campaign-analysis-title">
          <div className="campaign-analysis-heading">
            <div>
              <span className="eyebrow">Analisis individual</span>
              <h2 id="campaign-analysis-title">{report.campaignAnalysis.name}</h2>
              <p>{humanize(report.campaignAnalysis.channel)} · {humanize(report.campaignAnalysis.status)} · {report.campaignAnalysis.emailBatches} lote(s) Gmail</p>
            </div>
          </div>

          <div className="campaign-analysis-kpis">
            <CampaignAnalysisMetric icon={UsersRound} label="Destinatarios" value={report.campaignAnalysis.recipients} tone="neutral" />
            <CampaignAnalysisMetric icon={MailCheck} label="Enviados" value={report.campaignAnalysis.sent} tone="good" />
            <CampaignAnalysisMetric icon={XCircle} label="Fallidos" value={report.campaignAnalysis.failed} tone="danger" />
            <CampaignAnalysisMetric icon={Clock3} label="Pendientes" value={report.campaignAnalysis.pending} tone="attention" />
            <CampaignAnalysisMetric icon={MessageSquareText} label="Respuestas" value={report.campaignAnalysis.replies} tone="neutral" />
            <CampaignAnalysisMetric icon={Target} label="Interesados" value={report.campaignAnalysis.interested} tone="good" />
          </div>

          <div className="campaign-analysis-detail-grid">
            <div className="campaign-analysis-rates" aria-label="Tasas de la campana">
              <CampaignRate label="Cobertura de envio" value={report.campaignAnalysis.sendRate} tone="good" />
              <CampaignRate label="Pendientes" value={report.campaignAnalysis.pendingRate} tone="attention" />
              <CampaignRate label="Fallos" value={report.campaignAnalysis.failureRate} tone="danger" />
              <CampaignRate label="Respuestas sobre enviados" value={report.campaignAnalysis.replyRate} tone="neutral" />
            </div>
            <div className="campaign-analysis-diagnosis">
              <div><AlertTriangle size={20} /><strong>Que paso con esta campana</strong></div>
              <p>{report.campaignAnalysis.diagnosis}</p>
              <small>
                Primer envio: {report.campaignAnalysis.firstSentAt ? formatDateTime(report.campaignAnalysis.firstSentAt) : "Sin registro"} · Ultimo envio: {report.campaignAnalysis.lastSentAt ? formatDateTime(report.campaignAnalysis.lastSentAt) : "Sin registro"}
              </small>
              {report.campaignAnalysis.topErrors.length ? (
                <details>
                  <summary>Ver errores agrupados</summary>
                  <ul>{report.campaignAnalysis.topErrors.map((error) => <li key={error.message}><strong>{error.count}</strong> {error.message}</li>)}</ul>
                </details>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {!report.campaignAnalysis && report.financialAnalysis.available ? (
        <FinancialAnalysisPanel analysis={report.financialAnalysis} />
      ) : null}

      {!financialOnly ? <>
      <div className="report-kpi-grid">
        <ReportKpi icon={Building2} label="Empresas" value={formatNumber(report.kpis.companies)} detail={`${report.kpis.newCompanies} nuevas en el periodo`} />
        <ReportKpi icon={Target} label="Conversion" value={`${formatPercent(report.kpis.conversionRate)}%`} detail={`${report.kpis.clients} clientes actuales`} />
        <ReportKpi icon={MessageSquareText} label="Interacciones" value={formatNumber(report.kpis.interactions)} detail="Actividad registrada en el periodo" />
        <ReportKpi icon={Send} label="Envios" value={formatNumber(report.kpis.sent)} detail={`${report.kpis.recipients} destinatarios`} />
        <ReportKpi icon={MailCheck} label="Respuestas" value={formatNumber(report.kpis.replies)} detail={`${formatPercent(report.kpis.replyRate)}% de respuesta`} />
        <ReportKpi icon={UsersRound} label="Interesados" value={formatNumber(report.kpis.interested)} detail={`${report.kpis.pendingTasks} tareas pendientes`} />
      </div>

      <section className="report-insight-strip" aria-label="Conclusiones ejecutivas">
        <div className="report-insight-heading"><Sparkles size={20} /><div><span>Lectura ejecutiva</span><strong>Hallazgos del copiloto</strong></div></div>
        <div className="report-insight-list">
          {report.insights.map((insight) => (
            <article key={insight.title} className={insight.tone}>
              <strong>{insight.title}</strong>
              <p>{insight.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel agent-intelligence-panel" aria-labelledby="agent-intelligence-title">
        <div className="panel-heading agent-intelligence-heading">
          <div>
            <h2 id="agent-intelligence-title">Inteligencia de todos los agentes</h2>
            <span>Resultados consolidados, actividad, riesgos y salud operativa</span>
          </div>
          <Bot size={22} />
        </div>

        <div className="agent-intelligence-kpis">
          <div><span>Con datos</span><strong>{agentIntelligence.agentsWithData}/{agentIntelligence.totalAgents}</strong><small>agentes en el periodo</small></div>
          <div><span>Completadas</span><strong>{formatNumber(agentIntelligence.completedTasks)}</strong><small>analisis terminados</small></div>
          <div><span>En curso</span><strong>{formatNumber(agentIntelligence.runningTasks + agentIntelligence.pendingTasks)}</strong><small>pendientes o ejecutando</small></div>
          <div><span>Fallidas</span><strong>{formatNumber(agentIntelligence.failedTasks)}</strong><small>requieren revision</small></div>
          <div><span>Propuestas</span><strong>{formatNumber(agentIntelligence.pendingProposals)}</strong><small>esperan decision</small></div>
          <div><span>Integraciones</span><strong>{agentIntelligence.healthyIntegrations}/{agentIntelligence.totalIntegrations}</strong><small>conectadas</small></div>
        </div>

        <div className="agent-intelligence-visuals">
          <div>
            <div className="agent-visual-heading"><strong>Tendencia de ejecuciones</strong><span>Completadas, fallidas y pendientes</span></div>
            <AgentTaskTrendChart data={agentIntelligence.taskTrend} />
          </div>
          <div>
            <div className="agent-visual-heading"><strong>Estado de ejecuciones</strong><span>Distribucion del periodo</span></div>
            <BreakdownBars data={agentIntelligence.taskStatus} />
            <div className="agent-operational-note"><PlugZap size={17} /><span>{agentIntelligence.criticalAlerts} alertas criticas activas</span></div>
          </div>
        </div>

        <div className="agent-roster" aria-label="Detalle por agente">
          {agentIntelligence.agents.map((agent) => (
            <article className="agent-roster-row" key={agent.type}>
              <div className="agent-roster-identity">
                <span className={`agent-status-dot ${agent.status}`} />
                <div><strong>{agent.label}</strong><small>{agentStatusLabel(agent.status)}</small></div>
              </div>
              <div className="agent-roster-success">
                <div><span>Exito</span><strong>{formatPercent(agent.successRate)}%</strong></div>
                <div className="report-bar-track"><span style={{ width: `${agent.successRate}%` }} /></div>
              </div>
              <p>{agent.summary}</p>
              <div className="agent-roster-metrics">
                {agent.metrics.slice(0, 3).map((metric) => <span key={metric.key}><small>{metric.label}</small><strong>{String(metric.value)}</strong></span>)}
                {!agent.metrics.length ? <span><small>Ultimo analisis</small><strong>{agent.lastRunAt ? formatDateTime(agent.lastRunAt) : "Sin datos"}</strong></span> : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="report-main-grid">
        <section className="panel report-chart-panel report-trend-panel">
          <div className="panel-heading"><div><h2>Actividad comercial</h2><span>Interacciones, campanas y respuestas por mes</span></div><BarChart3 size={21} /></div>
          <TrendChart data={report.trend} />
        </section>
        <section className="panel report-chart-panel">
          <div className="panel-heading"><div><h2>Embudo comercial</h2><span>Estado actual de la cartera filtrada</span></div><Target size={21} /></div>
          <div className="report-funnel">
            {report.funnel.map((item) => (
              <div key={item.key}>
                <div><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div>
                <div className="report-bar-track"><span style={{ width: `${Math.max((item.value / maxFunnel) * 100, item.value ? 4 : 0)}%` }} /></div>
                <small>{formatPercent(item.percentage)}%</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="report-secondary-grid">
        <section className="panel report-chart-panel">
          <div className="panel-heading"><div><h2>Composicion de cartera</h2><span>Empresas por tipo</span></div></div>
          <DonutChart data={report.companyTypes} total={report.kpis.companies} />
        </section>
        <section className="panel report-chart-panel">
          <div className="panel-heading"><div><h2>Origen de clientes</h2><span>Participacion de cada fuente</span></div></div>
          <BreakdownBars data={report.sources} />
        </section>
        <section className="panel report-quality-panel">
          <div className="panel-heading"><div><h2>Calidad de datos</h2><span>Cobertura para acciones comerciales</span></div></div>
          <QualityMetric label="Empresas contactables" value={report.dataQuality.contactable} total={report.kpis.companies} tone="good" />
          <QualityMetric label="Sin email, telefono o WhatsApp" value={report.dataQuality.missingContact} total={report.kpis.companies} tone="attention" />
          <QualityMetric label="Sin region informada" value={report.dataQuality.missingLocation} total={report.kpis.companies} tone="neutral" />
        </section>
      </div>

      <section className="panel report-table-panel">
        <div className="panel-heading"><div><h2>Rendimiento de campanas</h2><span>Hasta 12 campanas del periodo</span></div><span>{report.campaignPerformance.length} resultados</span></div>
        {report.campaignPerformance.length ? (
          <div className="report-table-scroll">
            <table>
              <thead><tr><th>Campana</th><th>Estado</th><th>Canal</th><th>Destinatarios</th><th>Enviados</th><th>Respuestas</th><th>Interesados</th><th>Tasa</th><th></th></tr></thead>
              <tbody>
                {report.campaignPerformance.map((campaign) => (
                  <tr key={campaign.id}>
                    <td><strong>{campaign.name}</strong></td>
                    <td><span className={`status-badge ${campaign.status}`}>{humanize(campaign.status)}</span></td>
                    <td>{humanize(campaign.channel)}</td>
                    <td>{formatNumber(campaign.recipients)}</td>
                    <td>{formatNumber(campaign.sent)}</td>
                    <td>{formatNumber(campaign.replies)}</td>
                    <td>{formatNumber(campaign.interested)}</td>
                    <td><strong>{formatPercent(campaign.replyRate)}%</strong></td>
                    <td>
                      <button
                        className="ghost-button report-campaign-link"
                        type="button"
                        onClick={() => {
                          const nextFilters = { ...filters, periodDays: 0, campaignId: campaign.id };
                          setFilters(nextFilters);
                          void loadReport(nextFilters);
                        }}
                      >
                        Analizar <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="report-empty"><BarChart3 size={24} /><span>No hay campanas para los filtros y periodo seleccionados.</span></div>}
      </section>
      </> : null}

      <div className="report-method-note">
        <CheckCircle2 size={18} />
        <span>Las cifras se calculan con consultas fijas del backend. El modelo redacta conclusiones, pero no genera SQL ni modifica registros.</span>
      </div>
    </section>
  );
}

function ReportKpi({ icon: Icon, label, value, detail }: { icon: typeof Building2; label: string; value: string; detail: string }) {
  return <article><div><Icon size={19} /><span>{label}</span></div><strong>{value}</strong><p>{detail}</p></article>;
}

function FinancialAnalysisPanel({ analysis }: { analysis: CopilotReportSnapshot["financialAnalysis"] }) {
  const maximum = Math.max(analysis.netSales, analysis.netPurchases, Math.abs(analysis.documentaryDifference), 1);
  const resultLabel = analysis.profitabilityAvailable ? "Utilidad contable" : "Diferencia documental";
  const resultValue = analysis.profitabilityAvailable ? Number(analysis.profitabilityValue) : analysis.documentaryDifference;
  return (
    <section className="panel financial-analysis-panel" aria-labelledby="financial-analysis-title">
      <div className="financial-analysis-heading">
        <div>
          <span className="eyebrow">Agente de finanzas</span>
          <h2 id="financial-analysis-title">Lectura financiera de {analysis.monthLabel}</h2>
          <p>Facto y cierre contable del periodo disponible</p>
        </div>
        <span className={`financial-certification ${analysis.profitabilityAvailable ? "certified" : "reference"}`}>
          {analysis.profitabilityAvailable ? "Rentabilidad certificada" : "Lectura referencial"}
        </span>
      </div>
      <div className="financial-analysis-kpis">
        <article><CircleDollarSign size={19} /><span>Ventas netas</span><strong>{formatCurrency(analysis.netSales)}</strong><small>{analysis.salesDocuments} documentos</small></article>
        <article><PackageCheck size={19} /><span>Compras netas</span><strong>{formatCurrency(analysis.netPurchases)}</strong><small>{analysis.purchaseDocuments} documentos</small></article>
        <article className={resultValue < 0 ? "danger" : "good"}><TrendingUp size={19} /><span>{resultLabel}</span><strong>{formatCurrency(resultValue)}</strong><small>{formatPercent(analysis.profitabilityAvailable ? Number(analysis.profitabilityRate) : analysis.documentaryMarginRate)}% sobre ventas</small></article>
        <article><BarChart3 size={19} /><span>Variacion de ventas</span><strong>{analysis.salesTrendPercent === null ? "Sin base" : `${analysis.salesTrendPercent > 0 ? "+" : ""}${formatPercent(analysis.salesTrendPercent)}%`}</strong><small>contra el mes disponible anterior</small></article>
      </div>
      <div className="financial-analysis-detail">
        <div className="financial-comparison-bars">
          {[
            { label: "Ventas netas", value: analysis.netSales, tone: "sales" },
            { label: "Compras netas", value: analysis.netPurchases, tone: "purchases" },
            { label: resultLabel, value: Math.abs(resultValue), tone: resultValue < 0 ? "loss" : "result" },
          ].map((item) => (
            <div key={item.label}>
              <div><span>{item.label}</span><strong>{formatCurrency(item.value)}</strong></div>
              <div className="report-bar-track"><span className={item.tone} style={{ width: `${Math.max((item.value / maximum) * 100, item.value ? 4 : 0)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="financial-analysis-explanation">
          <AlertTriangle size={20} />
          <div><strong>{analysis.profitabilityAvailable ? "Cierre mensual disponible" : "Como interpretar esta cifra"}</strong><p>{analysis.explanation}</p></div>
        </div>
      </div>
      {analysis.comparison?.available ? (
        <div className="financial-year-comparison" aria-label={`Comparacion financiera ${analysis.comparison.firstYear} y ${analysis.comparison.secondYear}`}>
          <div className="financial-year-comparison-heading">
            <div><BarChart3 size={19} /><strong>{analysis.comparison.periodLabel}</strong></div>
            <span>{analysis.comparison.salesChangePercent === null ? "Sin base" : `${analysis.comparison.salesChangePercent > 0 ? "+" : ""}${formatPercent(analysis.comparison.salesChangePercent)}% ventas`}</span>
          </div>
          <div className="financial-year-comparison-grid">
            {[analysis.comparison.first, analysis.comparison.second].map((year) => (
              <article key={year.year}>
                <strong>{year.year}</strong>
                <div><span>Ventas netas</span><b>{formatCurrency(year.netSales)}</b></div>
                <div><span>Compras netas</span><b>{formatCurrency(year.netPurchases)}</b></div>
                <div><span>Diferencia documental</span><b>{formatCurrency(year.documentaryDifference)}</b></div>
              </article>
            ))}
          </div>
          <p>{analysis.comparison.explanation}</p>
        </div>
      ) : null}
    </section>
  );
}

function CampaignAnalysisMetric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Building2;
  label: string;
  value: number;
  tone: "good" | "attention" | "danger" | "neutral";
}) {
  return <article className={tone}><Icon size={18} /><span>{label}</span><strong>{formatNumber(value)}</strong></article>;
}

function CampaignRate({ label, value, tone }: { label: string; value: number; tone: "good" | "attention" | "danger" | "neutral" }) {
  return (
    <div className={tone}>
      <div><span>{label}</span><strong>{formatPercent(value)}%</strong></div>
      <progress value={value} max={100}>{formatPercent(value)}%</progress>
    </div>
  );
}

function TrendChart({ data }: { data: CopilotReportSnapshot["trend"] }) {
  const width = 720;
  const height = 250;
  const left = 42;
  const right = 18;
  const top = 24;
  const bottom = 42;
  const max = Math.max(...data.flatMap((item) => [item.interactions, item.campaigns, item.replies]), 1);
  const x = (index: number) => left + (data.length <= 1 ? 0 : index * ((width - left - right) / (data.length - 1)));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const points = (field: "interactions" | "campaigns" | "replies") => data.map((item, index) => `${x(index)},${y(item[field])}`).join(" ");
  return (
    <div className="report-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Tendencia de actividad comercial">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const lineY = top + (height - top - bottom) * ratio;
          return <line key={ratio} x1={left} x2={width - right} y1={lineY} y2={lineY} className="grid-line" />;
        })}
        <polyline points={points("interactions")} className="trend-line interactions" />
        <polyline points={points("campaigns")} className="trend-line campaigns" />
        <polyline points={points("replies")} className="trend-line replies" />
        {data.map((item, index) => (
          <g key={item.key}>
            <circle cx={x(index)} cy={y(item.interactions)} r="4" className="trend-point interactions"><title>{item.label}: {item.interactions} interacciones</title></circle>
            <circle cx={x(index)} cy={y(item.campaigns)} r="4" className="trend-point campaigns"><title>{item.label}: {item.campaigns} campanas</title></circle>
            <circle cx={x(index)} cy={y(item.replies)} r="4" className="trend-point replies"><title>{item.label}: {item.replies} respuestas</title></circle>
            <text x={x(index)} y={height - 14} textAnchor="middle">{item.label}</text>
          </g>
        ))}
      </svg>
      <div className="report-chart-legend"><span className="interactions">Interacciones</span><span className="campaigns">Campanas</span><span className="replies">Respuestas</span></div>
    </div>
  );
}

function AgentTaskTrendChart({ data }: { data: CopilotReportSnapshot["agentIntelligence"]["taskTrend"] }) {
  const width = 720;
  const height = 220;
  const left = 42;
  const right = 18;
  const top = 22;
  const bottom = 38;
  const max = Math.max(...data.flatMap((item) => [item.completed, item.failed, item.pending]), 1);
  const x = (index: number) => left + (data.length <= 1 ? 0 : index * ((width - left - right) / (data.length - 1)));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const points = (field: "completed" | "failed" | "pending") => data.map((item, index) => `${x(index)},${y(item[field])}`).join(" ");
  return (
    <div className="agent-task-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Tendencia de ejecuciones de todos los agentes">
        {[0, 0.5, 1].map((ratio) => {
          const lineY = top + (height - top - bottom) * ratio;
          return <line key={ratio} x1={left} x2={width - right} y1={lineY} y2={lineY} className="grid-line" />;
        })}
        <polyline points={points("completed")} className="agent-trend-line completed" />
        <polyline points={points("failed")} className="agent-trend-line failed" />
        <polyline points={points("pending")} className="agent-trend-line pending" />
        {data.map((item, index) => (
          <g key={item.key}>
            <circle cx={x(index)} cy={y(item.completed)} r="3.5" className="agent-trend-point completed"><title>{item.label}: {item.completed} completadas</title></circle>
            <circle cx={x(index)} cy={y(item.failed)} r="3.5" className="agent-trend-point failed"><title>{item.label}: {item.failed} fallidas</title></circle>
            <circle cx={x(index)} cy={y(item.pending)} r="3.5" className="agent-trend-point pending"><title>{item.label}: {item.pending} pendientes</title></circle>
            <text x={x(index)} y={height - 12} textAnchor="middle">{item.label}</text>
          </g>
        ))}
      </svg>
      <div className="agent-trend-legend"><span className="completed">Completadas</span><span className="failed">Fallidas</span><span className="pending">Pendientes</span></div>
    </div>
  );
}

function DonutChart({ data, total }: { data: CopilotReportBreakdown[]; total: number }) {
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="report-donut-layout">
      <div className="report-donut">
        <svg viewBox="0 0 120 120" role="img" aria-label="Distribucion de empresas por tipo">
          <circle cx="60" cy="60" r={radius} className="donut-base" />
          {data.map((item, index) => {
            const length = total ? (item.value / total) * circumference : 0;
            const dashOffset = -offset;
            offset += length;
            return <circle key={item.key} cx="60" cy="60" r={radius} className="donut-segment" style={{ stroke: chartColors[index % chartColors.length], strokeDasharray: `${length} ${circumference - length}`, strokeDashoffset: dashOffset }}><title>{item.label}: {item.value}</title></circle>;
          })}
        </svg>
        <div><strong>{formatNumber(total)}</strong><span>empresas</span></div>
      </div>
      <div className="report-donut-legend">
        {data.map((item, index) => <div key={item.key}><i style={{ background: chartColors[index % chartColors.length] }} /><span>{item.label}</span><strong>{formatPercent(item.percentage)}%</strong></div>)}
      </div>
    </div>
  );
}

function BreakdownBars({ data }: { data: CopilotReportBreakdown[] }) {
  const max = Math.max(...data.map((item) => item.value), 1);
  return <div className="report-breakdown-bars">{data.map((item, index) => <div key={item.key}><div><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div><div className="report-bar-track"><span style={{ width: `${Math.max((item.value / max) * 100, item.value ? 4 : 0)}%`, background: chartColors[index % chartColors.length] }} /></div><small>{formatPercent(item.percentage)}%</small></div>)}</div>;
}

function QualityMetric({ label, value, total, tone }: { label: string; value: number; total: number; tone: "good" | "attention" | "neutral" }) {
  const rate = total ? Math.round((value / total) * 1000) / 10 : 0;
  return <div className={`report-quality-row ${tone}`}><div><span>{label}</span><strong>{formatNumber(value)}</strong></div><div className="report-bar-track"><span style={{ width: `${rate}%` }} /></div><small>{formatPercent(rate)}%</small></div>;
}

function buildLocalReport(companies: Company[], interactions: Interaction[], filters: CopilotReportFilters): CopilotReportSnapshot {
  const selected = companies.filter((company) =>
    (!filters.source || company.source === filters.source) &&
    (!filters.companyType || company.type === filters.companyType) &&
    (!filters.region || company.region === filters.region)
  );
  const ids = new Set(selected.map((company) => company.id));
  const activity = interactions.filter((interaction) => ids.has(interaction.companyId) && withinDays(interaction.date, filters.periodDays));
  const clients = selected.filter((company) => company.status === "cliente").length;
  const active = selected.filter((company) => company.status !== "descartado").length;
  const contactable = selected.filter((company) => company.email || company.phone || company.whatsapp).length;
  const funnel = localBreakdown(selected.map((company) => company.status), selected.length);
  const companyTypes = localBreakdown(selected.map((company) => company.type), selected.length);
  const sources = localBreakdown(selected.map((company) => company.source || "Sin dato"), selected.length);
  const conversion = active ? Math.round((clients / active) * 1000) / 10 : 0;
  const contactRate = selected.length ? Math.round((contactable / selected.length) * 1000) / 10 : 0;
  return {
    toolName: "generate_professional_report",
    title: filters.reportKind === "financial" ? "Informe financiero mensual" : "Informe comercial Clima Activa",
    subtitle: filters.reportKind === "financial" ? "Sin corte financiero local disponible." : "Vista parcial de cartera y actividad disponible en este navegador.",
    generatedAt: new Date().toISOString(),
    periodLabel: periodLabel(filters.periodDays),
    filters: { periodDays: filters.periodDays, source: filters.source ?? "", companyType: filters.companyType ?? "", region: filters.region ?? "", campaignId: filters.campaignId ?? "" },
    filterOptions: {
      sources: unique(companies.map((company) => company.source)),
      companyTypes: unique(companies.map((company) => company.type)),
      regions: unique(companies.map((company) => company.region)),
      campaigns: [],
    },
    kpis: { companies: selected.length, clients, conversionRate: conversion, newCompanies: 0, interactions: activity.length, campaigns: 0, recipients: 0, sent: 0, replies: 0, replyRate: 0, interested: 0, pendingTasks: 0 },
    funnel,
    companyTypes,
    sources,
    campaignStatuses: [],
    trend: localTrend(activity),
    campaignPerformance: [],
    campaignAnalysis: null,
    agentIntelligence: emptyAgentIntelligence(),
    financialAnalysis: emptyFinancialAnalysis(),
    insights: [
      { tone: conversion >= 35 ? "positive" : conversion < 15 ? "attention" : "neutral", title: `Conversion comercial de ${formatPercent(conversion)}%`, detail: `${clients} empresas estan actualmente en estado cliente.` },
      { tone: contactRate >= 80 ? "positive" : "attention", title: `${formatPercent(contactRate)}% de la cartera es contactable`, detail: `${selected.length - contactable} empresas requieren completar datos de contacto.` },
    ],
    dataQuality: { contactable, missingContact: selected.length - contactable, missingLocation: selected.filter((company) => !company.region).length },
    warnings: [filters.reportKind === "financial" ? "Conecta la Edge Function para consultar ventas, compras y cierre contable." : "La Edge Function de informes no esta disponible; campanas y respuestas no se incluyen en esta lectura parcial."],
  };
}

function localBreakdown(values: string[], total: number): CopilotReportBreakdown[] {
  const counts = values.reduce<Record<string, number>>((result, value) => ({ ...result, [value || "sin_dato"]: (result[value || "sin_dato"] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([key, value]) => ({ key, label: humanize(key), value, percentage: total ? Math.round((value / total) * 1000) / 10 : 0 })).sort((a, b) => b.value - a.value);
}

function localTrend(interactions: Interaction[]) {
  const now = new Date();
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return { key, label: date.toLocaleDateString("es-CL", { month: "short" }), interactions: interactions.filter((item) => item.date.startsWith(key)).length, campaigns: 0, replies: 0 };
  });
}

function withinDays(value: string, days: number) {
  if (!days) return true;
  const timestamp = new Date(value.length === 10 ? `${value}T12:00:00` : value).getTime();
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * 86400000;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
}

function periodLabel(days: number) {
  if (!days) return "Historico completo";
  if (days === 180) return "Ultimos 6 meses";
  if (days === 365) return "Ultimos 12 meses";
  return `Ultimos ${days} dias`;
}

function reportFiltersFromLocation(): CopilotReportFilters {
  const params = new URLSearchParams(window.location.search);
  const requested = Number(params.get("period") ?? 90);
  return {
    periodDays: [0, 30, 90, 180, 365].includes(requested) ? requested : 90,
    campaignId: params.get("campaign") || undefined,
    reportKind: params.get("view") === "financial" ? "financial" : undefined,
    financialYear: /^20\d{2}$/.test(params.get("year") ?? "") ? Number(params.get("year")) : undefined,
    financialCompareYear: /^20\d{2}$/.test(params.get("compareYear") ?? "") ? Number(params.get("compareYear")) : undefined,
  };
}

function humanize(value: string) {
  return (value || "Sin dato").replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CL").format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(value);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

function emptyAgentIntelligence(): CopilotReportSnapshot["agentIntelligence"] {
  return {
    totalAgents: 7,
    agentsWithData: 0,
    completedTasks: 0,
    failedTasks: 0,
    pendingTasks: 0,
    runningTasks: 0,
    pendingProposals: 0,
    criticalAlerts: 0,
    healthyIntegrations: 0,
    totalIntegrations: 0,
    agents: [
      ["commercial", "Comercial"],
      ["marketing", "Marketing"],
      ["finance", "Finanzas"],
      ["collections", "Cobranza"],
      ["logistics", "Logistica"],
      ["foreign_trade", "Comercio exterior"],
      ["executive", "Gerencia"],
    ].map(([type, label]) => ({
      type,
      label,
      status: "idle" as const,
      completed: 0,
      failed: 0,
      pending: 0,
      running: 0,
      successRate: 0,
      lastRunAt: null,
      summary: "Sin analisis disponibles en esta lectura local.",
      warnings: [],
      metrics: [],
    })),
    taskStatus: [],
    taskTrend: [],
    proposalRisk: [],
    alertSeverity: [],
    integrationStatus: [],
  };
}

function emptyFinancialAnalysis(): CopilotReportSnapshot["financialAnalysis"] {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    available: false,
    monthKey,
    monthLabel: now.toLocaleDateString("es-CL", { month: "long", year: "numeric" }),
    isCurrentMonth: true,
    updatedAt: null,
    periodStart: null,
    periodEnd: null,
    netSales: 0,
    grossSales: 0,
    salesTax: 0,
    salesDocuments: 0,
    netPurchases: 0,
    grossPurchases: 0,
    purchaseTax: 0,
    purchaseDocuments: 0,
    documentaryDifference: 0,
    documentaryMarginRate: 0,
    previousMonthNetSales: 0,
    salesTrendPercent: null,
    referenceGrossMargin: null,
    referenceMarginRate: null,
    profitabilityAvailable: false,
    profitabilityValue: null,
    profitabilityRate: null,
    accountingStatus: "sin_cierre",
    accountingPeriodLabel: "Sin cierre mensual",
    explanation: "Sin datos financieros en esta lectura local.",
    warnings: [],
    comparison: null,
  };
}

function agentStatusLabel(status: CopilotReportSnapshot["agentIntelligence"]["agents"][number]["status"]) {
  return status === "healthy" ? "Actualizado" : status === "attention" ? "Requiere atencion" : status === "running" ? "En ejecucion" : "Sin datos";
}
