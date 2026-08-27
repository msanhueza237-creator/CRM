import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Gauge,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import {
  getForeignTradeIntelligence,
  runForeignTradeIntelligence,
  saveForeignTradeIntelligenceScenario,
} from "../../lib/foreignTradeApi";
import { queueForeignTradeAnalysis } from "../agents/foreignTradeAnalysis";
import type {
  ForeignTradeIntelligenceData,
  ForeignTradeIntelligenceRecommendation,
  ForeignTradeOperation,
} from "../../types/foreignTrade";

type IntelligenceForm = {
  asOf: string;
  productionDays: number;
  seaTravelDays: number;
  customsDelayDays: number;
  additionalDelayDays: number;
  safetyStockDays: number;
  targetCoverageDays: number;
  demandChangePercent: number;
};

const defaultForm: IntelligenceForm = {
  asOf: new Date().toISOString().slice(0, 10),
  productionDays: 45,
  seaTravelDays: 45,
  customsDelayDays: 5,
  additionalDelayDays: 0,
  safetyStockDays: 30,
  targetCoverageDays: 155,
  demandChangePercent: 0,
};

export function ForeignTradeIntelligencePanel({
  operationId = null,
  operations = [],
  onSelectOperation,
}: {
  operationId?: string | null;
  operations?: ForeignTradeOperation[];
  onSelectOperation?: (operationId: string | null) => void;
}) {
  const [form, setForm] = useState<IntelligenceForm>(defaultForm);
  const [data, setData] = useState<ForeignTradeIntelligenceData>({ snapshot: null, recommendations: [], scenarios: [] });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scenarioName, setScenarioName] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getForeignTradeIntelligence(operationId);
      setData(result);
      if (result.snapshot) setForm(formFromParameters(result.snapshot.assumptions));
    } catch (loadError) {
      setError(humanizeIntelligenceError(loadError));
    } finally {
      setLoading(false);
    }
  }, [operationId]);

  useEffect(() => {
    void load();
    // operationId selects an independent, historically frozen intelligence scope.
  }, [load]);

  const sortedRecommendations = useMemo(() => [...data.recommendations].sort((left, right) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    return order[right.severity] - order[left.severity] || right.recommended_units - left.recommended_units;
  }), [data.recommendations]);

  async function runAnalysis() {
    setRunning(true);
    setError("");
    setNotice("");
    try {
      await runForeignTradeIntelligence({ operationId, ...form });
      await load();
      setNotice("Análisis recalculado y guardado como una foto histórica. No se ejecutó ninguna compra ni cambio de inventario.");
    } catch (runError) {
      setError(humanizeIntelligenceError(runError));
    } finally {
      setRunning(false);
    }
  }

  async function saveScenario() {
    setError("");
    setNotice("");
    try {
      await saveForeignTradeIntelligenceScenario({ operationId, name: scenarioName, parameters: form });
      setScenarioName("");
      await load();
      setNotice("Escenario guardado. Puedes recuperarlo sin alterar la operación oficial.");
    } catch (saveError) {
      setError(humanizeIntelligenceError(saveError));
    }
  }

  async function askAgent(event: FormEvent) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt) return;
    setAsking(true);
    setError("");
    setNotice("");
    try {
      const result = await queueForeignTradeAnalysis({
        operationId: operationId || undefined,
        snapshotId: data.snapshot?.id,
        question: prompt,
      });
      setQuestion("");
      setNotice(`Consulta enviada exclusivamente al Agente de Comercio Exterior. Tarea ${result.taskId.slice(0, 8)} creada para análisis; requiere revisión humana antes de actuar.`);
    } catch (askError) {
      setError(humanizeIntelligenceError(askError));
    } finally {
      setAsking(false);
    }
  }

  const summary = data.snapshot?.summary;
  const assumptions = data.snapshot?.assumptions;

  return (
    <div className="foreign-trade-intelligence-stack">
      <section className="foreign-trade-intelligence-hero">
        <div>
          <span><BrainCircuit size={17} /> Inteligencia de Comercio Exterior</span>
          <h2>Proyección explicable de inventario y compras</h2>
          <p>Combina Facto en modo solo lectura con las operaciones oficiales. Cada resultado queda congelado y nunca ejecuta compras, modifica stock ni aprueba documentos.</p>
        </div>
        <span className="foreign-trade-private-badge"><ShieldCheck size={15} /> Solo gerencia y Agente de Comercio Exterior</span>
      </section>

      {onSelectOperation ? (
        <label className="foreign-trade-intelligence-scope">
          <span>Alcance del análisis</span>
          <select value={operationId || ""} onChange={(event) => onSelectOperation(event.target.value || null)}>
            <option value="">Portafolio completo</option>
            {operations.map((operation) => <option value={operation.id} key={operation.id}>{operation.reference} · {operation.title}</option>)}
          </select>
        </label>
      ) : null}

      <section className="panel foreign-trade-intelligence-controls">
        <div className="foreign-trade-detail-panel-heading">
          <div><h2>Supuestos ajustables</h2><p>Los valores se guardan con cada análisis y no sobrescriben resultados anteriores.</p></div>
          <button className="primary-button" type="button" disabled={running} onClick={() => void runAnalysis()}>{running ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />} {running ? "Calculando..." : "Calcular proyección"}</button>
        </div>
        <div className="foreign-trade-intelligence-form">
          <NumberField label="Producción" suffix="días" value={form.productionDays} onChange={(value) => setForm({ ...form, productionDays: value })} />
          <NumberField label="Viaje" suffix="días" value={form.seaTravelDays} onChange={(value) => setForm({ ...form, seaTravelDays: value })} />
          <NumberField label="Aduana" suffix="días" value={form.customsDelayDays} onChange={(value) => setForm({ ...form, customsDelayDays: value })} />
          <NumberField label="Demora adicional" suffix="días" value={form.additionalDelayDays} onChange={(value) => setForm({ ...form, additionalDelayDays: value })} />
          <NumberField label="Stock de seguridad" suffix="días" value={form.safetyStockDays} onChange={(value) => setForm({ ...form, safetyStockDays: value })} />
          <NumberField label="Cobertura objetivo" suffix="días" value={form.targetCoverageDays} min={1} onChange={(value) => setForm({ ...form, targetCoverageDays: value })} />
          <NumberField label="Cambio de demanda" suffix="%" value={form.demandChangePercent} min={-100} onChange={(value) => setForm({ ...form, demandChangePercent: value })} />
          <label><span>Fecha de corte</span><input type="date" value={form.asOf} onChange={(event) => setForm({ ...form, asOf: event.target.value })} /></label>
        </div>
        <div className="foreign-trade-intelligence-scenario-bar">
          <input value={scenarioName} maxLength={120} onChange={(event) => setScenarioName(event.target.value)} placeholder="Nombre del escenario, por ejemplo Dólar alto" />
          <button className="ghost-button" type="button" disabled={scenarioName.trim().length < 3} onClick={() => void saveScenario()}><Save size={16} /> Guardar escenario</button>
          {data.scenarios.length ? <select aria-label="Escenarios guardados" defaultValue="" onChange={(event) => {
            const scenario = data.scenarios.find((item) => item.id === event.target.value);
            if (scenario) setForm(formFromParameters(scenario.parameters));
          }}><option value="">Recuperar escenario...</option>{data.scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.name}</option>)}</select> : null}
        </div>
      </section>

      {loading ? <div className="panel foreign-trade-loading"><LoaderCircle className="spin" size={25} /><strong>Cargando inteligencia histórica</strong></div> : null}
      {error ? <div className="notice-banner error"><AlertTriangle size={18} /> {error}</div> : null}
      {notice ? <div className="notice-banner success"><CheckCircle2 size={18} /> {notice}</div> : null}

      {!loading && summary ? (
        <>
          <section className="foreign-trade-intelligence-kpis">
            <IntelligenceKpi icon={<PackageCheck />} label="Productos analizados" value={formatNumber(summary.products_analyzed)} detail={`${summary.products_with_data_gaps} con datos faltantes`} />
            <IntelligenceKpi icon={<AlertTriangle />} label="Riesgo crítico" value={formatNumber(summary.critical_products)} detail={`${summary.high_risk_products} en riesgo alto`} tone={summary.critical_products ? "danger" : "normal"} />
            <IntelligenceKpi icon={<TrendingUp />} label="Compra sugerida" value={formatNumber(summary.recommended_units)} detail="Unidades para revisión" />
            <IntelligenceKpi icon={<Gauge />} label="Confianza" value={`${Math.round((data.snapshot?.confidence || 0) * 100)}%`} detail="Según frescura y cobertura" />
            <IntelligenceKpi icon={<CalendarClock />} label="Lead time" value={`${assumptions?.lead_time_days || 0} días`} detail={`Cobertura efectiva ${assumptions?.effective_target_days || 0} días`} />
          </section>

          <section className="panel foreign-trade-intelligence-results">
            <div className="panel-heading"><div><h2>Productos y recomendaciones</h2><span>Ordenados por riesgo. Son recomendaciones, no órdenes de compra.</span></div><span>{formatDateTime(data.snapshot?.created_at)}</span></div>
            {sortedRecommendations.length ? (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Producto</th><th>Riesgo</th><th>Stock Facto</th><th>En tránsito</th><th>Demanda mensual</th><th>Cobertura</th><th>Al llegar</th><th>Sugerencia</th><th>Confianza</th></tr></thead>
                  <tbody>{sortedRecommendations.map((recommendation) => <RecommendationRow recommendation={recommendation} key={recommendation.id} />)}</tbody>
                </table>
              </div>
            ) : <p className="foreign-trade-intelligence-empty">No hay productos para este alcance. Revisa SKU, inventario Facto o líneas de la operación.</p>}
          </section>

          <section className="foreign-trade-intelligence-explain">
            <div><strong>Cómo se calculó</strong><span>{assumptions?.formula || "Cobertura objetivo menos stock actual y entradas confirmadas."}</span></div>
            <div><strong>Fuentes</strong><span>{summary.source}. Corte Facto: {formatDateTime(data.snapshot?.source_observed_at)}.</span></div>
            <div><strong>Control humano</strong><span>No hay automatización de compras, costos, inventario ni documentos oficiales.</span></div>
          </section>
        </>
      ) : null}

      <form className="panel foreign-trade-agent-question" onSubmit={askAgent}>
        <div><Bot size={22} /><div><h2>Preguntar al Agente de Comercio Exterior</h2><p>La consulta usa este alcance y el último snapshot. El Agente Comercial no puede acceder a este contrato.</p></div></div>
        <textarea value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} placeholder="Ej.: ¿Qué productos corren riesgo de quiebre antes de que llegue esta importación?" />
        <button className="primary-button" type="submit" disabled={asking || !question.trim()}>{asking ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} {asking ? "Enviando..." : "Solicitar análisis"}</button>
      </form>
    </div>
  );
}

