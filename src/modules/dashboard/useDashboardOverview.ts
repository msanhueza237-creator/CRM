import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, isSupabaseConfigured } from "../../lib/supabase";
import { getAccountingOverview } from "../../lib/accountingApi";
import type { ForeignTradeDashboardSummary } from "../../types/foreignTrade";
import type { AppRole } from "../auth/AuthContext";

export type Overview = {
  finance: Awaited<ReturnType<typeof getAccountingOverview>> | null;
  trade: ForeignTradeDashboardSummary | null;
  counts: Record<string, number | null>;
  connections: Array<{ provider: string; status: string; last_success_at: string | null }>;
  publications: Array<{ id: string; scheduled_at: string }>;
  warnings: string[];
  readAt: string | null;
};
const empty = (): Overview => ({ finance: null, trade: null, counts: {}, connections: [], publications: [], warnings: [], readAt: null });
export const stages = ["prospecto", "contactado", "interesado", "cotizado", "cliente"];

export function useDashboardOverview(role: AppRole | undefined, userId: string | undefined) {
  const [data, setData] = useState<Overview>(empty);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const running = useRef(false);
  const lastRead = useRef(0);
  const refresh = useCallback(async () => {
    if (running.current || !role || !userId) return;
    if (!isSupabaseConfigured || !supabase) {
      setData({ ...empty(), warnings: ["Sin conexión: no se muestran cifras de demostración."] });
      setLoading(false); return;
    }
    const db = supabase, current = ++generation.current;
    running.current = true; setLoading(true);
    const next = empty();
    async function count(key: string, query: PromiseLike<{ count: number | null; error: unknown }>, label: string) {
      try { const result = await query; if (result.error || result.count === null) throw new Error(); next.counts[key] = result.count; }
      catch { next.counts[key] = null; next.warnings.push(`No disponible: ${label}.`); }
    }
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    const jobs: Promise<unknown>[] = [
      count("companies", db.from("companies").select("id", { count: "exact", head: true }), "empresas"),
      ...stages.map(stage => count(stage, db.from("companies").select("id", { count: "exact", head: true }).eq("status", stage), `etapa ${stage}`)),
      count("scheduled", db.from("content_publications").select("id", { count: "exact", head: true }).eq("status", "scheduled"), "publicaciones programadas"),
      count("approval", db.from("content_publications").select("id", { count: "exact", head: true }).eq("status", "pending_approval"), "contenido por aprobar"),
      count("published", db.from("content_publications").select("id", { count: "exact", head: true }).eq("status", "published").gte("published_at", from), "contenido publicado"),
      count("contentErrors", db.from("content_publications").select("id", { count: "exact", head: true }).eq("status", "failed"), "errores de publicación"),
      (async () => { try { const r = await db.from("content_publications").select("id,scheduled_at").eq("status", "scheduled").not("scheduled_at", "is", null).order("scheduled_at").limit(3); if (r.error) throw r.error; next.publications = r.data || []; } catch { next.warnings.push("Agenda editorial no disponible."); } })(),
    ];
    if (role === "administrador" || role === "finanzas") jobs.push((async () => {
      try { next.finance = await getAccountingOverview(); } catch { next.warnings.push("Finanzas no disponible; no se sustituyen sus saldos por cero."); }
    })());
    if (role === "administrador") jobs.push(
      count("inventory", db.from("inventory_risk_alerts").select("id", { count: "exact", head: true }).eq("status", "open"), "alertas de inventario"),
      count("proposals", db.from("action_proposals").select("id", { count: "exact", head: true }).eq("status", "pending"), "propuestas de agentes"),
      (async () => { try { const r = await db.rpc("foreign_trade_dashboard_summary"); if (r.error || !r.data || typeof r.data !== "object" || Array.isArray(r.data)) throw new Error(); next.trade = r.data as ForeignTradeDashboardSummary; } catch { next.warnings.push("Comercio exterior no disponible."); } })(),
      (async () => { try { const r = await db.from("integration_connections").select("provider,status,last_success_at").in("provider", ["facto", "tiendanube", "gmail", "meta_social", "meta_whatsapp"]); if (r.error) throw r.error; next.connections = r.data || []; } catch { next.warnings.push("Estado de conexiones no disponible."); } })(),
    );
    await Promise.all(jobs);
    if (current === generation.current) { next.readAt = new Date().toISOString(); lastRead.current = Date.now(); setData(next); setLoading(false); running.current = false; }
  }, [role, userId]);
  useEffect(() => {
    running.current = false; setData(empty()); void refresh();
    const onVisible = () => { if (!document.hidden && Date.now() - lastRead.current > 120000) void refresh(); };
    const timer = window.setInterval(onVisible, 300000);
    window.addEventListener("focus", onVisible);
    return () => { generation.current++; running.current = false; clearInterval(timer); window.removeEventListener("focus", onVisible); };
  }, [refresh]);
  return { data, loading, refresh };
}
