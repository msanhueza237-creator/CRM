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
  UserRoundSearch,
  WalletCards,
  XCircle,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";

type AgentType =
  | "commercial"
  | "marketing"
  | "finance"
  | "collections"
  | "foreign_trade"
  | "executive";

interface AgentTask {
  id: string;
  agent_type: AgentType;
  action: string;
  status: string;
  created_at: string;
  result?: { summary?: string } | null;
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

const agents: Array<{
  type: AgentType;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  { type: "commercial", title: "Agente comercial", description: "Prospectos y seguimientos.", icon: UserRoundSearch },
  { type: "marketing", title: "Agente marketing", description: "Borradores de campañas.", icon: Megaphone },
  { type: "finance", title: "Agente finanzas", description: "Márgenes y anomalías.", icon: CircleDollarSign },
  { type: "collections", title: "Agente cobranza", description: "Cartera vencida y recordatorios.", icon: WalletCards },
  { type: "foreign_trade", title: "Comercio exterior", description: "Stock, compras e importaciones.", icon: PackageSearch },
  { type: "executive", title: "Agente gerente", description: "Resumen y alertas prioritarias.", icon: Sparkles },
];

const defaultAction: Record<AgentType, string> = {
  commercial: "review_pipeline",
  marketing: "draft_campaign",
  finance: "review_margin",
  collections: "review_aging",
  foreign_trade: "review_inventory_risk",
  executive: "prepare_brief",
};

export function AgentsPage() {
  const { user } = useAuth();
  const canManage = user?.role === "administrador";
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !user) return;
    const [taskResult, proposalResult, alertResult, connectionResult] = await Promise.all([
      supabase.from("business_agent_tasks").select("id,agent_type,action,status,created_at,result,error_code").order("created_at", { ascending: false }).limit(30),
      supabase.from("action_proposals").select("id,kind,title,summary,risk_level,status,created_at").order("created_at", { ascending: false }).limit(30),
      supabase.from("inventory_risk_alerts").select("id,sku,severity,title,detail,status").eq("status", "open").order("created_at", { ascending: false }).limit(30),
      supabase.from("integration_connections").select("provider,status,read_only,message,last_success_at").order("provider"),
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
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  async function requestAgent(type: AgentType) {
    if (!supabase || !user) return;
    setBusy(type);
    setNotice("");
    const payload =
      type === "foreign_trade"
        ? { sku: "REVISION_GENERAL", as_of: new Date().toISOString().slice(0, 10) }
        : {};
    const { error } = await supabase.from("business_agent_tasks").insert({
      agent_type: type,
      action: defaultAction[type],
      payload,
      requested_by: user.id,
    });
    setBusy("");
    setNotice(error ? error.message : "Tarea agregada. El Agent Hub la procesará con lease seguro.");
    await load();
  }

  async function decideProposal(id: string, decision: "approved" | "rejected") {
    if (!supabase) return;
    setBusy(id);
    const { error } = await supabase.rpc("decide_action_proposal", {
      p_proposal_id: id,
      p_decision: decision,
      p_note: decision === "approved" ? "Aprobado desde el centro de agentes" : "Rechazado desde el centro de agentes",
    });
    setBusy("");
    setNotice(error ? error.message : decision === "approved" ? "Propuesta aprobada." : "Propuesta rechazada.");
    await load();
  }

  return (
    <section className="agents-page">
      <div className="page-heading agent-heading">
        <div>
          <span className="eyebrow">CENTRO OPERACIONAL</span>
          <h1>Agentes Clima Activa</h1>
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
              </div>
              <button className="primary-button" type="button" disabled={!canManage || busy === agent.type} onClick={() => void requestAgent(agent.type)}>
                {busy === agent.type ? "Solicitando..." : "Solicitar análisis"}
              </button>
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
                <div><strong>{proposal.title}</strong><p>{proposal.summary}</p><small>Riesgo: {proposal.risk_level}</small></div>
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
