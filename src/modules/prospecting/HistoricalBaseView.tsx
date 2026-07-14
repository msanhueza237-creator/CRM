import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, FileSpreadsheet, RotateCcw, Search, Upload } from "lucide-react";
import type { HistoricalImportBatch, HistoricalImportPreview } from "../../types/crm";
import {
  commitHistoricalImport,
  listHistoricalBatches,
  previewHistoricalFile,
  rollbackHistoricalBatch,
} from "./historicalImport";

type Props = { role: string; onNotice: (notice: { type: "success" | "error" | "info"; text: string }) => void };

const statusLabel: Record<HistoricalImportBatch["status"], string> = {
  processing: "Procesando", ready: "Disponible", partial: "Requiere revisión",
  failed: "Fallida", rolled_back: "Revertida",
};

export function HistoricalBaseView({ role, onNotice }: Props) {
  const [batches, setBatches] = useState<HistoricalImportBatch[]>([]);
  const [preview, setPreview] = useState<HistoricalImportPreview | null>(null);
  const [relationshipDate, setRelationshipDate] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const canImport = role === "administrador" || role === "vendedor";

  useEffect(() => { void listHistoricalBatches().then(setBatches).catch((error) => onNotice({ type: "error", text: String(error.message ?? error) })); }, [onNotice]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es-CL");
    if (!needle) return preview?.preview ?? [];
    return (preview?.rows ?? []).filter((row) =>
      [row.legal_name, row.legacy_code, row.rut_normalized, ...row.emails, row.phone_raw]
        .some((value) => value.toLocaleLowerCase("es-CL").includes(needle))).slice(0, 100);
  }, [preview, query]);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setPreview(null);
    try {
      const result = await previewHistoricalFile(file, relationshipDate);
      setPreview(result);
      onNotice({ type: "info", text: `Archivo analizado: ${result.stats.entities ?? result.rows.length} empresas únicas. Aún no se ha guardado.` });
    } catch (error) {
      onNotice({ type: "error", text: error instanceof Error ? error.message : "No fue posible analizar el archivo." });
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview || !authorized) return;
    setBusy(true);
    try {
      const batch = await commitHistoricalImport(preview);
      setBatches(await listHistoricalBatches());
      setPreview(null);
      setAuthorized(false);
      onNotice({ type: "success", text: `${batch.entityCount} empresas quedaron en la base histórica. No se crearon contactos ni campañas.` });
    } catch (error) {
      onNotice({ type: "error", text: error instanceof Error ? error.message : "No fue posible guardar el lote." });
    } finally { setBusy(false); }
  }

  async function rollback(batch: HistoricalImportBatch) {
    if (!confirm(`¿Revertir la importación ${batch.filename}? Esta acción no afecta Empresas ni Campañas.`)) return;
    setBusy(true);
    try {
      await rollbackHistoricalBatch(batch.id);
      setBatches(await listHistoricalBatches());
      onNotice({ type: "success", text: "Lote histórico revertido." });
    } catch (error) { onNotice({ type: "error", text: error instanceof Error ? error.message : "No fue posible revertir." }); }
    finally { setBusy(false); }
  }

  return <div className="page-stack historical-base">
    <div className="historical-intro panel">
      <div><p className="eyebrow">Fuente interna de contraste</p><h2>Base histórica de clientes</h2>
        <span>El agente puede usarla para reconocer empresas y completar búsquedas. Un dato histórico prueba una relación pasada, no que el email, teléfono o domicilio sigan vigentes.</span></div>
      <Database size={34} />
    </div>

    {canImport ? <div className="panel historical-upload">
      <div className="panel-heading"><div><h2>Importar archivo</h2><span>CSV, XLSX o XLS · todas las hojas se consolidan · máximo 10.000 empresas y 25 MB</span></div></div>
      <div className="historical-upload-grid">
        <label><span>Fecha aproximada de la relación (opcional)</span><input type="date" value={relationshipDate} onChange={(event) => setRelationshipDate(event.target.value)} /></label>
        <label className={`file-drop ${busy ? "disabled" : ""}`}><FileSpreadsheet size={26} /><span>{busy ? "Analizando…" : "Seleccionar CSV o Excel"}</span>
          <input type="file" accept=".csv,.xlsx,.xls" disabled={busy} onChange={(event) => void selectFile(event)} /></label>
      </div>
      <div className="historical-safety"><AlertTriangle size={19} /><span>“Nombre Vendedor” se ignora. No se crean personas, empresas ni destinatarios. Los registros quedan con territorio desconocido hasta su verificación.</span></div>
    </div> : null}

    {preview ? <div className="panel historical-preview">
      <div className="panel-heading"><div><h2>Vista previa: {preview.filename}</h2><span>{preview.sheets.length} hojas · SHA-256 {preview.sha256.slice(0, 12)}…</span></div></div>
      <div className="metric-grid historical-metrics">
        <MiniMetric label="Filas leídas" value={preview.stats.source_rows ?? preview.rows.length} />
        <MiniMetric label="Empresas únicas" value={preview.stats.entities ?? preview.rows.length} />
        <MiniMetric label="Duplicados unidos" value={preview.stats.duplicates_consolidated ?? 0} />
        <MiniMetric label="A revisar" value={preview.stats.needs_review ?? 0} />
      </div>
      <div className="historical-preview-tools"><label><Search size={16} /><input placeholder="Buscar en la vista previa" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span>Se muestran hasta {query ? 100 : 25} filas</span></div>
      <div className="table-wrap"><table><thead><tr><th>Código</th><th>Razón social</th><th>RUT</th><th>Email</th><th>Teléfono</th><th>Origen</th><th>Estado</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.identity_key}><td>{row.legacy_code || "—"}</td><td><strong>{row.legal_name}</strong></td><td>{row.rut_normalized || row.rut_raw || "—"}</td><td>{row.emails.join(", ") || "—"}</td><td>{row.phone_normalized || row.phone_raw || "—"}</td><td>{row.provenance.map((item) => `${item.sheet} · fila ${item.row}`).join("; ")}</td><td>{row.flags.length > 2 ? <span className="status-chip warning">Revisar</span> : <span className="status-chip neutral">Histórico</span>}</td></tr>)}</tbody></table></div>
      <label className="historical-confirm"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /><span>Confirmo que tengo autorización para conservar y usar esta base con fines comerciales legítimos y revisión humana.</span></label>
      <div className="form-actions"><button className="ghost-button" type="button" onClick={() => setPreview(null)}>Descartar</button><button className="primary-button" type="button" disabled={!authorized || busy} onClick={() => void commit()}><Upload size={17} /> Guardar como base histórica</button></div>
    </div> : null}

    <div className="panel">
      <div className="panel-heading"><div><h2>Importaciones</h2><span>{batches.filter((batch) => batch.status !== "rolled_back").reduce((sum, batch) => sum + batch.entityCount, 0)} registros incorporados</span></div></div>
      {batches.length ? <div className="table-wrap"><table><thead><tr><th>Archivo</th><th>Fecha</th><th>Estado</th><th>Filas</th><th>Empresas</th><th>Hojas</th><th></th></tr></thead><tbody>
        {batches.map((batch) => <tr key={batch.id}><td><strong>{batch.filename}</strong><small>{batch.fileSha256.slice(0, 12)}…</small></td><td>{new Date(batch.createdAt).toLocaleDateString("es-CL")}</td><td><span className={`status-chip ${batch.status === "ready" ? "success" : batch.status === "partial" ? "warning" : "neutral"}`}>{statusLabel[batch.status]}</span></td><td>{batch.sourceRowCount}</td><td>{batch.entityCount}</td><td>{batch.sheets.length}</td><td>{role === "administrador" && batch.status !== "rolled_back" ? <button className="icon-button" title="Revertir lote" disabled={busy} onClick={() => void rollback(batch)}><RotateCcw size={16} /></button> : <CheckCircle2 size={16} />}</td></tr>)}
      </tbody></table></div> : <div className="historical-empty"><FileSpreadsheet size={28} /><strong>Sin archivos históricos</strong><span>Importa la antigua base cuando estés listo.</span></div>}
    </div>
  </div>;
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return <div className="metric-card"><span>{label}</span><strong>{value.toLocaleString("es-CL")}</strong></div>;
}
