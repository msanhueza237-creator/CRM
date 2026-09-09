import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Megaphone,
  PackageSearch,
  RefreshCw,
  Sparkles,
  Truck,
  UserRoundSearch,
  WalletCards,
  XCircle,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";

type AgentType =
  | "commercial"
  | "marketing"
  | "finance"
  | "collections"
  | "logistics"
  | "foreign_trade"
  | "executive";

interface AgentTask {
  id: string;
  agent_type: AgentType;
  action: string;
  status: string;
  created_at: string;
  result?: {
    summary?: string;
    warnings?: string[];
    metrics?: Record<string, string | number | boolean | null>;
  } | null;
  error_code?: string | null;
}

interface Proposal {
  id: string;
  kind: string;
  title: string;
  summary: string;
  risk_level: string;
  status: string;
  created_at: string;
}

interface AgentActionItem {
  id: string;
  proposal_id: string;
  kind: string;
  destination_module: string;
  destination_path: string;
  destination_record_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
}

interface ProposalDecisionResult {
  decision?: string;
  message?: string;
  destination_module?: string;
  destination_path?: string;
}

interface RiskAlert {
  id: string;
  sku: string;
  severity: string;
  title: string;
  detail: string;
  status: string;
}

interface Connection {
  provider: string;
  status: string;
  read_only: boolean;
  message: string | null;
  last_success_at: string | null;
}

interface InventorySnapshotRecord {
  payload: {
    sku?: string;
    available_units?: number;
    unit_cost_usd?: number;
    average_daily_demand?: number;
    stock_known?: boolean;
    cost_known?: boolean;
    cost_available_in_source?: boolean;
    cost_requires_usd_conversion?: boolean;
    demand_available?: boolean;
    demand_observation_days?: number;
    units_sold_observed?: number;
    name?: string;
    price_known?: boolean;
    unit_price?: number;
    unit_margin?: number | null;
    margin_percent?: number | null;
    sales_history_available?: boolean;
  };
}

interface IntegrationPayloadRecord {
  external_id?: string | null;
  resource: string;
  payload: Record<string, unknown>;
  updated_at?: string | null;
}


const agents: Array<{
  type: AgentType;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  { type: "commercial", title: "Agente comercial", description: "Cartera unificada, recurrencia y segmentos HVAC.", icon: UserRoundSearch },
  { type: "marketing", title: "Agente marketing", description: "Audiencias, productos y campañas trazables para revisión.", icon: Megaphone },
  { type: "finance", title: "Agente finanzas", description: "Márgenes y anomalías.", icon: CircleDollarSign },
  { type: "collections", title: "Agente cobranza", description: "Cartera vencida y recordatorios.", icon: WalletCards },
  { type: "logistics", title: "Agente logistico", description: "Rotacion, margen, sobrestock y bodega.", icon: Truck },
  { type: "foreign_trade", title: "Comercio exterior", description: "Stock, compras e importaciones.", icon: PackageSearch },
  { type: "executive", title: "Agente gerente", description: "Resumen y alertas prioritarias.", icon: Sparkles },
];

const defaultAction: Record<AgentType, string> = {
  commercial: "review_pipeline",
  marketing: "prepare_marketing_plan",
  finance: "review_margin",
  collections: "review_aging",
  logistics: "review_logistics",
  foreign_trade: "review_import_plan",
  executive: "prepare_brief",
};

const proposalDestinations: Record<string, { label: string; detail: string; path: string }> = {
  campaign_draft: {
    label: "Borrador en Campañas",
    detail: "crea la campaña y agrega las empresas CRM disponibles; no la envía",
    path: "/campanas",
  },
  purchase_order: {
    label: "Compra en Comercio Exterior",
    detail: "formaliza un borrador para revisión; no emite la orden al proveedor",
    path: "/agentes/foreign_trade/dashboard",
  },
  collection_reminder: {
    label: "Tarea de Cobranza",
    detail: "crea un seguimiento interno; no contacta al cliente",
    path: "/agentes/collections/dashboard",
  },
  commercial_follow_up: {
    label: "Tarea Comercial",
    detail: "deja el seguimiento pendiente en el agente comercial",
    path: "/agentes/commercial/dashboard",
  },
  executive_alert: {
    label: "Tarea Gerencial",
    detail: "registra la decisión prioritaria para seguimiento",
    path: "/agentes/executive/dashboard",
  },
};

function proposalDestination(kind: string) {
  return proposalDestinations[kind] ?? {
    label: "Acción trazable",
    detail: "queda registrada para revisión humana",
    path: "/agentes",
  };
}

function approvedActionPath(item: AgentActionItem) {
  const destination = item.destination_path || proposalDestination(item.kind).path;
  const taskDestinations = new Set(["collections", "commercial", "executive"]);

  if (!item.destination_record_id || !taskDestinations.has(item.destination_module)) {
    return destination;
  }

  const separator = destination.includes("?") ? "&" : "?";
  return `${destination}${separator}task=${encodeURIComponent(item.destination_record_id)}#approved-task`;
}

