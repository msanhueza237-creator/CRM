import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Building2,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Megaphone,
  PackageSearch,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { demoActivities, demoTasks } from "../../data/demoData";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { type GmailMetrics, emptyGmailMetrics, getGmailMetrics } from "../../lib/gmailApi";
import { useCompanyStore } from "../companies/CompanyStore";
import type { Company, CompanyStatus, CompanyType } from "../../types/crm";

const companyTypes: CompanyType[] = ["distribuidor", "tienda comercial", "tecnico", "instalador grande", "competencia", "otro"];
const funnelStages: CompanyStatus[] = ["prospecto", "contactado", "interesado", "cotizado", "cliente"];
const OTHER_SOURCES_LABEL = "Otras fuentes";
const MAX_SOURCE_ROWS = 6;

interface ConnectionSummary {
  provider: string;
  status: string;
  message: string;
  last_success_at: string | null;
}

interface OperationalDashboard {
  connections: ConnectionSummary[];
  productCounts: Record<string, number>;
  latestProductSync: Record<string, string>;
  openInventoryAlerts: number;
  severeInventoryAlerts: number;
  pendingProposals: number;
  pendingAgentTasks: number;
  leadTimeDays: number;
  safetyStockDays: number;
  targetCoverageDays: number;
  error: string;
}

