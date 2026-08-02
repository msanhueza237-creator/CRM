import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Building2,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  Mail,
  Megaphone,
  PackageSearch,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Target,
  UsersRound,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { type GmailMetrics, emptyGmailMetrics, getGmailMetrics } from "../../lib/gmailApi";
import { useCompanyStore } from "../companies/CompanyStore";
import type { Company, CompanyStatus, CompanyType } from "../../types/crm";

const companyTypes: CompanyType[] = ["distribuidor", "tienda comercial", "tecnico", "instalador grande", "competencia", "otro"];
const funnelStages: CompanyStatus[] = ["prospecto", "contactado", "interesado", "cotizado", "cliente"];
const agentTypes = ["commercial", "marketing", "finance", "collections", "logistics", "foreign_trade", "executive"] as const;
const OTHER_SOURCES_LABEL = "Otras fuentes";
const MAX_SOURCE_ROWS = 6;

type AgentType = (typeof agentTypes)[number];

interface ConnectionSummary {
  provider: string;
  status: string;
  message: string;
  last_success_at: string | null;
}

interface AgentRunSummary {
  id: string;
  agent_type: AgentType;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
}

interface DashboardActivity {
  id: string;
  occurredAt: string;
  title: string;
  detail: string;
  kind: "crm" | "email" | "whatsapp" | "agent";
  to: string;
}

interface GlobalDashboard {
  connections: ConnectionSummary[];
  productCounts: Record<string, number>;
  latestProductSync: Record<string, string>;
  openInventoryAlerts: number;
  severeInventoryAlerts: number;
  pendingProposals: number;
  pendingAgentTasks: number;
  prospectingCampaigns: number;
  activeProspectingRuns: number;
  pendingCandidates: number;
  possibleDuplicates: number;
  approvedCandidates: number;
  campaigns: number;
  activeCampaigns: number;
  draftCampaigns: number;
  campaignRecipients: number;
  campaignSent: number;
  campaignInterested: number;
  emailReplies: number;
  whatsappReplies: number;
  latestAgents: AgentRunSummary[];
  activities: DashboardActivity[];
  leadTimeDays: number;
  safetyStockDays: number;
  targetCoverageDays: number;
  refreshedAt: string;
  warnings: string[];
}

