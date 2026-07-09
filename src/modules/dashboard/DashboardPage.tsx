import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Building2, CalendarClock, CheckCircle2, Megaphone } from "lucide-react";
import { demoActivities, demoCampaigns, demoTasks } from "../../data/demoData";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useCompanyStore } from "../companies/CompanyStore";
import { type GmailMetrics, emptyGmailMetrics, getGmailMetrics } from "../../lib/gmailApi";
import type { Company, CompanyStatus, CompanyType } from "../../types/crm";

const companyTypes: CompanyType[] = ["distribuidor", "tienda comercial", "tecnico", "instalador grande", "competencia", "otro"];

const funnelStages: CompanyStatus[] = ["prospecto", "contactado", "interesado", "cotizado", "cliente"];

const OTHER_SOURCES_LABEL = "Otras fuentes";
const MAX_SOURCE_ROWS = 6;

function buildFunnel(companies: Company[]) {
  const pipeline = companies.filter((company) => company.status !== "descartado");
  const counts = funnelStages.map(
    (_, index) => pipeline.filter((company) => funnelStages.indexOf(company.status) >= index).length,
  );

  return funnelStages.map((stage, index) => ({
    stage,
    count: counts[index],
    conversionFromPrevious: index === 0 || counts[index - 1] === 0 ? null : Math.round((counts[index] / counts[index - 1]) * 100),
  }));
}

