import { useRef, useState, type FormEvent } from "react";
import { Check, FileCheck2, LoaderCircle } from "lucide-react";
import { importVerifiedFactoCost } from "../../lib/accountingApi";
import type { AccountingPeriod, AccountingSourceDocument } from "../../types/accounting";
import { eligibleForVerifiedCost, validVerifiedCostInput } from "./verifiedFactoCostPolicy";
import { VerifiedFactoReturn } from "./VerifiedFactoReturn";

type Props = {
  entityId: string;
  source: AccountingSourceDocument;
  periods: AccountingPeriod[];
  onImported: () => Promise<unknown>;
};

export function VerifiedFactoCost({ entityId, source, periods, onImported }: Props) {
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ entryId: string; amountClp: number; existing: boolean } | null>(null);
  const submitting = useRef(false);
  const clp = (value: number) => new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(value);
  const eligible = eligibleForVerifiedCost(source, periods);
  const valid = eligible && validVerifiedCostInput(amount, evidence, confirmed);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || submitting.current || result) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await importVerifiedFactoCost({ entityId, sourceDocumentId: source.id, amountClp: Number(amount), evidence: evidence.trim() });
      if (saved.status !== "posted" || saved.amountClp !== Number(amount) || !saved.entryId) throw new Error("Respuesta incompleta. Revisar el libro antes de repetir la importacion.");
      setResult(saved);
      try { await onImported(); } catch { setError("Costo registrado. No se pudo refrescar la vista; vuelve a cargarla sin repetir el registro."); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo verificar el registro. Revisar el libro antes de repetir.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (source.document_type === "sales_credit_note") return <VerifiedFactoReturn entityId={entityId} source={source} periods={periods} onImported={onImported} />;
  return <section className="panel">
    <div className="accounting-panel-heading"><div><p>Respaldo contable Facto</p><h2>Costo verificado de mercaderias</h2><span>{source.counterpart_name} · Documento {source.folio} · {source.issued_on}</span></div><FileCheck2 size={24} /></div>
    {result ? <div role="status" className="accounting-balance-check ok"><Check size={18} /><strong>{result.existing ? "Costo existente verificado" : "Costo incorporado"}: {clp(result.amountClp)}</strong><span>Asiento {result.entryId}</span></div> : <form onSubmit={event => void submit(event)}>
      <fieldset disabled={busy || !eligible} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="accounting-form-grid">
          <label>Costo CLP<input type="number" required min="1" step="1" value={amount} onChange={event => { setAmount(event.target.value); setConfirmed(false); }} /></label>
          <label className="wide">Evidencia del Libro Diario<textarea required minLength={20} maxLength={500} rows={4} value={evidence} onChange={event => { setEvidence(event.target.value); setConfirmed(false); }} /></label>
        </div>
        <div className="accounting-balance-check"><span>Fecha contable: {source.issued_on}</span><span>Debe costo: {clp(Number(amount) || 0)}</span><span>Haber inventario: {clp(Number(amount) || 0)}</span></div>
        <label className="accounting-report-confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Verifique el costo historico y el par costo/inventario en Facto, con esta misma fecha, sin duplicados ni reversas pendientes. No es una estimacion porcentual ni un servicio.</span></label>
        <button className="primary-button" disabled={!valid || busy} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : <FileCheck2 size={17} />} {busy ? "Verificando registro..." : "Importar costo verificado"}</button>
      </fieldset>
      {!eligible ? <p className="accounting-local-error">Solo ventas Facto validadas en CLP y periodo abierto. Los servicios, estimaciones y notas de credito requieren revision separada.</p> : null}
    </form>}
    {error ? <p role="alert" className="accounting-local-error">{error}</p> : null}
  </section>;
}
