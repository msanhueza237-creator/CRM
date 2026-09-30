import { useRef, useState } from "react";
import { BookOpenCheck, LoaderCircle } from "lucide-react";
import { confirmFactoPosting, previewFactoPosting } from "../../lib/accountingApi";
import type { FactoPostingPreview } from "../../../supabase/functions/_shared/facto-posting-contract";
import type { AccountingSourceDocument } from "../../types/accounting";

export function FactoPostingReview({ entityId, source, onPosted }: {
  entityId: string; source: AccountingSourceDocument; onPosted: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<FactoPostingPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const running = useRef(false);
  const clp = (n: number) => new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(n);

  async function review() {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); setConfirmed(false); setPreview(null);
    try {
      const saved = await previewFactoPosting(entityId, source.id);
      if (saved.preview?.id !== source.id || saved.bankBalanceAdjustments !== 0) throw new Error("Previsualizacion incompleta; no se puede confirmar.");
      setPreview(saved.preview);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo revisar el documento."); }
    finally { running.current = false; setBusy(false); }
  }

  async function post() {
    if (!preview || !confirmed || running.current || result || uncertain) return;
    running.current = true; setBusy(true); setError("");
    try {
      const saved = await confirmFactoPosting(entityId, preview);
      if (saved.documents?.length !== 1 || saved.documents[0].id !== source.id || saved.bankBalanceAdjustments !== 0)
        throw new Error("Respuesta incompleta; revisar el libro antes de repetir.");
      setResult(`Documento ${preview.folio} contabilizado con fecha ${preview.date}.`);
      try { await onPosted(); } catch { setError("Asiento registrado. No se pudo refrescar la pantalla; actualizala sin repetir el registro."); }
    } catch (e) {
      setUncertain(true);
      setError(`${e instanceof Error ? e.message : "No se pudo verificar el resultado."} Actualiza y revisa el libro antes de volver a intentarlo.`);
    } finally { running.current = false; setBusy(false); }
  }

  if (source.source_type !== "FACTO" || !["sales_invoice", "sales_receipt", "sales_credit_note"].includes(source.document_type)) return null;
  return <section className="panel facto-posting-review">
    <div className="accounting-panel-heading"><div><p>Documento {source.folio}</p><h2>Asiento de venta</h2><span>{source.counterpart_name}</span></div><BookOpenCheck size={24} /></div>
    {result ? <p role="status" className="accounting-balance-check ok">{result}</p> : <>
      {!preview ? <button type="button" className="ghost-button" disabled={busy || uncertain} onClick={() => void review()}>{busy ? <LoaderCircle className="spin" size={17} /> : <BookOpenCheck size={17} />} Revisar asiento</button> : <>
        <p>Fecha contable: {preview.date} · {preview.creditNote ? "Nota de credito" : "Venta"} · CLP</p>
        <div className="facto-posting-table"><table><thead><tr><th>Cuenta</th><th>Debe</th><th>Haber</th></tr></thead><tbody>
          <tr><td>Clientes y documentos por cobrar</td><td>{clp(preview.creditNote ? 0 : preview.total)}</td><td>{clp(preview.creditNote ? preview.total : 0)}</td></tr>
          <tr><td>Ventas netas</td><td>{clp(preview.creditNote ? preview.net : 0)}</td><td>{clp(preview.creditNote ? 0 : preview.net)}</td></tr>
          <tr><td>IVA debito fiscal</td><td>{clp(preview.creditNote ? preview.tax : 0)}</td><td>{clp(preview.creditNote ? 0 : preview.tax)}</td></tr>
        </tbody></table></div>
        <label className="accounting-report-confirmation"><input type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={e => setConfirmed(e.target.checked)} /><span>Confirmo este asiento del documento. No incluye costos, inventario, cobros, pagos ni ajustes bancarios.</span></label>
        <button type="button" className="primary-button" disabled={busy || !confirmed || uncertain} onClick={() => void post()}>{busy ? <LoaderCircle className="spin" size={17} /> : <BookOpenCheck size={17} />} Contabilizar documento</button>
      </>}
    </>}
    {error ? <p role="alert" className="accounting-local-error">{error}</p> : null}
  </section>;
}