const emptyDashboard: GlobalDashboard = {
  connections: [],
  productCounts: {},
  latestProductSync: {},
  openInventoryAlerts: 0,
  severeInventoryAlerts: 0,
  pendingProposals: 0,
  pendingAgentTasks: 0,
  prospectingCampaigns: 0,
  activeProspectingRuns: 0,
  pendingCandidates: 0,
  possibleDuplicates: 0,
  approvedCandidates: 0,
  campaigns: 0,
  activeCampaigns: 0,
  draftCampaigns: 0,
  campaignRecipients: 0,
  campaignSent: 0,
  campaignInterested: 0,
  emailReplies: 0,
  whatsappReplies: 0,
  latestAgents: [],
  activities: [],
  leadTimeDays: 95,
  safetyStockDays: 30,
  targetCoverageDays: 155,
  refreshedAt: "",
  warnings: [],
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
  const [dashboard, setDashboard] = useState<GlobalDashboard>(emptyDashboard);
  const [loading, setLoading] = useState(false);

  const loadGlobalDashboard = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setLoading(true);
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
        prospectingCampaignsResult,
        prospectingRunsResult,
        candidatesResult,
        campaignsResult,
        recipientsResult,
        emailReplyCountResult,
        emailReplyRowsResult,
        whatsappCountResult,
        whatsappRowsResult,
      ] = await Promise.all([
        supabase.from("integration_connections").select("provider,status,message,last_success_at").in("provider", ["facto", "tiendanube", "gmail", "brave", "meta_whatsapp"]),
        supabase.from("integration_records").select("id", { count: "exact", head: true }).eq("provider", "facto").eq("resource", "products"),
        supabase.from("integration_records").select("id", { count: "exact", head: true }).eq("provider", "tiendanube").eq("resource", "products"),
        supabase.from("integration_records").select("provider,resource,updated_at").eq("resource", "products").order("updated_at", { ascending: false }).limit(200),
        supabase.from("inventory_risk_alerts").select("severity,status").eq("status", "open"),
        supabase.from("action_proposals").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("business_agent_tasks").select("id,agent_type,status,created_at,completed_at,error_code").order("created_at", { ascending: false }).limit(80),
        supabase.from("business_settings").select("key,value").in("key", ["foreign_trade.production_days", "foreign_trade.sea_travel_days", "foreign_trade.customs_delay_days", "foreign_trade.safety_stock_days", "foreign_trade.target_coverage_days"]),
        supabase.from("prospecting_campaigns").select("id,status"),
        supabase.from("prospecting_runs").select("id,status,created_at").order("created_at", { ascending: false }).limit(100),
        supabase.from("prospecting_campaign_candidates").select("review_status"),
        supabase.from("campaigns").select("id,status,created_at,send_at"),
        supabase.from("campaign_recipients").select("sent_at,replied_at,interested,discarded"),
        supabase.from("email_campaign_recipients").select("id", { count: "exact", head: true }).not("replied_at", "is", null),
        supabase.from("email_campaign_recipients").select("id,campaign_id,company_id,reply_from_email,reply_subject,reply_snippet,replied_at").not("replied_at", "is", null).order("replied_at", { ascending: false }).limit(8),
        supabase.from("whatsapp_messages").select("id", { count: "exact", head: true }).eq("direction", "incoming"),
        supabase.from("whatsapp_messages").select("id,company_id,phone_number,body,occurred_at,created_at").eq("direction", "incoming").order("occurred_at", { ascending: false, nullsFirst: false }).limit(8),
      ]);

      const results = [
        ["integraciones", connectionsResult.error],
        ["productos Facto", factoProductsResult.error],
        ["productos Tiendanube", tiendanubeProductsResult.error],
        ["sincronizaciones", latestRecordsResult.error],
        ["alertas", alertsResult.error],
        ["propuestas", proposalsResult.error],
        ["agentes", tasksResult.error],
        ["parámetros", settingsResult.error],
        ["prospección", prospectingCampaignsResult.error || prospectingRunsResult.error || candidatesResult.error],
        ["campañas", campaignsResult.error || recipientsResult.error],
        ["respuestas email", emailReplyCountResult.error || emailReplyRowsResult.error],
        ["respuestas WhatsApp", whatsappCountResult.error || whatsappRowsResult.error],
      ] as const;
      const warnings = results.filter(([, error]) => Boolean(error)).map(([label]) => `No se pudo actualizar ${label}.`);

      const settings = new Map((settingsResult.data ?? []).map((row) => [String(row.key), Number(row.value)]));
      const productionDays = settings.get("foreign_trade.production_days") || 45;
      const seaTravelDays = settings.get("foreign_trade.sea_travel_days") || 45;
      const customsDelayDays = settings.get("foreign_trade.customs_delay_days") || 5;
      const latestProductSync: Record<string, string> = {};
      for (const record of latestRecordsResult.data ?? []) {
        const provider = String(record.provider);
        if (!latestProductSync[provider]) latestProductSync[provider] = String(record.updated_at ?? "");
      }

      const taskRows = (tasksResult.data ?? []) as AgentRunSummary[];
      const latestAgents: AgentRunSummary[] = [];
      for (const type of agentTypes) {
        const latest = taskRows.find((task) => task.agent_type === type);
        if (latest) latestAgents.push(latest);
      }
      const pendingAgentTasks = taskRows.filter((task) => ["pending", "in_progress"].includes(task.status)).length;

      const candidateRows = candidatesResult.data ?? [];
      const prospectingRunRows = prospectingRunsResult.data ?? [];
      const campaignRows = campaignsResult.data ?? [];
      const recipientRows = recipientsResult.data ?? [];
      const alertRows = alertsResult.data ?? [];

      const emailActivities: DashboardActivity[] = (emailReplyRowsResult.data ?? []).map((row) => ({
        id: `email-${row.id}`,
        occurredAt: String(row.replied_at ?? ""),
        title: `Respuesta email de ${String(row.reply_from_email ?? "cliente")}`,
        detail: String(row.reply_subject ?? row.reply_snippet ?? "Respuesta recibida"),
        kind: "email",
        to: "/campanas",
      }));
      const whatsappActivities: DashboardActivity[] = (whatsappRowsResult.data ?? []).map((row) => ({
        id: `whatsapp-${row.id}`,
        occurredAt: String(row.occurred_at ?? row.created_at ?? ""),
        title: `Respuesta WhatsApp ${String(row.phone_number ?? "")}`,
        detail: String(row.body ?? "Mensaje recibido"),
        kind: "whatsapp",
        to: "/administracion",
      }));
      const agentActivities: DashboardActivity[] = taskRows.slice(0, 8).map((task) => ({
        id: `agent-${task.id}`,
        occurredAt: task.completed_at || task.created_at,
        title: `${agentName(task.agent_type)} · ${agentStatusLabel(task.status)}`,
        detail: task.error_code ? `Incidencia: ${task.error_code}` : "Análisis registrado en el centro de agentes.",
        kind: "agent",
        to: `/agentes/${task.agent_type}/dashboard`,
      }));

      setDashboard({
        connections: (connectionsResult.data ?? []).map((connection) => ({
          provider: String(connection.provider),
          status: String(connection.status),
          message: String(connection.message ?? ""),
          last_success_at: String(connection.last_success_at ?? "") || null,
        })),
        productCounts: { facto: factoProductsResult.count ?? 0, tiendanube: tiendanubeProductsResult.count ?? 0 },
        latestProductSync,
        openInventoryAlerts: alertRows.length,
        severeInventoryAlerts: alertRows.filter((alert) => ["high", "critical"].includes(String(alert.severity))).length,
        pendingProposals: proposalsResult.count ?? 0,
        pendingAgentTasks,
        prospectingCampaigns: prospectingCampaignsResult.data?.length ?? 0,
        activeProspectingRuns: prospectingRunRows.filter((run) => ["pending", "running", "paused", "cancel_requested"].includes(String(run.status))).length,
        pendingCandidates: candidateRows.filter((row) => String(row.review_status) === "pending").length,
        possibleDuplicates: candidateRows.filter((row) => String(row.review_status) === "possible_duplicate").length,
        approvedCandidates: candidateRows.filter((row) => ["approved", "linked"].includes(String(row.review_status))).length,
        campaigns: campaignRows.length,
        activeCampaigns: campaignRows.filter((row) => ["programada", "enviada"].includes(String(row.status))).length,
        draftCampaigns: campaignRows.filter((row) => String(row.status) === "borrador").length,
        campaignRecipients: recipientRows.length,
        campaignSent: recipientRows.filter((row) => Boolean(row.sent_at)).length,
        campaignInterested: recipientRows.filter((row) => Boolean(row.interested)).length,
        emailReplies: emailReplyCountResult.count ?? recipientRows.filter((row) => Boolean(row.replied_at)).length,
        whatsappReplies: whatsappCountResult.count ?? 0,
        latestAgents,
        activities: [...emailActivities, ...whatsappActivities, ...agentActivities]
          .filter((activity) => activity.occurredAt)
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
          .slice(0, 10),
        leadTimeDays: productionDays + seaTravelDays + customsDelayDays,
        safetyStockDays: settings.get("foreign_trade.safety_stock_days") || 30,
        targetCoverageDays: settings.get("foreign_trade.target_coverage_days") || 155,
        refreshedAt: new Date().toISOString(),
        warnings,
      });
    } catch {
      setDashboard((current) => ({ ...current, refreshedAt: new Date().toISOString(), warnings: ["No se pudo completar la lectura global del CRM."] }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    async function load() {
      try {
        setGmailMetrics(await getGmailMetrics());
      } catch {
        // Gmail is one signal among several; the global dashboard remains usable.
      }
      await loadGlobalDashboard();
    }
    void load();
  }, [loadGlobalDashboard]);

  const conversionBase = companies.filter((company) => company.status !== "descartado").length;
  const clients = companies.filter((company) => company.status === "cliente").length;
  const conversionRate = conversionBase ? Math.round((clients / conversionBase) * 100) : 0;
  const discardedCount = companies.filter((company) => company.status === "descartado").length;
  const funnel = useMemo(() => buildFunnel(companies), [companies]);
  const sourceBreakdown = useMemo(() => buildSourceBreakdown(companies), [companies]);
  const today = new Date().toISOString().slice(0, 10);
  const dueFollowUps = companies
    .filter((company) => company.nextFollowUp && company.nextFollowUp <= today && company.status !== "descartado")
    .sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const contactableCompanies = companies.filter((company) => company.email || company.whatsappNumber || company.whatsapp || company.phone).length;
  const locatedCompanies = companies.filter((company) => company.region && company.city).length;
  const realCrmActivities: DashboardActivity[] = interactions.slice(0, 10).map((interaction) => {
    const company = companies.find((item) => item.id === interaction.companyId);
    return {
      id: `crm-${interaction.id}`,
      occurredAt: interaction.date,
      title: `${interaction.type}: ${company?.name ?? "Empresa"}`,
      detail: interaction.result || interaction.description || interaction.nextAction || "Actividad registrada",
      kind: "crm",
      to: company ? `/empresas/${company.id}` : "/empresas",
    };
  });
  const combinedActivities = [...dashboard.activities, ...realCrmActivities]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 10);
  const connectedIntegrations = dashboard.connections.filter((connection) => connection.status === "connected").length;
  const integrationErrors = dashboard.connections.filter((connection) => ["error", "degraded"].includes(connection.status)).length;
  const totalReplies = dashboard.emailReplies + dashboard.whatsappReplies;
  const attentionCount = dashboard.severeInventoryAlerts + dashboard.pendingProposals + dashboard.pendingCandidates + dashboard.possibleDuplicates + dueFollowUps.length + integrationErrors;

  return (
    <section className="page-stack global-dashboard-page">
      <div className="page-heading executive-heading">
        <div>
          <p>Vista global del CRM</p>
          <h1>Centro de control Clima Activa</h1>
          <span>Empresas, prospección, campañas, agentes e integraciones reunidos en una sola lectura trazable.</span>
        </div>
        <div className="heading-actions">
          <button className="ghost-button" type="button" onClick={() => void loadGlobalDashboard()} disabled={loading}>
            <RefreshCw size={18} className={loading ? "spin-icon" : ""} />
            {loading ? "Actualizando..." : "Actualizar CRM"}
          </button>
          <Link className="primary-button" to="/agentes/executive/dashboard">
            <Sparkles size={18} /> Agente gerente
          </Link>
        </div>
      </div>

      {dashboard.warnings.length ? (
        <div className="notice-banner info">
          <strong>Lectura parcial.</strong> {dashboard.warnings.join(" ")}
        </div>
      ) : null}

      <section className={`command-panel global-command-panel ${attentionCount ? "needs-attention" : "healthy"}`}>
        <div className="command-main">
          <span className="eyebrow">ESTADO GENERAL</span>
          <h2>{buildGlobalHeadline(attentionCount, integrationErrors, totalReplies)}</h2>
          <p>{buildGlobalSummary(dashboard, companies.length, dueFollowUps.length, contactableCompanies)}</p>
          <small>Última lectura: {formatDateTime(dashboard.refreshedAt) || "pendiente"}</small>
        </div>
        <div className="command-metrics">
          <MiniKpi label="Atenciones" value={formatCount(attentionCount)} detail="Abre los bloques prioritarios" />
          <MiniKpi label="Integraciones" value={`${connectedIntegrations}/${dashboard.connections.length || 5}`} detail={integrationErrors ? `${integrationErrors} con incidencia` : "Sin errores reportados"} />
          <MiniKpi label="Respuestas" value={formatCount(totalReplies)} detail={`${dashboard.emailReplies} email · ${dashboard.whatsappReplies} WhatsApp`} />
        </div>
      </section>

      <div className="global-kpi-grid">
        <MetricCard to="/empresas" icon={Building2} label="Empresas CRM" value={formatCount(companies.length)} detail={`${clients} clientes · ${contactableCompanies} contactables`} />
        <MetricCard to="/prospeccion?tab=candidates" icon={SearchCheck} label="Por revisar" value={formatCount(dashboard.pendingCandidates + dashboard.possibleDuplicates)} detail={`${dashboard.possibleDuplicates} posibles duplicados`} tone={dashboard.pendingCandidates ? "attention" : "default"} />
        <MetricCard to="/campanas" icon={Megaphone} label="Campañas" value={formatCount(dashboard.campaigns)} detail={`${dashboard.activeCampaigns} activas · ${dashboard.draftCampaigns} borradores`} />
        <MetricCard to="/campanas" icon={Mail} label="Respuestas recibidas" value={formatCount(totalReplies)} detail={`${dashboard.campaignInterested} interesados marcados`} />
        <MetricCard to="/agentes/logistics/dashboard" icon={AlertTriangle} label="Riesgos de inventario" value={formatCount(dashboard.openInventoryAlerts)} detail={`${dashboard.severeInventoryAlerts} críticos o altos`} tone={dashboard.severeInventoryAlerts ? "danger" : "default"} />
        <MetricCard to="/agentes" icon={Sparkles} label="Decisiones pendientes" value={formatCount(dashboard.pendingProposals)} detail={`${dashboard.pendingAgentTasks} análisis en proceso`} tone={dashboard.pendingProposals ? "attention" : "default"} />
      </div>

      <section className="global-section">
        <div className="global-section-heading">
          <div><span className="eyebrow">MÓDULOS DEL CRM</span><h2>Estado por área</h2></div>
          <span>Selecciona un cuadro para abrir el detalle.</span>
        </div>
        <div className="global-module-grid">
          <ModuleCard to="/empresas" icon={UsersRound} title="Base comercial" value={`${formatCount(companies.length)} empresas`} detail={`${contactableCompanies} con canal de contacto · ${locatedCompanies} con región y comuna`} status={`${conversionRate}% conversión`} />
          <ModuleCard to="/prospeccion" icon={Target} title="Prospección" value={`${formatCount(dashboard.prospectingCampaigns)} búsquedas`} detail={`${dashboard.activeProspectingRuns} ejecuciones activas · ${dashboard.approvedCandidates} aprobados/vinculados`} status={`${dashboard.pendingCandidates} pendientes`} />
          <ModuleCard to="/campanas" icon={Megaphone} title="Campañas" value={`${formatCount(dashboard.campaignRecipients)} destinatarios`} detail={`${dashboard.campaignSent} envíos registrados · ${totalReplies} respuestas`} status={`${dashboard.activeCampaigns} activas`} />
          <ModuleCard to="/agentes" icon={Bot} title="Centro de agentes" value={`${dashboard.latestAgents.length}/${agentTypes.length} con historial`} detail={`${dashboard.pendingAgentTasks} tareas abiertas · ${dashboard.pendingProposals} propuestas`} status={dashboard.pendingAgentTasks ? "Trabajando" : "Disponible"} />
          <ModuleCard to="/agentes/logistics/dashboard" icon={PackageSearch} title="Inventario" value={`${formatCount(dashboard.productCounts.facto)} SKU Facto`} detail={`${formatCount(dashboard.productCounts.tiendanube)} productos Tiendanube · ${dashboard.leadTimeDays} días importación`} status={`${dashboard.openInventoryAlerts} alertas`} />
          <ModuleCard to="/administracion" icon={Database} title="Integraciones" value={`${connectedIntegrations} conectadas`} detail="Facto, Tiendanube, Gmail, Brave y WhatsApp Meta" status={integrationErrors ? `${integrationErrors} con error` : "Operativas"} />
        </div>
      </section>

      <div className="two-column global-priority-grid">
        <div className="panel">
          <div className="panel-heading"><h2>Atención prioritaria</h2><span>{attentionCount} señales</span></div>
          <div className="priority-list">
            <PriorityRow to="/agentes/logistics/dashboard" icon={AlertTriangle} label="Alertas de inventario críticas/altas" value={dashboard.severeInventoryAlerts} />
            <PriorityRow to="/prospeccion?tab=candidates" icon={SearchCheck} label="Candidatos esperando revisión" value={dashboard.pendingCandidates + dashboard.possibleDuplicates} />
            <PriorityRow to="/empresas" icon={CalendarClock} label="Seguimientos vencidos o para hoy" value={dueFollowUps.length} />
            <PriorityRow to="/agentes" icon={Sparkles} label="Propuestas esperando decisión" value={dashboard.pendingProposals} />
            <PriorityRow to="/administracion" icon={Database} label="Integraciones con incidencia" value={integrationErrors} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading"><h2>Última actividad real</h2><span>{combinedActivities.length} registros</span></div>
          <div className="global-activity-list">
            {combinedActivities.length ? combinedActivities.slice(0, 7).map((activity) => (
              <Link to={activity.to} key={activity.id}>
                <span className={`activity-dot ${activity.kind}`} />
                <div><strong>{activity.title}</strong><small>{truncate(activity.detail, 100)}</small></div>
                <time>{formatCompactDate(activity.occurredAt)}</time>
              </Link>
            )) : <EmptyState text="Aún no hay interacciones, respuestas o análisis registrados." />}
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading"><h2>Estado de los agentes</h2><Link className="panel-link" to="/agentes">Abrir centro</Link></div>
        <div className="agent-health-grid">
          {agentTypes.map((type) => {
            const run = dashboard.latestAgents.find((item) => item.agent_type === type);
            return (
              <Link to={`/agentes/${type}/dashboard`} key={type} className={`agent-health-card ${run?.status ?? "empty"}`}>
                <Bot size={19} />
                <div><strong>{agentName(type)}</strong><span>{run ? agentStatusLabel(run.status) : "Sin análisis"}</span><small>{run ? formatDateTime(run.completed_at || run.created_at) : "Solicítalo desde Agentes"}</small></div>
                <ArrowUpRight size={17} />
              </Link>
            );
          })}
        </div>
      </section>

      <div className="two-column">
        <div className="panel">
          <div className="panel-heading"><h2>Empresas por tipo</h2><span>{formatCount(companies.length)} total</span></div>
          <div className="bar-list">
            {companyTypes.map((type) => <BarRow key={type} to={`/empresas?type=${encodeURIComponent(type)}`} label={type} value={companies.filter((company) => company.type === type).length} max={companies.length} />)}
          </div>
        </div>
        <div className="panel">
          <div className="panel-heading"><h2>Funnel comercial</h2><span>{discardedCount} descartadas</span></div>
          <div className="bar-list">
            {funnel.map(({ stage, count, conversionFromPrevious }) => <BarRow key={stage} to={`/empresas?status=${encodeURIComponent(stage)}`} label={conversionFromPrevious === null ? stage : `${stage} (${conversionFromPrevious}% del anterior)`} value={count} max={funnel[0]?.count ?? 0} />)}
          </div>
        </div>
      </div>

      <div className="two-column">
        <div className="panel">
          <div className="panel-heading"><h2>Próximos seguimientos</h2><Link className="panel-link" to="/empresas">Ver empresas</Link></div>
          <div className="follow-up-list">
            {dueFollowUps.length ? dueFollowUps.slice(0, 8).map((company) => (
              <Link to={`/empresas/${company.id}`} key={company.id}>
                <Clock3 size={18} /><div><strong>{company.name}</strong><span>{company.nextFollowUp} · {company.status}</span></div><ArrowUpRight size={17} />
              </Link>
            )) : <EmptyState text="No hay seguimientos vencidos ni programados para hoy." />}
          </div>
        </div>
        <div className="panel">
          <div className="panel-heading"><h2>Conversión por fuente</h2><span>Origen CRM</span></div>
          <div className="source-compact-list">
            {sourceBreakdown.map((row) => (
              <Link key={row.source} to={row.source === OTHER_SOURCES_LABEL ? "/empresas" : `/empresas?source=${encodeURIComponent(row.source)}`}>
                <div><strong>{row.source}</strong><span>{row.total} empresas · {row.clients} clientes</span></div><b>{row.conversionRate}%</b>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-heading"><h2>Fuentes de verdad</h2><Link className="panel-link" to="/administracion">Administrar conexiones</Link></div>
        <div className="source-authority-list global-authority-list">
          <AuthorityRow icon={CircleDollarSign} title="Facto ERP" badge="Manda" status={connectionStatus(dashboard, "facto")} detail={`Stock, documentos y cartera · ${formatCount(dashboard.productCounts.facto)} productos sincronizados.`} />
          <AuthorityRow icon={ShoppingCart} title="Tiendanube / Climactiva.cl" badge="Complementa" status={connectionStatus(dashboard, "tiendanube")} detail={`Ecommerce y compradores web · ${formatCount(dashboard.productCounts.tiendanube)} productos sincronizados.`} />
          <AuthorityRow icon={ShieldCheck} title="CRM Clima Activa" badge="Decide" status="operativo" detail="Empresas, aprobación de prospectos, campañas, seguimiento y decisiones humanas." />
        </div>
      </section>

      <div className="dashboard-footnote">
        <ShieldCheck size={18} />
        <span>El Dashboard resume datos almacenados en el CRM. Finanzas, logística, comercio exterior y gerencia conservan sus análisis especializados y su evidencia.</span>
        <span>Gmail hoy: {gmailMetrics.sentToday}/{gmailMetrics.dailyLimit || 0}</span>
      </div>
    </section>
  );
}

function MetricCard({ icon: Icon, label, value, detail, to, tone = "default" }: { icon: typeof Building2; label: string; value: string; detail: string; to: string; tone?: "default" | "attention" | "danger" }) {
  return <Link className={`metric-card metric-link global-metric-card ${tone}`} to={to}><Icon size={22} /><span>{label}</span><strong>{value}</strong><p>{detail}</p><ArrowUpRight className="card-arrow" size={17} /></Link>;
}

function ModuleCard({ icon: Icon, title, value, detail, status, to }: { icon: typeof Building2; title: string; value: string; detail: string; status: string; to: string }) {
  return <Link className="global-module-card" to={to}><div className="module-card-top"><Icon size={21} /><span>{status}</span></div><h3>{title}</h3><strong>{value}</strong><p>{detail}</p><span className="module-card-action">Abrir módulo <ArrowUpRight size={15} /></span></Link>;
}

function PriorityRow({ icon: Icon, label, value, to }: { icon: typeof AlertTriangle; label: string; value: number; to: string }) {
  return <Link to={to} className={value ? "has-value" : "clear"}><Icon size={19} /><span>{label}</span><strong>{formatCount(value)}</strong><ArrowUpRight size={16} /></Link>;
}

function MiniKpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function AuthorityRow({ icon: Icon, title, badge, status, detail }: { icon: typeof Building2; title: string; badge: string; status: string; detail: string }) {
  return <article><Icon size={22} /><div><strong>{title}</strong><span>{badge}</span><p>{detail}</p></div><small className={`status-chip ${status === "connected" || status === "operativo" ? "success" : "pending"}`}>{status}</small></article>;
}

function BarRow({ label, value, max, to }: { label: string; value: number; max: number; to: string }) {
  const width = max ? `${Math.max((value / max) * 100, value ? 8 : 0)}%` : "0%";
  return <Link className="bar-row bar-link" to={to}><div><span>{label}</span><strong>{value}</strong></div><div className="bar-track"><span style={{ width }} /></div></Link>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="dashboard-empty"><CheckCircle2 size={19} /><span>{text}</span></div>;
}

function connectionStatus(dashboard: GlobalDashboard, provider: string) {
  return dashboard.connections.find((connection) => connection.provider === provider)?.status ?? "pendiente";
}

function buildGlobalHeadline(attention: number, integrationErrors: number, replies: number) {
  if (integrationErrors) return "Hay una conexión que revisar antes del próximo corte.";
  if (attention) return `${formatCount(attention)} señales requieren revisión en el CRM.`;
  if (replies) return "CRM operativo y con respuestas recientes de clientes.";
  return "CRM operativo, conectado y sin alertas críticas abiertas.";
}

function buildGlobalSummary(dashboard: GlobalDashboard, companies: number, due: number, contactable: number) {
  return `${formatCount(companies)} empresas (${formatCount(contactable)} contactables), ${dashboard.pendingCandidates + dashboard.possibleDuplicates} candidatos por revisar, ${dashboard.openInventoryAlerts} alertas de inventario y ${due} seguimientos vencidos o para hoy.`;
}

function agentName(type: string) {
  return ({ commercial: "Agente comercial", marketing: "Agente marketing", finance: "Agente finanzas", collections: "Agente cobranza", logistics: "Agente logístico", foreign_trade: "Comercio exterior", executive: "Agente gerente" } as Record<string, string>)[type] ?? type;
}

function agentStatusLabel(status: string) {
  return ({ pending: "Pendiente", in_progress: "En proceso", completed: "Completado", failed: "Con error", cancelled: "Cancelado" } as Record<string, string>)[status] ?? status;
}

function formatCount(value: number | undefined) {
  return new Intl.NumberFormat("es-CL").format(value ?? 0);
}

function formatDateTime(value: string | undefined | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

function formatCompactDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-CL", { day: "2-digit", month: "short" });
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