export function AgentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = user?.role === "administrador";
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [actionItems, setActionItems] = useState<AgentActionItem[]>([]);
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !user) return;
    const [taskResult, proposalResult, alertResult, connectionResult, actionItemResult] = await Promise.all([
      supabase.from("business_agent_tasks").select("id,agent_type,action,status,created_at,result,error_code").order("created_at", { ascending: false }).limit(30),
      supabase.from("action_proposals").select("id,kind,title,summary,risk_level,status,created_at").order("created_at", { ascending: false }).limit(30),
      supabase.from("inventory_risk_alerts").select("id,sku,severity,title,detail,status").eq("status", "open").order("created_at", { ascending: false }).limit(30),
      supabase.from("integration_connections").select("provider,status,read_only,message,last_success_at").order("provider"),
      supabase.from("agent_action_items").select("id,proposal_id,kind,destination_module,destination_path,destination_record_id,title,summary,status,created_at").order("created_at", { ascending: false }).limit(20),
    ]);
    const firstError = taskResult.error || proposalResult.error || alertResult.error || connectionResult.error;
    if (firstError) {
      setNotice("Falta ejecutar supabase/agent_hub.sql en Supabase.");
      return;
    }
    setTasks((taskResult.data ?? []) as AgentTask[]);
    setProposals((proposalResult.data ?? []) as Proposal[]);
    setAlerts((alertResult.data ?? []) as RiskAlert[]);
    setConnections((connectionResult.data ?? []) as Connection[]);
    if (actionItemResult.error) {
      setActionItems([]);
      setNotice("Falta ejecutar supabase/agent_action_dispatch.sql en Supabase para activar los destinos de aprobación.");
    } else {
      setActionItems((actionItemResult.data ?? []) as AgentActionItem[]);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function requestAgent(type: AgentType) {
    if (!supabase || !user) return;
    setBusy(type);
    setNotice("");
    try {
      const { data, error } = await supabase.from("business_agent_tasks").insert({
        agent_type: type,
        action: defaultAction[type],
        requested_by: user.id,
        payload: { source_module: "crm_modules", contract_version: 1, delivery: { auto_send: false } },
      }).select("id").single();
      if (error) throw error;
      await load();
      navigate(`/agentes/${type}/dashboard?task=${data.id}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo solicitar el analisis de modulos.");
    } finally {
      setBusy("");
    }
  }

  async function decideProposal(id: string, decision: "approved" | "rejected") {
    if (!supabase) return;
    setBusy(id);
    const { data, error } = await supabase.rpc("decide_action_proposal", {
      p_proposal_id: id,
      p_decision: decision,
      p_note: decision === "approved" ? "Aprobado desde el centro de agentes" : "Rechazado desde el centro de agentes",
    });
    const result = data as ProposalDecisionResult | null;
    setBusy("");
    setNotice(
      error
        ? error.message
        : result?.message ?? (decision === "approved" ? "Propuesta aprobada y materializada." : "Propuesta rechazada."),
    );
    await load();
  }

  return (
    <section className="agents-page">
      <div className="page-heading agent-heading">
        <div>
          <span className="eyebrow">CENTRO OPERACIONAL</span>
          <h1>Agentes Climactiva</h1>
          <p>Analizan información y preparan propuestas. Ningún agente compra, cobra ni envía campañas sin aprobación.</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void load()}>
          <RefreshCw size={18} /> Actualizar
        </button>
      </div>

      {notice ? <div className="notice-banner info">{notice}</div> : null}
      {!canManage ? <div className="notice-banner info">Vista de solo lectura. Solo un administrador puede solicitar análisis o decidir propuestas.</div> : null}

      <section className="agent-command-card">
        <div>
          <span className="eyebrow">REGLAS DEL CENTRO</span>
          <h2>El CRM decide; los agentes preparan evidencia</h2>
          <p>
            Facto es la fuente principal para stock, ventas y documentos. Tiendanube complementa productos,
            pedidos web y clientes online. Los agentes solo preparan analisis y propuestas: ninguna compra,
            cobranza o campana sale sin revision humana.
          </p>
        </div>
        <div className="agent-policy-grid">
          <article>
            <strong>95 dias</strong>
            <span>45 produccion · 45 viaje · 5 aduana</span>
          </article>
          <article>
            <strong>USD 50k-70k</strong>
            <span>rango objetivo por orden china</span>
          </article>
          <article>
            <strong>Nov-Feb</strong>
            <span>temporada alta; febrero baja produccion china</span>
          </article>
        </div>
      </section>

      <div className="agent-grid">
        {agents.map((agent) => {
          const latest = tasks.find((task) => task.agent_type === agent.type);
          return (
            <article className="agent-card" key={agent.type}>
              <agent.icon size={26} />
              <div>
                <h2>{agent.title}</h2>
                <p>{agent.description}</p>
                <small>Última tarea: {latest ? `${latest.status} · ${new Date(latest.created_at).toLocaleString("es-CL")}` : "sin ejecutar"}</small>
                {latest?.result?.summary ? <p className="agent-result-summary">{latest.result.summary}</p> : null}
                {latest?.result?.warnings?.map((warning) => (
                  <small className="agent-result-warning" key={warning}>{warning}</small>
                ))}
                {latest?.status === "failed" ? (
                  <p className="agent-result-warning">El análisis falló{latest.error_code ? ` (${latest.error_code})` : ""}. Puedes solicitarlo nuevamente.</p>
                ) : null}
              </div>
              <button className="primary-button" type="button" disabled={!canManage || busy === agent.type} onClick={() => void requestAgent(agent.type)}>
                {busy === agent.type ? "Solicitando..." : "Solicitar análisis"}
              </button>
              <Link className="ghost-button agent-dashboard-link" to={`/agentes/${agent.type}/dashboard`}>
                Ver dashboard
              </Link>
            </article>
          );
        })}
      </div>

      <div className="agent-columns">
        <section className="data-card">
          <div className="section-title">
            <div><h2>Propuestas pendientes</h2><p>Revisión humana obligatoria.</p></div>
            <span className="count-pill">{proposals.filter((item) => item.status === "pending").length}</span>
          </div>
          <div className="agent-list">
            {proposals.filter((item) => item.status === "pending").map((proposal) => (
              <article key={proposal.id}>
                <div>
                  <strong>{proposal.title}</strong>
                  <p>{proposal.summary}</p>
                  <small>Riesgo: {proposal.risk_level}</small>
                  <small className="proposal-destination">
                    Al aprobar: <strong>{proposalDestination(proposal.kind).label}</strong>. {proposalDestination(proposal.kind).detail}.
                  </small>
                </div>
                {canManage ? <div className="proposal-actions">
                  <button className="ghost-button" type="button" disabled={busy === proposal.id} onClick={() => void decideProposal(proposal.id, "rejected")}><XCircle size={16} /> Rechazar</button>
                  <button className="primary-button" type="button" disabled={busy === proposal.id} onClick={() => void decideProposal(proposal.id, "approved")}><CheckCircle2 size={16} /> Aprobar</button>
                </div> : null}
              </article>
            ))}
            {!proposals.some((item) => item.status === "pending") ? <p>No hay propuestas pendientes.</p> : null}
          </div>
        </section>

        <section className="data-card">
          <div className="section-title"><div><h2>Riesgo de inventario</h2><p>Quiebres y compras sugeridas.</p></div><AlertTriangle size={22} /></div>
          <div className="agent-list">
            {alerts.map((alert) => <article key={alert.id}><div><strong>{alert.sku} · {alert.title}</strong><p>{alert.detail}</p><small>Severidad: {alert.severity}</small></div></article>)}
            {!alerts.length ? <p>No hay alertas abiertas.</p> : null}
          </div>
        </section>
      </div>

      <section className="data-card approved-actions-card">
        <div className="section-title">
          <div>
            <h2>Acciones aprobadas</h2>
            <p>Cada aprobación muestra qué creó y dónde debes continuar.</p>
          </div>
          <span className="count-pill">{actionItems.length}</span>
        </div>
        <div className="approved-actions-list">
          {actionItems.map((item) => (
            <article key={item.id}>
              <div>
                <span className={`status-chip ${item.status === "draft" ? "pending" : "success"}`}>
                  {item.status === "draft" ? "Borrador" : "Pendiente de revisión"}
                </span>
                <strong>{item.title}</strong>
                <p>{item.summary || proposalDestination(item.kind).detail}</p>
                <small>{new Date(item.created_at).toLocaleString("es-CL")}</small>
              </div>
              <Link className="ghost-button approved-action-link" to={approvedActionPath(item)}>
                Abrir {proposalDestination(item.kind).label}
              </Link>
            </article>
          ))}
          {!actionItems.length ? <p>Aún no hay propuestas aprobadas con destino materializado.</p> : null}
        </div>
      </section>

      <section className="data-card">
        <div className="section-title"><div><h2>Conexiones del centro</h2><p>Los secretos permanecen en Dokploy.</p></div></div>
        <div className="connection-grid">
          {connections.map((connection) => (
            <article key={connection.provider}>
              <strong>{connection.provider}</strong>
              <span className={`status-chip ${connection.status === "connected" ? "success" : "pending"}`}>{connection.status}</span>
              <small>{connection.read_only ? "Solo lectura" : "Operacional controlada"} · {connection.message || "Sin detalle"}</small>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