function buildSourceBreakdown(companies: Company[]) {
  const bySource = new Map<string, { total: number; clients: number }>();
  for (const company of companies) {
    const key = company.source?.trim() || "Sin fuente";
    const entry = bySource.get(key) ?? { total: 0, clients: 0 };
    entry.total += 1;
    if (company.status === "cliente") entry.clients += 1;
    bySource.set(key, entry);
  }

  const rows = Array.from(bySource.entries())
    .map(([source, { total, clients }]) => ({
      source,
      total,
      clients,
      conversionRate: total ? Math.round((clients / total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  if (rows.length <= MAX_SOURCE_ROWS) return rows;

  const visible = rows.slice(0, MAX_SOURCE_ROWS);
  const rest = rows.slice(MAX_SOURCE_ROWS);
  const merged = rest.reduce(
    (acc, row) => ({ total: acc.total + row.total, clients: acc.clients + row.clients }),
    { total: 0, clients: 0 },
  );
  visible.push({
    source: OTHER_SOURCES_LABEL,
    total: merged.total,
    clients: merged.clients,
    conversionRate: merged.total ? Math.round((merged.clients / merged.total) * 100) : 0,
  });
  return visible;
}

export function DashboardPage() {
  const { companies, interactions } = useCompanyStore();
  const [gmailMetrics, setGmailMetrics] = useState<GmailMetrics>(emptyGmailMetrics);
  const conversionBase = companies.filter((company) => company.status !== "descartado").length;
  const clients = companies.filter((company) => company.status === "cliente").length;
  const conversionRate = conversionBase ? Math.round((clients / conversionBase) * 100) : 0;
  const recentInteractions = interactions.slice(0, 6);
  const discardedCount = companies.filter((company) => company.status === "descartado").length;
  const funnel = useMemo(() => buildFunnel(companies), [companies]);
  const sourceBreakdown = useMemo(() => buildSourceBreakdown(companies), [companies]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    async function loadGmailMetricsData() {
      try {
        const data = await getGmailMetrics();
        setGmailMetrics(data);
      } catch {
        // Gmail metrics are non-critical — fail silently on dashboard
      }
    }

    void loadGmailMetricsData();
  }, []);


  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <p>Resumen comercial</p>
          <h1>Dashboard</h1>
        </div>
        <Link className="primary-button" to="/empresas/nueva">
          <Building2 size={18} />
          Nueva empresa
        </Link>
      </div>

      <div className="metric-grid">
        <MetricCard to="/empresas" icon={Building2} label="Empresas registradas" value={companies.length.toString()} detail="Abrir base comercial" />
        <MetricCard to="/campanas" icon={Megaphone} label="Campanas activas" value={demoCampaigns.length.toString()} detail="Revisar campanas" />
        <MetricCard to="#seguimientos" icon={CalendarClock} label="Proximos seguimientos" value={demoTasks.length.toString()} detail="Ver pendientes" />
        <MetricCard to="/empresas?status=cliente" icon={CheckCircle2} label="Conversion comercial" value={`${conversionRate}%`} detail="Ver clientes" />
      </div>

      <div className="metric-grid">
        <MetricCard to="/administracion" icon={Megaphone} label="Emails enviados hoy" value={`${gmailMetrics.sentToday}/${gmailMetrics.dailyLimit || 0}`} detail="Limite diario Gmail" />
        <MetricCard to="/campanas" icon={Megaphone} label="Campanas email activas" value={gmailMetrics.activeCampaigns.toString()} detail="Ver campanas" />
        <MetricCard to="/campanas" icon={CheckCircle2} label="Emails fallidos" value={gmailMetrics.failedEmails.toString()} detail="Revisar errores" />
        <MetricCard to="/empresas" icon={Building2} label="Empresas contactadas" value={gmailMetrics.companiesContacted.toString()} detail={gmailMetrics.lastCampaign || "Sin campana email"} />
      </div>

      <div className="two-column">
        <div className="panel">
          <div className="panel-heading">
            <h2>Empresas por tipo</h2>
          </div>
          <div className="bar-list">
            {companyTypes.map((type) => (
              <BarRow
                key={type}
                to={`/empresas?type=${encodeURIComponent(type)}`}
                label={type}
                value={companies.filter((company) => company.type === type).length}
                max={companies.length}
              />
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <h2>Funnel de conversion</h2>
            <span>{discardedCount} descartadas</span>
          </div>
          <div className="bar-list">
            {funnel.map(({ stage, count, conversionFromPrevious }) => (
              <BarRow
                key={stage}
                to={`/empresas?status=${encodeURIComponent(stage)}`}
                label={conversionFromPrevious === null ? stage : `${stage} (${conversionFromPrevious}% del anterior)`}
                value={count}
                max={funnel[0]?.count ?? 0}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Conversion por fuente</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fuente</th>
                <th>Empresas</th>
                <th>Clientes</th>
                <th>Tasa de conversion</th>
              </tr>
            </thead>
            <tbody>
              {sourceBreakdown.map((row) => (
                <tr key={row.source}>
                  <td>
                    {row.source === OTHER_SOURCES_LABEL ? (
                      row.source
                    ) : (
                      <Link className="table-link" to={`/empresas?source=${encodeURIComponent(row.source)}`}>
                        {row.source}
                      </Link>
                    )}
                  </td>
                  <td>{row.total}</td>
                  <td>{row.clients}</td>
                  <td>{row.conversionRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="two-column">
        <div className="panel">
          <div className="panel-heading">
            <h2>Ultimas actividades</h2>
            <Link className="panel-link" to="/empresas">Ver empresas</Link>
          </div>
          <div className="timeline compact">
            {demoActivities.map((activity) => (
              <Link className="timeline-link" to="/empresas" key={activity.id}>
                <article>
                  <span>{activity.date}</span>
                  <p>{activity.text}</p>
                </article>
              </Link>
            ))}
          </div>
        </div>

        <div className="panel" id="seguimientos">
          <div className="panel-heading">
            <h2>Proximos seguimientos</h2>
          </div>
          <div className="task-list">
            {demoTasks.map((task) => {
              const company = companies.find((item) => item.id === task.companyId);
              return (
                <Link className="task-link" to={company ? `/empresas/${company.id}` : "/empresas"} key={task.id}>
                  <article>
                    <CalendarClock size={18} />
                    <div>
                      <strong>{task.title}</strong>
                      <span>{company?.name ?? "Empresa no encontrada"} - {task.dueDate}</span>
                    </div>
                    <ArrowUpRight size={18} />
                  </article>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Historial reciente</h2>
          <Link className="panel-link" to="/empresas">Abrir fichas</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Empresa</th>
                <th>Tipo</th>
                <th>Resultado</th>
                <th>Proxima accion</th>
              </tr>
            </thead>
            <tbody>
              {recentInteractions.map((interaction) => {
                const company = companies.find((item) => item.id === interaction.companyId);
                return (
                  <tr key={interaction.id}>
                    <td>{interaction.date}</td>
                    <td>
                      <Link className="table-link" to={company ? `/empresas/${company.id}` : "/empresas"}>
                        {company?.name ?? "Empresa no encontrada"}
                      </Link>
                    </td>
                    <td>{interaction.type}</td>
                    <td>{interaction.result}</td>
                    <td>{interaction.nextAction}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  to,
}: {
  icon: typeof Building2;
  label: string;
  value: string;
  detail: string;
  to: string;
}) {
  return (
    <Link className="metric-card metric-link" to={to}>
      <Icon size={22} />
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </Link>
  );
}

function BarRow({ label, value, max, to }: { label: string; value: number; max: number; to: string }) {
  const width = max ? `${Math.max((value / max) * 100, value ? 8 : 0)}%` : "0%";
  return (
    <Link className="bar-row bar-link" to={to}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="bar-track">
        <span style={{ width }} />
      </div>
    </Link>
  );
}
