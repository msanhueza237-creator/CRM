import { useEffect, useState } from "react";
import { RefreshCw, TriangleAlert, Save, Play, Check, X } from "lucide-react";
import { getAgentUsage, setModelCostMode, type AgentUsage } from "../../lib/copilotCentralApi";
import "./agent-diagnostics.css";

export function AgentDiagnostics() {
  const [data, setData] = useState<AgentUsage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState("luna_only");
  const [hours, setHours] = useState(1);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{ mode: string; hours: number }>();
  const modeLabels: Record<string, string> = { luna_only: "Luna only", auto: "Luna + Sol automatico", sol_manual: "Sol manual unicamente" };
  useEffect(() => { if (data?.modelPolicy) setMode(data.modelPolicy.mode); }, [data]);
  async function changeMode() {
    if (!pending) return;
    setSaving(true); setError("");
    try { setData(await setModelCostMode(pending.mode, pending.hours)); setPending(undefined); } catch (e) { setError(e instanceof Error ? e.message : "No se pudo guardar."); } finally { setSaving(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    getAgentUsage(controller.signal).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  return <section className="agent-diagnostics" aria-labelledby="agent-diagnostics-title">
    <header><div><h2 id="agent-diagnostics-title">Actividad del Gerente y especialistas</h2><span className="muted">Ultimos 30 dias · Consultas de texto y voz</span></div><button type="button" className="ghost-button" disabled={loading} onClick={() => setRevision(n => n + 1)} title="Actualizar actividad" aria-label="Actualizar actividad"><RefreshCw size={18} className={loading ? "spin" : ""} /></button></header>
    {error && <p role="alert"><TriangleAlert size={16} /> {error}</p>}
    {loading && !data && <p role="status">Consultando actividad...</p>}
    {data && <><p>{data.enabled ? "Gerente activo" : "Orquestacion anterior activa"} · {data.sampledRuns} ejecuciones{data.partial ? " · Muestra parcial de las 1.000 mas recientes" : ""}</p>
      {data.modelPolicy && <section className="model-cost-policy" aria-label="Consumo OpenAI">
        <h3>Modelos y presupuesto</h3>
        <dl className="model-cost-summary">
          <div><dt>Predeterminado</dt><dd>{data.modelPolicy.defaultModel}</dd></div>
          <div><dt>Escalamiento</dt><dd>{data.modelPolicy.escalationModel}</dd></div>
          <div><dt>Automatico</dt><dd>{data.modelPolicy.mode === "auto" ? "Activado" : "Desactivado"}</dd></div>
          <div><dt>Modo ahorro</dt><dd>{data.modelPolicy.economy ? "Activo" : "Inactivo"}</dd></div>
          <div><dt>Presupuesto diario</dt><dd>{data.modelPolicy.budget == null ? "Sin configurar · llamadas bloqueadas" : `USD ${data.modelPolicy.budget.toFixed(2)}`}</dd></div>
          <div><dt>Control de gasto</dt><dd>{data.modelPolicy.guardEnabled ? "Activo" : "Desactivado"}</dd></div>
          {["luna", "sol"].map(tier => { const rows = data.costs?.models?.filter(m => m.tier === tier); return <div key={tier}><dt>{tier === "luna" ? "Luna hoy" : "Sol hoy"}</dt><dd>{rows ? `${rows.reduce((n, m) => n + m.calls, 0)} llamadas · USD ${rows.reduce((n, m) => n + m.cost, 0).toFixed(4)}` : "No disponible"}</dd></div>; })}
          <div><dt>Total hoy</dt><dd>{data.costs?.totals ? `USD ${data.costs.totals.cost.toFixed(4)}` : "No disponible"}</dd></div>
        </dl>
        {data.costs?.error && <p role="alert">{data.costs.error}</p>}
        {data.costs?.warning && <p role="status">{data.costs.warning}</p>}
        {Boolean(data.costs?.totals?.uncertain) && <p role="status">{data.costs?.totals?.uncertain} llamadas en curso o sin consumo confirmado. Su reserva sigue descontada del presupuesto.</p>}
        {data.costs?.policy?.quota_blocked && <p role="alert">API suspendida por saldo/cuota. <button className="ghost-button" disabled={saving} onClick={() => setPending({ mode: "resume_after_quota", hours })}><Play size={16} /> Rehabilitar API</button></p>}
        <div className="model-cost-controls"><label>Modo temporal<select value={mode} onChange={e => setMode(e.target.value)}><option value="luna_only">Luna only</option><option value="auto">Luna + Sol automatico</option><option value="sol_manual">Sol manual unicamente</option></select></label><label>Horas<input type="number" min={1} max={24} value={hours} onChange={e => setHours(Number(e.target.value))} /></label><button className="ghost-button" title="Guardar politica temporal" aria-label="Guardar politica temporal" disabled={saving || Boolean(data.costs?.error) || hours < 1 || hours > 24 || !Number.isInteger(hours)} onClick={() => setPending({ mode, hours })}><Save size={18} /></button></div>
        {pending && <div className="model-cost-confirm" role="alertdialog" aria-label="Confirmar politica de modelos"><p>{pending.mode === "resume_after_quota" ? "Confirma que revisaste y resolviste el saldo/cuota de OpenAI. Se habilitaran nuevas llamadas dentro del presupuesto autorizado." : `Aplicar ${modeLabels[pending.mode]} durante ${pending.hours} hora(s)? El presupuesto diario sigue vigente.`}</p><div><button className="ghost-button" disabled={saving} onClick={() => setPending(undefined)}><X size={18} /> Cancelar</button><button className="primary-button" disabled={saving} onClick={() => void changeMode()}><Check size={18} /> Confirmar</button></div></div>}
        {data.costs?.policy?.expires_at && <p className="muted">Modo temporal hasta {new Date(data.costs.policy.expires_at).toLocaleString("es-CL")}</p>}
        <p className="muted">USD estimados de Responses, con reservas pendientes y sin descuentos de cache. La voz Live conserva su medicion independiente. Dia de negocio: Chile.</p>
        <details><summary>Consumo de hoy por agente y conversacion</summary><div className="agent-diagnostics-scroll"><table><thead><tr><th>Agente</th><th>Llamadas</th><th>USD</th></tr></thead><tbody>{data.costs?.agents?.map(a => <tr key={a.agent}><th>{a.agent}</th><td>{a.calls}</td><td>{a.cost.toFixed(4)}</td></tr>)}</tbody></table><table><thead><tr><th>Conversacion</th><th>Llamadas</th><th>USD</th></tr></thead><tbody>{data.costs?.conversations?.map(c => <tr key={c.conversation_id || "backend"}><th>{c.conversation_id || "Procesos del backend"}</th><td>{c.calls}</td><td>{c.cost.toFixed(4)}</td></tr>)}</tbody></table></div></details>
        {Boolean(data.costs?.errors?.length) && <details><summary>Errores recientes</summary><ul>{data.costs?.errors?.map((e, i) => <li key={i}>{new Date(e.created_at).toLocaleString("es-CL")} · {e.agent} · {e.error_code}</li>)}</ul></details>}
      </section>}
      <div className="agent-diagnostics-scroll"><table><thead><tr><th>Agente</th><th>Consultas</th><th>Fallos</th><th>Parciales</th><th>Promedio</th><th>Tokens</th><th>USD estimado</th></tr></thead><tbody>{data.agents.map(agent => <tr key={agent.agent}><th scope="row">{agent.label}</th><td>{agent.runs}</td><td>{agent.failed}</td><td>{agent.partial}</td><td>{agent.runs ? `${(agent.durationMs / agent.runs / 1000).toFixed(1)} s` : "Sin actividad"}</td><td>{(agent.tokensInput + agent.tokensOutput).toLocaleString("es-CL")}</td><td>{agent.estimatedUsd.toFixed(3)}</td></tr>)}</tbody></table></div>
      <p className="muted">{data.estimateNote}</p></>}
  </section>;
}
