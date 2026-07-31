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
import { useCompanyStore } from "../companies/CompanyStore";

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

const agents: Array<{
  type: AgentType;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  { type: "commercial", title: "Agente comercial", description: "Cartera unificada, recurrencia y segmentos HVAC.", icon: UserRoundSearch },
  { type: "marketing", title: "Agente marketing", description: "Borradores de campañas.", icon: Megaphone },
  { type: "finance", title: "Agente finanzas", description: "Márgenes y anomalías.", icon: CircleDollarSign },
  { type: "collections", title: "Agente cobranza", description: "Cartera vencida y recordatorios.", icon: WalletCards },
  { type: "logistics", title: "Agente logistico", description: "Rotacion, margen, sobrestock y bodega.", icon: Truck },
  { type: "foreign_trade", title: "Comercio exterior", description: "Stock, compras e importaciones.", icon: PackageSearch },
  { type: "executive", title: "Agente gerente", description: "Resumen y alertas prioritarias.", icon: Sparkles },
];

const defaultAction: Record<AgentType, string> = {
  commercial: "review_pipeline",
  marketing: "draft_campaign",
  finance: "review_margin",
  collections: "review_aging",
  logistics: "review_logistics",
  foreign_trade: "review_inventory_risk",
  executive: "prepare_brief",
};

