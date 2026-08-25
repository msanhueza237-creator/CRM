import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
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
  Trash2,
  X,
} from "lucide-react";
import {
  cancelForeignTradeDocumentExtraction,
  autoFinalizeForeignTradeExpenseReconciliation,
  autoFinalizeForeignTradeOperation,
  confirmForeignTradeDocument,
  confirmForeignTradeAgencySettlementDocument,
  confirmForeignTradeFreightDocument,
  confirmForeignTradeFundRequestDocument,
  deleteForeignTradeProductSupplierMapping,
  deleteForeignTradeDocument,
  downloadForeignTradeDocumentSection,
  extractForeignTradeDocument,
  getForeignTradeDocumentUrl,
  getForeignTradeDocuments,
  getForeignTradeExpenseReconciliations,
  reconcileForeignTradeDocument,
  searchForeignTradeCatalog,
  updateForeignTradeDocumentType,
  uploadForeignTradeDocument,
} from "../../lib/foreignTradeApi";
import type {
  ForeignTradeCatalogProduct,
  ForeignTradeAgencySettlementExtraction,
  ForeignTradeAgencySettlementLine,
  ForeignTradeAnyDocumentExtraction,
  ForeignTradeCostCategory,
  ForeignTradeDocument,
  ForeignTradeDocumentExtraction,
  ForeignTradeDocumentScope,
  ForeignTradeDocumentType,
  ForeignTradeExpenseReconciliation,
  ForeignTradeExtractedLine,
  ForeignTradeFundRequestExtraction,
  ForeignTradeFundRequestLine,
  ForeignTradeFreightDocumentExtraction,
  ForeignTradeFreightDocumentLine,
  ForeignTradeProductReconciliationLine,
  ForeignTradeProductReconciliationResult,
  ForeignTradeReconciliationLineType,
  ForeignTradeSupplier,
} from "../../types/foreignTrade";
import { normalizeForeignTradeFundRequestReview } from "./foreignTradeFundRequestReview";
import { normalizeForeignTradeAgencySettlementReview } from "./foreignTradeAgencySettlementReview";
import { normalizeForeignTradeFreightDocumentReview } from "./foreignTradeFreightDocumentReview";

const documentTypes: Array<{ value: ForeignTradeDocumentType; label: string }> = [
  { value: "proforma", label: "Proforma" },
  { value: "purchase_order", label: "Orden de compra" },
  { value: "commercial_invoice", label: "Commercial invoice" },
  { value: "packing_list", label: "Packing list" },
  { value: "freight_quote", label: "Factura / cotización de transporte" },
  { value: "bill_of_lading", label: "Bill of lading" },
  { value: "certificate_of_origin", label: "Certificado de origen" },
  { value: "customs_document", label: "Documento aduanero" },
  { value: "payment_receipt", label: "Comprobante de pago" },
  { value: "fund_request", label: "Solicitud / provisión de fondos" },
  { value: "agency_settlement", label: "Rendición final de agencia" },
  { value: "other", label: "Otro" },
];

const productExtractableDocumentTypes = new Set<ForeignTradeDocumentType>([
  "proforma",
  "purchase_order",
  "commercial_invoice",
  "packing_list",
]);
const sectionAwareDocumentTypes = new Set<ForeignTradeDocumentType>([
  "commercial_invoice",
  "packing_list",
  "bill_of_lading",
]);
const supportingExtractableDocumentTypes = new Set<ForeignTradeDocumentType>(["bill_of_lading"]);
const expenseExtractableDocumentTypes = new Set<ForeignTradeDocumentType>(["fund_request", "agency_settlement", "freight_quote"]);
const extractableDocumentTypes = new Set<ForeignTradeDocumentType>([
  ...productExtractableDocumentTypes,
  ...supportingExtractableDocumentTypes,
  ...expenseExtractableDocumentTypes,
]);

const currentExtractionVersion = "pdf_skill_v12_compound_sections";
const currentFundRequestExtractionVersion = "fund_request_v1";
const currentAgencySettlementExtractionVersion = "agency_settlement_v1";
const currentFreightDocumentExtractionVersion = "freight_document_v1";

