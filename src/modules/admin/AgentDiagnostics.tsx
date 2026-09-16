import { useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { getAgentUsage, type AgentUsage } from "../../lib/copilotCentralApi";
import "./agent-diagnostics.css";

export function AgentDiagnostics() {
  const [data, setData] = useState<AgentUsage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    getAgentUsage(controller.signal).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  return <section className="agent-diagnostics" aria-labelledby="agent-diagnostics-title">
    <header><div><h2 id="agent-diagnostics-title">Actividad del Gerente y especialistas</h2><span className="muted">Ultimos 30 dias · Consultas de texto y voz</span></div><button type="button" className="button secondary" disabled={loading} onClick={() => setRevision(n => n + 1)} title="Actualizar actividad" aria-label="Actualizar actividad"><RefreshCw size={18} className={loading ? "spin" : ""} /></button></header>
    {error && <p role="alert"><TriangleAlert size={16} /> {error}</p>}
    {loading && !data && <p role="status">Consultando actividad...</p>}
    {data && <><p>{data.enabled ? "Gerente activo" : "Orquestacion anterior activa"} · {data.sampledRuns} ejecuciones{data.partial ? " · Muestra parcial de las 1.000 mas recientes" : ""}</p>
      <div className="agent-diagnostics-scroll"><table><thead><tr><th>Agente</th><th>Consultas</th><th>Fallos</th><th>Parciales</th><th>Promedio</th><th>Tokens</th><th>USD estimado</th></tr></thead><tbody>{data.agents.map(agent => <tr key={agent.agent}><th scope="row">{agent.label}</th><td>{agent.runs}</td><td>{agent.failed}</td><td>{agent.partial}</td><td>{agent.runs ? `${(agent.durationMs / agent.runs / 1000).toFixed(1)} s` : "Sin actividad"}</td><td>{(agent.tokensInput + agent.tokensOutput).toLocaleString("es-CL")}</td><td>{agent.estimatedUsd.toFixed(3)}</td></tr>)}</tbody></table></div>
      <p className="muted">{data.estimateNote}</p></>}
  </section>;
}
