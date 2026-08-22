import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  FileUp,
  Link2,
  LoaderCircle,
  RefreshCw,
  ScanText,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  confirmForeignTradeDocument,
  extractForeignTradeDocument,
  getForeignTradeDocumentUrl,
  getForeignTradeDocuments,
  searchForeignTradeCatalog,
  uploadForeignTradeDocument,
} from "../../lib/foreignTradeApi";
import type {
  ForeignTradeCatalogProduct,
  ForeignTradeDocument,
  ForeignTradeDocumentExtraction,
  ForeignTradeDocumentType,
  ForeignTradeExtractedLine,
  ForeignTradeSupplier,
} from "../../types/foreignTrade";

const documentTypes: Array<{ value: ForeignTradeDocumentType; label: string }> = [
  { value: "proforma", label: "Proforma" },
  { value: "purchase_order", label: "Orden de compra" },
  { value: "commercial_invoice", label: "Commercial invoice" },
  { value: "packing_list", label: "Packing list" },
  { value: "freight_quote", label: "Cotización de transporte" },
  { value: "bill_of_lading", label: "Bill of lading" },
  { value: "certificate_of_origin", label: "Certificado de origen" },
  { value: "other", label: "Otro" },
];

export function ForeignTradeDocumentsPanel({
  operationId,
  supplierId,
  suppliers,
  onChanged,
}: {
  operationId: string;
  supplierId: string | null;
  suppliers: ForeignTradeSupplier[];
  onChanged: (message: string) => Promise<void>;
}) {
  const [documents, setDocuments] = useState<ForeignTradeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<ForeignTradeDocumentType>("proforma");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reviewDocument, setReviewDocument] = useState<ForeignTradeDocument | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDocuments(await getForeignTradeDocuments(operationId));
      setError("");
    } catch (loadError) {
      const text = loadError instanceof Error ? loadError.message : "No se pudieron cargar los documentos.";
      setError(/foreign_trade_document_list|does not exist|404/i.test(text)
        ? "Falta ejecutar supabase/foreign_trade_center_phase3.sql en Supabase."
        : text);
    } finally {
      setLoading(false);
    }
  }, [operationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!documents.some((document) => ["queued", "extracting"].includes(document.parse_status))) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [documents, load]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusyId("upload"); setError(""); setMessage("Guardando el original en el repositorio privado...");
    try {
      const documentId = await uploadForeignTradeDocument({ operationId, supplierId, documentType, file });
      setFile(null);
      await load();
      setMessage("Original guardado. Analizando campos y productos...");
      await extractForeignTradeDocument(documentId);
      await load();
      setMessage("Extracción terminada. Revisa los datos antes de confirmarlos.");
    } catch (uploadError) {
      setError(humanizeDocumentError(uploadError));
      await load();
    } finally { setBusyId(""); }
  }

  async function retry(document: ForeignTradeDocument) {
    setBusyId(document.id); setError(""); setMessage("Reintentando la extracción...");
    try {
      await extractForeignTradeDocument(document.id);
      await load();
      setMessage("Extracción lista para revisión.");
    } catch (retryError) {
      setError(humanizeDocumentError(retryError));
      await load();
    } finally { setBusyId(""); }
  }

  async function downloadDocument(document: ForeignTradeDocument) {
    const popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    setBusyId(`download:${document.id}`); setError("");
    try {
      const signedUrl = await getForeignTradeDocumentUrl(document);
      if (popup) popup.location.replace(signedUrl);
      else window.location.assign(signedUrl);
    } catch (downloadError) {
      popup?.close();
      setError(downloadError instanceof Error ? downloadError.message : "No se pudo abrir el documento privado.");
    } finally { setBusyId(""); }
  }

  return (
    <section className="foreign-trade-documents-layout">
      <form className="panel foreign-trade-document-upload" onSubmit={upload}>
        <div className="foreign-trade-detail-panel-heading">
          <div><h2>Cargar documento privado</h2><p>El original se conserva y ningún dato se oficializa sin tu revisión.</p></div>
          <span className="foreign-trade-private-badge"><ShieldCheck size={15} /> Solo gerencia</span>
        </div>
        <label className="foreign-trade-dropzone">
          <FileUp size={28} />
          <strong>{file ? file.name : "Selecciona una proforma PDF o Excel"}</strong>
          <span>{file ? formatFileSize(file.size) : "PDF, XLS o XLSX · máximo 25 MB"}</span>
          <input type="file" accept=".pdf,.xls,.xlsx,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <div className="foreign-trade-upload-actions">
          <label><span>Tipo de documento</span><select value={documentType} onChange={(event) => setDocumentType(event.target.value as ForeignTradeDocumentType)}>{documentTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <button className="primary-button" type="submit" disabled={!file || Boolean(busyId)}>{busyId === "upload" ? <LoaderCircle className="spin" size={17} /> : <ScanText size={17} />} {busyId === "upload" ? "Procesando..." : "Guardar y analizar"}</button>
        </div>
        {message ? <div className="notice-banner success"><CheckCircle2 size={17} /> {message}</div> : null}
        {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
      </form>

      <section className="panel foreign-trade-document-list">
        <div className="foreign-trade-detail-panel-heading"><div><h2>Documentos de la operación</h2><p>Trazabilidad del original, extracción y confirmación.</p></div><button className="icon-button" type="button" title="Actualizar documentos" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={17} /></button></div>
        {loading && !documents.length ? <div className="foreign-trade-loading compact"><LoaderCircle className="spin" size={22} /><span>Cargando documentos...</span></div> : null}
        {!loading && !documents.length ? <div className="empty-state"><FileText size={27} /><strong>Sin documentos</strong><span>Carga la primera proforma para iniciar la revisión asistida.</span></div> : null}
        <div className="foreign-trade-document-items">
          {documents.map((document) => (
            <article key={document.id}>
              <div className="foreign-trade-document-icon">{document.mime_type === "application/pdf" ? <FileText /> : <FileSpreadsheet />}</div>
              <div className="foreign-trade-document-info">
                <strong>{document.original_file_name}</strong>
                <span>{documentTypeLabel(document.document_type)} · {formatFileSize(document.file_size)} · {formatDateTime(document.created_at)}</span>
                {document.extraction_error ? <small>{document.extraction_error}</small> : null}
              </div>
              <DocumentStatus document={document} />
              <div className="foreign-trade-row-actions">
                <button className="icon-button" type="button" title="Abrir original privado" disabled={busyId === `download:${document.id}`} onClick={() => void downloadDocument(document)}>{busyId === `download:${document.id}` ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</button>
                {document.parse_status === "review_required" ? <button className="ghost-button" type="button" onClick={() => setReviewDocument(document)}><Eye size={16} /> Revisar</button> : null}
                {document.parse_status === "failed" ? <button className="ghost-button" type="button" disabled={busyId === document.id} onClick={() => void retry(document)}>{busyId === document.id ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Reintentar</button> : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      {reviewDocument ? <DocumentReviewDialog document={reviewDocument} suppliers={suppliers} onClose={() => setReviewDocument(null)} onConfirmed={async (resultMessage) => { setReviewDocument(null); await load(); await onChanged(resultMessage); }} /> : null}
    </section>
  );
}

function DocumentReviewDialog({ document, suppliers, onClose, onConfirmed }: { document: ForeignTradeDocument; suppliers: ForeignTradeSupplier[]; onClose: () => void; onConfirmed: (message: string) => Promise<void> }) {
  const [review, setReview] = useState<ForeignTradeDocumentExtraction>(() => structuredClone(document.extraction_result) as ForeignTradeDocumentExtraction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalog, setCatalog] = useState<ForeignTradeCatalogProduct[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);

  function setGeneral(key: keyof ForeignTradeDocumentExtraction["general"], value: string | number | null) {
    setReview((current) => ({ ...current, general: { ...current.general, [key]: value } }));
  }
  function setLine(index: number, patch: Partial<ForeignTradeExtractedLine>) {
    setReview((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line) }));
  }
  async function searchCatalog() {
    setCatalogBusy(true);
    try { setCatalog(await searchForeignTradeCatalog(catalogSearch)); }
    catch (searchError) { setError(searchError instanceof Error ? searchError.message : "No se pudo buscar el catálogo."); }
    finally { setCatalogBusy(false); }
  }
  async function confirm() {
    if (!window.confirm("¿Confirmar esta revisión e importar las líneas seleccionadas? El archivo original y la extracción se conservarán.")) return;
    setBusy(true); setError("");
    try {
      const result = await confirmForeignTradeDocument(document.id, review);
      await onConfirmed(`${result.inserted_lines} producto(s) importados desde la revisión confirmada.`);
    } catch (confirmError) { setError(humanizeDocumentError(confirmError)); }
    finally { setBusy(false); }
  }

  const general = review.general;
  return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-review-title">
    <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-review-title">Revisar proforma</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
    <div className="foreign-trade-review-summary"><ConfidenceBadge value={document.extraction_confidence} /><span>{review.lines.length} líneas detectadas</span><span>{document.review_warnings.length} advertencias</span></div>
    {document.review_warnings.length ? <section className="foreign-trade-review-warnings"><strong><AlertTriangle size={16} /> Datos que requieren atención</strong>{document.review_warnings.map((warning, index) => <p key={`${warning.code}-${index}`} className={warning.severity}>{warning.message}</p>)}</section> : null}

    <section className="foreign-trade-review-section"><div><h3>Datos generales</h3><span>Extraído del documento · editable antes de confirmar</span></div><div className="foreign-trade-form-grid">
      <label><span>Proveedor CRM</span><select value={general.supplier_id || ""} onChange={(event) => setGeneral("supplier_id", event.target.value || null)}><option value="">Sin vincular</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
      <ReviewField label="Proveedor reconocido" value={general.supplier_name} onChange={(value) => setGeneral("supplier_name", value)} />
      <ReviewField label="Número de proforma" value={general.proforma_number} onChange={(value) => setGeneral("proforma_number", value)} />
      <ReviewField label="Fecha" type="date" value={general.document_date} onChange={(value) => setGeneral("document_date", value)} />
      <ReviewField label="Vigencia" type="date" value={general.valid_until} onChange={(value) => setGeneral("valid_until", value)} />
      <ReviewField label="Moneda" value={general.currency} maxLength={3} onChange={(value) => setGeneral("currency", value.toUpperCase())} />
      <ReviewField label="Incoterm" value={general.incoterm} onChange={(value) => setGeneral("incoterm", value.toUpperCase())} />
      <ReviewField label="Puerto de origen" value={general.origin_port} onChange={(value) => setGeneral("origin_port", value)} />
      <ReviewField label="Puerto de destino" value={general.destination_port} onChange={(value) => setGeneral("destination_port", value)} />
      <ReviewField label="Condiciones de pago" value={general.payment_terms} onChange={(value) => setGeneral("payment_terms", value)} />
      <ReviewField label="Producción, días" type="number" value={general.production_days} onChange={(value) => setGeneral("production_days", nullableNumber(value))} />
      <ReviewField label="Número de orden" value={general.order_number} onChange={(value) => setGeneral("order_number", value)} />
      <label className="wide-field"><span>Observaciones</span><textarea value={general.observations || ""} onChange={(event) => setGeneral("observations", event.target.value || null)} /></label>
    </div></section>

    <section className="foreign-trade-review-section"><div className="foreign-trade-review-products-heading"><div><h3>Productos reconocidos</h3><span>Desmarca cualquier fila que no deba importarse.</span></div><div><input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="Buscar catálogo para vincular" /><button className="ghost-button" type="button" onClick={() => void searchCatalog()}>{catalogBusy ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />} Buscar</button></div></div>
      <div className="foreign-trade-review-lines">{review.lines.map((line, index) => <ReviewLineCard key={`${line.source_index}-${index}`} line={line} catalog={catalog} onChange={(patch) => setLine(index, patch)} />)}</div>
    </section>
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="primary-button" type="button" disabled={busy || !review.lines.some((line) => line.include)} onClick={() => void confirm()}><ShieldCheck size={17} /> {busy ? "Confirmando..." : "Confirmar e importar"}</button></footer>
  </div></div>;
}

function ReviewLineCard({ line, catalog, onChange }: { line: ForeignTradeExtractedLine; catalog: ForeignTradeCatalogProduct[]; onChange: (patch: Partial<ForeignTradeExtractedLine>) => void }) {
  return <article className={!line.include ? "excluded" : ""}>
    <header><label><input type="checkbox" checked={line.include} onChange={(event) => onChange({ include: event.target.checked })} /><span>Línea {line.source_index}</span></label><ConfidenceBadge value={line.confidence} /></header>
    <div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Producto</span><input value={line.product_name} onChange={(event) => onChange({ product_name: event.target.value })} /></label>
      <label className="wide-field"><span>Vincular catálogo CRM</span><select value={line.content_product_id || ""} onChange={(event) => { const selected = catalog.find((product) => product.id === event.target.value); onChange({ content_product_id: event.target.value || null, sku: selected?.sku || line.sku, product_name: selected?.name || line.product_name }); }}><option value="">Producto temporal / coincidencia automática por SKU</option>{catalog.map((product) => <option key={product.id} value={product.id}>{product.sku ? `${product.sku} · ` : ""}{product.name}</option>)}</select></label>
      <ReviewLineField label="SKU proveedor" value={line.supplier_sku} onChange={(value) => onChange({ supplier_sku: value })} />
      <ReviewLineField label="SKU CRM" value={line.sku} onChange={(value) => onChange({ sku: value })} />
      <ReviewLineField label="Modelo" value={line.model} onChange={(value) => onChange({ model: value })} />
      <ReviewLineNumber label="Cantidad" value={line.quantity} onChange={(value) => onChange({ quantity: value })} />
      <ReviewLineNumber label="Unidades por caja" value={line.quantity_per_box} onChange={(value) => onChange({ quantity_per_box: value })} />
      <ReviewLineNumber label="Cajas" value={line.box_count} onChange={(value) => onChange({ box_count: value })} />
      <ReviewLineField label="Moneda" value={line.currency} maxLength={3} onChange={(value) => onChange({ currency: value?.toUpperCase() || null })} />
      <ReviewLineNumber label="Precio unitario" value={line.unit_price} onChange={(value) => onChange({ unit_price: value })} />
      <ReviewLineNumber label="Total documento" value={line.total_price} onChange={(value) => onChange({ total_price: value })} />
      <ReviewLineNumber label="CBM total" value={line.cbm_total} onChange={(value) => onChange({ cbm_total: value })} />
      <ReviewLineNumber label="Peso bruto kg" value={line.gross_weight_kg} onChange={(value) => onChange({ gross_weight_kg: value })} />
      <ReviewLineField label="HS Code" value={line.hs_code} onChange={(value) => onChange({ hs_code: value })} />
      <ReviewLineField label="País de origen" value={line.country_of_origin} onChange={(value) => onChange({ country_of_origin: value?.toUpperCase() || null })} />
      <label className="wide-field"><span>Descripción</span><textarea value={line.description || ""} onChange={(event) => onChange({ description: event.target.value || null })} /></label>
      {line.content_product_id ? <label className="foreign-trade-checkbox-field wide-field"><input type="checkbox" checked={line.remember_link} onChange={(event) => onChange({ remember_link: event.target.checked })} /><span>Recordar la relación con este proveedor</span></label> : null}
    </div>
    {line.recalculated_cbm_total !== null ? <p className="foreign-trade-recalculation">CBM recalculado: <strong>{formatNumber(line.recalculated_cbm_total)} m³</strong>{line.cbm_total !== null && line.cbm_total !== line.recalculated_cbm_total ? " · revisa la diferencia" : ""}</p> : null}
    {line.warnings.length ? <div className="foreign-trade-line-warnings">{line.warnings.map((warning) => <span key={warning}><AlertTriangle size={13} /> {warning}</span>)}</div> : null}
  </article>;
}

function ReviewField({ label, value, onChange, type = "text", maxLength }: { label: string; value: string | number | null; onChange: (value: string) => void; type?: string; maxLength?: number }) { return <label><span>{label}</span><input type={type} maxLength={maxLength} value={value ?? ""} onChange={(event) => onChange(event.target.value)} /></label>; }
function ReviewLineField({ label, value, onChange, maxLength }: { label: string; value: string | null; onChange: (value: string | null) => void; maxLength?: number }) { return <label><span>{label}</span><input maxLength={maxLength} value={value || ""} onChange={(event) => onChange(event.target.value || null)} /></label>; }
function ReviewLineNumber({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) { return <label><span>{label}</span><input type="number" min="0" step="any" value={value ?? ""} onChange={(event) => onChange(nullableNumber(event.target.value))} /></label>; }

function DocumentStatus({ document }: { document: ForeignTradeDocument }) {
  const content = ({ uploaded: "Cargado", queued: "En cola", extracting: "Analizando", review_required: "Revisión requerida", confirmed: "Confirmado", failed: "Error" })[document.parse_status];
  return <span className={`foreign-trade-document-status ${document.parse_status}`}>{["queued", "extracting"].includes(document.parse_status) ? <LoaderCircle className="spin" size={13} /> : null}{content}</span>;
}
function ConfidenceBadge({ value }: { value: number | null }) { const level = value === null ? "unknown" : value >= .85 ? "high" : value >= .6 ? "medium" : "low"; const label = value === null ? "Sin confianza" : `${Math.round(value * 100)}% confianza`; return <span className={`foreign-trade-confidence ${level}`}>{label}</span>; }
function nullableNumber(value: string) { const number = Number(value); return value.trim() && Number.isFinite(number) ? number : null; }
function documentTypeLabel(type: ForeignTradeDocumentType) { return documentTypes.find((item) => item.value === type)?.label || type; }
function formatFileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatNumber(value: number) { return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 6 }).format(value); }
function humanizeDocumentError(error: unknown) { const message = error instanceof Error ? error.message : "No se pudo procesar el documento."; if (message.includes("OPENAI_API_KEY")) return "La extracción inteligente no está configurada en Supabase."; if (message.includes("already") || message.includes("not_ready")) return "El documento ya fue confirmado o todavía no está listo para revisión."; if (message.includes("invalid_review") || message.includes("invalid_product")) return "Revisa los datos marcados antes de confirmar."; return message; }
