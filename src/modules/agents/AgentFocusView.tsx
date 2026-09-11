import { Link } from "react-router-dom";
import { ArrowLeft, Check, RefreshCw, X } from "lucide-react";
import type { AgentCenterData } from "./AgentsDashboard";
export function AgentFocusView({ data, focus, provider, loading, notice, busy, canManage, refresh, more, decide }: {
  data: AgentCenterData; focus: string; provider: string | null; loading: boolean; notice: string; busy: string; canManage: boolean;
  refresh: () => void; more: () => void; decide: (id: string, decision: "approved" | "rejected") => void;
}) {
  const title = focus === "proposals" ? "Propuestas pendientes" : focus === "inventory" ? "Alertas de inventario abiertas" : `Conexión · ${provider || "Todas"}`;
  const total = focus === "proposals" ? data.totals.proposals : data.totals.alerts;
  const shown = focus === "proposals" ? data.proposals.length : data.alerts.length;
  return <section className="agents-center"><Link to="/dashboard"><ArrowLeft size={17} /> Dashboard</Link><header className="ac-heading"><h1>{title}</h1><button className="ac-icon" onClick={refresh} disabled={loading} aria-label="Actualizar detalle" title="Actualizar detalle"><RefreshCw size={18} /></button></header>
    {notice && <p role="alert">{notice}</p>}
    {focus !== "connection" && <p>{shown} de {total ?? "No disponible"}</p>}
    {focus === "proposals" && data.proposals.map(row => <details className="ac-proposal" key={row.id}><summary>{row.title}</summary><p>{row.summary}</p><div className="ac-proposal-actions"><button disabled={!canManage || Boolean(busy)} onClick={() => decide(row.id, "rejected")}><X size={16} /> Rechazar</button><button disabled={!canManage || Boolean(busy)} onClick={() => decide(row.id, "approved")}><Check size={16} /> Aprobar</button></div></details>)}
    {focus === "inventory" && data.alerts.map(row => <article className="ac-proposal" key={row.id}><h2>{row.sku} · {row.title}</h2><p>{row.detail}</p><small>{row.severity}</small></article>)}
    {focus === "connection" && data.connections.filter(row => !provider || row.provider === provider).map(row => <article key={row.provider}><h2>{row.provider}</h2><p>{row.status} · {row.message}</p><p>Última conexión: {row.last_success_at ? new Date(row.last_success_at).toLocaleString("es-CL") : "Sin fecha"}</p></article>)}
    {!loading && !notice && (focus === "connection" ? !data.connections.some(row => !provider || row.provider === provider) : !shown) && <p>Sin registros para este filtro.</p>}
    {focus !== "connection" && shown < (total || 0) && <button className="ac-more" disabled={loading} onClick={more}>Cargar más registros</button>}
  </section>;
}
