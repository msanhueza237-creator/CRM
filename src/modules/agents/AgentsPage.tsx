import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import { AgentsDashboard, type AgentCenterData } from "./AgentsDashboard";
import { agentDefinitions, type AgentTask, type AgentType } from "./agent-center";

const emptyData: AgentCenterData = { tasks: [], activity: [], proposals: [], actions: [], alerts: [], connections: [], delivery: null, totals: { proposals: null, actions: null, alerts: null }, schedule: null };

export function AgentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [data, setData] = useState<AgentCenterData>(emptyData);
  const [busy, setBusy] = useState(""), [notice, setNotice] = useState(""), [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(20);
  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !user) { setLoading(false); return; }
    setLoading(true);
    try {
      const client = supabase;
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 8);
      const activity: AgentTask[] = [];
      // The chart must not quietly count only the first API page.
      for (let offset = 0; ; ) {
        const page = await client.from("business_agent_tasks").select("id,agent_type,action,status,created_at", { count: "exact" }).gte("created_at", cutoff.toISOString()).order("created_at", { ascending: false }).order("id").range(offset, offset + 499);
        if (page.error || page.count === null) throw new Error("No se pudo verificar la actividad de los agentes.");
        const found = (page.data || []) as AgentTask[];
        activity.push(...found); offset += found.length;
        if (offset >= page.count) break;
        if (!found.length || offset >= 10000) throw new Error("La actividad requiere una lectura mas amplia. No se mostraran totales parciales.");
      }
      const [latest, proposals, actions, alerts, connections, settings, delivery] = await Promise.all([
        Promise.all(agentDefinitions.map(async (a) => {
          const result = await client.from("business_agent_tasks").select("id,agent_type,action,status,created_at,error_code,summary:result->>summary,metrics:result->metrics,warnings:result->warnings").eq("agent_type", a.type).order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (result.error) throw result.error;
          const row = result.data;
          return row ? { ...row, result: { summary: row.summary, metrics: row.metrics, warnings: row.warnings } } as unknown as AgentTask : null;
        })),
        client.from("action_proposals").select("id,kind,title,summary,risk_level,status,created_at", { count: "exact" }).eq("status", "pending").order("created_at", { ascending: false }).limit(limit),
        client.from("agent_action_items").select("id,kind,destination_module,destination_path,destination_record_id,title,summary,status,created_at", { count: "exact" }).order("created_at", { ascending: false }).limit(limit),
        client.from("inventory_risk_alerts").select("id,sku,severity,title,detail", { count: "exact" }).eq("status", "open").order("created_at", { ascending: false }).limit(limit),
        client.from("integration_connections").select("provider,status,message,last_success_at").order("provider"),
        client.from("executive_agent_settings").select("morning_time,timezone,email_enabled").eq("id", "default").maybeSingle(),
        client.from("executive_notifications").select("status,sent_at,created_at,error").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if ([proposals, actions, alerts, connections, settings, delivery].some((r) => r.error)) throw new Error("No se pudieron actualizar todas las fuentes. Se conserva la ultima lectura.");
      setData({ tasks: latest.filter((t): t is AgentTask => Boolean(t)), activity, proposals: proposals.data || [], actions: actions.data || [], alerts: alerts.data || [], connections: connections.data || [], schedule: settings.data, delivery: delivery.data,
        totals: { proposals: proposals.count, actions: actions.count, alerts: alerts.count } });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo actualizar el centro de agentes.");
    } finally { setLoading(false); }
  }, [user, limit]);
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60000); return () => window.clearInterval(timer); }, [load]);

  async function requestAgent(type: AgentType) {
    if (!supabase || !user || user.role !== "administrador" || busy) return;
    setBusy(type); setNotice("");
    try {
      const result = await supabase.from("business_agent_tasks").insert({ agent_type: type, action: agentDefinitions.find((a) => a.type === type)!.action, requested_by: user.id,
        payload: { source_module: "crm_modules", contract_version: 1, mode: "manual", delivery: { auto_send: false } } }).select("id").single();
      if (result.error) throw result.error;
      navigate(`/agentes/${type}/dashboard?task=${result.data.id}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "No se pudo solicitar el analisis."); }
    finally { setBusy(""); }
  }
  async function decide(id: string, decision: "approved" | "rejected") {
    if (!supabase || user?.role !== "administrador" || busy) return;
    setBusy(id); setNotice("");
    try {
      const result = await supabase.rpc("decide_action_proposal", { p_proposal_id: id, p_decision: decision, p_note: "Decision desde el centro de agentes" });
      if (result.error) throw result.error;
      setNotice(result.data?.message || (decision === "approved" ? "Propuesta aprobada." : "Propuesta rechazada."));
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "No se pudo registrar la decision."); }
    finally { setBusy(""); }
  }
  return <AgentsDashboard data={data} loading={loading} notice={notice} busy={busy} canManage={user?.role === "administrador"} refresh={() => { setNotice(""); void load(); }} request={(type) => void requestAgent(type)} decide={(id, decision) => void decide(id, decision)} more={() => setLimit((n) => n + 20)} />;
}