const emptyOperationalDashboard: OperationalDashboard = {
  connections: [],
  productCounts: {},
  latestProductSync: {},
  openInventoryAlerts: 0,
  severeInventoryAlerts: 0,
  pendingProposals: 0,
  pendingAgentTasks: 0,
  leadTimeDays: 95,
  safetyStockDays: 30,
  targetCoverageDays: 155,
  error: "",
};

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
  const [operations, setOperations] = useState<OperationalDashboard>(emptyOperationalDashboard);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const conversionBase = companies.filter((company) => company.status !== "descartado").length;
  const clients = companies.filter((company) => company.status === "cliente").length;
  const conversionRate = conversionBase ? Math.round((clients / conversionBase) * 100) : 0;
  const recentInteractions = interactions.slice(0, 6);
  const discardedCount = companies.filter((company) => company.status === "descartado").length;
  const funnel = useMemo(() => buildFunnel(companies), [companies]);
  const sourceBreakdown = useMemo(() => buildSourceBreakdown(companies), [companies]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    async function loadDashboardData() {
      try {
        const data = await getGmailMetrics();
        setGmailMetrics(data);
      } catch {
        // Gmail metrics are non-critical; the rest of the dashboard can continue.
      }
      await loadOperationalDashboard();
    }

    void loadDashboardData();
  }, []);

  async function loadOperationalDashboard() {
    if (!isSupabaseConfigured || !supabase) return;
    setOperationsLoading(true);
    try {
      const [
        connectionsResult,
        factoProductsResult,
        tiendanubeProductsResult,
        latestRecordsResult,
        alertsResult,
        proposalsResult,
        tasksResult,
        settingsResult,
      ] = await Promise.all([
        supabase
          .from("integration_connections")
          .select("provider,status,message,last_success_at")
          .in("provider", ["facto", "tiendanube", "gmail", "brave", "meta_whatsapp"]),
        supabase
          .from("integration_records")
          .select("id", { count: "exact", head: true })
          .eq("provider", "facto")
          .eq("resource", "products"),
        supabase
          .from("integration_records")
          .select("id", { count: "exact", head: true })
          .eq("provider", "tiendanube")
          .eq("resource", "products"),
        supabase
          .from("integration_records")
          .select("provider,resource,updated_at")
          .eq("resource", "products")
          .order("updated_at", { ascending: false })
          .limit(200),
        supabase.from("inventory_risk_alerts").select("severity,status").eq("status", "open"),
        supabase.from("action_proposals").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("business_agent_tasks").select("id", { count: "exact", head: true }).in("status", ["pending", "in_progress"]),
        supabase
          .from("business_settings")
          .select("key,value")
          .in("key", [
            "foreign_trade.production_days",
            "foreign_trade.sea_travel_days",
            "foreign_trade.customs_delay_days",
            "foreign_trade.safety_stock_days",
            "foreign_trade.target_coverage_days",
          ]),
      ]);

      const firstError =
        connectionsResult.error ||
        factoProductsResult.error ||
        tiendanubeProductsResult.error ||
        latestRecordsResult.error ||
        alertsResult.error ||
        proposalsResult.error ||
        tasksResult.error ||
        settingsResult.error;

      if (firstError) {
        setOperations({ ...emptyOperationalDashboard, error: "Agent Hub pendiente de instalar o actualizar en Supabase." });
        return;
      }

      const settings = new Map((settingsResult.data ?? []).map((row) => [String(row.key), Number(row.value)]));
      const productionDays = settings.get("foreign_trade.production_days") || 45;
      const seaTravelDays = settings.get("foreign_trade.sea_travel_days") || 45;
      const customsDelayDays = settings.get("foreign_trade.customs_delay_days") || 5;
      const latestProductSync: Record<string, string> = {};
      for (const record of latestRecordsResult.data ?? []) {
        const provider = String(record.provider);
        if (!latestProductSync[provider]) latestProductSync[provider] = String(record.updated_at ?? "");
      }
      const openAlerts = alertsResult.data ?? [];

      setOperations({
        connections: (connectionsResult.data ?? []).map((connection) => ({
          provider: String(connection.provider),
          status: String(connection.status),
          message: String(connection.message ?? ""),
          last_success_at: String(connection.last_success_at ?? "") || null,
        })),
        productCounts: {
          facto: factoProductsResult.count ?? 0,
          tiendanube: tiendanubeProductsResult.count ?? 0,
        },
        latestProductSync,
        openInventoryAlerts: openAlerts.length,
        severeInventoryAlerts: openAlerts.filter((alert) => ["high", "critical"].includes(String(alert.severity))).length,
        pendingProposals: proposalsResult.count ?? 0,
        pendingAgentTasks: tasksResult.count ?? 0,
        leadTimeDays: productionDays + seaTravelDays + customsDelayDays,
        safetyStockDays: settings.get("foreign_trade.safety_stock_days") || 30,
        targetCoverageDays: settings.get("foreign_trade.target_coverage_days") || 155,
        error: "",
      });
    } catch {
      setOperations({ ...emptyOperationalDashboard, error: "No se pudo leer el centro de agentes." });
    } finally {
      setOperationsLoading(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-heading executive-heading">
        <div>
          <p>Centro de mando</p>
          <h1>Dashboard ejecutivo</h1>
          <span>Facto manda; Tiendanube, Gmail y prospección complementan la lectura comercial.</span>
        </div>
        <div className="heading-actions">
          <button className="ghost-button" type="button" onClick={() => void loadOperationalDashboard()}>
            <RefreshCw size={18} />
            {operationsLoading ? "Actualizando..." : "Actualizar centro"}
          </button>
          <Link className="primary-button" to="/agentes">
            <Bot size={18} />
            Abrir agentes
          </Link>
        </div>
      </div>

      {operations.error ? <div className="notice-banner info">{operations.error}</div> : null}

      <section className="command-panel">
        <div className="command-main">
          <span className="eyebrow">Prioridad operacional</span>
          <h2>{buildExecutiveHeadline(operations)}</h2>
          <p>{buildExecutiveSummary(operations)}</p>
        </div>
        <div className="command-metrics">
          <MiniKpi label="Facto productos" value={formatCount(operations.productCounts.facto)} detail={formatDateTime(operations.latestProductSync.facto) || "sin lectura"} />
          <MiniKpi label="Tiendanube productos" value={formatCount(operations.productCounts.tiendanube)} detail={formatDateTime(operations.latestProductSync.tiendanube) || "sin lectura"} />
          <MiniKpi label="Lead time importación" value={`${operations.leadTimeDays} días`} detail={`${operations.safetyStockDays} seguridad · ${operations.targetCoverageDays} objetivo`} />
        </div>
      </section>

      <div className="metric-grid">
        <MetricCard to="/empresas" icon={Building2} label="Empresas registradas" value={companies.length.toString()} detail="Abrir base comercial" />
        <MetricCard to="/agentes" icon={AlertTriangle} label="Alertas de inventario" value={operations.openInventoryAlerts.toString()} detail={`${operations.severeInventoryAlerts} críticas/altas`} />
        <MetricCard to="/agentes" icon={Sparkles} label="Propuestas de agentes" value={operations.pendingProposals.toString()} detail={`${operations.pendingAgentTasks} tareas en cola`} />
        <MetricCard to="/empresas?status=cliente" icon={CheckCircle2} label="Conversión comercial" value={`${conversionRate}%`} detail="Ver clientes" />
      </div>

      <div className="metric-grid">
        <MetricCard to="/administracion" icon={Megaphone} label="Emails enviados hoy" value={`${gmailMetrics.sentToday}/${gmailMetrics.dailyLimit || 0}`} detail="Límite diario Gmail" />
        <MetricCard to="/campanas" icon={Megaphone} label="Campañas email activas" value={gmailMetrics.activeCampaigns.toString()} detail="Ver campañas" />
        <MetricCard to="/campanas" icon={CheckCircle2} label="Emails fallidos" value={gmailMetrics.failedEmails.toString()} detail="Revisar errores" />
        <MetricCard to="/empresas" icon={Building2} label="Empresas contactadas" value={gmailMetrics.companiesContacted.toString()} detail={gmailMetrics.lastCampaign || "Sin campaña email"} />
      </div>

      <div className="two-column">
        <div className="panel">
          <div className="panel-heading">
            <h2>Fuentes de verdad</h2>
            <Link className="panel-link" to="/agentes">Ver integraciones</Link>
          </div>
          <div className="source-authority-list">
            <AuthorityRow
              icon={CircleDollarSign}
              title="Facto ERP"
              badge="Manda"
              status={connectionStatus(operations, "facto")}
              detail="Stock, facturación, clientes con compra y documentos comerciales."
            />
            <AuthorityRow
              icon={ShoppingCart}
              title="Tiendanube"
              badge="Complementa"
              status={connectionStatus(operations, "tiendanube")}
              detail="Productos publicados, tienda online, pedidos web y señales ecommerce."
            />
            <AuthorityRow
              icon={ShieldCheck}
              title="CRM Clima Activa"
              badge="Decide"
              status="operativo"
              detail="Revisión humana, campañas, seguimiento, aprobación y control comercial."
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <h2>Comercio exterior</h2>
            <span>Parámetros iniciales</span>
          </div>
          <div className="import-timeline">
            <TimelineStep label="Producción fábrica China" value="45 días" />
            <TimelineStep label="Viaje internacional" value="45 días" />
            <TimelineStep label="Aduana y recepción" value="5 días" />
          </div>
          <div className="import-policy-box">
            <PackageSearch size={20} />
            <p>
              El agente debe avisar antes del quiebre considerando {operations.leadTimeDays} días de reposición,
              temporada alta noviembre-febrero y pausa china de febrero.
            </p>
          </div>
        </div>
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
            <h2>Funnel de conversión</h2>
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
          <h2>Conversión por fuente</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fuente</th>
                <th>Empresas</th>
                <th>Clientes</th>
                <th>Tasa de conversión</th>
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
            <h2>Últimas actividades</h2>
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
            <h2>Próximos seguimientos</h2>
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
                <th>Próxima acción</th>
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

function MiniKpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function AuthorityRow({
  icon: Icon,
  title,
  badge,
  status,
  detail,
}: {
  icon: typeof Building2;
  title: string;
  badge: string;
  status: string;
  detail: string;
}) {
  return (
    <article>
      <Icon size={22} />
      <div>
        <strong>{title}</strong>
        <span>{badge}</span>
        <p>{detail}</p>
      </div>
      <small className={`status-chip ${status === "connected" || status === "operativo" ? "success" : "pending"}`}>{status}</small>
    </article>
  );
}

function TimelineStep({ label, value }: { label: string; value: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
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

function connectionStatus(operations: OperationalDashboard, provider: string) {
  return operations.connections.find((connection) => connection.provider === provider)?.status ?? "pendiente";
}

function buildExecutiveHeadline(operations: OperationalDashboard) {
  const factoStatus = connectionStatus(operations, "facto");
  const tiendanubeStatus = connectionStatus(operations, "tiendanube");
  if (factoStatus === "connected" && tiendanubeStatus === "connected") return "ERP y tienda conectados: listo para análisis operacional.";
  if (factoStatus === "connected") return "Facto conectado: ya podemos priorizar stock, ventas y cobranza.";
  if (operations.openInventoryAlerts > 0) return "Hay alertas de inventario que revisar antes de vender más.";
  return "Centro preparado: esperando lecturas completas de integraciones.";
}

function buildExecutiveSummary(operations: OperationalDashboard) {
  if (operations.error) return "El CRM sigue operativo; falta completar la instalación del centro de agentes para activar datos ejecutivos.";
  const productText = `${formatCount(operations.productCounts.facto)} productos Facto y ${formatCount(operations.productCounts.tiendanube)} productos Tiendanube`;
  return `${productText}. ${operations.pendingProposals} propuestas requieren decisión humana y ${operations.openInventoryAlerts} alertas de inventario están abiertas.`;
}

function formatCount(value: number | undefined) {
  return new Intl.NumberFormat("es-CL").format(value ?? 0);
}

function formatDateTime(value: string | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}