export function AgentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { companies } = useCompanyStore();
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
    let error: { message: string } | null = null;
    let dashboardTaskId = "";
    let successMessage = "Tarea agregada. El Agent Hub la procesara con lease seguro.";
    if (type === "commercial") {
      const [commercialResult, financialResult] = await Promise.all([
        supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "commercial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
        supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "financial_snapshots")
          .order("updated_at", { ascending: false })
          .limit(1),
      ]);
      if (commercialResult.error || financialResult.error) {
        error = commercialResult.error || financialResult.error;
      } else {
        const commercialSnapshot = commercialResult.data?.[0]?.payload as
          | { customers?: Array<Record<string, unknown>>; sources?: Record<string, number> }
          | undefined;
        const financialSnapshot = financialResult.data?.[0]?.payload as
          | Record<string, unknown>
          | undefined;
        if (!commercialSnapshot?.customers?.length && !companies.length) {
          setBusy("");
          setNotice("Facto y Tiendanube aun estan preparando la cartera unificada. Espera la siguiente sincronizacion.");
          await load();
          return;
        }
        const crmCompanies = companies.map((company) => ({
          id: company.id,
          name: company.name,
          legal_name: company.legalName,
          rut: company.rut,
          email: company.email,
          phone: company.phone,
          whatsapp: company.whatsapp,
          whatsapp_number: company.whatsappNumber,
          type: company.type,
          status: company.status,
          priority: company.priority,
          region: company.region,
          city: company.city,
          source: company.source,
        }));
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "commercial",
            action: "review_customer_portfolio",
            requested_by: user.id,
            payload: {
              commercial_snapshot: commercialSnapshot?.customers ?? [],
              crm_companies: crmCompanies,
              source_counts: commercialSnapshot?.sources ?? {},
              financial_snapshot: financialSnapshot ?? {},
            },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage = `Analisis comercial enviado con ${commercialSnapshot?.customers?.length ?? 0} identidades de Facto/Tiendanube y ${crmCompanies.length} empresas revisadas en el CRM.`;
      }
    } else if (type === "foreign_trade" || type === "logistics") {
      const snapshots: InventorySnapshotRecord["payload"][] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: snapshotError } = await supabase
          .from("integration_records")
          .select("payload")
          .eq("provider", "facto")
          .eq("resource", "inventory_snapshots")
          .range(from, from + 999);
        if (snapshotError) {
          error = snapshotError;
          break;
        }
        const page = ((data ?? []) as InventorySnapshotRecord[])
          .map((row) => row.payload)
          .filter((item) => item.sku);
        snapshots.push(...page);
        if ((data ?? []).length < 1000) break;
      }
      if (!error) {
        if (!snapshots.length) {
          setBusy("");
          setNotice("Facto aun no entrego productos para el analisis. Espera la siguiente sincronizacion.");
          await load();
          return;
        }
        if (type === "logistics") {
          const { data: insertedTask, error: insertError } = await supabase
            .from("business_agent_tasks")
            .insert({
              agent_type: "logistics",
              action: defaultAction.logistics,
              requested_by: user.id,
              payload: { products: snapshots },
            })
            .select("id")
            .single();
          error = insertError;
          dashboardTaskId = insertedTask?.id ?? "";
          successMessage = `Analisis logistico enviado con ${snapshots.length} SKU sincronizados desde Facto. Los hallazgos se transformaran en propuestas revisables.`;
        } else {
          const today = new Date().toISOString().slice(0, 10);
          const tasks = snapshots
            .filter((item) => item.stock_known && item.cost_known && item.demand_available)
            .slice(0, 50)
            .map((item) => ({
              agent_type: "foreign_trade" as const,
              action: defaultAction.foreign_trade,
              requested_by: user.id,
              payload: {
                sku: item.sku,
                available_units: item.available_units ?? 0,
                committed_units: 0,
                confirmed_inbound_units: 0,
                average_daily_demand: item.average_daily_demand ?? 0,
                unit_cost_usd: item.unit_cost_usd ?? 0,
                as_of: today,
                evidence: {
                  source: "facto_read_only",
                  observation_days: item.demand_observation_days ?? 0,
                  units_sold_observed: item.units_sold_observed ?? 0,
                },
              },
            }));
          if (!tasks.length) {
            const readiness = {
              catalog_count: snapshots.length,
              stock_known: snapshots.filter((item) => item.stock_known).length,
              cost_known: snapshots.filter((item) => item.cost_known).length,
              cost_available_in_source: snapshots.filter((item) => item.cost_available_in_source).length,
              cost_requires_usd_conversion: snapshots.filter((item) => item.cost_requires_usd_conversion).length,
              demand_available: snapshots.filter((item) => item.demand_available).length,
              eligible: 0,
            };
            const { error: insertError } = await supabase.from("business_agent_tasks").insert({
              agent_type: "foreign_trade",
              action: "review_inventory_readiness",
              requested_by: user.id,
              payload: readiness,
            });
            error = insertError;
            const withStock = snapshots.filter((item) => item.stock_known).length;
            const withSourceCost = snapshots.filter((item) => item.cost_available_in_source).length;
            const withDemand = snapshots.filter((item) => item.demand_available).length;
            successMessage = `Diagnostico enviado: ${snapshots.length} productos; ${withStock} con stock, ${withSourceCost} con costo de origen y ${withDemand} con ventas por SKU. El agente mostrara lo que falta sin inventar una compra.`;
          } else {
            const { error: insertError } = await supabase.from("business_agent_tasks").insert(tasks);
            error = insertError;
            successMessage = `${tasks.length} SKU con evidencia de Facto fueron enviados a revision de comercio exterior. Las compras seguiran requiriendo aprobacion humana.`;
          }
        }
      }
    } else if (type === "finance") {
      const { data: financialRows, error: financialError } = await supabase
        .from("integration_records")
        .select("payload")
        .eq("provider", "facto")
        .eq("resource", "financial_snapshots")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (financialError) {
        error = financialError;
      } else {
        const financialSnapshot = financialRows?.[0]?.payload;
        if (!financialSnapshot) {
          setBusy("");
          setNotice("Facto aun esta preparando el resumen financiero. Espera la siguiente sincronizacion y vuelve a intentarlo.");
          await load();
          return;
        }
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "finance",
            action: defaultAction.finance,
            requested_by: user.id,
            payload: { financial_snapshot: financialSnapshot },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage = `Analisis financiero enviado con ${Number(financialSnapshot.document_count ?? 0)} documentos reales de Facto.`;
      }
    } else if (type === "collections") {
      const { data: financialRows, error: financialError } = await supabase
        .from("integration_records")
        .select("payload")
        .eq("provider", "facto")
        .eq("resource", "financial_snapshots")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (financialError) {
        error = financialError;
      } else {
        const financialSnapshot = financialRows?.[0]?.payload as
          | {
              collections?: {
                mode?: string;
                authoritative?: boolean;
                overdue_amount?: number;
                documents_detail?: Array<{
                  document_id?: string;
                  document_number?: string;
                  customer?: string;
                  tax_id?: string;
                  observed_amount?: number;
                  days_overdue?: number;
                }>;
              };
            }
          | undefined;
        const collections = financialSnapshot?.collections;
        const verifiedCollections = (
          ["facto_receivables", "facto_document_pdf"].includes(collections?.mode ?? "")
          && collections?.authoritative === true
        );
        const documents = verifiedCollections
          ? (collections?.documents_detail ?? []).filter((item) => Number(item.observed_amount ?? 0) > 0)
          : [];
        const { data: insertedTask, error: insertError } = await supabase
          .from("business_agent_tasks")
          .insert({
            agent_type: "collections",
            action: defaultAction.collections,
            requested_by: user.id,
            payload: {
              source: verifiedCollections ? collections?.mode : "unavailable",
              authoritative: verifiedCollections,
              overdue_amount: verifiedCollections ? Number(collections?.overdue_amount ?? 0) : 0,
              invoice_ids: documents
                .map((item) => item.document_id)
                .filter((item): item is string => Boolean(item)),
              documents,
            },
          })
          .select("id")
          .single();
        error = insertError;
        dashboardTaskId = insertedTask?.id ?? "";
        successMessage = verifiedCollections
          ? `Cobranza verificada enviada con ${documents.length} documentos y saldo exacto informado por Facto.`
          : "Facto aun no entrega la ruta oficial Cobranza -> Documentos impagos ni saldos exactos en sus PDF. No se calculo deuda desde totales de facturas ni pagos.";
      }
    } else {
      const response = await supabase.from("business_agent_tasks").insert({
        agent_type: type,
        action: defaultAction[type],
        payload: {},
        requested_by: user.id,
      });
      error = response.error;
    }
    setBusy("");
    setNotice(error ? error.message : successMessage);
    await load();
    if (!error) {
      const taskQuery = dashboardTaskId ? `?task=${dashboardTaskId}` : "";
      navigate(`/agentes/${type}/dashboard${taskQuery}`);
    }
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