function NumberField({ label, suffix, value, min = 0, onChange }: { label: string; suffix: string; value: number; min?: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><div className="foreign-trade-number-input"><input type="number" min={min} step="1" value={value} onChange={(event) => onChange(Number(event.target.value || 0))} /><span>{suffix}</span></div></label>;
}

function IntelligenceKpi({ icon, label, value, detail, tone = "normal" }: { icon: ReactNode; label: string; value: string; detail: string; tone?: "normal" | "danger" }) {
  return <article className={`foreign-trade-intelligence-kpi ${tone}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>;
}

function RecommendationRow({ recommendation }: { recommendation: ForeignTradeIntelligenceRecommendation }) {
  return (
    <tr>
      <td data-label="Producto"><strong>{recommendation.product_name || recommendation.sku}</strong><small>{recommendation.sku}</small>{recommendation.warnings.map((warning) => <em key={warning}>{warning}</em>)}</td>
      <td data-label="Riesgo"><span className={`foreign-trade-risk ${recommendation.severity}`}>{riskLabel(recommendation.severity)}</span></td>
      <td data-label="Stock Facto">{formatNumber(recommendation.available_units)}</td>
      <td data-label="En tránsito">{formatNumber(recommendation.confirmed_inbound_units)}</td>
      <td data-label="Demanda mensual">{formatNumber(recommendation.monthly_demand)}</td>
      <td data-label="Cobertura">{recommendation.coverage_days === null ? "Sin demanda" : `${formatNumber(recommendation.coverage_days)} días`}</td>
      <td data-label="Al llegar">{formatNumber(recommendation.projected_stock_at_arrival)}</td>
      <td data-label="Sugerencia"><strong>{formatNumber(recommendation.recommended_units)} u.</strong><small>{recommendation.required_order_date ? `Pedir antes del ${formatDate(recommendation.required_order_date)}` : "Revisar demanda"}</small></td>
      <td data-label="Confianza">{Math.round(recommendation.confidence * 100)}%<small>{recommendation.confidence_level === "high" ? "Alta" : recommendation.confidence_level === "medium" ? "Media" : "Baja"}</small></td>
    </tr>
  );
}

function formFromParameters(parameters: object): IntelligenceForm {
  const values = parameters as Record<string, unknown>;
  return {
    asOf: String(values.as_of || values.as_of_date || new Date().toISOString().slice(0, 10)),
    productionDays: numeric(values.production_days, 45),
    seaTravelDays: numeric(values.sea_travel_days, 45),
    customsDelayDays: numeric(values.customs_delay_days, 5),
    additionalDelayDays: numeric(values.additional_delay_days, 0),
    safetyStockDays: numeric(values.safety_stock_days, 30),
    targetCoverageDays: numeric(values.target_coverage_days, 155),
    demandChangePercent: numeric(values.demand_change_percent, 0),
  };
}

function numeric(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function riskLabel(value: ForeignTradeIntelligenceRecommendation["severity"]) {
  return { low: "Bajo", medium: "Medio", high: "Alto", critical: "Crítico" }[value];
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(value || 0);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "short" }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value?: string | null) {
  if (!value) return "Sin registro";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function humanizeIntelligenceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "No se pudo completar la operación.");
  if (/foreign_trade_center_phase19|foreign_trade_intelligence|run_foreign_trade_intelligence|replenishment_recommendations|schema cache|does not exist|PGRST20/i.test(message)) {
    return "Falta aplicar la migración de Inteligencia de Comercio Exterior en Supabase.";
  }
  if (/forbidden|permission|42501/i.test(message)) return "Tu usuario no tiene permiso gerencial para consultar esta información.";
  return message;
}