type PendingDocumentUpload = {
  key: string;
  file: File;
  documentType: ForeignTradeDocumentType;
};

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
  const [pendingFiles, setPendingFiles] = useState<PendingDocumentUpload[]>([]);
  const [documentType, setDocumentType] = useState<ForeignTradeDocumentType>("proforma");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reviewDocument, setReviewDocument] = useState<ForeignTradeDocument | null>(null);
  const [extractingIds, setExtractingIds] = useState<Set<string>>(() => new Set());
  const extractionControllers = useRef(new Map<string, AbortController>());
  const stopBatchRequested = useRef(false);
  const activeUploadDocumentId = useRef("");

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

  useEffect(() => () => {
    extractionControllers.current.forEach((controller) => controller.abort());
    extractionControllers.current.clear();
  }, []);

  useEffect(() => {
    if (!documents.some((document) => ["queued", "extracting"].includes(document.parse_status))) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [documents, load]);

  async function runExtraction(documentId: string) {
    const previous = extractionControllers.current.get(documentId);
    previous?.abort();
    const controller = new AbortController();
    extractionControllers.current.set(documentId, controller);
    setExtractingIds((current) => new Set(current).add(documentId));
    try {
      return await extractForeignTradeDocument(documentId, controller.signal);
    } finally {
      if (extractionControllers.current.get(documentId) === controller) {
        extractionControllers.current.delete(documentId);
        setExtractingIds((current) => {
          const next = new Set(current);
          next.delete(documentId);
          return next;
        });
      }
    }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!pendingFiles.length) return;
    stopBatchRequested.current = false;
    setBusyId("upload"); setError(""); setMessage("Guardando el original en el repositorio privado...");
    const uploadedKeys = new Set<string>();
    const uploadErrors: string[] = [];
    const extractionErrors: string[] = [];
    let extracted = 0;
    let originalsOnly = 0;
    try {
      for (let index = 0; index < pendingFiles.length; index += 1) {
        if (stopBatchRequested.current) break;
        const pending = pendingFiles[index];
        setMessage(`Procesando documento ${index + 1} de ${pendingFiles.length}: ${pending.file.name}`);
        let documentId = "";
        try {
          documentId = await uploadForeignTradeDocument({
            operationId,
            supplierId,
            documentType: pending.documentType,
            file: pending.file,
          });
          activeUploadDocumentId.current = documentId;
          uploadedKeys.add(pending.key);
          await load();
        } catch (uploadError) {
          uploadErrors.push(`${pending.file.name}: ${humanizeDocumentError(uploadError)}`);
          continue;
        }

        if (stopBatchRequested.current) {
          await cancelForeignTradeDocumentExtraction(documentId).catch(() => undefined);
          originalsOnly += 1;
          break;
        }
        if (!extractableDocumentTypes.has(pending.documentType)) {
          originalsOnly += 1;
          activeUploadDocumentId.current = "";
          continue;
        }
        try {
          await runExtraction(documentId);
          extracted += 1;
        } catch (extractionError) {
          if (!isAbortError(extractionError)) extractionErrors.push(`${pending.file.name}: ${humanizeDocumentError(extractionError)}`);
        } finally {
          activeUploadDocumentId.current = "";
        }
        if (stopBatchRequested.current) break;
      }
      setPendingFiles((current) => current.filter((item) => !uploadedKeys.has(item.key)));
      await load();
      const summary = [
        uploadedKeys.size ? `${uploadedKeys.size} original(es) guardado(s)` : "",
        extracted ? `${extracted} extracción(es) lista(s) para revisar` : "",
        originalsOnly ? `${originalsOnly} documento(s) conservado(s) como respaldo` : "",
      ].filter(Boolean).join(" · ");
      setMessage(stopBatchRequested.current
        ? `${summary || "Carga detenida"}. No se procesarán más archivos.`
        : summary || "No se cargaron documentos.");
      setError([...uploadErrors, ...extractionErrors].join(" "));
    } finally {
      activeUploadDocumentId.current = "";
      stopBatchRequested.current = false;
      setBusyId("");
    }
  }

  async function stopUpload() {
    stopBatchRequested.current = true;
    extractionControllers.current.forEach((controller) => controller.abort());
    setMessage("Deteniendo la carga después de conservar el original actual...");
    const documentId = activeUploadDocumentId.current;
    if (!documentId) return;
    try {
      await cancelForeignTradeDocumentExtraction(documentId);
      await load();
    } catch (cancelError) {
      setError(humanizeDocumentError(cancelError));
    }
  }

  function selectFiles(fileList: FileList | null) {
    const selected = Array.from(fileList || []);
    if (selected.length > 2) setError("Puedes seleccionar un máximo de 2 documentos por carga.");
    else setError("");
    setPendingFiles(selected.slice(0, 2).map((selectedFile) => ({
      key: `${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`,
      file: selectedFile,
      documentType: inferDocumentType(selectedFile.name, documentType),
    })));
  }

  function updatePendingType(key: string, nextType: ForeignTradeDocumentType) {
    setPendingFiles((current) => current.map((item) => item.key === key ? { ...item, documentType: nextType } : item));
  }

  function removePendingFile(key: string) {
    setPendingFiles((current) => current.filter((item) => item.key !== key));
  }

  async function retry(document: ForeignTradeDocument, openReview = false) {
    setBusyId(document.id); setError(""); setMessage("Reintentando la extracción...");
    setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, parse_status: "extracting" } : item));
    try {
      await runExtraction(document.id);
      const refreshedDocuments = await getForeignTradeDocuments(operationId);
      setDocuments(refreshedDocuments);
      const refreshedDocument = refreshedDocuments.find((item) => item.id === document.id);
      if (openReview && refreshedDocument?.parse_status === "review_required") setReviewDocument(refreshedDocument);
      const lineCount = extractionLines(refreshedDocument?.extraction_result).length;
      setMessage(lineCount
        ? document.document_type === "freight_quote"
          ? `Extracción lista: ${lineCount} cargo(s) logístico(s) para revisar y costear.`
          : expenseExtractableDocumentTypes.has(document.document_type)
          ? `Extracción lista: ${lineCount} concepto(s) de gastos y tributos para revisar.`
          : `Extracción regenerada: ${lineCount} producto(s) listos para revisar.`
        : "Extracción lista para revisión.");
    } catch (retryError) {
      await load();
      if (!isAbortError(retryError)) setError(humanizeDocumentError(retryError));
    } finally { setBusyId(""); }
  }

  async function stopExtraction(document: ForeignTradeDocument) {
    extractionControllers.current.get(document.id)?.abort();
    setBusyId(`cancel:${document.id}`); setError(""); setMessage("Deteniendo el análisis...");
    try {
      await cancelForeignTradeDocumentExtraction(document.id);
      await load();
      setMessage("Análisis detenido. Puedes cambiar la clasificación, reemplazar el archivo o eliminarlo.");
    } catch (cancelError) {
      await load();
      setError(humanizeDocumentError(cancelError));
    } finally { setBusyId(""); }
  }

  async function reclassify(document: ForeignTradeDocument, nextType: ForeignTradeDocumentType) {
    if (nextType === document.document_type) return;
    setBusyId(`type:${document.id}`); setError(""); setMessage("");
    try {
      if (["queued", "extracting"].includes(document.parse_status) || extractingIds.has(document.id)) {
        extractionControllers.current.get(document.id)?.abort();
        await cancelForeignTradeDocumentExtraction(document.id);
      }
      await updateForeignTradeDocumentType(document.id, nextType);
      await load();
      setMessage(extractableDocumentTypes.has(nextType)
        ? "Tipo actualizado. Usa Analizar para iniciar la lectura con la clasificación correcta."
        : "Tipo actualizado. El original quedó disponible como respaldo y no requiere extracción de productos.");
    } catch (updateError) {
      await load();
      setError(humanizeDocumentError(updateError));
    } finally { setBusyId(""); }
  }

  async function removeDocument(document: ForeignTradeDocument) {
    const confirmedWarning = document.parse_status === "confirmed"
      ? " También se retirarán los productos, costos y valores conciliados que provengan exclusivamente de este documento."
      : "";
    if (!window.confirm(`¿Eliminar definitivamente ${document.original_file_name}?${confirmedWarning} Esta acción no se puede deshacer.`)) return;
    extractionControllers.current.get(document.id)?.abort();
    setBusyId(`delete:${document.id}`); setError(""); setMessage("");
    try {
      await deleteForeignTradeDocument(document.id, document.parse_status === "confirmed");
      await load();
      await onChanged(document.parse_status === "confirmed"
        ? "Documento confirmado eliminado y datos derivados retirados para recalcular la operación."
        : "Documento eliminado junto con su archivo privado.");
    } catch (deleteError) {
      await load();
      setError(humanizeDocumentError(deleteError));
    } finally { setBusyId(""); }
  }

  async function replaceDocument(document: ForeignTradeDocument, replacement: File | null) {
    if (!replacement) return;
    const confirmedWarning = document.parse_status === "confirmed"
      ? " Los datos derivados del original anterior se retirarán y el archivo nuevo deberá revisarse nuevamente."
      : "";
    if (!window.confirm(`¿Reemplazar ${document.original_file_name} por ${replacement.name}?${confirmedWarning} El original anterior se eliminará cuando el nuevo quede guardado.`)) return;
    extractionControllers.current.get(document.id)?.abort();
    setBusyId(`replace:${document.id}`); setError(""); setMessage("Guardando el archivo de reemplazo...");
    let replacementId = "";
    try {
      if (["queued", "extracting"].includes(document.parse_status) || extractingIds.has(document.id)) {
        await cancelForeignTradeDocumentExtraction(document.id);
      }
      replacementId = await uploadForeignTradeDocument({
        operationId,
        supplierId: document.supplier_id || supplierId,
        documentType: document.document_type,
        file: replacement,
      });
      await deleteForeignTradeDocument(document.id, document.parse_status === "confirmed");
      await load();
      if (extractableDocumentTypes.has(document.document_type)) {
        setMessage("Archivo reemplazado. Analizando el nuevo original...");
        await runExtraction(replacementId);
        await load();
        setMessage("Archivo reemplazado y extracción lista para revisión.");
      } else {
        setMessage("Archivo reemplazado correctamente.");
      }
    } catch (replaceError) {
      await load();
      if (!isAbortError(replaceError)) {
        const prefix = replacementId ? "El nuevo original quedó guardado. " : "";
        setError(prefix + humanizeDocumentError(replaceError));
      }
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

  async function downloadDocumentSection(document: ForeignTradeDocument) {
    setBusyId(`section:${document.id}`); setError(""); setMessage("");
    try {
      const result = await downloadForeignTradeDocumentSection(document.id);
      const url = URL.createObjectURL(result.blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      await load();
      setMessage(`${documentTypeLabel(document.document_type)} descargado: página${result.pages.length === 1 ? "" : "s"} ${formatPageNumbers(result.pages)}.`);
    } catch (downloadError) {
      setError(humanizeDocumentError(downloadError));
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
          <strong>{pendingFiles.length ? `${pendingFiles.length} documento(s) seleccionado(s)` : "Selecciona uno o dos documentos"}</strong>
          <span>PDF, XLS, XLSX o CSV · máximo 25 MB por archivo</span>
          <input multiple disabled={Boolean(busyId)} type="file" accept=".pdf,.xls,.xlsx,.csv,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = ""; }} />
        </label>
        {pendingFiles.length ? <div className="foreign-trade-pending-documents">{pendingFiles.map((pending) => <article key={pending.key}>
          <div><FileText size={17} /><span><strong>{pending.file.name}</strong><small>{formatFileSize(pending.file.size)}</small></span></div>
          <label><span>Tipo</span><select value={pending.documentType} disabled={Boolean(busyId)} onChange={(event) => updatePendingType(pending.key, event.target.value as ForeignTradeDocumentType)}>{documentTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <button className="icon-button danger" type="button" title="Quitar de la carga" disabled={Boolean(busyId)} onClick={() => removePendingFile(pending.key)}><X size={15} /></button>
        </article>)}</div> : null}
        <div className="foreign-trade-upload-actions">
          <label><span>Tipo predeterminado</span><select value={documentType} disabled={Boolean(busyId)} onChange={(event) => { const nextType = event.target.value as ForeignTradeDocumentType; setDocumentType(nextType); setPendingFiles((current) => current.map((item) => ({ ...item, documentType: nextType }))); }}>{documentTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <div className="foreign-trade-upload-action-buttons">
            {busyId === "upload" ? <button className="ghost-button danger" type="button" onClick={() => void stopUpload()}><CircleStop size={17} /> Detener carga</button> : null}
            <button className="primary-button" type="submit" disabled={!pendingFiles.length || Boolean(busyId)}>{busyId === "upload" ? <LoaderCircle className="spin" size={17} /> : pendingFiles.some((item) => extractableDocumentTypes.has(item.documentType)) ? <ScanText size={17} /> : <FileUp size={17} />} {busyId === "upload" ? "Procesando..." : pendingFiles.some((item) => extractableDocumentTypes.has(item.documentType)) ? "Guardar y procesar" : "Guardar originales"}</button>
          </div>
        </div>
        <p className="foreign-trade-document-type-help">Si un PDF contiene varios documentos, selecciona <strong>Commercial invoice</strong>, <strong>Packing list</strong> o <strong>Bill of lading</strong>: el lector aislará solo sus páginas y habilitará la descarga de esa sección. Usa <strong>Factura / cotización de transporte</strong> para fletes y <strong>Rendición final de agencia</strong> para paquetes de facturas aduaneras.</p>
        {message ? <div className="notice-banner success"><CheckCircle2 size={17} /> {message}</div> : null}
        {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
      </form>

      <section className="panel foreign-trade-document-list">
        <div className="foreign-trade-detail-panel-heading"><div><h2>Documentos de la operación</h2><p>Trazabilidad del original, extracción y confirmación.</p></div><button className="icon-button" type="button" title="Actualizar documentos" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={17} /></button></div>
        {loading && !documents.length ? <div className="foreign-trade-loading compact"><LoaderCircle className="spin" size={22} /><span>Cargando documentos...</span></div> : null}
        {!loading && !documents.length ? <div className="empty-state"><FileText size={27} /><strong>Sin documentos</strong><span>Carga la primera proforma para iniciar la revisión asistida.</span></div> : null}
        <div className="foreign-trade-document-items">
          {documents.map((document) => {
            const isExtracting = ["queued", "extracting"].includes(document.parse_status) || extractingIds.has(document.id);
            const sectionScope = getDocumentScope(document);
            const replacing = busyId === `replace:${document.id}`;
            const deleting = busyId === `delete:${document.id}`;
            const cancelling = busyId === `cancel:${document.id}`;
            return <article key={document.id}>
              <div className="foreign-trade-document-icon">{document.mime_type === "application/pdf" ? <FileText /> : <FileSpreadsheet />}</div>
              <div className="foreign-trade-document-info">
                <strong>{document.original_file_name}</strong>
                <span>{documentTypeLabel(document.document_type)} · {formatFileSize(document.file_size)} · {formatDateTime(document.created_at)}</span>
                {sectionScope?.detected ? <small className="foreign-trade-document-scope">Sección: {formatPageNumbers(sectionScope.page_numbers)} de {sectionScope.total_pdf_pages || "?"} página(s)</small> : null}
                {document.parse_status !== "confirmed" ? <label className="foreign-trade-document-type-editor"><span>Clasificación</span><select value={document.document_type} disabled={busyId === `type:${document.id}` || replacing || deleting || cancelling} onChange={(event) => void reclassify(document, event.target.value as ForeignTradeDocumentType)}>{documentTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label> : null}
                {document.extraction_error ? <small>{document.extraction_error}</small> : null}
              </div>
              <DocumentStatus document={isExtracting ? { ...document, parse_status: "extracting" } : document} />
              <div className="foreign-trade-row-actions">
                <button className="icon-button" type="button" title="Abrir original privado" disabled={busyId === `download:${document.id}`} onClick={() => void downloadDocument(document)}>{busyId === `download:${document.id}` ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}</button>
                {document.mime_type === "application/pdf" && sectionAwareDocumentTypes.has(document.document_type) ? <button className="ghost-button" type="button" title={sectionScope?.detected ? `Descargar solo ${documentTypeLabel(document.document_type)}` : `Detectar y descargar solo ${documentTypeLabel(document.document_type)}`} disabled={busyId === `section:${document.id}`} onClick={() => void downloadDocumentSection(document)}>{busyId === `section:${document.id}` ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} {sectionScope?.detected ? "Sección" : "Detectar sección"}</button> : null}
                <label className={`ghost-button foreign-trade-replace-file ${replacing ? "disabled" : ""}`} title={document.parse_status === "confirmed" ? "Cambiar el original y retirar sus datos derivados" : "Cambiar el archivo conservando su clasificación"}><FileUp size={16} /> {replacing ? "Cambiando..." : "Cambiar"}<input disabled={replacing || deleting} type="file" accept=".pdf,.xls,.xlsx,.csv,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => { const replacement = event.target.files?.[0] || null; event.currentTarget.value = ""; void replaceDocument(document, replacement); }} /></label>
                {document.parse_status === "review_required" ? <button className="ghost-button" type="button" onClick={() => setReviewDocument(document)}><Eye size={16} /> Revisar</button> : null}
                {document.parse_status === "confirmed" && productExtractableDocumentTypes.has(document.document_type) ? <button className="ghost-button" type="button" onClick={() => setReviewDocument(document)}><Link2 size={16} /> Conciliar productos</button> : null}
                {!isExtracting && document.parse_status === "uploaded" && extractableDocumentTypes.has(document.document_type) ? <button className="ghost-button" type="button" disabled={busyId === document.id} onClick={() => void retry(document, true)}>{busyId === document.id ? <LoaderCircle className="spin" size={16} /> : <ScanText size={16} />} Analizar</button> : null}
                {!isExtracting && document.parse_status === "review_required" && extractableDocumentTypes.has(document.document_type) ? <button className="ghost-button" type="button" disabled={busyId === document.id} onClick={() => void retry(document, true)}>{busyId === document.id ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Regenerar</button> : null}
                {isExtracting ? <button className="ghost-button danger" type="button" disabled={cancelling} onClick={() => void stopExtraction(document)}>{cancelling ? <LoaderCircle className="spin" size={16} /> : <CircleStop size={16} />} Detener</button> : null}
                {!isExtracting && document.parse_status === "failed" && extractableDocumentTypes.has(document.document_type) ? <button className="ghost-button" type="button" disabled={busyId === document.id} onClick={() => void retry(document)}>{busyId === document.id ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Reintentar</button> : null}
                <button className="icon-button danger" type="button" title={document.parse_status === "confirmed" ? "Eliminar documento y retirar datos derivados" : "Eliminar documento"} disabled={deleting || replacing} onClick={() => void removeDocument(document)}>{deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}</button>
              </div>
            </article>;
          })}
        </div>
      </section>

      {reviewDocument ? reviewDocument.document_type === "fund_request"
        ? <FundRequestReviewDialog document={reviewDocument} onClose={() => setReviewDocument(null)} onRegenerate={async () => { const staleDocument = reviewDocument; setReviewDocument(null); await retry(staleDocument, true); }} onConfirmed={async (resultMessage) => { setReviewDocument(null); await load(); await onChanged(resultMessage); }} />
        : reviewDocument.document_type === "agency_settlement"
          ? <AgencySettlementReviewDialog document={reviewDocument} onClose={() => setReviewDocument(null)} onRegenerate={async () => { const staleDocument = reviewDocument; setReviewDocument(null); await retry(staleDocument, true); }} onConfirmed={async (resultMessage) => { setReviewDocument(null); await load(); await onChanged(resultMessage); }} />
          : reviewDocument.document_type === "freight_quote"
            ? <FreightDocumentReviewDialog document={reviewDocument} onClose={() => setReviewDocument(null)} onRegenerate={async () => { const staleDocument = reviewDocument; setReviewDocument(null); await retry(staleDocument, true); }} onConfirmed={async (resultMessage) => { setReviewDocument(null); await load(); await onChanged(resultMessage); }} />
            : supportingExtractableDocumentTypes.has(reviewDocument.document_type)
              ? <SupportingDocumentReviewDialog document={reviewDocument} onClose={() => setReviewDocument(null)} onRegenerate={async () => { const staleDocument = reviewDocument; setReviewDocument(null); await retry(staleDocument, true); }} onDownload={() => downloadDocumentSection(reviewDocument)} />
            : <DocumentReviewDialog document={reviewDocument} suppliers={suppliers} onClose={() => setReviewDocument(null)} onRegenerate={async () => { const staleDocument = reviewDocument; setReviewDocument(null); await retry(staleDocument, true); }} onConfirmed={async (resultMessage) => { setReviewDocument(null); await load(); await onChanged(resultMessage); }} />
        : null}
    </section>
  );
}

function SupportingDocumentReviewDialog({
  document,
  onClose,
  onRegenerate,
  onDownload,
}: {
  document: ForeignTradeDocument;
  onClose: () => void;
  onRegenerate: () => Promise<void>;
  onDownload: () => Promise<void>;
}) {
  const review = structuredClone(document.extraction_result) as ForeignTradeDocumentExtraction;
  const scope = getDocumentScope(document);
  const general = review.general || {} as ForeignTradeDocumentExtraction["general"];
  const [busy, setBusy] = useState<"regenerate" | "download" | "">("");
  const [error, setError] = useState("");

  async function run(action: "regenerate" | "download", callback: () => Promise<void>) {
    setBusy(action); setError("");
    try { await callback(); }
    catch (actionError) { setError(humanizeDocumentError(actionError)); }
    finally { setBusy(""); }
  }

  return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog compact" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-supporting-review-title">
    <header className="foreign-trade-dialog-heading"><div><span>Sección documental protegida</span><h2 id="foreign-trade-supporting-review-title">Revisar {documentTypeLabel(document.document_type)}</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
    {scope?.detected ? <section className="foreign-trade-section-detection success"><CheckCircle2 size={19} /><div><strong>Sección identificada</strong><span>Página{scope.page_numbers.length === 1 ? "" : "s"} {formatPageNumbers(scope.page_numbers)} de {scope.total_pdf_pages || "?"}. La descarga contendrá únicamente estas páginas.</span></div></section> : <section className="foreign-trade-section-detection warning"><AlertTriangle size={19} /><div><strong>No se identificaron páginas confiables</strong><span>Regenera el análisis con la clasificación correcta antes de descargar la sección.</span></div></section>}
    <section className="foreign-trade-review-section"><div><h3>Datos reconocidos</h3><span>Solo se muestran antecedentes encontrados dentro del B/L.</span></div><div className="foreign-trade-form-grid foreign-trade-readonly-grid">
      <ReadOnlyReviewField label="Referencia documental" value={general.proforma_number || general.order_number} />
      <ReadOnlyReviewField label="Fecha" value={general.document_date} />
      <ReadOnlyReviewField label="Proveedor / emisor" value={general.supplier_name} />
      <ReadOnlyReviewField label="Puerto de origen" value={general.origin_port} />
      <ReadOnlyReviewField label="Puerto de destino" value={general.destination_port} />
      <ReadOnlyReviewField label="Incoterm" value={general.incoterm} />
      <ReadOnlyReviewField label="Observaciones" value={general.observations} wide />
    </div></section>
    {scope?.evidence.length ? <section className="foreign-trade-review-section"><div><h3>Evidencia de clasificación</h3><span>{scope.evidence.join(" · ")}</span></div></section> : null}
    {document.review_warnings.length ? <section className="foreign-trade-review-warnings"><strong><AlertTriangle size={16} /> Datos que requieren atención</strong>{document.review_warnings.map((warning, index) => <p key={`${warning.code}-${index}`} className={warning.severity}>{warning.message}</p>)}</section> : null}
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cerrar</button><button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void run("regenerate", onRegenerate)}>{busy === "regenerate" ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />} Regenerar</button><button className="primary-button" type="button" disabled={Boolean(busy) || !scope?.detected} onClick={() => void run("download", onDownload)}>{busy === "download" ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />} Descargar sección</button></footer>
  </div></div>;
}

function DocumentReviewDialog({ document, suppliers, onClose, onRegenerate, onConfirmed }: { document: ForeignTradeDocument; suppliers: ForeignTradeSupplier[]; onClose: () => void; onRegenerate: () => Promise<void>; onConfirmed: (message: string) => Promise<void> }) {
  const [review, setReview] = useState<ForeignTradeDocumentExtraction>(() => structuredClone(document.extraction_result) as ForeignTradeDocumentExtraction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalog, setCatalog] = useState<ForeignTradeCatalogProduct[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [reconciliation, setReconciliation] = useState<ForeignTradeProductReconciliationResult | null>(null);
  const [reconciliationBusy, setReconciliationBusy] = useState(true);
  const [reconciliationError, setReconciliationError] = useState("");

  useEffect(() => {
    let active = true;
    setReconciliationBusy(true);
    setReconciliationError("");
    void reconcileForeignTradeDocument(document.id, review.general.supplier_id)
      .then((result) => {
        if (!active) return;
        setReconciliation(result);
        const bySourceIndex = new Map(result.lines.map((item) => [item.source_index, item]));
        setReview((current) => ({
          ...current,
          lines: current.lines.map((line) => {
            const match = bySourceIndex.get(line.source_index);
            if (!match?.selected_product_id || line.content_product_id) return line;
            const candidate = match.candidates.find((item) => item.product_id === match.selected_product_id);
            return {
              ...line,
              content_product_id: match.selected_product_id,
              sku: candidate?.sku || line.sku,
            };
          }),
        }));
      })
      .catch((matchError) => {
        if (!active) return;
        setReconciliationError(humanizeDocumentError(matchError));
      })
      .finally(() => { if (active) setReconciliationBusy(false); });
    return () => { active = false; };
  }, [document.id, review.general.supplier_id]);

  function setGeneral(key: keyof ForeignTradeDocumentExtraction["general"], value: string | number | null) {
    setReview((current) => ({ ...current, general: { ...current.general, [key]: value } }));
  }
  function setDocumentTotal(key: keyof ForeignTradeDocumentExtraction["document_totals"], value: number | null) {
    setReview((current) => ({ ...current, document_totals: { ...current.document_totals, [key]: value } }));
  }
  function setLine(index: number, patch: Partial<ForeignTradeExtractedLine>) {
    setReview((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? withDerivedCbm(line, patch) : line),
    }));
  }
  async function searchCatalog() {
    setCatalogBusy(true);
    try { setCatalog(await searchForeignTradeCatalog(catalogSearch)); }
    catch (searchError) { setError(searchError instanceof Error ? searchError.message : "No se pudo buscar el catálogo."); }
    finally { setCatalogBusy(false); }
  }
  async function confirm() {
    const reconciliationOnly = document.parse_status === "confirmed";
    const reviewCopy = productDocumentReviewCopy(document.document_type);
    if (!window.confirm(reconciliationOnly
      ? "¿Guardar estas equivalencias de productos? No se duplicarán las líneas ya importadas ni se modificará el catálogo maestro."
      : `¿Confirmar esta revisión de ${reviewCopy.label} e importar las líneas seleccionadas? Tu revisión manual se considerará definitiva aunque la extracción tenga advertencias. El archivo original y la sección extraída se conservarán.`)) return;
    setBusy(true); setError("");
    try {
      const documentCurrency = normalizeCurrencyCode(review.general.currency, "USD");
      const normalizedReview = {
        ...review,
        general: {
          ...review.general,
          currency: documentCurrency,
        },
        lines: review.lines.map((line) => ({
          ...withDerivedCbm(line, {}),
          currency: normalizeCurrencyCode(line.currency, documentCurrency),
        })),
        document_totals: {
          ...review.document_totals,
          line_count: review.document_totals.line_count || review.lines.length,
        },
      };
      const result = await confirmForeignTradeDocument(document.id, normalizedReview);
      await onConfirmed(reconciliationOnly
        ? `${result.reconciliation_confirmed || 0} equivalencia(s) guardada(s); no se duplicaron productos ni líneas.`
        : `${result.inserted_lines} producto(s) importados desde la revisión confirmada.`);
    } catch (confirmError) { setError(humanizeDocumentError(confirmError)); }
    finally { setBusy(false); }
  }

  const general = review.general;
  const reviewCopy = productDocumentReviewCopy(document.document_type);
  const documentScope = getDocumentScope(document);
  const lineCbmTotal = review.lines.reduce((sum, line) => sum + (line.cbm_total || 0), 0);
  const expectedLineCount = review.document_totals.line_count;
  const incompleteCoverage = Boolean(expectedLineCount && review.lines.length / expectedLineCount < 0.8);
  const needsRegeneration = review.extraction_version !== currentExtractionVersion || incompleteCoverage;
  const reconciliationBySourceIndex = new Map((reconciliation?.lines || []).map((item) => [item.source_index, item]));
  return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-review-title">
    <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-review-title">Revisar {reviewCopy.label}</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
    <div className="foreign-trade-review-summary"><ConfidenceBadge value={document.extraction_confidence} /><span>{review.lines.length} líneas detectadas</span><span>{document.review_warnings.length} advertencias</span></div>
    {documentScope?.detected ? <section className="foreign-trade-section-detection success"><CheckCircle2 size={19} /><div><strong>{reviewCopy.label} aislado correctamente</strong><span>Página{documentScope.page_numbers.length === 1 ? "" : "s"} {formatPageNumbers(documentScope.page_numbers)} de {documentScope.total_pdf_pages || "?"}; las demás secciones del PDF fueron excluidas.</span></div></section> : null}
    {needsRegeneration ? <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>Extracción desactualizada o incompleta.</strong> Puedes regenerarla para intentar recuperar más datos o confirmar tu revisión manual e importarla tal como está.</span></div> : null}
    {document.review_warnings.length ? <section className="foreign-trade-review-warnings"><strong><AlertTriangle size={16} /> Datos que requieren atención</strong>{document.review_warnings.map((warning, index) => <p key={`${warning.code}-${index}`} className={warning.severity}>{warning.message}</p>)}</section> : null}

    <section className="foreign-trade-review-section"><div><h3>Datos generales</h3><span>Extraído del documento · editable antes de confirmar</span></div><div className="foreign-trade-form-grid">
      <label><span>Proveedor CRM</span><select value={general.supplier_id || ""} onChange={(event) => setGeneral("supplier_id", event.target.value || null)}><option value="">Sin vincular</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
      <ReviewField label="Proveedor reconocido" value={general.supplier_name} onChange={(value) => setGeneral("supplier_name", value)} />
      <ReviewField label={reviewCopy.numberLabel} value={general.proforma_number} onChange={(value) => setGeneral("proforma_number", value)} />
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

    <section className="foreign-trade-review-section"><div><h3>Totales del documento</h3><span>Contrasta estos valores con el pie de {reviewCopy.article} antes de confirmar.</span></div><div className="foreign-trade-form-grid">
      <ReviewLineNumber label="Total mercadería" value={review.document_totals.total} onChange={(value) => setDocumentTotal("total", value)} />
      <ReviewLineNumber label="Total cajas" value={review.document_totals.boxes} onChange={(value) => setDocumentTotal("boxes", value)} />
      <ReviewLineNumber label="Peso bruto total kg" value={review.document_totals.gross_weight_kg} onChange={(value) => setDocumentTotal("gross_weight_kg", value)} />
      <ReviewLineNumber label="Peso neto total kg" value={review.document_totals.net_weight_kg} onChange={(value) => setDocumentTotal("net_weight_kg", value)} />
      <ReviewLineNumber label="CBM total documento" value={review.document_totals.cbm_total} onChange={(value) => setDocumentTotal("cbm_total", value)} />
      <ReviewLineNumber label="Filas comerciales esperadas" value={expectedLineCount} onChange={(value) => setDocumentTotal("line_count", value)} />
    </div><p className="foreign-trade-recalculation">Cobertura: <strong>{review.lines.length}{expectedLineCount ? ` de ${expectedLineCount}` : " filas"}</strong> · Suma CBM de productos: <strong>{formatNumber(lineCbmTotal)} m³</strong>{review.document_totals.cbm_total !== null && Math.abs(lineCbmTotal - review.document_totals.cbm_total) > Math.max(0.01, review.document_totals.cbm_total * 0.02) ? " · revisa la diferencia con el total documental" : ""}</p></section>

    <section className="foreign-trade-review-section"><div className="foreign-trade-review-products-heading"><div><h3>Conciliación de productos</h3><span>El catálogo maestro permanece protegido; aquí solo se confirma una equivalencia por proveedor.</span></div><div><input value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="Buscar catálogo para vincular" /><button className="ghost-button" type="button" onClick={() => void searchCatalog()}>{catalogBusy ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />} Buscar</button></div></div>
      <div className="foreign-trade-match-summary">
        {reconciliationBusy ? <span><LoaderCircle className="spin" size={14} /> Comparando con el catálogo...</span> : null}
        {reconciliation ? <><span className="success">{reconciliation.summary.auto_matched || 0} encontrados automáticamente</span><span>{reconciliation.summary.suggested || 0} sugeridos</span><span className="warning">{reconciliation.summary.review || 0} requieren confirmación</span><span className="warning">{reconciliation.summary.unmatched || 0} sin coincidencia</span></> : null}
      </div>
      {reconciliationError ? <div className="notice-banner error"><AlertTriangle size={16} /> {reconciliationError}</div> : null}
      <div className="foreign-trade-review-lines">{review.lines.map((line, index) => <ReviewLineCard key={`${line.source_index}-${index}`} line={line} reconciliation={reconciliationBySourceIndex.get(line.source_index) || null} catalog={catalog} onChange={(patch) => setLine(index, patch)} onForgetMapping={async (mappingId) => {
        if (!window.confirm("¿Olvidar esta equivalencia aprendida? Los documentos futuros volverán a requerir conciliación.")) return;
        setBusy(true); setError("");
        try {
          await deleteForeignTradeProductSupplierMapping(mappingId);
          setReconciliation(await reconcileForeignTradeDocument(document.id, review.general.supplier_id));
        } catch (mappingError) { setError(humanizeDocumentError(mappingError)); }
        finally { setBusy(false); }
      }} />)}</div>
    </section>
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button>{document.parse_status !== "confirmed" ? <button className="ghost-button" type="button" disabled={busy} onClick={() => void onRegenerate()}><RefreshCw size={17} /> Regenerar extracción</button> : null}<button className="primary-button" type="button" disabled={busy || !review.lines.some((line) => line.include)} title={needsRegeneration ? "Confirmar la revisión manual e importar pese a las advertencias" : undefined} onClick={() => void confirm()}><ShieldCheck size={17} /> {busy ? "Confirmando..." : document.parse_status === "confirmed" ? "Guardar conciliación" : "Confirmar e importar"}</button></footer>
  </div></div>;
}

const reconciliationLineTypeOptions: Array<{ value: ForeignTradeReconciliationLineType; label: string }> = [
  { value: "operating_expense", label: "Gasto operacional" },
  { value: "agency_fee", label: "Honorario de agencia" },
  { value: "customs_duty", label: "Derecho aduanero" },
  { value: "import_vat", label: "IVA importación" },
  { value: "adjustment", label: "Ajuste" },
];
const reconciliationCategoryOptions: Array<{ value: Exclude<ForeignTradeCostCategory, "merchandise">; label: string }> = [
  { value: "origin", label: "Gastos en origen" },
  { value: "international_freight", label: "Flete internacional" },
  { value: "insurance", label: "Seguro" },
  { value: "chile_port", label: "Puerto / terminal Chile" },
  { value: "storage", label: "Almacenaje" },
  { value: "customs_agency", label: "Agencia de aduana" },
  { value: "national_transport", label: "Transporte nacional" },
  { value: "inspection", label: "Inspección" },
  { value: "certificate", label: "Certificados" },
  { value: "duties", label: "Derechos aduaneros" },
  { value: "taxes", label: "Impuestos" },
  { value: "supplier_charge", label: "Cargo de proveedor" },
  { value: "other", label: "Otro" },
];
const freightCategoryOptions = reconciliationCategoryOptions.filter((item) => !["duties", "taxes"].includes(item.value));

function FreightDocumentReviewDialog({ document, onClose, onRegenerate, onConfirmed }: { document: ForeignTradeDocument; onClose: () => void; onRegenerate: () => Promise<void>; onConfirmed: (message: string) => Promise<void> }) {
  const [initialReview] = useState(() => normalizeForeignTradeFreightDocumentReview(document.extraction_result));
  const [review, setReview] = useState<ForeignTradeFreightDocumentExtraction>(initialReview.review);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const documentWarnings = Array.isArray(document.review_warnings) ? document.review_warnings : [];

  if (!initialReview.isCompatible) {
    return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-freight-review-title">
      <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-freight-review-title">Revisar transporte internacional</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
      <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>Este archivo todavía no tiene una extracción logística compatible.</strong> Regenera el análisis para reconocer transportista, ruta, factura, moneda, tipo de cambio y cargos de flete.</span></div>
      {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
      <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cerrar</button><button className="primary-button" type="button" disabled={busy} onClick={() => { setBusy(true); setError(""); void onRegenerate().catch((regenerateError) => { setBusy(false); setError(humanizeDocumentError(regenerateError)); }); }}><RefreshCw className={busy ? "spin" : ""} size={17} /> {busy ? "Regenerando..." : "Regenerar extracción"}</button></footer>
    </div></div>;
  }

  function setGeneral(key: keyof ForeignTradeFreightDocumentExtraction["general"], value: string | number | null) {
    setReview((current) => ({ ...current, general: { ...current.general, [key]: value } }));
  }
  function setLine(index: number, patch: Partial<ForeignTradeFreightDocumentLine>) {
    setReview((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? normalizeFreightDocumentLine({ ...line, ...patch }, patch) : line),
    }));
  }

  const selectedLines = review.lines.filter((line) => line.include && line.include_in_costing);
  const calculatedNet = roundMoney(selectedLines.reduce((sum, line) => sum + (line.net_clp || 0), 0));
  const calculatedVat = roundMoney(selectedLines.reduce((sum, line) => sum + (line.vat_clp || 0), 0));
  const calculatedTotal = roundMoney(selectedLines.reduce((sum, line) => sum + (line.total_clp || 0), 0));
  const needsRegeneration = review.extraction_version !== currentFreightDocumentExtractionVersion;

  async function confirm() {
    if (!window.confirm("¿Confirmar este transporte e incorporarlo al costeo? Se creará o vinculará un costo real con trazabilidad al documento y se recalcularán los precios.")) return;
    setBusy(true); setError("");
    try {
      const normalizedLines = review.lines.map((line) => normalizeFreightDocumentLine({
        ...line,
        currency: normalizeCurrencyCode(line.currency, "CLP"),
      }, {}));
      const normalizedReview: ForeignTradeFreightDocumentExtraction = {
        ...review,
        extraction_version: currentFreightDocumentExtractionVersion,
        document_kind: "freight_document",
        general: { ...review.general, currency: normalizeCurrencyCode(review.general.currency, "CLP") },
        lines: normalizedLines,
        totals: {
          net_clp: calculatedNet,
          vat_clp: calculatedVat,
          document_total_clp: review.totals.document_total_clp ?? calculatedTotal,
          line_count: normalizedLines.length,
        },
      };
      const result = await confirmForeignTradeFreightDocument(document.id, normalizedReview);
      const reconciliation = await autoFinalizeForeignTradeOperation(document.operation_id);
      const duplicateText = result.linked_existing_costs
        ? ` ${result.linked_existing_costs} costo(s) ya existente(s) fueron vinculados sin duplicarlos.`
        : "";
      const reconciliationText = reconciliation.processed_reconciliations
        ? ` Se actualizaron ${reconciliation.processed_reconciliations} conciliación(es) de agencia.`
        : "";
      await onConfirmed(`${result.inserted_costs} costo(s) marítimo(s) incorporados por ${formatClp(result.total_cost_clp)}.${duplicateText}${reconciliationText} Costos base y Costeo y precio quedaron actualizados.`);
    } catch (confirmError) { setError(humanizeDocumentError(confirmError)); }
    finally { setBusy(false); }
  }

  return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-freight-review-title">
    <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-freight-review-title">Revisar transporte internacional</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
    <div className="foreign-trade-review-summary"><ConfidenceBadge value={document.extraction_confidence} /><span>{review.lines.length} cargo(s) detectado(s)</span><span>{documentWarnings.length} advertencias</span></div>
    {needsRegeneration ? <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>Extracción desactualizada.</strong> Regenera el análisis antes de confirmar.</span></div> : null}
    {documentWarnings.length ? <section className="foreign-trade-review-warnings"><strong><AlertTriangle size={16} /> Datos que requieren atención</strong>{documentWarnings.map((warning, index) => <p key={`${warning.code}-${index}`} className={warning.severity}>{warning.message}</p>)}</section> : null}

    <section className="foreign-trade-review-section"><div><h3>Identificación del transporte</h3><span>Comprueba documento, proveedor, ruta y B/L antes de costear.</span></div><div className="foreign-trade-form-grid">
      <ReviewField label="Referencia del embarque" value={review.general.reference} onChange={(value) => setGeneral("reference", value || null)} />
      <ReviewField label="Transportista / forwarder" value={review.general.carrier_name} onChange={(value) => setGeneral("carrier_name", value || null)} />
      <ReviewField label="N.º factura / cotización" value={review.general.document_number} onChange={(value) => setGeneral("document_number", value || null)} />
      <ReviewField label="Fecha" type="date" value={review.general.document_date} onChange={(value) => setGeneral("document_date", value || null)} />
      <ReviewField label="Moneda principal" value={review.general.currency} maxLength={3} onChange={(value) => setGeneral("currency", value.toUpperCase() || null)} />
      <ReviewLineNumber label="Total declarado CLP" value={review.general.declared_total_clp} onChange={(value) => setGeneral("declared_total_clp", value)} />
      <ReviewField label="Puerto de origen" value={review.general.origin_port} onChange={(value) => setGeneral("origin_port", value || null)} />
      <ReviewField label="Puerto de destino" value={review.general.destination_port} onChange={(value) => setGeneral("destination_port", value || null)} />
      <ReviewField label="Bill of lading (B/L)" value={review.general.bill_of_lading} onChange={(value) => setGeneral("bill_of_lading", value || null)} />
      <label className="wide-field"><span>Observaciones</span><textarea value={review.general.observations || ""} onChange={(event) => setGeneral("observations", event.target.value || null)} /></label>
    </div></section>

    <section className="foreign-trade-review-section"><div><h3>Control del costo</h3><span>El valor original y su conversión se conservan para auditoría.</span></div><div className="foreign-trade-form-grid">
      <ReviewLineReadonlyNumber label="Neto reconocido CLP" value={calculatedNet} />
      <ReviewLineReadonlyNumber label="IVA reconocido CLP" value={calculatedVat} />
      <ReviewLineReadonlyNumber label="Total reconocido CLP" value={calculatedTotal} />
      <ReviewLineReadonlyNumber label="Total documento CLP" value={review.totals.document_total_clp} />
    </div>{review.totals.document_total_clp !== null && Math.abs(calculatedTotal - review.totals.document_total_clp) > Math.max(1, review.totals.document_total_clp * 0.01) ? <p className="foreign-trade-recalculation">La suma difiere del total documental en <strong>{formatClp(Math.abs(calculatedTotal - review.totals.document_total_clp))}</strong>. Revisa cargos o subtotales antes de confirmar.</p> : null}</section>

    <section className="foreign-trade-review-section"><div><h3>Cargos logísticos reconocidos</h3><span>Desmarca cualquier subtotal duplicado. El sistema evita duplicar un costo real coincidente.</span></div><div className="foreign-trade-review-lines">{review.lines.map((line, index) => <FreightDocumentLineCard key={`${line.source_index}-${index}`} line={line} onChange={(patch) => setLine(index, patch)} />)}</div></section>
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="ghost-button" type="button" disabled={busy} onClick={() => void onRegenerate()}><RefreshCw size={17} /> Regenerar extracción</button><button className="primary-button" type="button" disabled={busy || needsRegeneration || !selectedLines.length} onClick={() => void confirm()}><ShieldCheck size={17} /> {busy ? "Costeando..." : "Confirmar e incorporar al costeo"}</button></footer>
  </div></div>;
}

function FreightDocumentLineCard({ line, onChange }: { line: ForeignTradeFreightDocumentLine; onChange: (patch: Partial<ForeignTradeFreightDocumentLine>) => void }) {
  return <article className={!line.include ? "excluded" : ""}>
    <header><label><input type="checkbox" checked={line.include} onChange={(event) => onChange({ include: event.target.checked })} /><span>Cargo {line.source_index}{line.source_page ? ` · pág. ${line.source_page}` : ""}</span></label><ConfidenceBadge value={line.confidence} /></header>
    <div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Concepto</span><input value={line.concept} onChange={(event) => onChange({ concept: event.target.value })} /></label>
      <label><span>Categoría</span><select value={line.cost_category} onChange={(event) => onChange({ cost_category: event.target.value as Exclude<ForeignTradeCostCategory, "merchandise"> })}>{freightCategoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <ReviewLineNumber label="Página" value={line.source_page} onChange={(value) => onChange({ source_page: value === null ? null : Math.max(1, Math.round(value)) })} />
      <ReviewLineField label="Proveedor" value={line.provider_name} onChange={(value) => onChange({ provider_name: value })} />
      <ReviewLineField label="N.º documento" value={line.document_number} onChange={(value) => onChange({ document_number: value })} />
      <ReviewLineField label="Fecha" value={line.document_date} onChange={(value) => onChange({ document_date: value })} />
      <ReviewLineNumber label="Neto CLP" value={line.net_clp} onChange={(value) => onChange({ net_clp: value })} />
      <ReviewLineNumber label="IVA CLP" value={line.vat_clp} onChange={(value) => onChange({ vat_clp: value })} />
      <ReviewLineNumber label="Total CLP" value={line.total_clp} onChange={(value) => onChange({ total_clp: value })} />
      <ReviewLineNumber label="Monto original" value={line.amount_original} onChange={(value) => onChange({ amount_original: value })} />
      <ReviewLineField label="Moneda original" value={line.currency} maxLength={3} onChange={(value) => onChange({ currency: (value || "").toUpperCase() })} />
      <ReviewLineNumber label="Tipo cambio a CLP" value={line.exchange_rate_clp} onChange={(value) => onChange({ exchange_rate_clp: value })} />
      <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={line.recoverable_tax} onChange={(event) => onChange({ recoverable_tax: event.target.checked })} /><span>IVA recuperable</span></label>
      <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={line.include_in_costing} onChange={(event) => onChange({ include_in_costing: event.target.checked })} /><span>Incluir en costeo</span></label>
    </div>
    {line.currency !== "CLP" && line.amount_original !== null && line.exchange_rate_clp === null && line.total_clp === null ? <div className="foreign-trade-line-warnings"><span><AlertTriangle size={13} /> Falta tipo de cambio o equivalente CLP.</span></div> : null}
    {line.warnings.length ? <div className="foreign-trade-line-warnings">{line.warnings.map((warning) => <span key={warning}><AlertTriangle size={13} /> {warning}</span>)}</div> : null}
  </article>;
}

function normalizeFreightDocumentLine(line: ForeignTradeFreightDocumentLine, patch: Partial<ForeignTradeFreightDocumentLine>): ForeignTradeFreightDocumentLine {
  const next = { ...line };
  next.currency = String(next.currency || "").trim().toUpperCase();
  if (next.currency === "CLP") next.exchange_rate_clp = 1;
  if (("net_clp" in patch || "vat_clp" in patch) && !("total_clp" in patch)) {
    next.total_clp = next.net_clp !== null || next.vat_clp !== null
      ? roundMoney((next.net_clp || 0) + (next.vat_clp || 0))
      : null;
  } else if (("amount_original" in patch || "exchange_rate_clp" in patch || "currency" in patch) && !("total_clp" in patch) && next.amount_original !== null && next.exchange_rate_clp !== null) {
    next.total_clp = roundMoney(next.amount_original * next.exchange_rate_clp);
    if (next.vat_clp === null || next.vat_clp === 0) next.net_clp = next.total_clp;
  }
  return next;
}

function FundRequestReviewDialog({ document, onClose, onRegenerate, onConfirmed }: { document: ForeignTradeDocument; onClose: () => void; onRegenerate: () => Promise<void>; onConfirmed: (message: string) => Promise<void> }) {
  const [initialReview] = useState(() => normalizeForeignTradeFundRequestReview(document.extraction_result));
  const [review, setReview] = useState<ForeignTradeFundRequestExtraction>(initialReview.review);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const documentWarnings = Array.isArray(document.review_warnings) ? document.review_warnings : [];

  if (!initialReview.isCompatible) {
    return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-fund-review-title">
      <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-fund-review-title">Revisar provisión de fondos</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
      <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>La extracción guardada pertenece a una versión anterior o quedó incompleta.</strong> El documento original está seguro. Regenera el análisis para obtener los gastos y tributos con el lector especializado de provisiones.</span></div>
      {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
      <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cerrar</button><button className="primary-button" type="button" disabled={busy} onClick={() => { setBusy(true); setError(""); void onRegenerate().catch((regenerateError) => { setBusy(false); setError(humanizeDocumentError(regenerateError)); }); }}><RefreshCw className={busy ? "spin" : ""} size={17} /> {busy ? "Regenerando..." : "Regenerar extracción"}</button></footer>
    </div></div>;
  }

  function setGeneral(key: keyof ForeignTradeFundRequestExtraction["general"], value: string | number | null) {
    setReview((current) => ({ ...current, general: { ...current.general, [key]: value } }));
  }
  function setLine(index: number, patch: Partial<ForeignTradeFundRequestLine>) {
    setReview((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? normalizeFundRequestLine({ ...line, ...patch }, patch) : line),
    }));
  }
  async function confirm() {
    if (!window.confirm("¿Confirmar esta provisión y crear una conciliación editable? Los gastos y tributos quedarán separados; todavía no se aplicarán al costeo oficial.")) return;
    setBusy(true); setError("");
    try {
      const normalizedLines = review.lines.map((line) => normalizeFundRequestLine({
        ...line,
        currency: normalizeCurrencyCode(line.currency, "CLP"),
      }, {}));
      const selectedLines = normalizedLines.filter((line) => line.include);
      const expenses = selectedLines.filter((line) => !["customs_duty", "import_vat"].includes(line.line_type)).reduce((sum, line) => sum + (line.provision_total_clp || 0), 0);
      const taxes = selectedLines.filter((line) => ["customs_duty", "import_vat"].includes(line.line_type)).reduce((sum, line) => sum + (line.provision_total_clp || 0), 0);
      const normalizedReview: ForeignTradeFundRequestExtraction = {
        ...review,
        extraction_version: review.extraction_version || currentFundRequestExtractionVersion,
        document_kind: "fund_request",
        general: {
          ...review.general,
          currency: normalizeCurrencyCode(review.general.currency, "CLP"),
        },
        lines: normalizedLines,
        totals: {
          expenses_clp: roundMoney(expenses),
          taxes_clp: roundMoney(taxes),
          document_total_clp: review.totals.document_total_clp ?? roundMoney(expenses + taxes),
          line_count: normalizedLines.length,
        },
      };
      const result = await confirmForeignTradeFundRequestDocument(document.id, normalizedReview);
      await onConfirmed(`${result.inserted_lines} concepto(s) importados a una nueva conciliación de agencia.`);
    } catch (confirmError) { setError(humanizeDocumentError(confirmError)); }
    finally { setBusy(false); }
  }

  const selectedLines = review.lines.filter((line) => line.include);
  const expenses = selectedLines.filter((line) => !["customs_duty", "import_vat"].includes(line.line_type)).reduce((sum, line) => sum + (line.provision_total_clp || 0), 0);
  const taxes = selectedLines.filter((line) => ["customs_duty", "import_vat"].includes(line.line_type)).reduce((sum, line) => sum + (line.provision_total_clp || 0), 0);
  const calculatedTotal = expenses + taxes;
  const needsRegeneration = review.extraction_version !== currentFundRequestExtractionVersion;

  return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-fund-review-title">
    <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-fund-review-title">Revisar provisión de fondos</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
    <div className="foreign-trade-review-summary"><ConfidenceBadge value={document.extraction_confidence} /><span>{review.lines.length} conceptos detectados</span><span>{documentWarnings.length} advertencias</span></div>
    {needsRegeneration ? <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>Extracción desactualizada.</strong> Regenera el análisis antes de confirmar para utilizar el lector especializado de provisiones.</span></div> : null}
    {documentWarnings.length ? <section className="foreign-trade-review-warnings"><strong><AlertTriangle size={16} /> Datos que requieren atención</strong>{documentWarnings.map((warning, index) => <p key={`${warning.code}-${index}`} className={warning.severity}>{warning.message}</p>)}</section> : null}

    <section className="foreign-trade-review-section"><div><h3>Identificación de la provisión</h3><span>Verifica la solicitud, agencia, fecha y monto antes de crear la conciliación.</span></div><div className="foreign-trade-form-grid">
      <ReviewField label="Referencia / solicitud" value={review.general.reference} onChange={(value) => setGeneral("reference", value || null)} />
      <ReviewField label="Agencia de aduanas" value={review.general.agency_name} onChange={(value) => setGeneral("agency_name", value || null)} />
      <ReviewField label="Fecha" type="date" value={review.general.document_date} onChange={(value) => setGeneral("document_date", value || null)} />
      <ReviewField label="Moneda principal" value={review.general.currency} maxLength={3} onChange={(value) => setGeneral("currency", value.toUpperCase() || null)} />
      <ReviewLineNumber label="Total declarado CLP" value={review.general.declared_total_clp} onChange={(value) => setGeneral("declared_total_clp", value)} />
      <ReviewLineNumber label="Monto solicitado / depositado CLP" value={review.general.remittance_amount_clp} onChange={(value) => setGeneral("remittance_amount_clp", value)} />
      <label className="wide-field"><span>Observaciones</span><textarea value={review.general.observations || ""} onChange={(event) => setGeneral("observations", event.target.value || null)} /></label>
    </div></section>

    <section className="foreign-trade-review-section"><div><h3>Control de totales</h3><span>Los tributos se muestran separados y no se confunden con gastos operacionales.</span></div><div className="foreign-trade-form-grid">
      <ReviewLineReadonlyNumber label="Gastos provisionados CLP" value={roundMoney(expenses)} />
      <ReviewLineReadonlyNumber label="Tributos provisionados CLP" value={roundMoney(taxes)} />
      <ReviewLineReadonlyNumber label="Suma de conceptos CLP" value={roundMoney(calculatedTotal)} />
      <ReviewLineReadonlyNumber label="Total del documento CLP" value={review.totals.document_total_clp} />
    </div>{review.totals.document_total_clp !== null && Math.abs(calculatedTotal - review.totals.document_total_clp) > Math.max(1, review.totals.document_total_clp * 0.01) ? <p className="foreign-trade-recalculation">La suma difiere del total documental en <strong>{formatClp(Math.abs(calculatedTotal - review.totals.document_total_clp))}</strong>. Revisa conceptos duplicados o faltantes.</p> : null}</section>

    <section className="foreign-trade-review-section"><div><h3>Gastos y tributos reconocidos</h3><span>Edita clasificación, moneda y conversión. Desmarca conceptos que no correspondan.</span></div><div className="foreign-trade-review-lines">{review.lines.map((line, index) => <FundRequestLineCard key={`${line.source_index}-${index}`} line={line} onChange={(patch) => setLine(index, patch)} />)}</div></section>
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="ghost-button" type="button" disabled={busy} onClick={() => void onRegenerate()}><RefreshCw size={17} /> Regenerar extracción</button><button className="primary-button" type="button" disabled={busy || needsRegeneration || !selectedLines.length} onClick={() => void confirm()}><ShieldCheck size={17} /> {busy ? "Confirmando..." : "Confirmar y crear conciliación"}</button></footer>
  </div></div>;
}

function AgencySettlementReviewDialog({ document, onClose, onRegenerate, onConfirmed }: { document: ForeignTradeDocument; onClose: () => void; onRegenerate: () => Promise<void>; onConfirmed: (message: string) => Promise<void> }) {
  const [initialReview] = useState(() => normalizeForeignTradeAgencySettlementReview(document.extraction_result));
  const [review, setReview] = useState<ForeignTradeAgencySettlementExtraction>(initialReview.review);
  const [reconciliations, setReconciliations] = useState<ForeignTradeExpenseReconciliation[]>([]);
  const [reconciliationId, setReconciliationId] = useState("");
  const [loadingReconciliations, setLoadingReconciliations] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const documentWarnings = Array.isArray(document.review_warnings) ? document.review_warnings : [];

  useEffect(() => {
    let active = true;
    void getForeignTradeExpenseReconciliations(document.operation_id)
      .then((items) => {
        if (!active) return;
        const editable = items.filter((item) => ["draft", "reviewed"].includes(item.status));
        setReconciliations(editable);
        const preferred = editable.find((item) => item.final_document_id === document.id)
          || editable.find((item) => item.provision_document_id)
          || editable[0];
        if (preferred) {
          setReconciliationId(preferred.id);
          setReview((current) => ({ ...current, lines: autoMatchSettlementLines(current.lines, preferred.lines) }));
        }
      })
      .catch((loadError) => setError(humanizeDocumentError(loadError)))
      .finally(() => { if (active) setLoadingReconciliations(false); });
    return () => { active = false; };
  }, [document.id, document.operation_id]);

  if (!initialReview.isCompatible) {
    return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-settlement-review-title">
      <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-settlement-review-title">Revisar rendición final</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
      <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>La extracción guardada no corresponde al lector de rendiciones finales.</strong> Regenera el documento para obtener facturas, monedas, tipos de cambio y costos reales.</span></div>
      {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
      <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cerrar</button><button className="primary-button" type="button" disabled={busy} onClick={() => { setBusy(true); setError(""); void onRegenerate().catch((regenerateError) => { setBusy(false); setError(humanizeDocumentError(regenerateError)); }); }}><RefreshCw className={busy ? "spin" : ""} size={17} /> {busy ? "Regenerando..." : "Regenerar extracción"}</button></footer>
    </div></div>;
  }

  const selectedReconciliation = reconciliations.find((item) => item.id === reconciliationId) || null;
  const selectedLines = review.lines.filter((line) => line.include);
  const expenses = selectedLines.filter((line) => !["customs_duty", "import_vat"].includes(line.line_type)).reduce((sum, line) => sum + (line.actual_total_clp || 0), 0);
  const taxes = selectedLines.filter((line) => ["customs_duty", "import_vat"].includes(line.line_type)).reduce((sum, line) => sum + (line.actual_total_clp || 0), 0);
  const calculatedTotal = roundMoney(expenses + taxes);
  const needsRegeneration = review.extraction_version !== currentAgencySettlementExtractionVersion;
  const referencesDiffer = Boolean(selectedReconciliation?.provision_reference && review.general.reference
    && normalizeReference(selectedReconciliation.provision_reference) !== normalizeReference(review.general.reference));

  function setGeneral(key: keyof ForeignTradeAgencySettlementExtraction["general"], value: string | number | null) {
    setReview((current) => ({ ...current, general: { ...current.general, [key]: value } }));
  }
  function setLine(index: number, patch: Partial<ForeignTradeAgencySettlementLine>) {
    setReview((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? normalizeAgencySettlementLine({ ...line, ...patch }, patch) : line),
    }));
  }
  function selectReconciliation(nextId: string) {
    setReconciliationId(nextId);
    const next = reconciliations.find((item) => item.id === nextId);
    if (next) setReview((current) => ({ ...current, identity_confirmed: false, lines: autoMatchSettlementLines(current.lines, next.lines) }));
  }
  async function confirm() {
    if (!reconciliationId) { setError("Selecciona la conciliación creada desde la provisión de fondos."); return; }
    if (referencesDiffer && !review.identity_confirmed) { setError("Las referencias no coinciden. Confirma manualmente que ambos documentos pertenecen al mismo despacho."); return; }
    if (!window.confirm("¿Confirmar, conciliar y aplicar estos costos reales? El sistema completará las referencias, calculará el saldo y actualizará el costeo automáticamente.")) return;
    setBusy(true); setError("");
    try {
      const normalizedLines = review.lines.map((line) => normalizeAgencySettlementLine({ ...line, currency: normalizeCurrencyCode(line.currency, "CLP") }, {}));
      const normalizedReview: ForeignTradeAgencySettlementExtraction = {
        ...review,
        extraction_version: review.extraction_version || currentAgencySettlementExtractionVersion,
        document_kind: "agency_settlement",
        general: { ...review.general, currency: normalizeCurrencyCode(review.general.currency, "CLP") },
        lines: normalizedLines,
        totals: {
          expenses_clp: roundMoney(expenses),
          taxes_clp: roundMoney(taxes),
          document_total_clp: review.totals.document_total_clp ?? calculatedTotal,
          line_count: normalizedLines.length,
        },
      };
      const result = await confirmForeignTradeAgencySettlementDocument(document.id, reconciliationId, normalizedReview);
      const automatic = await autoFinalizeForeignTradeExpenseReconciliation(reconciliationId);
      await onConfirmed(`${result.updated_lines} concepto(s) conciliados y ${result.inserted_lines} gasto(s) real(es) nuevos. ${automatic.applied_lines} costo(s) aplicados; saldo por devolver ${formatClp(automatic.refund_due_clp)}. Los precios quedaron recalculados.`);
    } catch (confirmError) { setError(humanizeDocumentError(confirmError)); }
    finally { setBusy(false); }
  }

  return <div className="foreign-trade-modal-backdrop" role="presentation"><div className="foreign-trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="foreign-trade-settlement-review-title">
    <header className="foreign-trade-dialog-heading"><div><span>Revisión humana obligatoria</span><h2 id="foreign-trade-settlement-review-title">Revisar rendición final de agencia</h2><p>{document.original_file_name}</p></div><button className="icon-button" type="button" title="Cerrar" onClick={onClose}><X size={18} /></button></header>
    <div className="foreign-trade-review-summary"><ConfidenceBadge value={document.extraction_confidence} /><span>{review.lines.length} costos reales detectados</span><span>{documentWarnings.length} advertencias</span></div>
    {needsRegeneration ? <div className="foreign-trade-stale-extraction"><AlertTriangle size={18} /><span><strong>Extracción desactualizada.</strong> Regenera el análisis antes de confirmar.</span></div> : null}
    {documentWarnings.length ? <section className="foreign-trade-review-warnings"><strong><AlertTriangle size={16} /> Datos que requieren atención</strong>{documentWarnings.map((warning, index) => <p key={`${warning.code}-${index}`} className={warning.severity}>{warning.message}</p>)}</section> : null}

    <section className="foreign-trade-review-section"><div><h3>Conciliación de destino</h3><span>La factura real se compara con una provisión ya confirmada.</span></div><div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Conciliación</span><select disabled={loadingReconciliations} value={reconciliationId} onChange={(event) => selectReconciliation(event.target.value)}><option value="">{loadingReconciliations ? "Cargando conciliaciones..." : "Selecciona una conciliación"}</option>{reconciliations.map((item) => <option key={item.id} value={item.id}>{item.title} · provisión {item.provision_reference || "sin referencia"} · {formatClp(item.remittance_amount_clp)}</option>)}</select></label>
      {!loadingReconciliations && !reconciliations.length ? <div className="notice-banner error wide-field"><AlertTriangle size={17} /> Primero confirma una provisión de fondos para crear la conciliación.</div> : null}
    </div></section>

    <section className="foreign-trade-review-section"><div><h3>Identificación de la rendición</h3><span>Verifica factura, referencia y fecha antes de cargar costos reales.</span></div><div className="foreign-trade-form-grid">
      <ReviewField label="Referencia del despacho" value={review.general.reference} onChange={(value) => setGeneral("reference", value || null)} />
      <ReviewField label="Agencia de aduanas" value={review.general.agency_name} onChange={(value) => setGeneral("agency_name", value || null)} />
      <ReviewField label="N.º factura principal" value={review.general.invoice_number} onChange={(value) => setGeneral("invoice_number", value || null)} />
      <ReviewField label="Fecha" type="date" value={review.general.document_date} onChange={(value) => setGeneral("document_date", value || null)} />
      <ReviewField label="Moneda principal" value={review.general.currency} maxLength={3} onChange={(value) => setGeneral("currency", value.toUpperCase() || null)} />
      <ReviewLineNumber label="Total declarado CLP" value={review.general.declared_total_clp} onChange={(value) => setGeneral("declared_total_clp", value)} />
      <label className="wide-field"><span>Observaciones</span><textarea value={review.general.observations || ""} onChange={(event) => setGeneral("observations", event.target.value || null)} /></label>
      {referencesDiffer ? <label className="foreign-trade-checkbox-field wide-field"><input type="checkbox" checked={review.identity_confirmed} onChange={(event) => setReview((current) => ({ ...current, identity_confirmed: event.target.checked }))} /><span>Confirmo que esta rendición corresponde a la provisión seleccionada aunque las referencias sean diferentes.</span></label> : null}
    </div></section>

    <section className="foreign-trade-review-section"><div><h3>Control de valores reales</h3><span>Los tributos se mantienen separados de los gastos operacionales.</span></div><div className="foreign-trade-form-grid">
      <ReviewLineReadonlyNumber label="Gastos reales CLP" value={roundMoney(expenses)} />
      <ReviewLineReadonlyNumber label="Tributos reales CLP" value={roundMoney(taxes)} />
      <ReviewLineReadonlyNumber label="Suma reconocida CLP" value={calculatedTotal} />
      <ReviewLineReadonlyNumber label="Total documento CLP" value={review.totals.document_total_clp} />
    </div>{review.totals.document_total_clp !== null && Math.abs(calculatedTotal - review.totals.document_total_clp) > Math.max(1, review.totals.document_total_clp * 0.01) ? <p className="foreign-trade-recalculation">La suma difiere del total documental en <strong>{formatClp(Math.abs(calculatedTotal - review.totals.document_total_clp))}</strong>. Revisa líneas faltantes, notas de crédito o subtotales duplicados.</p> : null}</section>

    <section className="foreign-trade-review-section"><div><h3>Costos reales reconocidos</h3><span>Relaciona cada costo con su provisión. Usa “Nuevo costo real” cuando no existía en la estimación.</span></div><div className="foreign-trade-review-lines">{review.lines.map((line, index) => <AgencySettlementLineCard key={`${line.source_index}-${index}`} line={line} provisionLines={selectedReconciliation?.lines || []} onChange={(patch) => setLine(index, patch)} />)}</div></section>
    {error ? <div className="notice-banner error"><AlertTriangle size={17} /> {error}</div> : null}
    <footer className="foreign-trade-dialog-actions"><button className="ghost-button" type="button" onClick={onClose}>Cancelar</button><button className="ghost-button" type="button" disabled={busy} onClick={() => void onRegenerate()}><RefreshCw size={17} /> Regenerar extracción</button><button className="primary-button" type="button" disabled={busy || needsRegeneration || !reconciliationId || !selectedLines.length} onClick={() => void confirm()}><ShieldCheck size={17} /> {busy ? "Conciliando y costeando..." : "Confirmar, conciliar y costear"}</button></footer>
  </div></div>;
}

function AgencySettlementLineCard({ line, provisionLines, onChange }: { line: ForeignTradeAgencySettlementLine; provisionLines: ForeignTradeExpenseReconciliation["lines"]; onChange: (patch: Partial<ForeignTradeAgencySettlementLine>) => void }) {
  return <article className={!line.include ? "excluded" : ""}>
    <header><label><input type="checkbox" checked={line.include} onChange={(event) => onChange({ include: event.target.checked })} /><span>Costo real {line.source_index}{line.source_page ? ` · pág. ${line.source_page}` : ""}</span></label><ConfidenceBadge value={line.confidence} /></header>
    <div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Relacionar con provisión</span><select value={line.reconciliation_line_id || ""} onChange={(event) => onChange({ reconciliation_line_id: event.target.value || null })}><option value="">Nuevo costo real sin provisión equivalente</option>{provisionLines.map((item) => <option key={item.id} value={item.id}>{item.concept} · {formatClp(item.provision_total_clp)}</option>)}</select></label>
      <label className="wide-field"><span>Concepto real</span><input value={line.concept} onChange={(event) => onChange({ concept: event.target.value })} /></label>
      <label><span>Tipo</span><select value={line.line_type} onChange={(event) => onChange({ line_type: event.target.value as ForeignTradeReconciliationLineType })}>{reconciliationLineTypeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>Categoría</span><select value={line.cost_category} onChange={(event) => onChange({ cost_category: event.target.value as ForeignTradeCostCategory })}>{reconciliationCategoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <ReviewLineNumber label="Página" value={line.source_page} onChange={(value) => onChange({ source_page: value === null ? null : Math.max(1, Math.round(value)) })} />
      <ReviewLineField label="Proveedor" value={line.provider_name} onChange={(value) => onChange({ provider_name: value })} />
      <ReviewLineField label="N.º documento" value={line.document_number} onChange={(value) => onChange({ document_number: value })} />
      <ReviewLineField label="Fecha respaldo" value={line.document_date} onChange={(value) => onChange({ document_date: value })} />
      <ReviewLineNumber label="Neto real CLP" value={line.actual_net_clp} onChange={(value) => onChange({ actual_net_clp: value })} />
      <ReviewLineNumber label="IVA real CLP" value={line.actual_vat_clp} onChange={(value) => onChange({ actual_vat_clp: value })} />
      <ReviewLineNumber label="Total real CLP" value={line.actual_total_clp} onChange={(value) => onChange({ actual_total_clp: value })} />
      <ReviewLineNumber label="Monto original" value={line.amount_original} onChange={(value) => onChange({ amount_original: value })} />
      <ReviewLineField label="Moneda original" value={line.currency} maxLength={3} onChange={(value) => onChange({ currency: (value || "").toUpperCase() })} />
      <ReviewLineNumber label="Tipo cambio a CLP" value={line.exchange_rate_clp} onChange={(value) => onChange({ exchange_rate_clp: value })} />
      <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={line.recoverable_tax} onChange={(event) => onChange({ recoverable_tax: event.target.checked })} /><span>Impuesto recuperable</span></label>
      <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={line.include_in_costing} onChange={(event) => onChange({ include_in_costing: event.target.checked })} /><span>Incluir en costeo</span></label>
    </div>
    {line.currency !== "CLP" && line.amount_original !== null && line.exchange_rate_clp === null && line.actual_total_clp === null ? <div className="foreign-trade-line-warnings"><span><AlertTriangle size={13} /> Falta tipo de cambio o equivalente CLP.</span></div> : null}
    {line.warnings.length ? <div className="foreign-trade-line-warnings">{line.warnings.map((warning) => <span key={warning}><AlertTriangle size={13} /> {warning}</span>)}</div> : null}
  </article>;
}

function normalizeAgencySettlementLine(line: ForeignTradeAgencySettlementLine, patch: Partial<ForeignTradeAgencySettlementLine>): ForeignTradeAgencySettlementLine {
  const next = { ...line };
  if ("line_type" in patch) {
    if (next.line_type === "customs_duty") { next.cost_category = "duties"; next.include_in_costing = true; }
    if (next.line_type === "import_vat") { next.cost_category = "taxes"; next.recoverable_tax = true; next.include_in_costing = false; }
    if (next.line_type === "agency_fee") next.cost_category = "customs_agency";
  }
  next.currency = String(next.currency || "").trim().toUpperCase();
  if (next.currency === "CLP") next.exchange_rate_clp = 1;
  if (("actual_net_clp" in patch || "actual_vat_clp" in patch) && !("actual_total_clp" in patch)) {
    next.actual_total_clp = next.actual_net_clp !== null || next.actual_vat_clp !== null
      ? roundMoney((next.actual_net_clp || 0) + (next.actual_vat_clp || 0))
      : null;
  } else if (("amount_original" in patch || "exchange_rate_clp" in patch || "currency" in patch) && !("actual_total_clp" in patch) && next.amount_original !== null && next.exchange_rate_clp !== null) {
    next.actual_total_clp = roundMoney(next.amount_original * next.exchange_rate_clp);
  }
  return next;
}

function autoMatchSettlementLines(lines: ForeignTradeAgencySettlementLine[], provisionLines: ForeignTradeExpenseReconciliation["lines"]) {
  const used = new Set<string>();
  return lines.map((line) => {
    if (line.reconciliation_line_id && provisionLines.some((candidate) => candidate.id === line.reconciliation_line_id) && !used.has(line.reconciliation_line_id)) {
      used.add(line.reconciliation_line_id);
      return line;
    }
    const available = provisionLines.filter((candidate) => !used.has(candidate.id));
    const concept = normalizeReference(line.concept);
    const documentNumber = normalizeReference(line.document_number || "");
    const match = available.find((candidate) => documentNumber && normalizeReference(candidate.document_number || "") === documentNumber)
      || available.find((candidate) => concept && normalizeReference(candidate.concept) === concept)
      || available.find((candidate) => candidate.line_type === line.line_type && candidate.cost_category === line.cost_category)
      || null;
    if (match) used.add(match.id);
    return { ...line, reconciliation_line_id: match?.id || null };
  });
}

function normalizeReference(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function FundRequestLineCard({ line, onChange }: { line: ForeignTradeFundRequestLine; onChange: (patch: Partial<ForeignTradeFundRequestLine>) => void }) {
  return <article className={!line.include ? "excluded" : ""}>
    <header><label><input type="checkbox" checked={line.include} onChange={(event) => onChange({ include: event.target.checked })} /><span>Concepto {line.source_index}{line.source_page ? ` · pág. ${line.source_page}` : ""}</span></label><ConfidenceBadge value={line.confidence} /></header>
    <div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Concepto</span><input value={line.concept} onChange={(event) => onChange({ concept: event.target.value })} /></label>
      <label><span>Tipo</span><select value={line.line_type} onChange={(event) => onChange({ line_type: event.target.value as ForeignTradeReconciliationLineType })}>{reconciliationLineTypeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>Categoría</span><select value={line.cost_category} onChange={(event) => onChange({ cost_category: event.target.value as ForeignTradeCostCategory })}>{reconciliationCategoryOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <ReviewLineNumber label="Página" value={line.source_page} onChange={(value) => onChange({ source_page: value === null ? null : Math.max(1, Math.round(value)) })} />
      <ReviewLineField label="Proveedor" value={line.provider_name} onChange={(value) => onChange({ provider_name: value })} />
      <ReviewLineField label="N.º documento" value={line.document_number} onChange={(value) => onChange({ document_number: value })} />
      <ReviewLineField label="Fecha respaldo" value={line.document_date} onChange={(value) => onChange({ document_date: value })} />
      <ReviewLineNumber label="Neto CLP" value={line.provision_net_clp} onChange={(value) => onChange({ provision_net_clp: value })} />
      <ReviewLineNumber label="IVA CLP" value={line.provision_vat_clp} onChange={(value) => onChange({ provision_vat_clp: value })} />
      <ReviewLineNumber label="Total CLP" value={line.provision_total_clp} onChange={(value) => onChange({ provision_total_clp: value })} />
      <ReviewLineNumber label="Monto original" value={line.amount_original} onChange={(value) => onChange({ amount_original: value })} />
      <ReviewLineField label="Moneda original" value={line.currency} maxLength={3} onChange={(value) => onChange({ currency: (value || "").toUpperCase() })} />
      <ReviewLineNumber label="Tipo cambio a CLP" value={line.exchange_rate_clp} onChange={(value) => onChange({ exchange_rate_clp: value })} />
      <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={line.recoverable_tax} onChange={(event) => onChange({ recoverable_tax: event.target.checked })} /><span>Impuesto recuperable</span></label>
      <label className="foreign-trade-checkbox-field"><input type="checkbox" checked={line.include_in_costing} onChange={(event) => onChange({ include_in_costing: event.target.checked })} /><span>Incluir en costeo</span></label>
    </div>
    {line.currency !== "CLP" && line.amount_original !== null && line.exchange_rate_clp === null && line.provision_total_clp === null ? <div className="foreign-trade-line-warnings"><span><AlertTriangle size={13} /> Falta tipo de cambio para convertir a CLP.</span></div> : null}
    {line.warnings.length ? <div className="foreign-trade-line-warnings">{line.warnings.map((warning) => <span key={warning}><AlertTriangle size={13} /> {warning}</span>)}</div> : null}
  </article>;
}

function normalizeFundRequestLine(line: ForeignTradeFundRequestLine, patch: Partial<ForeignTradeFundRequestLine>): ForeignTradeFundRequestLine {
  const next = { ...line };
  if ("line_type" in patch) {
    if (next.line_type === "customs_duty") { next.cost_category = "duties"; next.include_in_costing = true; }
    if (next.line_type === "import_vat") { next.cost_category = "taxes"; next.recoverable_tax = true; next.include_in_costing = false; }
    if (next.line_type === "agency_fee") next.cost_category = "customs_agency";
  }
  next.currency = String(next.currency || "").trim().toUpperCase();
  if (next.currency === "CLP") next.exchange_rate_clp = 1;
  if (("provision_net_clp" in patch || "provision_vat_clp" in patch) && !("provision_total_clp" in patch)) {
    next.provision_total_clp = next.provision_net_clp !== null || next.provision_vat_clp !== null
      ? roundMoney((next.provision_net_clp || 0) + (next.provision_vat_clp || 0))
      : null;
  } else if (("amount_original" in patch || "exchange_rate_clp" in patch || "currency" in patch) && !("provision_total_clp" in patch) && next.amount_original !== null && next.exchange_rate_clp !== null) {
    next.provision_total_clp = roundMoney(next.amount_original * next.exchange_rate_clp);
  } else if (next.provision_total_clp === null) {
    if (next.provision_net_clp !== null || next.provision_vat_clp !== null) next.provision_total_clp = roundMoney((next.provision_net_clp || 0) + (next.provision_vat_clp || 0));
    else if (next.amount_original !== null && next.exchange_rate_clp !== null) next.provision_total_clp = roundMoney(next.amount_original * next.exchange_rate_clp);
  }
  return next;
}

function roundMoney(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
function formatClp(value: number) { return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value); }

function ReviewLineCard({ line, reconciliation, catalog, onChange, onForgetMapping }: { line: ForeignTradeExtractedLine; reconciliation: ForeignTradeProductReconciliationLine | null; catalog: ForeignTradeCatalogProduct[]; onChange: (patch: Partial<ForeignTradeExtractedLine>) => void; onForgetMapping: (mappingId: string) => Promise<void> }) {
  const candidates = reconciliation?.candidates || [];
  const candidateProducts = candidates.map((candidate) => ({ id: candidate.product_id, sku: candidate.sku, name: candidate.name }));
  const choices = [...candidateProducts, ...catalog.map((product) => ({ id: product.id, sku: product.sku, name: product.name }))]
    .filter((product, index, products) => products.findIndex((candidate) => candidate.id === product.id) === index);
  const suggested = candidates.find((candidate) => candidate.product_id === reconciliation?.suggested_product_id) || candidates[0];
  function selectProduct(productId: string) {
    const selected = choices.find((product) => product.id === productId);
    onChange({
      content_product_id: productId || null,
      sku: selected?.sku || line.sku,
      remember_link: Boolean(productId),
    });
  }
  return <article className={!line.include ? "excluded" : ""}>
    <header><label><input type="checkbox" checked={line.include} onChange={(event) => onChange({ include: event.target.checked })} /><span>Línea {line.source_index}{line.source_row_label ? ` · ref. ${line.source_row_label}` : ""}{line.source_page ? ` · pág. ${line.source_page}` : ""}</span></label><ConfidenceBadge value={line.confidence} /></header>
    {reconciliation ? <div className={`foreign-trade-product-match ${reconciliation.status}`}>
      <div><strong>{productMatchStatusLabel(reconciliation.status)}</strong><span>{reconciliation.confidence === null ? "Sin puntaje" : `${Math.round(reconciliation.confidence * 100)}% de coincidencia`}</span></div>
      {suggested ? <p><strong>Sugerencia:</strong> {suggested.sku ? `${suggested.sku} · ` : ""}{suggested.name}</p> : <p>No se encontró una coincidencia suficientemente segura.</p>}
      {reconciliation.match_reasons.filter(Boolean).map((reason) => <span className="foreign-trade-match-reason" key={reason}>{reason}</span>)}
      {suggested && !line.content_product_id ? <button className="ghost-button" type="button" onClick={() => selectProduct(suggested.product_id)}><Link2 size={14} /> Usar sugerencia</button> : null}
      {line.content_product_id ? <button className="ghost-button" type="button" onClick={() => onChange({ content_product_id: null, remember_link: false })}><X size={14} /> Dejar pendiente</button> : null}
      {suggested?.mapping_id ? <button className="ghost-button danger" type="button" onClick={() => void onForgetMapping(suggested.mapping_id!)}><Trash2 size={14} /> Olvidar equivalencia aprendida</button> : null}
    </div> : null}
    <div className="foreign-trade-form-grid">
      <label className="wide-field"><span>Producto</span><input value={line.product_name} onChange={(event) => onChange({ product_name: event.target.value })} /></label>
      <label className="wide-field"><span>Producto interno vinculado</span><select value={line.content_product_id || ""} onChange={(event) => selectProduct(event.target.value)}><option value="">Sin vincular · requiere revisión</option>{choices.map((product) => <option key={product.id} value={product.id}>{product.sku ? `${product.sku} · ` : ""}{product.name}</option>)}</select></label>
      <ReviewLineField label="Código proveedor" value={line.supplier_product_code} onChange={(value) => onChange({ supplier_product_code: value })} />
      <ReviewLineField label="SKU proveedor" value={line.supplier_sku} onChange={(value) => onChange({ supplier_sku: value })} />
      <ReviewLineField label="Referencia proveedor" value={line.supplier_reference} onChange={(value) => onChange({ supplier_reference: value })} />
      <ReviewLineField label="SKU CRM" value={line.sku} onChange={(value) => onChange({ sku: value })} />
      <ReviewLineField label="Modelo" value={line.model} onChange={(value) => onChange({ model: value })} />
      <ReviewLineField label="Marca" value={line.brand} onChange={(value) => onChange({ brand: value })} />
      <ReviewLineNumber label="Cantidad" value={line.quantity} onChange={(value) => onChange({ quantity: value })} />
      <ReviewLineNumber label="Unidades por caja" value={line.quantity_per_box} onChange={(value) => onChange({ quantity_per_box: value })} />
      <ReviewLineNumber label="Cajas" value={line.box_count} onChange={(value) => onChange({ box_count: value })} />
      <ReviewLineField label="Moneda" value={line.currency} maxLength={3} onChange={(value) => onChange({ currency: value?.toUpperCase() || null })} />
      <ReviewLineNumber label="Precio unitario" value={line.unit_price} onChange={(value) => onChange({ unit_price: value })} />
      <ReviewLineNumber label="Total documento" value={line.total_price} onChange={(value) => onChange({ total_price: value })} />
      <ReviewLineNumber label="CBM total" value={line.cbm_total} onChange={(value) => onChange({ cbm_total: value })} />
      <ReviewLineNumber label="CBM por caja" value={line.cbm_per_box} onChange={(value) => onChange({ cbm_per_box: value })} />
      <ReviewLineReadonlyNumber label="CBM por unidad (calculado)" value={calculateCbmPerUnit(line.cbm_total, line.quantity)} />
      <ReviewLineNumber label="Peso bruto kg" value={line.gross_weight_kg} onChange={(value) => onChange({ gross_weight_kg: value })} />
      <ReviewLineField label="HS Code" value={line.hs_code} onChange={(value) => onChange({ hs_code: value })} />
      <ReviewLineField label="País de origen" value={line.country_of_origin} onChange={(value) => onChange({ country_of_origin: value?.toUpperCase() || null })} />
      <label className="wide-field"><span>Descripción original</span><textarea value={line.description_original || line.description || ""} onChange={(event) => onChange({ description_original: event.target.value || null, description: event.target.value || null })} /></label>
      <label className="wide-field"><span>Traducción para conciliación</span><textarea value={line.description_translated || ""} onChange={(event) => onChange({ description_translated: event.target.value || null })} /></label>
      {(line.technical_attributes || []).length ? <div className="foreign-trade-technical-attributes wide-field"><span>Atributos técnicos detectados</span><div>{(line.technical_attributes || []).map((attribute) => <small key={attribute}>{attribute}</small>)}</div></div> : null}
      {line.content_product_id ? <label className="foreign-trade-checkbox-field wide-field"><input type="checkbox" checked={line.remember_link} onChange={(event) => onChange({ remember_link: event.target.checked })} /><span>Confirmar permanentemente para este proveedor</span></label> : null}
    </div>
    {line.recalculated_cbm_total !== null ? <p className="foreign-trade-recalculation">CBM recalculado: <strong>{formatNumber(line.recalculated_cbm_total)} m³</strong>{line.cbm_total !== null && line.cbm_total !== line.recalculated_cbm_total ? " · revisa la diferencia" : ""}</p> : null}
    {line.warnings.length ? <div className="foreign-trade-line-warnings">{line.warnings.map((warning) => <span key={warning}><AlertTriangle size={13} /> {warning}</span>)}</div> : null}
  </article>;
}

function productMatchStatusLabel(status: ForeignTradeProductReconciliationLine["status"]) {
  return ({
    auto_matched: "Coincidencia automática segura",
    suggested: "Coincidencia sugerida",
    review: "Revisión necesaria",
    unmatched: "Sin coincidencia",
    confirmed: "Equivalencia confirmada",
    rejected: "Sugerencia rechazada",
  })[status];
}

function ReviewField({ label, value, onChange, type = "text", maxLength }: { label: string; value: string | number | null; onChange: (value: string) => void; type?: string; maxLength?: number }) { return <label><span>{label}</span><input type={type} maxLength={maxLength} value={value ?? ""} onChange={(event) => onChange(event.target.value)} /></label>; }
function ReadOnlyReviewField({ label, value, wide = false }: { label: string; value: string | number | null | undefined; wide?: boolean }) { return <div className={`foreign-trade-readonly-field${wide ? " wide-field" : ""}`}><span>{label}</span><strong>{value === null || value === undefined || value === "" ? "No reconocido" : value}</strong></div>; }
function ReviewLineField({ label, value, onChange, maxLength }: { label: string; value: string | null; onChange: (value: string | null) => void; maxLength?: number }) { return <label><span>{label}</span><input maxLength={maxLength} value={value || ""} onChange={(event) => onChange(event.target.value || null)} /></label>; }
function ReviewLineNumber({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) { return <label><span>{label}</span><input type="number" min="0" step="any" value={value ?? ""} onChange={(event) => onChange(nullableNumber(event.target.value))} /></label>; }
function ReviewLineReadonlyNumber({ label, value }: { label: string; value: number | null }) { return <label className="foreign-trade-derived-field"><span>{label}</span><input type="number" readOnly value={value ?? ""} /></label>; }

function withDerivedCbm(line: ForeignTradeExtractedLine, patch: Partial<ForeignTradeExtractedLine>): ForeignTradeExtractedLine {
  const next = { ...line, ...patch };
  if (!("cbm_per_box" in patch) && ("cbm_total" in patch || "box_count" in patch || !next.cbm_per_box)) {
    next.cbm_per_box = next.cbm_total !== null && next.box_count !== null && next.box_count > 0
      ? roundCbm(next.cbm_total / next.box_count)
      : next.cbm_per_box;
  }
  next.cbm_per_unit = calculateCbmPerUnit(next.cbm_total, next.quantity);
  return next;
}

function calculateCbmPerUnit(total: number | null, quantity: number | null) {
  return total !== null && quantity !== null && quantity > 0 ? roundCbm(total / quantity, 9) : null;
}

function roundCbm(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function extractionLines(value: ForeignTradeAnyDocumentExtraction | Record<string, never> | undefined) {
  return value && Array.isArray((value as ForeignTradeAnyDocumentExtraction).lines)
    ? (value as ForeignTradeAnyDocumentExtraction).lines
    : [];
}

function DocumentStatus({ document }: { document: ForeignTradeDocument }) {
  const content = ({ uploaded: "Cargado", queued: "En cola", extracting: "Analizando", review_required: "Revisión requerida", confirmed: "Confirmado", failed: "Error" })[document.parse_status];
  return <span className={`foreign-trade-document-status ${document.parse_status}`}>{["queued", "extracting"].includes(document.parse_status) ? <LoaderCircle className="spin" size={13} /> : null}{content}</span>;
}
function ConfidenceBadge({ value }: { value: number | null }) { const level = value === null ? "unknown" : value >= .85 ? "high" : value >= .6 ? "medium" : "low"; const label = value === null ? "Sin confianza" : `${Math.round(value * 100)}% confianza`; return <span className={`foreign-trade-confidence ${level}`}>{label}</span>; }
function nullableNumber(value: string) { const number = Number(value); return value.trim() && Number.isFinite(number) ? number : null; }
function documentTypeLabel(type: ForeignTradeDocumentType) { return documentTypes.find((item) => item.value === type)?.label || type; }
function productDocumentReviewCopy(type: ForeignTradeDocumentType) {
  if (type === "commercial_invoice") return { label: "Commercial Invoice", numberLabel: "Número de invoice", article: "la Commercial Invoice" };
  if (type === "packing_list") return { label: "Packing List", numberLabel: "Referencia del packing list", article: "el Packing List" };
  if (type === "purchase_order") return { label: "orden de compra", numberLabel: "Referencia de orden", article: "la orden de compra" };
  return { label: "proforma", numberLabel: "Número de proforma", article: "la proforma" };
}
function getDocumentScope(document: ForeignTradeDocument): ForeignTradeDocumentScope | null {
  const sources = [document.review_result, document.extraction_result];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const rawScope = (source as ForeignTradeDocumentExtraction).document_scope;
    if (!rawScope || typeof rawScope !== "object") continue;
    const totalPdfPages = Number(rawScope.total_pdf_pages);
    const pageNumbers = Array.from(new Set((Array.isArray(rawScope.page_numbers) ? rawScope.page_numbers : [])
      .map(Number)
      .filter((page) => Number.isInteger(page) && page > 0 && (!Number.isFinite(totalPdfPages) || page <= totalPdfPages))))
      .sort((left, right) => left - right);
    if (!rawScope.detected || !pageNumbers.length) continue;
    return {
      selected_document_type: rawScope.selected_document_type || document.document_type,
      detected: true,
      page_start: pageNumbers[0],
      page_end: pageNumbers[pageNumbers.length - 1] || pageNumbers[0],
      page_numbers: pageNumbers,
      total_pdf_pages: Number.isInteger(totalPdfPages) && totalPdfPages > 0 ? totalPdfPages : null,
      confidence: typeof rawScope.confidence === "number" ? rawScope.confidence : null,
      evidence: Array.isArray(rawScope.evidence) ? rawScope.evidence.map(String).filter(Boolean) : [],
      warnings: Array.isArray(rawScope.warnings) ? rawScope.warnings.map(String).filter(Boolean) : [],
    };
  }
  return null;
}
function formatPageNumbers(pages: number[]) {
  const sortedPages = Array.from(new Set(pages.filter((page) => Number.isInteger(page) && page > 0))).sort((left, right) => left - right);
  if (!sortedPages.length) return "sin páginas";
  const ranges: string[] = [];
  let start = sortedPages[0];
  let end = start;
  for (const page of sortedPages.slice(1)) {
    if (page === end + 1) { end = page; continue; }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = page;
    end = page;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(", ");
}
function inferDocumentType(fileName: string, fallback: ForeignTradeDocumentType): ForeignTradeDocumentType {
  const normalized = fileName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/rendicion|liquidacion.*agencia|cuenta.*gasto/.test(normalized)) return "agency_settlement";
  if (/solc|solicitud.*fond|provision.*fond/.test(normalized)) return "fund_request";
  if (/packing|lista.*empaque/.test(normalized)) return "packing_list";
  if (/(^|\W)(bill of lading|b\/l|bl)(\W|$)|conocimiento.*embarque/.test(normalized)) return "bill_of_lading";
  if (/purchase.*order|orden.*compra/.test(normalized)) return "purchase_order";
  if (/commercial.*invoice|factura.*comercial/.test(normalized)) return "commercial_invoice";
  if (/flete|freight|maritim|naviera|transport|forwarder/.test(normalized)) return "freight_quote";
  if (/proforma|pro-forma/.test(normalized)) return "proforma";
  return fallback;
}
function formatFileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatNumber(value: number) { return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 6 }).format(value); }
function isAbortError(error: unknown) { return error instanceof DOMException && error.name === "AbortError"; }
function normalizeCurrencyCode(value: string | null | undefined, fallback: string) {
  const normalized = String(value || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(normalized)) return normalized;
  const normalizedFallback = String(fallback || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalizedFallback) ? normalizedFallback : "USD";
}
function humanizeDocumentError(error: unknown) {
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error
    ? error.message
    : String(details.message || details.details || details.hint || "No se pudo procesar el documento.");
  if (message.includes("OPENAI_API_KEY")) return "La extracción inteligente no está configurada en Supabase.";
  if (/excedi[oó].*tiempo|excedi[oó].*segundos|timeout|timed out/i.test(message)) return "El original quedó guardado. El análisis tardó demasiado; usa Reintentar sin volver a subir el archivo.";
  if (/confirm_foreign_trade_fund_request_document/i.test(message)) return "Falta actualizar la base de datos con supabase/foreign_trade_center_phase6_fund_requests.sql.";
  if (/confirm_foreign_trade_agency_settlement_document/i.test(message)) return "Falta actualizar la base de datos con supabase/foreign_trade_center_phase7_agency_settlements.sql.";
  if (/confirm_foreign_trade_freight_document/i.test(message)) return "Falta actualizar la base de datos con la migración de documentos de transporte.";
  if (message.includes("foreign_trade_reconciliation_identity_mismatch")) return "Las referencias no coinciden. Confirma manualmente que la provisión y la rendición pertenecen al mismo despacho.";
  if (message.includes("foreign_trade_reconciliation_already_applied")) return "Esta conciliación ya fue aplicada al costeo y no puede recibir otra rendición final.";
  if (/update_foreign_trade_document_type|cancel_foreign_trade_document_extraction|delete_foreign_trade_document|schema cache|function.*does not exist|404/i.test(message)) return "Falta actualizar la base de datos de Comercio Exterior en Supabase.";
  if (/request_stale|detenido por el usuario/i.test(message)) return "El análisis fue detenido y su respuesta anterior quedó descartada.";
  if (message.includes("already") || message.includes("not_ready")) return "El documento ya fue confirmado o todavía no está listo para revisión.";
  if (message.includes("not_found_or_confirmed")) return "El documento ya no existe o fue confirmado y no puede modificarse.";
  if (message.includes("invalid_currency")) return "La moneda debe expresarse con un código de tres letras, por ejemplo USD.";
  if (message.includes("invalid_review") || message.includes("invalid_product") || message.includes("invalid_fund_request") || message.includes("without_lines")) return "Revisa los datos marcados antes de confirmar.";
  return message;
}
