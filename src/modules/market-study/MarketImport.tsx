import { useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import { importMarketResearch, previewMarketResearch } from '../../lib/marketStudyApi';
import { previewMarketImport } from '../../../supabase/functions/_shared/market-study-contract';

type Preview = ReturnType<typeof previewMarketImport>;
export function MarketImport({ reload }: { reload: () => void }) {
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewedBody, setReviewedBody] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  function change(value: string) {
    setRaw(value); setPreview(null); setReviewedBody(null);
    setConfirmed(false); setDone(''); setError('');
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(''); setDone(''); setPreview(null); setReviewedBody(null); setConfirmed(false);
    try {
      if (new TextEncoder().encode(raw).length > 350000) throw new Error('Máximo 350 KB por lote.');
      const local = previewMarketImport(JSON.parse(raw));
      setPreview(local);
      if (!local.canImport) return;
      setBusy(true);
      const body = { schema_version: 1, observations: local.items };
      const checked = await previewMarketResearch(body);
      setPreview(checked);
      if (checked.canImport) setReviewedBody({ schema_version: 1, observations: checked.items });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo validar con el CRM.');
    } finally { setBusy(false); }
  }
  async function commit() {
    if (busy || !preview?.canImport || !confirmed || !reviewedBody) return;
    setBusy(true); setError('');
    try {
      // Send the server-validated snapshot, never a subsequently edited textarea.
      const result = await importMarketResearch(reviewedBody);
      setDone(`${result.inserted} observaciones guardadas; ${result.duplicates} ya existían. Ninguna equivalencia se aprobó automáticamente.`);
      setPreview(null); setReviewedBody(null); setConfirmed(false); reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Importación no confirmada. Puedes reintentar el mismo lote.');
    } finally { setBusy(false); }
  }
  return <section className="market-card">
    <h2><Upload size={21}/> Recibir investigación</h2>
    <p>Recibe el archivo JSON de tu investigador sin darle acceso al CRM. La sesión actual valida y guarda el lote; las equivalencias quedan pendientes de revisión.</p>
    <form onSubmit={event => void inspect(event)}>
      <label>Archivo JSON<input disabled={busy} type="file" accept="application/json,.json" onChange={async event => {
        const file = event.target.files?.[0]; if (!file) return;
        change(''); setBusy(true);
        try { if (file.size > 350000) throw new Error('Máximo 350 KB por lote.'); change(await file.text()); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo leer el archivo.'); }
        finally { setBusy(false); }
      }}/></label>
      <label>Investigación JSON<textarea aria-label="Investigación JSON" disabled={busy} className="market-json" value={raw} onChange={event => change(event.target.value)} placeholder='{"schema_version":1,"observations":[...]}'/></label>
      <button disabled={!raw || busy}>Revisar carga</button>
    </form>
    {busy && <p role="status">Consultando el CRM con tu sesión actual.</p>}
    {preview && <div>
      <p>{preview.total} registros · {preview.items.length} válidos · {preview.errors.length} errores.</p>
      {preview.errors.map(issue => <p role="alert" key={issue.row}>Fila {issue.row}: {issue.message}</p>)}
      {preview.items.map(item => <article className="market-card" key={JSON.stringify([item.provider,item.external_id,item.revision])}>
        <strong>{item.product_label} · {item.seller}</strong>
        <p>{item.amount === null ? 'Precio ausente' : `${item.amount} ${item.currency || 'moneda desconocida'}`} · IVA: {item.vat_basis} ({item.vat_percent === null ? 'tasa desconocida' : `${item.vat_percent}%`}) · {item.package_quantity} {item.unit}</p>
        <p>Presentación: {item.presentation} · Disponibilidad: {item.availability} · Confianza: {Math.round(item.confidence * 100)}%</p>
        <p>SKU sugerido: {item.suggested_sku || 'Sin sugerencia'} · Tipo de oferente: {item.seller_kind}</p>
        <p>Fuente: <a href={item.source_url} target="_blank" rel="noopener noreferrer">{item.source_url}</a> · Fecha: {item.observed_at}</p>
        <p>Cambio: {item.fx ? `${item.fx.clp_per_unit} CLP/${item.fx.currency} · ${item.fx.observed_at} · ${item.fx.source}` : 'Sin tipo de cambio informado'}</p>
        <p>Identidad: {item.provider} / {item.external_id} · Revisión {item.revision}</p>
        {item.notes && <p>Notas: {item.notes}</p>}
      </article>)}

      {reviewedBody !== null && <p role="status">Formato validado por el CRM. Duplicados y conflictos se comprueban al guardar el lote completo.</p>}
      <label className="market-check"><input type="checkbox" disabled={busy || !reviewedBody} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>Revisé la vista previa y quiero guardar estas observaciones, sin cambiar precios.</label>
      <button disabled={!preview.canImport || !reviewedBody || !confirmed || busy} onClick={() => void commit()}>Guardar investigación</button>
    </div>}
    {error && <p role="alert">{error}</p>}{done && <p role="status">{done}</p>}
    <details><summary>Formato de conexión del futuro investigador</summary>
      <p>JSON v1: hasta 200 observaciones y 350 KB. Identidad por provider, external_id y revisión consecutiva. Mismo lote reintentado no duplica registros. Fecha, fuente, IVA, moneda y presentación deben ser explícitos; los datos desconocidos no se inventan.</p>
      <p>El investigador entrega un archivo; no recibe tu sesión, costos ni permisos para aprobar equivalencias. La conexión automática del dot todavía no está habilitada.</p>
    </details>
  </section>;
}
