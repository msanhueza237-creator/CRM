import { useRef, useState } from "react";
import { Check, FileCheck2, LoaderCircle } from "lucide-react";
import { confirmFactoCostReturn, reviewFactoCostReturn } from "../../lib/accountingApi";
import type { AccountingPeriod, AccountingSourceDocument } from "../../types/accounting";
import type { FactoCostReturnPreview } from "../../../supabase/functions/_shared/facto-cost-return-contract";
import { validVerifiedCostInput } from "./verifiedFactoCostPolicy";

type Props = { entityId: string; source: AccountingSourceDocument; periods: AccountingPeriod[]; onImported: () => Promise<unknown> };
const clp = (n: number) => new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(n);

export function VerifiedFactoReturn({ entityId, source, periods, onImported }: Props) {
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [returned, setReturned] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<FactoCostReturnPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ entryId: string; amountClp: number } | null>(null);
  const running = useRef(false);
  const eligible = source.source_type === "FACTO" && source.document_type === "sales_credit_note" && source.currency === "CLP"
    && ["validated", "posted"].includes(source.status) && source.data_quality === "validated"
    && periods.some(p => p.status === "open" && source.issued_on && source.issued_on >= p.starts_on && source.issued_on <= p.ends_on);
  const valid = eligible && validVerifiedCostInput(amount, evidence, returned);
  function invalidate() { setPreview(null); setConfirmed(false); setError(""); }
  async function submit(apply: boolean) {
    if (!valid || running.current || saved || (apply && (!preview || !confirmed))) return;
    running.current = true; setBusy(true); setError("");
    const input = { entityId, sourceDocumentId: source.id, amountClp: Number(amount), evidence: evidence.trim(), saleableReturnConfirmed: returned };
    try {
      if (!apply) {
        const result = await reviewFactoCostReturn(input);
        if (!result.preview?.reviewKey || result.preview.id !== source.id || result.preview.amountClp !== Number(amount)) throw new Error("Revision incompleta. No se registro la reversa.");
        setPreview(result.preview); setConfirmed(false);
      } else {
        const result = await confirmFactoCostReturn(input, preview!.reviewKey);
        if (result.status !== "posted" || result.amountClp !== Number(amount) || !result.entryId) throw new Error("Respuesta incompleta. Revisar el libro antes de repetir.");
        setSaved(result);
        try { await onImported(); } catch { setError("Reversa registrada. No se pudo refrescar la vista; recarga sin repetir el registro."); }
      }
    } catch (caught) { setPreview(null); setConfirmed(false); setError(caught instanceof Error ? caught.message : "No se pudo verificar. Revisar el libro antes de repetir."); }
    finally { running.current = false; setBusy(false); }
  }
  return <section className="panel facto-cost-return">
    <div className="accounting-panel-heading"><div><p>Devolucion de mercaderias</p><h2>Reversa de costo verificada</h2><span>Nota {source.folio} · {source.counterpart_name} · {source.issued_on}</span></div><FileCheck2 size={24} /></div>
    {saved ? <div role="status" className="accounting-balance-check ok"><Check size={18} /><strong>Reversa incorporada: {clp(saved.amountClp)}</strong><span>Asiento {saved.entryId}</span></div> : <>
      <fieldset disabled={busy || !eligible} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="accounting-form-grid">
          <label>Costo devuelto CLP<input type="number" min="1" step="1" value={amount} onChange={e => { setAmount(e.target.value); invalidate(); }} /></label>
          <label className="wide">Evidencia de costo y reversa en Facto<textarea rows={4} minLength={20} maxLength={500} value={evidence} onChange={e => { setEvidence(e.target.value); invalidate(); }} /></label>
        </div>
        <label className="accounting-report-confirmation"><input type="checkbox" checked={returned} onChange={e => { setReturned(e.target.checked); invalidate(); }} /><span>Mercaderia devuelta fisicamente y disponible para vender; costo historico y reversa comprobados en Facto. No incluye equipos en revision, estimaciones ni movimientos de stock nuevos.</span></label>
        {!preview ? <button className="primary-button" type="button" disabled={!valid || busy} onClick={() => void submit(false)}>{busy ? <LoaderCircle className="spin" size={17} /> : <FileCheck2 size={17} />} Revisar reversa</button> : <>
          <div className="accounting-balance-check"><span>Factura {preview.invoiceFolio} · Costo original {clp(preview.originalCost)}</span><span>Reversas previas {clp(preview.otherReversals)}</span><span>Fecha {preview.date}</span></div>
          <div className="accounting-balance-check"><span>Debe inventario {clp(preview.amountClp)}</span><span>Haber costo de ventas {clp(preview.amountClp)}</span><strong>Costo restante {clp(preview.remainingCost)}</strong></div>
          <label className="accounting-report-confirmation"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>Confirmo esta reversa contable sin modificar ventas, IVA, bancos, pagos ni cantidades de stock.</span></label>
          <button className="primary-button" type="button" disabled={!confirmed || busy} onClick={() => void submit(true)}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} Importar reversa verificada</button>
        </>}
      </fieldset>
      {!eligible ? <p className="accounting-local-error">Solo notas de credito Facto validadas en CLP y periodo abierto.</p> : null}
    </>}
    {error ? <p role="alert" className="accounting-local-error">{error}</p> : null}
  </section>;
}
