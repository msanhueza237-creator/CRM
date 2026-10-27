import { useState } from "react";
import type { ForeignTradeScenario } from "../../types/foreignTrade";
import { scenarioComparison, scenarioNumber, scenarioSnapshot } from "./foreignTradeSavedScenarios";
import "./savedCostingScenarios.css";

export function SavedCostingScenarios({ scenarios, operationId, disabled, onOpen }: {
  scenarios: ForeignTradeScenario[]; operationId: string; disabled: boolean;
  onOpen: (scenario: ForeignTradeScenario | null) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const available = scenarios.filter((item) => item.operation_id === operationId)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const compared = available.filter((item) => selected.includes(item.id));
  return <section className="panel saved-costing-scenarios" aria-label="Escenarios guardados">
    <h2>Escenarios guardados</h2>
    <p>Copias de esta operación. Selecciona hasta dos para comparar los resultados registrados, sin recalcularlos.</p>
    <button className="ghost-button" disabled={disabled} onClick={() => onOpen(null)}>Volver al escenario base</button>
    {!available.length ? <p>Aún no hay escenarios guardados. Escribe un nombre al final del costeo para guardar una copia.</p> : null}
    <div className="saved-scenario-list">{available.map((scenario) => <article key={scenario.id}>
      <strong>{scenario.name}</strong>
      <small>{scenario.status === "baseline" ? "Base · " : ""}{dateLabel(scenario.created_at)}</small>
      <small>{scenarioSnapshot(scenario, operationId) ? "Incluye productos y gastos históricos" : "Sin captura histórica de productos y gastos"}</small>
      <button className="ghost-button" disabled={disabled} onClick={() => onOpen(scenario)}>Abrir simulación: {scenario.name}</button>
      <label><input type="checkbox" checked={selected.includes(scenario.id)} disabled={!selected.includes(scenario.id) && selected.length >= 2}
        onChange={(event) => setSelected(event.target.checked ? [...selected, scenario.id] : selected.filter((id) => id !== scenario.id))} /> Comparar {scenario.name}</label>
    </article>)}</div>
    {compared.length ? <div aria-label="Comparación de escenarios" className="saved-scenario-comparison">{compared.map((scenario) => <article key={scenario.id}>
      <h3>{scenario.name}</h3><small>Resultados al guardar · {dateLabel(scenario.calculated_at)}</small>
      <dl>{scenarioComparison(scenario).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <details><summary>Objetivos y derechos por producto</summary>{scenarioSnapshot(scenario, operationId)?.lines.map((line) => <p key={line.id}>{line.product_name} · {scenarioNumber(line.quantity, "unidades")} · Derecho {scenarioNumber(scenario.assumptions.costing?.line_duty_percent?.[line.id] ?? scenario.assumptions.costing?.general_duty_percent, "%")} · Objetivo {scenarioNumber(scenario.assumptions.costing?.line_target_percent?.[line.id] ?? scenario.assumptions.costing?.target_percent, "%")}</p>) || <p>Sin productos históricos. Abre la simulación para revisar los supuestos disponibles.</p>}</details>
      {scenario.missing_inputs?.length ? <p>Datos pendientes al guardar: {scenario.missing_inputs.join(" ")}</p> : null}
    </article>)}</div> : null}
  </section>;
}
function dateLabel(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("es-CL") : "Fecha no registrada";
}
