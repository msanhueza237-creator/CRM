import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Building2,
  CheckCircle2,
  Clock3,
  Download,
  Filter,
  MailCheck,
  MessageSquareText,
  Printer,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  UsersRound,
  XCircle,
} from "lucide-react";
import {
  getCopilotReport,
  type CopilotReportBreakdown,
  type CopilotReportFilters,
  type CopilotReportSnapshot,
} from "../../lib/copilotApi";
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

  function updateFilter<Key extends keyof CopilotReportFilters>(key: Key, value: CopilotReportFilters[Key]) {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  }

  function exportCsv() {
    const lines = [
      ["Informe", report.title],
      ["Periodo", report.periodLabel],
      ["Actualizado", formatDateTime(report.generatedAt)],
      [],
      ["Indicador", "Valor"],
      ["Empresas", report.kpis.companies],
      ["Clientes", report.kpis.clients],
      ["Conversion (%)", report.kpis.conversionRate],
      ["Interacciones", report.kpis.interactions],
      ["Campanas", report.kpis.campaigns],
      ["Envios", report.kpis.sent],
      ["Respuestas", report.kpis.replies],
      ["Tasa de respuesta (%)", report.kpis.replyRate],
      ...(report.campaignAnalysis ? [
        [],
        ["Analisis de campana", report.campaignAnalysis.name],
        ["Estado", report.campaignAnalysis.status],
        ["Destinatarios", report.campaignAnalysis.recipients],
        ["Enviados", report.campaignAnalysis.sent],
        ["Fallidos", report.campaignAnalysis.failed],
        ["Pendientes", report.campaignAnalysis.pending],
        ["Respuestas", report.campaignAnalysis.replies],
        ["Diagnostico", report.campaignAnalysis.diagnosis],
      ] : []),
      [],
      ["Campana", "Estado", "Canal", "Destinatarios", "Enviados", "Respuestas", "Interesados", "Tasa respuesta (%)"],
      ...report.campaignPerformance.map((campaign) => [
        campaign.name,
        campaign.status,
        campaign.channel,
        campaign.recipients,
        campaign.sent,
        campaign.replies,
        campaign.interested,
        campaign.replyRate,
      ]),
    ];
    const csv = lines.map((row) => row.map(csvValue).join(";")).join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `informe-crm-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="page-stack reports-page">
      <div className="page-heading reports-heading">
        <div>
          <p>Analitica verificada</p>
          <h1>Informes CRM</h1>
          <span>Indicadores comerciales y de campanas preparados por el copiloto con datos reales.</span>
        </div>
        <div className="heading-actions reports-actions">
          <button className="ghost-button" type="button" onClick={() => window.print()}>
            <Printer size={18} /> Imprimir
          </button>
          <button className="ghost-button" type="button" onClick={exportCsv}>
            <Download size={18} /> Exportar CSV
          </button>
          <button className="primary-button" type="button" onClick={() => void loadReport()} disabled={loading}>
            <RefreshCw size={18} className={loading ? "spin-icon" : ""} />
            {loading ? "Actualizando..." : "Actualizar"}
          </button>
        </div>
      </div>

      <section className="report-filter-band" aria-label="Filtros del informe">
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
      </section>

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
    title: "Informe comercial Clima Activa",
    subtitle: "Vista parcial de cartera y actividad disponible en este navegador.",
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
    insights: [
      { tone: conversion >= 35 ? "positive" : conversion < 15 ? "attention" : "neutral", title: `Conversion comercial de ${formatPercent(conversion)}%`, detail: `${clients} empresas estan actualmente en estado cliente.` },
      { tone: contactRate >= 80 ? "positive" : "attention", title: `${formatPercent(contactRate)}% de la cartera es contactable`, detail: `${selected.length - contactable} empresas requieren completar datos de contacto.` },
    ],
    dataQuality: { contactable, missingContact: selected.length - contactable, missingLocation: selected.filter((company) => !company.region).length },
    warnings: ["La Edge Function de informes no esta disponible; campanas y respuestas no se incluyen en esta lectura parcial."],
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

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

function csvValue(value: string | number | undefined) {
  const text = String(value ?? "").replace(/"/g, '""');
  return `"${text}"`;
}
