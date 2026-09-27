import { Cpu, Loader2, RefreshCw } from "lucide-react";
import type { CopilotModelChoice } from "../../lib/copilotCentralApi";

export function CopilotModelSelector({ models, value, loading, disabled, error, onChange, onRefresh }: {
  models: CopilotModelChoice[]; value: string; loading: boolean; disabled: boolean; error: string;
  onChange: (id: string) => void; onRefresh: () => void;
}) {
  return <div className="cc-model-bar">
    <label className="cc-model-select">
      <Cpu size={18} aria-hidden="true" />
      <span>Modelo</span>
      <select aria-label="Modelo del Copiloto" title={models.find(m => m.id === value)?.label} value={value} disabled={disabled || loading} onChange={e => onChange(e.target.value)}>
        {!models.some(m => m.id === value) && <option value={value}>{loading ? "Cargando modelos..." : "Selecciona un modelo disponible"}</option>}
        {models.map(model => <option value={model.id} key={model.id}>{model.label}</option>)}
      </select>
    </label>
    <button className="cc-icon" type="button" title="Actualizar modelos disponibles" aria-label="Actualizar modelos disponibles" disabled={disabled || loading} onClick={onRefresh}>
      {loading ? <Loader2 size={17} className="spin" /> : <RefreshCw size={17} />}
    </button>
    {error && <span className="cc-model-error" role="alert">{error}</span>}
  </div>;
}
