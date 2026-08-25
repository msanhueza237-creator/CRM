import {
  FOREIGN_TRADE_AGENCY_SETTLEMENT_EXTRACTION_VERSION,
  FOREIGN_TRADE_EXTRACTION_VERSION,
  FOREIGN_TRADE_FUND_REQUEST_EXTRACTION_VERSION,
  FOREIGN_TRADE_FREIGHT_DOCUMENT_EXTRACTION_VERSION,
  buildExtractionRanges,
  mergeExtractionPasses,
  mergeCompactVerification,
  mergeUnnumberedRows,
  missingExtractionRanges,
  normalizeForeignTradeDocumentScope,
  prepareExtraction,
  prepareAgencySettlementExtraction,
  prepareFundRequestExtraction,
  prepareFreightDocumentExtraction,
  type ExtractionLineBatch,
  type ExtractionRange,
  type JsonRecord,
} from "./extraction-logic.ts";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import {
  FOREIGN_TRADE_PDF_SKILL_VERSION,
  assessPdfExtractionQuality,
  createForeignTradeDocumentScopePrompt,
  createForeignTradePdfReadingSkill,
  type ForeignTradePdfReadingSkill,
} from "./pdf-reading-skill.ts";

type RestClient = { url: string; anonKey: string; serviceRoleKey: string };
type Profile = { id: string; role: string; active: boolean };

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
]);
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const OPENAI_INLINE_FILE_MAX_BYTES = 8 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  const requestId = req.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  try {
    const rest = getRestClient();
    const route = getRoute(req.url);
    if (route === "health") return json({ ok: true, service: "foreign-trade-documents", extractionVersion: FOREIGN_TRADE_EXTRACTION_VERSION, fundRequestExtractionVersion: FOREIGN_TRADE_FUND_REQUEST_EXTRACTION_VERSION, agencySettlementExtractionVersion: FOREIGN_TRADE_AGENCY_SETTLEMENT_EXTRACTION_VERSION, freightDocumentExtractionVersion: FOREIGN_TRADE_FREIGHT_DOCUMENT_EXTRACTION_VERSION, pdfSkillVersion: FOREIGN_TRADE_PDF_SKILL_VERSION, requestId }, 200, req);

    const user = await authenticateRequest(req, rest);
    const profile = await getProfile(rest, user.id);
    if (!profile?.active) throw new HttpError(403, "Tu usuario no está activo en el CRM.");
    if (profile.role !== "administrador") throw new HttpError(403, "Solo administración puede procesar documentos privados.");

    if (route === "extract" && req.method === "POST") {
      const payload = await readJson(req);
      const documentId = requiredUuid(payload.document_id, "documento");
      return json(await queueDocumentExtraction(rest, documentId, requestId), 202, req);
    }
    if (route === "detect-section" && req.method === "POST") {
      const payload = await readJson(req);
      const documentId = requiredUuid(payload.document_id, "documento");
      return json(await detectDocumentSection(rest, documentId, requestId, req.signal), 200, req);
    }
    if (route === "set-section" && req.method === "POST") {
      const payload = await readJson(req);
      const documentId = requiredUuid(payload.document_id, "documento");
      return json(await setDocumentSection(rest, documentId, payload.page_numbers, requestId), 200, req);
    }
    if (route === "download-section" && req.method === "POST") {
      const payload = await readJson(req);
      const documentId = requiredUuid(payload.document_id, "documento");
      return await downloadDocumentSection(rest, documentId, requestId, req);
    }
    throw new HttpError(404, "Ruta no encontrada.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Error inesperado.";
    console.error("[foreign-trade-documents] request failed", { requestId, status, message });
    return json({ error: message, requestId }, status, req);
  }
});

async function detectDocumentSection(rest: RestClient, documentId: string, requestId: string, requestSignal: AbortSignal) {
  const documents = await selectRows(rest,
    `foreign_trade_documents?select=id,document_type,storage_bucket,storage_path,original_file_name,mime_type,parse_status,extraction_result,review_result&id=eq.${documentId}&limit=1`,
  );
  const document = documents[0];
  if (!document) throw new HttpError(404, "El documento no existe.");
  if (!isPdfDocumentRecord(document)) throw new HttpError(400, "La detección de secciones solo está disponible para archivos PDF.");
  const documentType = String(document.document_type || "other");
  if (!isSectionAwareDocumentType(documentType)) throw new HttpError(400, "Esta clasificación no utiliza separación de páginas.");

  const bytes = await downloadPrivateFile(rest, String(document.storage_bucket), String(document.storage_path));
  const sourcePdf = await PDFDocument.load(bytes).catch(() => {
    throw new HttpError(422, "El PDF original no se pudo abrir o está protegido.");
  });
  const pageCount = sourcePdf.getPageCount();
  const storedScope = preferredStoredDocumentScope(document, documentType);
  if (storedScope) {
    const reusableScope = normalizeScopeForPdf(storedScope, pageCount);
    if (reusableScope.detected) {
      console.info("[foreign-trade-documents] stored section reused", {
        requestId,
        documentId,
        documentType,
        pageNumbers: reusableScope.page_numbers,
      });
      return { documentId, status: String(document.parse_status || "uploaded"), scope: reusableScope, reused: true };
    }
  }
  const detected = await callOpenAiDocumentScopeDetection(
    bytes,
    String(document.original_file_name),
    documentType,
    requestId,
    requestSignal,
  );
  const scope = normalizeScopeForPdf(detected.scope, pageCount);
  if (!scope.detected || !scope.page_numbers.length) {
    throw new HttpError(422, `No se encontró una sección ${documentTypeFileLabel(documentType)} dentro del PDF.`);
  }
  await persistDiscoveredDocumentScope(rest, document, scope, detected.model);
  console.info("[foreign-trade-documents] section detection ready", {
    requestId,
    documentId,
    documentType,
    pageNumbers: scope.page_numbers,
    totalPdfPages: pageCount,
  });
  return { documentId, status: String(document.parse_status || "uploaded"), scope };
}

async function setDocumentSection(
  rest: RestClient,
  documentId: string,
  rawPageNumbers: unknown,
  requestId: string,
) {
  const documents = await selectRows(rest,
    `foreign_trade_documents?select=id,document_type,storage_bucket,storage_path,original_file_name,mime_type,parse_status,extraction_result,review_result&id=eq.${documentId}&limit=1`,
  );
  const document = documents[0];
  if (!document) throw new HttpError(404, "El documento no existe.");
  if (!isPdfDocumentRecord(document)) throw new HttpError(400, "La definición de páginas solo está disponible para archivos PDF.");
  const documentType = String(document.document_type || "other");
  if (!isSectionAwareDocumentType(documentType)) throw new HttpError(400, "Esta clasificación no utiliza separación de páginas.");
  if (String(document.parse_status || "") === "confirmed") {
    throw new HttpError(409, "El documento confirmado no puede cambiar de sección sin reemplazarlo.");
  }

  const bytes = await downloadPrivateFile(rest, String(document.storage_bucket), String(document.storage_path));
  const sourcePdf = await PDFDocument.load(bytes).catch(() => {
    throw new HttpError(422, "El PDF original no se pudo abrir o está protegido.");
  });
  const pageCount = sourcePdf.getPageCount();
  const pageNumbers = normalizeManualPageNumbers(rawPageNumbers, pageCount);
  if (!pageNumbers.length) throw new HttpError(400, `Indica al menos una página válida entre 1 y ${pageCount}.`);
  const scope = normalizeScopeForPdf(normalizeForeignTradeDocumentScope({
    selected_document_type: documentType,
    detected: true,
    page_start: pageNumbers[0],
    page_end: pageNumbers[pageNumbers.length - 1],
    page_numbers: pageNumbers,
    total_pdf_pages: pageCount,
    confidence: 1,
    evidence: ["Páginas verificadas manualmente por Administración."],
    warnings: [],
  }, documentType), pageCount);
  await persistDiscoveredDocumentScope(rest, document, scope, "manual_admin_review");
  console.info("[foreign-trade-documents] manual section saved", {
    requestId,
    documentId,
    documentType,
    pageNumbers,
    totalPdfPages: pageCount,
  });
  return { documentId, status: String(document.parse_status || "uploaded"), scope };
}

async function queueDocumentExtraction(rest: RestClient, documentId: string, requestId: string) {
  const documents = await selectRows(rest,
    `foreign_trade_documents?select=id,operation_id,document_type,storage_bucket,storage_path,original_file_name,mime_type,file_size,parse_status,extraction_result,review_result&id=eq.${documentId}&limit=1`,
  );
  const document = documents[0];
  if (!document) throw new HttpError(404, "El documento no existe.");
  if (document.parse_status === "confirmed") throw new HttpError(409, "El documento ya fue confirmado.");
  const mimeType = String(document.mime_type || "").toLowerCase();
  const fileSize = Number(document.file_size || 0);
  if (!allowedMimeTypes.has(mimeType) || fileSize <= 0 || fileSize > MAX_DOCUMENT_BYTES) {
    throw new HttpError(400, "El archivo no cumple el formato o tamaño permitido.");
  }

  await setExtraction(rest, documentId, "extracting", {}, null, [], null, null, requestId);
  const runtime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
  }).EdgeRuntime;
  if (!runtime?.waitUntil) {
    await setExtraction(rest, documentId, "failed", {}, null, [], "El runtime no permite procesamiento en segundo plano.", null, requestId);
    throw new HttpError(503, "El runtime de Supabase no permite iniciar el análisis en segundo plano.");
  }
  const backgroundController = new AbortController();
  const task = extractDocument(rest, document, requestId, backgroundController.signal).catch((error) => {
    console.error("[foreign-trade-documents] background extraction finished with error", {
      requestId,
      documentId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
  runtime.waitUntil(task);
  console.info("[foreign-trade-documents] extraction accepted for background processing", {
    requestId,
    documentId,
  });
  return { documentId, status: "extracting", requestId };
}

async function extractDocument(rest: RestClient, document: JsonRecord, requestId: string, requestSignal: AbortSignal) {
  const documentId = String(document.id || "");
  const mimeType = String(document.mime_type || "").toLowerCase();
  const fileSize = Number(document.file_size || 0);
  try {
    const bytes = await downloadPrivateFile(rest, String(document.storage_bucket), String(document.storage_path));
    if (bytes.byteLength !== fileSize) console.warn("[foreign-trade-documents] file size differs", { requestId, documentId });
    const documentType = String(document.document_type || "other");
    const storedScope = preferredStoredDocumentScope(document, documentType);
    const openAiResult = documentType === "fund_request"
      ? await callOpenAiFundRequestExtraction(bytes, String(document.original_file_name), mimeType, requestId, requestSignal)
      : documentType === "agency_settlement"
        ? await callOpenAiAgencySettlementExtraction(bytes, String(document.original_file_name), mimeType, requestId, requestSignal)
        : documentType === "freight_quote"
          ? await callOpenAiFreightDocumentExtraction(bytes, String(document.original_file_name), mimeType, requestId, requestSignal)
          : await callOpenAiExtraction(
            bytes,
            String(document.original_file_name),
            mimeType,
            documentType,
            requestId,
            requestSignal,
            async (header, model) => {
              const scope = normalizeForeignTradeDocumentScope(header.document_scope, documentType);
              if (!scope.detected) return;
              await persistDetectedDocumentScope(rest, documentId, requestId, scope, model);
            },
            storedScope,
          );
    const prepared = documentType === "fund_request"
      ? prepareFundRequestExtraction(openAiResult.data)
      : documentType === "agency_settlement"
        ? prepareAgencySettlementExtraction(openAiResult.data)
        : documentType === "freight_quote"
          ? prepareFreightDocumentExtraction(openAiResult.data)
          : prepareExtraction(openAiResult.data);
    await setExtraction(
      rest,
      documentId,
      "review_required",
      prepared.extraction,
      prepared.confidence,
      prepared.warnings,
      null,
      openAiResult.model,
      requestId,
    );
    await rpc(rest, "record_foreign_trade_document_processing_version", {
      p_document_id: documentId,
      p_payload: prepared.extraction,
      p_confidence: prepared.confidence,
      p_warnings: prepared.warnings,
      p_model: openAiResult.model,
      p_request_id: openAiResult.requestId || requestId,
    }).catch((versionError) => {
      console.warn("[foreign-trade-documents] processing version was not recorded", {
        requestId,
        documentId,
        error: versionError instanceof Error ? versionError.message : String(versionError),
      });
    });
    console.info("[foreign-trade-documents] extraction ready", {
      requestId,
      documentId,
      documentType,
      lines: prepared.extraction.lines.length,
      warnings: prepared.warnings.length,
      openAiRequestId: openAiResult.requestId || null,
    });
    return { documentId, status: "review_required", ...prepared, model: openAiResult.model, requestId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo analizar el documento.";
    await setExtraction(rest, documentId, "failed", {}, null, [], message, null, requestId).catch(() => undefined);
    throw error;
  }
}

async function downloadDocumentSection(rest: RestClient, documentId: string, requestId: string, req: Request) {
  const documents = await selectRows(rest,
    `foreign_trade_documents?select=id,document_type,storage_bucket,storage_path,original_file_name,mime_type,parse_status,extraction_result,review_result&id=eq.${documentId}&limit=1`,
  );
  const document = documents[0];
  if (!document) throw new HttpError(404, "El documento no existe.");
  if (String(document.mime_type || "").toLowerCase() !== "application/pdf") {
    throw new HttpError(400, "La descarga por sección está disponible únicamente para archivos PDF.");
  }

  const bytes = await downloadPrivateFile(rest, String(document.storage_bucket), String(document.storage_path));
  let sourcePdf: PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(bytes);
  } catch {
    throw new HttpError(422, "El PDF no se pudo dividir. Puede estar cifrado o dañado; el original permanece disponible.");
  }
  const pageCount = sourcePdf.getPageCount();
  const reviewScope = normalizeForeignTradeDocumentScope(asObject(document.review_result).document_scope, String(document.document_type || "other"));
  const extractionScope = normalizeForeignTradeDocumentScope(asObject(document.extraction_result).document_scope, String(document.document_type || "other"));
  let scope = reviewScope.detected ? reviewScope : extractionScope;
  if (!scope.detected || !scope.page_numbers.length) {
    const detected = await callOpenAiDocumentScopeDetection(
      bytes,
      String(document.original_file_name || "documento.pdf"),
      String(document.document_type || "other"),
      requestId,
      req.signal,
    );
    scope = {
      ...detected.scope,
      total_pdf_pages: pageCount,
      page_numbers: detected.scope.page_numbers.filter((page) => page >= 1 && page <= pageCount),
    };
    scope.page_start = scope.page_numbers.length ? Math.min(...scope.page_numbers) : null;
    scope.page_end = scope.page_numbers.length ? Math.max(...scope.page_numbers) : null;
    scope.detected = scope.detected && scope.page_numbers.length > 0;
    if (scope.detected) {
      await persistDiscoveredDocumentScope(rest, document, scope, detected.model);
    }
  }
  if (!scope.detected || !scope.page_numbers.length) {
    throw new HttpError(422, `No se encontró una sección ${documentTypeFileLabel(String(document.document_type || "document"))} dentro del PDF.`);
  }

  const pageNumbers = scope.page_numbers.filter((page) => page >= 1 && page <= pageCount);
  if (!pageNumbers.length) throw new HttpError(422, "Las páginas detectadas no existen en el PDF original. Regenera el análisis.");

  const sectionPdf = await PDFDocument.create();
  const copiedPages = await sectionPdf.copyPages(sourcePdf, pageNumbers.map((page) => page - 1));
  copiedPages.forEach((page) => sectionPdf.addPage(page));
  sectionPdf.setTitle(`${documentTypeFileLabel(String(document.document_type || "document"))} - ${String(document.original_file_name || "documento")}`);
  const sectionBytes = await sectionPdf.save();
  const fileName = sectionFileName(String(document.original_file_name || "documento.pdf"), String(document.document_type || "document"));
  return new Response(sectionBytes, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Document-Pages": pageNumbers.join(","),
      "X-Document-Total-Pages": String(pageCount),
    },
  });
}

async function callOpenAiDocumentScopeDetection(
  bytes: Uint8Array,
  filename: string,
  documentType: string,
  requestId: string,
  requestSignal: AbortSignal,
) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_DOCUMENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const configuredTimeout = clampNumber(Deno.env.get("OPENAI_DOCUMENT_REQUEST_TIMEOUT_MS"), 30_000, 300_000, 180_000);
  let temporaryFileId = "";
  try {
    if (bytes.byteLength > OPENAI_INLINE_FILE_MAX_BYTES) {
      temporaryFileId = await uploadOpenAiTemporaryFile(apiKey, bytes, filename, "application/pdf", requestId, requestSignal);
    }
    const result = await callOpenAiStructuredExtraction({
      apiKey,
      model,
      filename,
      mimeType: "application/pdf",
      ...(temporaryFileId
        ? { fileId: temporaryFileId }
        : { fileData: `data:application/pdf;base64,${bytesToBase64(bytes)}` }),
      requestId,
      requestSignal,
      timeoutMs: Math.min(configuredTimeout, 120_000),
      maxTokens: 1_800,
      stage: "document-scope",
      schemaName: "foreign_trade_document_scope_only",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["document_scope"],
        properties: { document_scope: documentScopeSchema },
      },
      prompt: createForeignTradeDocumentScopePrompt(documentType),
    });
    return {
      model,
      scope: normalizeForeignTradeDocumentScope(asObject(result.data).document_scope, documentType),
    };
  } finally {
    if (temporaryFileId) await deleteOpenAiTemporaryFile(apiKey, temporaryFileId, requestId);
  }
}

async function callOpenAiFundRequestExtraction(bytes: Uint8Array, filename: string, mimeType: string, requestId: string, requestSignal: AbortSignal) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_DOCUMENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const timeoutMs = clampNumber(Deno.env.get("OPENAI_DOCUMENT_REQUEST_TIMEOUT_MS"), 30_000, 300_000, 180_000);
  const maxTokens = clampNumber(Deno.env.get("OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS"), 2_000, 20_000, 12_000);
  const result = await callOpenAiStructuredExtraction({
    apiKey,
    model,
    filename,
    mimeType,
    fileData: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    requestId,
    requestSignal,
    timeoutMs,
    maxTokens,
    stage: "fund-request",
    schemaName: "foreign_trade_fund_request",
    schema: fundRequestExtractionSchema,
    prompt: `Lee visualmente y con máxima precisión todas las páginas de esta solicitud o provisión de fondos de una agencia de aduanas chilena.

OBJETIVO: extraer cada concepto monetario para una conciliación posterior. No es una proforma de productos. No inventes conceptos, montos, monedas, fechas, números de documento ni tipos de cambio.

REGLAS:
1. Devuelve una línea por cada gasto, honorario, derecho, impuesto o ajuste visible. Conserva el orden físico y la página.
2. Separa tributos de los gastos operacionales. Derechos aduaneros => line_type customs_duty y categoría duties. IVA de importación => line_type import_vat y categoría taxes. Honorarios de agencia => agency_fee/customs_agency. Los demás cargos => operating_expense y la categoría más precisa.
3. El IVA de importación es un tributo potencialmente recuperable: recoverable_tax true e include_in_costing false. Los derechos aduaneros se incluyen en costeo. Para IVA de facturas de servicios usa recoverable_tax true, pero conserva el total provisionado.
4. Si un monto está en USD u otra moneda, conserva amount_original y currency. Extrae exchange_rate_clp solo si el documento lo muestra. provision_total_clp debe ser el total en CLP declarado o inequívocamente convertido en el propio documento; si no existe conversión, usa null.
5. provision_net_clp y provision_vat_clp solo deben contener valores expresados en CLP en el documento. No calcules IVA ni tipos de cambio que no estén impresos.
6. Identifica referencia de solicitud, agencia, fecha, total declarado y monto solicitado/depositado. Fechas en YYYY-MM-DD cuando sean inequívocas.
7. Si un dato es dudoso, déjalo null y explica la duda en warnings. No combines dos conceptos distintos en una sola línea.
8. Revisa pies, subtotales y cuadros de tributos, pero no los dupliques como líneas si ya están desglosados.
9. confidence entre 0 y 1 refleja confianza de lectura, no importancia.

La salida debe corresponder exactamente al esquema solicitado.`,
  });
  console.info("[foreign-trade-documents] fund request extraction ready", {
    requestId,
    filename,
    lines: Array.isArray(asObject(result.data).lines) ? (asObject(result.data).lines as unknown[]).length : 0,
    openAiRequestId: result.requestId || null,
  });
  return { model, requestId: result.requestId, data: result.data };
}

async function callOpenAiFreightDocumentExtraction(bytes: Uint8Array, filename: string, mimeType: string, requestId: string, requestSignal: AbortSignal) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_DOCUMENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const timeoutMs = clampNumber(Deno.env.get("OPENAI_DOCUMENT_REQUEST_TIMEOUT_MS"), 30_000, 300_000, 180_000);
  const maxTokens = clampNumber(Deno.env.get("OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS"), 2_000, 20_000, 12_000);
  const result = await callOpenAiStructuredExtraction({
    apiKey,
    model,
    filename,
    mimeType,
    fileData: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    requestId,
    requestSignal,
    timeoutMs,
    maxTokens,
    stage: "freight-document",
    schemaName: "foreign_trade_freight_document",
    schema: freightDocumentExtractionSchema,
    prompt: `Lee visualmente y con máxima precisión todas las páginas de esta factura, cotización o liquidación de transporte marítimo, aéreo o terrestre.

OBJETIVO: extraer cada cargo logístico real o cotizado para incorporarlo al costo de importación. No es una proforma de productos ni una rendición de agencia. No inventes conceptos, rutas, montos, monedas, fechas, números de factura, B/L ni tipos de cambio.

REGLAS:
1. Identifica transportista o forwarder, número de factura/cotización, fecha, ruta, puerto de origen, puerto de destino, B/L y referencia de embarque cuando estén impresos.
2. Devuelve una línea por cargo monetario sin duplicar totales o subtotales. Clasifica flete oceánico/aéreo como international_freight; seguro como insurance; cargos de origen como origin; THC/DTHC y terminal Chile como chile_port; almacenaje como storage; transporte terrestre en Chile como national_transport; otros como other.
3. Si un documento expresa un cargo en USD y también su equivalente CLP, conserva ambos: amount_original, currency, exchange_rate_clp y total_clp. Extrae el tipo de cambio solo si está impreso o es aritméticamente inequívoco por ambos montos.
4. net_clp, vat_clp y total_clp solo contienen importes en CLP mostrados o inequívocamente convertidos en el documento. Para factura exenta, vat_clp es 0 y net_clp coincide con total_clp.
5. recoverable_tax true solo para IVA recuperable explícito. include_in_costing true para costos logísticos; no conviertas IVA recuperable en costo económico.
6. Conserva una línea incluso si el documento solo contiene un único flete. Usa fechas YYYY-MM-DD cuando sean inequívocas.
7. Si un dato es dudoso, déjalo null y explica la duda en warnings. confidence entre 0 y 1 refleja confianza de lectura.

La salida debe corresponder exactamente al esquema solicitado.`,
  });
  console.info("[foreign-trade-documents] freight document extraction ready", {
    requestId,
    filename,
    lines: Array.isArray(asObject(result.data).lines) ? (asObject(result.data).lines as unknown[]).length : 0,
    openAiRequestId: result.requestId || null,
  });
  return { model, requestId: result.requestId, data: result.data };
}

async function callOpenAiAgencySettlementExtraction(bytes: Uint8Array, filename: string, mimeType: string, requestId: string, requestSignal: AbortSignal) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_DOCUMENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const timeoutMs = clampNumber(Deno.env.get("OPENAI_DOCUMENT_REQUEST_TIMEOUT_MS"), 30_000, 300_000, 180_000);
  const maxTokens = clampNumber(Deno.env.get("OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS"), 2_000, 20_000, 12_000);
  const result = await callOpenAiStructuredExtraction({
    apiKey,
    model,
    filename,
    mimeType,
    fileData: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    requestId,
    requestSignal,
    timeoutMs,
    maxTokens,
    stage: "agency-settlement",
    schemaName: "foreign_trade_agency_settlement",
    schema: agencySettlementExtractionSchema,
    prompt: `Lee visualmente y con máxima precisión todas las páginas de esta rendición final, factura o paquete de respaldos de una agencia de aduanas chilena.

OBJETIVO: extraer cada costo REAL pagado o facturado para compararlo con una provisión anterior. No es una proforma de productos. No inventes conceptos, montos, monedas, fechas, números de documento ni tipos de cambio.

REGLAS:
1. Devuelve una línea por cada factura, gasto, honorario, derecho, impuesto, nota de crédito o ajuste visible. Conserva el orden físico y la página.
2. Separa tributos de gastos operacionales. Derechos aduaneros => customs_duty/duties. IVA de importación => import_vat/taxes. Honorarios de agencia => agency_fee/customs_agency.
3. Extrae actual_net_clp, actual_vat_clp y actual_total_clp solo cuando el documento los muestra en CLP. No calcules IVA que no esté impreso.
4. Si una factura está en USD u otra moneda, conserva amount_original y currency. Extrae exchange_rate_clp solo si aparece en esa factura. Si el documento también declara su equivalente CLP, consérvalo en actual_total_clp aunque el tipo de cambio no esté explícito.
5. El IVA de importación es potencialmente recuperable: recoverable_tax true e include_in_costing false. El IVA de facturas de servicios también puede ser recuperable, pero el total real debe conservarse para conciliación.
6. Identifica referencia del despacho, agencia, número de factura principal, fecha y total declarado. Fechas en YYYY-MM-DD cuando sean inequívocas.
7. No dupliques subtotales o resúmenes cuando sus conceptos ya aparecen desglosados. Una nota de crédito o devolución debe ser adjustment y describirse claramente, sin convertirla silenciosamente en gasto positivo.
8. Si un dato es dudoso, déjalo null y explica la duda en warnings. confidence entre 0 y 1 refleja confianza de lectura.

La salida debe corresponder exactamente al esquema solicitado.`,
  });
  console.info("[foreign-trade-documents] agency settlement extraction ready", {
    requestId,
    filename,
    lines: Array.isArray(asObject(result.data).lines) ? (asObject(result.data).lines as unknown[]).length : 0,
    openAiRequestId: result.requestId || null,
  });
  return { model, requestId: result.requestId, data: result.data };
}

async function callOpenAiExtraction(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  documentType: string,
  requestId: string,
  requestSignal: AbortSignal,
  onHeader?: (header: JsonRecord, model: string) => Promise<void>,
  storedScope: ReturnType<typeof normalizeForeignTradeDocumentScope> | null = null,
) {
  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(503, "Falta configurar OPENAI_API_KEY en la Edge Function.");
  const model = Deno.env.get("OPENAI_DOCUMENT_MODEL")?.trim()
    || Deno.env.get("OPENAI_TEXT_MODEL")?.trim()
    || "gpt-4.1-mini";
  const timeoutMs = clampNumber(Deno.env.get("OPENAI_DOCUMENT_REQUEST_TIMEOUT_MS"), 30_000, 300_000, 180_000);
  const maxTokens = clampNumber(Deno.env.get("OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS"), 2_000, 20_000, 12_000);
  const lineChunkSize = 15;
  const rangeConcurrency = Math.round(clampNumber(Deno.env.get("OPENAI_DOCUMENT_RANGE_CONCURRENCY"), 1, 8, 6));
  const skill = createForeignTradePdfReadingSkill(documentType);
  const trustedScope = mimeType === "application/pdf" && storedScope?.detected
    ? storedScope
    : null;
  const preScopedPdf = trustedScope
    ? await createScopedPdfData(bytes, trustedScope.page_numbers, requestId)
    : null;
  const analysisBytes = preScopedPdf?.bytes || bytes;
  let temporaryFileId = "";
  let lineTemporaryFileId = "";
  if (mimeType === "application/pdf") {
    temporaryFileId = await uploadOpenAiTemporaryFile(
      apiKey,
      analysisBytes,
      preScopedPdf ? sectionFileName(filename, documentType) : filename,
      mimeType,
      requestId,
      requestSignal,
    );
  }
  const common = {
    apiKey,
    model,
    filename,
    mimeType,
    ...(temporaryFileId
      ? { fileId: temporaryFileId }
      : { fileData: `data:${mimeType};base64,${bytesToBase64(analysisBytes)}` }),
    requestId,
    requestSignal,
    timeoutMs,
  };
  const headerCommon = common;
  const trustedPageMapping = preScopedPdf
    ? preScopedPdf.originalPageNumbers.map((page, index) => `${index + 1}->${page}`).join(", ")
    : "";
  const trustedScopeInstruction = trustedScope
    ? `\n\nSECCION YA RECONOCIDA Y VALIDADA: no vuelvas a decidir si existe. Usa exclusivamente las paginas fisicas originales ${trustedScope.page_numbers.join(", ")} para ${documentTypeFileLabel(documentType)}.${trustedPageMapping ? ` El PDF adjunto ya fue recortado. Mapeo pagina adjunta->pagina fisica original: ${trustedPageMapping}.` : ""} Devuelve document_scope.detected=true y conserva exactamente esas paginas fisicas originales en document_scope.page_numbers. No rechaces la seccion por no ver paginas externas que fueron retiradas deliberadamente.`
    : "";
  console.info("[foreign-trade-documents] OpenAI extraction started", {
    requestId,
    filename,
    fileSize: bytes.byteLength,
    timeoutMs,
    model,
    documentType,
    lineChunkSize,
    rangeConcurrency,
    pdfSkillVersion: skill.version,
    reusedStoredScope: Boolean(trustedScope),
    storedScopePages: trustedScope?.page_numbers || [],
    sharedOpenAiFile: Boolean(temporaryFileId),
    analysisBytes: analysisBytes.byteLength,
  });

  try {
    const headerResult = await callOpenAiStructuredExtraction({
      ...headerCommon,
      stage: "header",
      prompt: skill.headerPrompt + trustedScopeInstruction,
      schemaName: "foreign_trade_document_header",
      schema: headerExtractionSchema,
      maxTokens: Math.min(maxTokens, 5_000),
      timeoutMs: Math.min(timeoutMs, 60_000),
    });
    const detectedHeaderScope = normalizeForeignTradeDocumentScope(asObject(headerResult.data).document_scope, documentType);
    const documentScope = trustedScope || detectedHeaderScope;
    const headerData = { ...asObject(headerResult.data), document_scope: documentScope };
    await onHeader?.(headerData, model);
    if (mimeType === "application/pdf" && !documentScope.detected) {
      throw new HttpError(422, `No se encontró una sección ${documentTypeFileLabel(documentType)} dentro del PDF. Cambia la clasificación o verifica el archivo.`);
    }
    const scopedPdf = preScopedPdf || (mimeType === "application/pdf" && documentScope.detected
      ? await createScopedPdfData(bytes, documentScope.page_numbers, requestId)
      : null);
    if (!preScopedPdf && scopedPdf && temporaryFileId) {
      lineTemporaryFileId = await uploadOpenAiTemporaryFile(
        apiKey,
        scopedPdf.bytes,
        sectionFileName(filename, documentType),
        mimeType,
        requestId,
        requestSignal,
      );
    }
    const lineCommon = lineTemporaryFileId
      ? { ...common, fileId: lineTemporaryFileId, fileData: undefined }
      : common;
    const pageMapping = scopedPdf
      ? scopedPdf.originalPageNumbers.map((page, index) => `${index + 1}→${page}`).join(", ")
      : "";
    const scopeInstruction = documentScope.detected
      ? `\n\nRESTRICCIÓN DE SECCIÓN: trabaja únicamente con las páginas PDF ${documentScope.page_numbers.join(", ")} identificadas como ${documentTypeFileLabel(documentType)}. Ignora cualquier Invoice, Packing List, B/L u otro documento ubicado fuera de esas páginas.${scopedPdf ? ` El archivo recibido en esta pasada ya fue recortado. MAPEO página del archivo→página física original: ${pageMapping}. source_page debe usar siempre la página física original indicada a la derecha del mapeo.` : " source_page debe conservar el número físico del PDF original."}`
      : "";
    const scopedSkill: ForeignTradePdfReadingSkill = {
      ...skill,
      linePrompt: (range, mode) => skill.linePrompt(range, mode) + scopeInstruction,
    };
    const unnumberedPromise = extractUnnumberedRowsSafely(lineCommon, scopedSkill, maxTokens, scopeInstruction);
    const headerTotals = asObject(headerData.document_totals);
    const expectedLineCount = Number(headerTotals.line_count || 0);
    console.info("[foreign-trade-documents] header extraction ready", {
      requestId,
      expectedLineCount,
    });
    const extractionTarget = expectedLineCount > 0 ? Math.min(500, expectedLineCount + 2) : expectedLineCount;
    const ranges = buildExtractionRanges(extractionTarget, lineChunkSize);
    let batches = await mapWithConcurrency(ranges, rangeConcurrency, async (range) => extractLineRangeSafely(lineCommon, scopedSkill, range, maxTokens, "extract"));
    let requestBatches = [...batches];
    let merged = mergeExtractionPasses(headerData, batches);
    console.info("[foreign-trade-documents] first line pass ready", {
      requestId,
      expectedLineCount,
      extractedLineCount: merged.lines.length,
    });
    const recoveryRanges = missingExtractionRanges(expectedLineCount, merged.lines, lineChunkSize);
    if (recoveryRanges.length) {
      console.warn("[foreign-trade-documents] incomplete first pass, recovering ranges", {
        requestId,
        expectedLineCount,
        extractedLineCount: merged.lines.length,
        recoveryRanges,
      });
      const recovered = await mapWithConcurrency(
        recoveryRanges,
        rangeConcurrency,
        async (range) => extractLineRangeSafely(lineCommon, scopedSkill, range, maxTokens, "recover"),
      );
      batches = [...batches, ...recovered];
      requestBatches = [...requestBatches, ...recovered];
      merged = mergeExtractionPasses(headerData, batches);
    }

    let quality = assessPdfExtractionQuality(merged, lineChunkSize);
    if (quality.requiresVerification) {
      console.warn("[foreign-trade-documents] quality verification started", {
        requestId,
        score: quality.score,
        warnings: quality.warnings,
      });
      const verificationRanges = buildExtractionRanges(Math.max(extractionTarget, merged.lines.length), lineChunkSize);
      const verifiedBatches = await mapWithConcurrency(
        verificationRanges,
        rangeConcurrency,
        async (range) => extractCompactLineRangeSafely(lineCommon, scopedSkill, range, maxTokens),
      );
      requestBatches = [...requestBatches, ...verifiedBatches];
      const compactVerification = {
        lines: verifiedBatches.flatMap((batch) => {
          const data = asObject(batch.data);
          return Array.isArray(data.lines) ? data.lines : [];
        }),
        warnings: verifiedBatches.flatMap((batch) => {
          const data = asObject(batch.data);
          return Array.isArray(data.warnings) ? data.warnings : [];
        }),
      };
      const verifiedMerged = mergeCompactVerification(merged, compactVerification);
      const verifiedQuality = assessPdfExtractionQuality(verifiedMerged, lineChunkSize);
      if (verifiedMerged.lines.length >= merged.lines.length && verifiedQuality.score >= quality.score) {
        merged = verifiedMerged;
        quality = verifiedQuality;
      }
      console.info("[foreign-trade-documents] compact verification ready", JSON.stringify({
        requestId,
        extractedLineCount: merged.lines.length,
        score: quality.score,
        warnings: quality.warnings,
      }));
    }

    const unnumberedResult = await unnumberedPromise;
    requestBatches = [...requestBatches, { start: 1, end: 500, data: { _request_id: unnumberedResult.requestId } }];
    merged = mergeUnnumberedRows(merged, unnumberedResult.data);
    quality = assessPdfExtractionQuality(merged, lineChunkSize);

    const extractionWithSkill = {
      ...merged,
      pdf_skill_version: skill.version,
      warnings: [...new Set([...merged.warnings, ...quality.warnings])].slice(0, 30),
    };

    if (quality.critical) {
      throw new HttpError(
        502,
        `La extracción quedó incompleta: se reconocieron ${quality.extractedLineCount} de ${quality.expectedLineCount} productos. Reintenta; el original permanece guardado.`,
      );
    }
    return {
      model,
      requestId: [headerResult.requestId, ...requestBatches.map((batch) => String(asObject(batch.data)._request_id || ""))]
        .filter(Boolean)
        .join(","),
      data: extractionWithSkill,
    };
  } finally {
    if (temporaryFileId) await deleteOpenAiTemporaryFile(apiKey, temporaryFileId, requestId);
    if (lineTemporaryFileId) await deleteOpenAiTemporaryFile(apiKey, lineTemporaryFileId, requestId);
  }
}

async function extractUnnumberedRowsSafely(
  common: Omit<StructuredExtractionInput, "maxTokens" | "stage" | "prompt" | "schemaName" | "schema">,
  skill: ForeignTradePdfReadingSkill,
  maxTokens: number,
  scopeInstruction = "",
) {
  try {
    const result = await callOpenAiStructuredExtraction({
      ...common,
      stage: "scan-unnumbered-rows",
      prompt: `Actúa como segundo revisor de un documento ${skill.documentType}. Recorre visualmente todas las páginas y devuelve EXCLUSIVAMENTE productos comerciales que no tengan número o etiqueta de fila impresa en la primera columna. No devuelvas filas numeradas, encabezados, subtotales ni totales.\n\nPara cada producto sin número, source_index debe ser su posición física contando todas las filas comerciales anteriores, incluidas otras filas sin número; source_row_label debe ser null. Extrae nombre, cantidad, cajas, precio, importe, peso y CBM desde su propia línea. Presta especial atención a productos ubicados entre dos filas numeradas consecutivas. Si no existe ninguno, devuelve lines vacío. Nunca inventes una fila para explicar una diferencia de totales.${scopeInstruction}`,
      schemaName: "foreign_trade_document_unnumbered_rows",
      schema: lineExtractionSchema,
      maxTokens: Math.min(maxTokens, 3_000),
      timeoutMs: Math.min(common.timeoutMs, 35_000),
    });
    console.info("[foreign-trade-documents] unnumbered row scan ready", {
      requestId: common.requestId,
      extractedLineCount: Array.isArray(asObject(result.data).lines) ? (asObject(result.data).lines as unknown[]).length : 0,
    });
    return { requestId: result.requestId, data: result.data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error no identificado";
    console.error("[foreign-trade-documents] unnumbered row scan failed", { requestId: common.requestId, message });
    return {
      requestId: "",
      data: { lines: [], warnings: [`No se pudo completar la búsqueda de filas sin número: ${message}`] },
    };
  }
}

async function extractCompactLineRange(
  common: Omit<StructuredExtractionInput, "maxTokens" | "stage" | "prompt" | "schemaName" | "schema">,
  skill: ForeignTradePdfReadingSkill,
  range: ExtractionRange,
  maxTokens: number,
): Promise<ExtractionLineBatch> {
  const result = await callOpenAiStructuredExtraction({
    ...common,
    stage: `verify-compact-${range.start}-${range.end}`,
    prompt: `${skill.linePrompt(range, "verify")}\n\nDevuelve todas las filas físicas reales del rango, incluidas las que no tengan número impreso. Para esta verificación compacta prioriza identidad, cantidad, cajas, precio, peso bruto y CBM total de cada fila. No inventes filas para completar una secuencia ni omitas una fila por no tener número impreso.`,
    schemaName: "foreign_trade_document_compact_verification",
    schema: compactVerificationSchema,
    maxTokens: Math.min(maxTokens, 3_500),
    timeoutMs: Math.min(common.timeoutMs, 40_000),
  });
  console.info("[foreign-trade-documents] compact line range ready", {
    requestId: common.requestId,
    start: range.start,
    end: range.end,
    extractedLineCount: Array.isArray(asObject(result.data).lines) ? (asObject(result.data).lines as unknown[]).length : 0,
  });
  return { ...range, data: { ...asObject(result.data), _request_id: result.requestId } };
}

async function extractCompactLineRangeSafely(
  common: Omit<StructuredExtractionInput, "maxTokens" | "stage" | "prompt" | "schemaName" | "schema">,
  skill: ForeignTradePdfReadingSkill,
  range: ExtractionRange,
  maxTokens: number,
): Promise<ExtractionLineBatch> {
  try {
    return await extractCompactLineRange(common, skill, range, maxTokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error no identificado";
    console.error("[foreign-trade-documents] compact line range failed", {
      requestId: common.requestId,
      start: range.start,
      end: range.end,
      message,
    });
    return {
      ...range,
      data: {
        lines: [],
        warnings: [`No se pudo verificar el bloque físico ${range.start}-${range.end}: ${message}`],
      },
    };
  }
}

type StructuredExtractionInput = {
  apiKey: string;
  model: string;
  filename: string;
  mimeType: string;
  fileData?: string;
  fileId?: string;
  requestId: string;
  requestSignal: AbortSignal;
  timeoutMs: number;
  maxTokens: number;
  stage: string;
  prompt: string;
  schemaName: string;
  schema: JsonRecord;
};

async function extractLineRange(
  common: Omit<StructuredExtractionInput, "maxTokens" | "stage" | "prompt" | "schemaName" | "schema">,
  skill: ForeignTradePdfReadingSkill,
  range: ExtractionRange,
  maxTokens: number,
  mode: "extract" | "recover" | "verify",
): Promise<ExtractionLineBatch> {
  const result = await callOpenAiStructuredExtraction({
    ...common,
    stage: `${mode}-${range.start}-${range.end}`,
    prompt: skill.linePrompt(range, mode),
    schemaName: "foreign_trade_document_lines",
    schema: lineExtractionSchema,
    maxTokens: Math.min(maxTokens, 8_000),
    timeoutMs: Math.min(common.timeoutMs, 40_000),
  });
  console.info("[foreign-trade-documents] line range ready", {
    requestId: common.requestId,
    mode,
    start: range.start,
    end: range.end,
    extractedLineCount: Array.isArray(asObject(result.data).lines) ? (asObject(result.data).lines as unknown[]).length : 0,
  });
  return {
    ...range,
    data: { ...result.data, _request_id: result.requestId },
  };
}

async function extractLineRangeSafely(
  common: Omit<StructuredExtractionInput, "maxTokens" | "stage" | "prompt" | "schemaName" | "schema">,
  skill: ForeignTradePdfReadingSkill,
  range: ExtractionRange,
  maxTokens: number,
  mode: "extract" | "recover" | "verify",
): Promise<ExtractionLineBatch> {
  try {
    return await extractLineRange(common, skill, range, maxTokens, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error no identificado";
    console.error("[foreign-trade-documents] line range failed", {
      requestId: common.requestId,
      mode,
      start: range.start,
      end: range.end,
      message,
    });
    return {
      ...range,
      data: {
        lines: [],
        warnings: [`No se pudo extraer el bloque físico ${range.start}-${range.end}: ${message}`],
      },
    };
  }
}

async function callOpenAiStructuredExtraction(input: StructuredExtractionInput) {
  if (!input.fileData && !input.fileId) throw new HttpError(500, "La extracción no recibió un archivo válido.");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort();
  if (input.requestSignal.aborted) controller.abort();
  else input.requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          model: input.model,
          store: false,
          max_output_tokens: input.maxTokens,
          input: [{
            role: "user",
            content: [
              input.fileId
                ? { type: "input_file", file_id: input.fileId }
                : { type: "input_file", filename: input.filename, file_data: input.fileData },
              { type: "input_text", text: input.prompt },
            ],
          }],
          text: { format: { type: "json_schema", name: input.schemaName, strict: true, schema: input.schema } },
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as JsonRecord;
      if (response.ok) {
        const outputText = extractOutputText(payload);
        if (!outputText) throw new HttpError(502, "OpenAI no devolvió una extracción estructurada.");
        return {
          requestId: response.headers.get("x-request-id") || String(payload.id || ""),
          data: JSON.parse(outputText) as JsonRecord,
        };
      }
      const apiError = asObject(payload.error);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) {
        throw new HttpError(response.status, String(apiError.message || "OpenAI rechazó la extracción."));
      }
      const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
      const delayMs = Math.min(8_000, Math.max(1_000, retryAfterSeconds * 1_000 || 1_500 * (attempt + 1)));
      console.warn("[foreign-trade-documents] transient OpenAI error, retrying", {
        requestId: input.requestId,
        stage: input.stage,
        status: response.status,
        attempt: attempt + 1,
        delayMs,
      });
      await waitForRetry(delayMs, controller.signal);
    }
    throw new HttpError(502, "OpenAI no completó la extracción después de los reintentos.");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (!timedOut) throw new HttpError(499, "Análisis detenido por el usuario.");
      throw new HttpError(504, `La extracción excedió ${Math.round(input.timeoutMs / 1000)} segundos durante ${input.stage}. El original quedó guardado y puedes reintentar sin subirlo nuevamente.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.requestSignal.removeEventListener("abort", abortFromRequest);
  }
}

async function waitForRetry(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    setTimeout(() => signal.removeEventListener("abort", abort), delayMs + 1);
  });
}

async function uploadOpenAiTemporaryFile(
  apiKey: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  requestId: string,
  requestSignal: AbortSignal,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort();
  if (requestSignal.aborted) controller.abort();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  try {
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", "3600");
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    const response = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) {
      const apiError = asObject(payload.error);
      throw new HttpError(response.status, String(apiError.message || "OpenAI rechazó el PDF temporal."));
    }
    const fileId = String(payload.id || "");
    if (!fileId) throw new HttpError(502, "OpenAI no devolvió el identificador del PDF temporal.");
    if (String(payload.status || "") === "error") throw new HttpError(502, "OpenAI no pudo preparar el PDF temporal.");
    if (String(payload.status || "") === "uploaded") {
      await waitForOpenAiFileReady(apiKey, fileId, requestId, controller.signal);
    }
    console.info("[foreign-trade-documents] temporary PDF uploaded", {
      requestId,
      bytes: bytes.byteLength,
    });
    return fileId;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (!timedOut) throw new HttpError(499, "Análisis detenido por el usuario.");
      throw new HttpError(504, "La preparación del PDF grande excedió 120 segundos. El original quedó guardado para reintentar.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", abortFromRequest);
  }
}

async function waitForOpenAiFileReady(apiKey: string, fileId: string, requestId: string, signal: AbortSignal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await waitForRetry(1_000, signal);
    const response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) throw new HttpError(response.status, "No se pudo comprobar la preparación del PDF temporal.");
    const status = String(payload.status || "");
    if (!status || status === "processed") return;
    if (status === "error") throw new HttpError(502, "OpenAI informó un error al preparar el PDF temporal.");
  }
  console.warn("[foreign-trade-documents] temporary file still reports uploaded status", { requestId, fileId });
}

async function deleteOpenAiTemporaryFile(apiKey: string, fileId: string, requestId: string) {
  try {
    const response = await fetch(`https://api.openai.com/v1/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) console.warn("[foreign-trade-documents] temporary OpenAI file could not be deleted", { requestId, status: response.status });
  } catch (error) {
    console.warn("[foreign-trade-documents] temporary OpenAI file cleanup failed", {
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createScopedPdfData(bytes: Uint8Array, requestedPages: number[], requestId: string) {
  const source = await PDFDocument.load(bytes).catch(() => null);
  if (!source) return null;
  const pageCount = source.getPageCount();
  const originalPageNumbers = [...new Set(requestedPages)]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
    .sort((left, right) => left - right);
  if (!originalPageNumbers.length || originalPageNumbers.length >= pageCount) return null;
  const scoped = await PDFDocument.create();
  const pages = await scoped.copyPages(source, originalPageNumbers.map((page) => page - 1));
  pages.forEach((page) => scoped.addPage(page));
  const scopedBytes = await scoped.save();
  console.info("[foreign-trade-documents] scoped PDF ready", {
    requestId,
    sourcePages: pageCount,
    scopedPages: originalPageNumbers.length,
    sourceBytes: bytes.byteLength,
    scopedBytes: scopedBytes.byteLength,
  });
  return {
    fileData: `data:application/pdf;base64,${bytesToBase64(scopedBytes)}`,
    bytes: scopedBytes,
    originalPageNumbers,
  };
}

const nullableString = { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };
const warningsSchema = { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } };
const documentScopeSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["selected_document_type", "detected", "page_start", "page_end", "page_numbers", "total_pdf_pages", "confidence", "evidence", "warnings"],
  properties: {
    selected_document_type: { type: "string", maxLength: 80 },
    detected: { type: "boolean" },
    page_start: nullableInteger,
    page_end: nullableInteger,
    page_numbers: { type: "array", maxItems: 500, items: { type: "integer", minimum: 1, maximum: 5000 } },
    total_pdf_pages: nullableInteger,
    confidence: nullableNumber,
    evidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300 } },
    warnings: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300 } },
  },
};
const generalSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["supplier_name", "proforma_number", "document_date", "valid_until", "currency", "incoterm", "origin_port", "destination_port", "payment_terms", "production_days", "order_number", "observations", "confidence", "warnings"],
  properties: {
    supplier_name: nullableString, proforma_number: nullableString, document_date: nullableString,
    valid_until: nullableString, currency: nullableString, incoterm: nullableString,
    origin_port: nullableString, destination_port: nullableString, payment_terms: nullableString,
    production_days: nullableInteger, order_number: nullableString, observations: nullableString,
    confidence: nullableNumber, warnings: warningsSchema,
  },
};
const documentTotalsSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["subtotal", "total", "cbm_total", "gross_weight_kg", "net_weight_kg", "boxes", "line_count"],
  properties: {
    subtotal: nullableNumber, total: nullableNumber, cbm_total: nullableNumber,
    gross_weight_kg: nullableNumber, net_weight_kg: nullableNumber, boxes: nullableNumber,
    line_count: { type: "integer", minimum: 0, maximum: 500 },
  },
};
const headerExtractionSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["document_scope", "general", "document_totals", "warnings"],
  properties: {
    document_scope: documentScopeSchema,
    general: generalSchema,
    document_totals: documentTotalsSchema,
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};
const extractedLineSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["source_index", "source_page", "source_row_label", "supplier_product_code", "supplier_sku", "supplier_reference", "sku", "product_name", "description", "description_original", "description_translated", "model", "brand", "technical_attributes", "quantity", "quantity_per_box", "box_count", "currency", "unit_price", "total_price", "unit_weight_kg", "gross_weight_kg", "net_weight_kg", "box_length_cm", "box_width_cm", "box_height_cm", "cbm_per_box", "cbm_total", "country_of_origin", "hs_code", "confidence", "warnings"],
  properties: {
    source_index: { type: "integer", minimum: 1, maximum: 500 }, source_page: nullableInteger,
    source_row_label: nullableString, supplier_product_code: nullableString,
    supplier_sku: nullableString, supplier_reference: nullableString, sku: nullableString,
    product_name: nullableString, description: nullableString,
    description_original: nullableString, description_translated: nullableString,
    model: nullableString, brand: nullableString,
    technical_attributes: { type: "array", maxItems: 30, items: { type: "string", maxLength: 120 } },
    quantity: nullableNumber, quantity_per_box: nullableNumber, box_count: nullableNumber,
    currency: nullableString, unit_price: nullableNumber, total_price: nullableNumber,
    unit_weight_kg: nullableNumber, gross_weight_kg: nullableNumber, net_weight_kg: nullableNumber,
    box_length_cm: nullableNumber, box_width_cm: nullableNumber, box_height_cm: nullableNumber,
    cbm_per_box: nullableNumber, cbm_total: nullableNumber, country_of_origin: nullableString,
    hs_code: nullableString, confidence: nullableNumber, warnings: warningsSchema,
  },
};
const lineExtractionSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "warnings"],
  properties: {
    lines: {
      type: "array",
      maxItems: 80,
      items: extractedLineSchema,
    },
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};
const compactVerifiedLineSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["source_index", "source_page", "source_row_label", "product_name", "quantity", "box_count", "unit_price", "total_price", "gross_weight_kg", "cbm_total", "confidence"],
  properties: {
    source_index: { type: "integer", minimum: 1, maximum: 500 },
    source_page: nullableInteger,
    source_row_label: nullableString,
    product_name: nullableString,
    quantity: nullableNumber,
    box_count: nullableNumber,
    unit_price: nullableNumber,
    total_price: nullableNumber,
    gross_weight_kg: nullableNumber,
    cbm_total: nullableNumber,
    confidence: nullableNumber,
  },
};
const compactVerificationSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["lines", "warnings"],
  properties: {
    lines: { type: "array", maxItems: 500, items: compactVerifiedLineSchema },
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};

const fundRequestGeneralSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["reference", "agency_name", "document_date", "currency", "declared_total_clp", "remittance_amount_clp", "observations", "confidence", "warnings"],
  properties: {
    reference: nullableString,
    agency_name: nullableString,
    document_date: nullableString,
    currency: nullableString,
    declared_total_clp: nullableNumber,
    remittance_amount_clp: nullableNumber,
    observations: nullableString,
    confidence: nullableNumber,
    warnings: warningsSchema,
  },
};
const fundRequestLineSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: [
    "source_index", "source_page", "include", "line_type", "cost_category", "concept",
    "provider_name", "document_number", "document_date", "provision_net_clp",
    "provision_vat_clp", "provision_total_clp", "amount_original", "currency",
    "exchange_rate_clp", "recoverable_tax", "include_in_costing", "confidence", "warnings",
  ],
  properties: {
    source_index: { type: "integer", minimum: 1, maximum: 300 },
    source_page: nullableInteger,
    include: { type: "boolean" },
    line_type: { type: "string", enum: ["operating_expense", "agency_fee", "customs_duty", "import_vat", "adjustment"] },
    cost_category: { type: "string", enum: ["origin", "international_freight", "insurance", "chile_port", "storage", "customs_agency", "national_transport", "inspection", "certificate", "duties", "taxes", "supplier_charge", "other"] },
    concept: nullableString,
    provider_name: nullableString,
    document_number: nullableString,
    document_date: nullableString,
    provision_net_clp: nullableNumber,
    provision_vat_clp: nullableNumber,
    provision_total_clp: nullableNumber,
    amount_original: nullableNumber,
    currency: nullableString,
    exchange_rate_clp: nullableNumber,
    recoverable_tax: { type: "boolean" },
    include_in_costing: { type: "boolean" },
    confidence: nullableNumber,
    warnings: warningsSchema,
  },
};
const fundRequestExtractionSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["general", "lines", "totals", "warnings"],
  properties: {
    general: fundRequestGeneralSchema,
    lines: { type: "array", maxItems: 300, items: fundRequestLineSchema },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["expenses_clp", "taxes_clp", "document_total_clp", "line_count"],
      properties: {
        expenses_clp: nullableNumber,
        taxes_clp: nullableNumber,
        document_total_clp: nullableNumber,
        line_count: { type: "integer", minimum: 0, maximum: 300 },
      },
    },
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};

const freightDocumentGeneralSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["reference", "carrier_name", "document_number", "document_date", "currency", "declared_total_clp", "origin_port", "destination_port", "bill_of_lading", "observations", "confidence", "warnings"],
  properties: {
    reference: nullableString,
    carrier_name: nullableString,
    document_number: nullableString,
    document_date: nullableString,
    currency: nullableString,
    declared_total_clp: nullableNumber,
    origin_port: nullableString,
    destination_port: nullableString,
    bill_of_lading: nullableString,
    observations: nullableString,
    confidence: nullableNumber,
    warnings: warningsSchema,
  },
};
const freightDocumentLineSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: [
    "source_index", "source_page", "include", "cost_category", "concept",
    "provider_name", "document_number", "document_date", "net_clp", "vat_clp",
    "total_clp", "amount_original", "currency", "exchange_rate_clp",
    "recoverable_tax", "include_in_costing", "confidence", "warnings",
  ],
  properties: {
    source_index: { type: "integer", minimum: 1, maximum: 100 },
    source_page: nullableInteger,
    include: { type: "boolean" },
    cost_category: { type: "string", enum: ["origin", "international_freight", "insurance", "chile_port", "storage", "customs_agency", "national_transport", "inspection", "certificate", "supplier_charge", "other"] },
    concept: nullableString,
    provider_name: nullableString,
    document_number: nullableString,
    document_date: nullableString,
    net_clp: nullableNumber,
    vat_clp: nullableNumber,
    total_clp: nullableNumber,
    amount_original: nullableNumber,
    currency: nullableString,
    exchange_rate_clp: nullableNumber,
    recoverable_tax: { type: "boolean" },
    include_in_costing: { type: "boolean" },
    confidence: nullableNumber,
    warnings: warningsSchema,
  },
};
const freightDocumentExtractionSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["general", "lines", "totals", "warnings"],
  properties: {
    general: freightDocumentGeneralSchema,
    lines: { type: "array", maxItems: 100, items: freightDocumentLineSchema },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["net_clp", "vat_clp", "document_total_clp", "line_count"],
      properties: {
        net_clp: nullableNumber,
        vat_clp: nullableNumber,
        document_total_clp: nullableNumber,
        line_count: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};

const agencySettlementGeneralSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["reference", "agency_name", "invoice_number", "document_date", "currency", "declared_total_clp", "observations", "confidence", "warnings"],
  properties: {
    reference: nullableString,
    agency_name: nullableString,
    invoice_number: nullableString,
    document_date: nullableString,
    currency: nullableString,
    declared_total_clp: nullableNumber,
    observations: nullableString,
    confidence: nullableNumber,
    warnings: warningsSchema,
  },
};
const agencySettlementLineSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: [
    "source_index", "source_page", "include", "line_type", "cost_category", "concept",
    "provider_name", "document_number", "document_date", "actual_net_clp",
    "actual_vat_clp", "actual_total_clp", "amount_original", "currency",
    "exchange_rate_clp", "recoverable_tax", "include_in_costing", "confidence", "warnings",
  ],
  properties: {
    source_index: { type: "integer", minimum: 1, maximum: 300 },
    source_page: nullableInteger,
    include: { type: "boolean" },
    line_type: { type: "string", enum: ["operating_expense", "agency_fee", "customs_duty", "import_vat", "adjustment"] },
    cost_category: { type: "string", enum: ["origin", "international_freight", "insurance", "chile_port", "storage", "customs_agency", "national_transport", "inspection", "certificate", "duties", "taxes", "supplier_charge", "other"] },
    concept: nullableString,
    provider_name: nullableString,
    document_number: nullableString,
    document_date: nullableString,
    actual_net_clp: nullableNumber,
    actual_vat_clp: nullableNumber,
    actual_total_clp: nullableNumber,
    amount_original: nullableNumber,
    currency: nullableString,
    exchange_rate_clp: nullableNumber,
    recoverable_tax: { type: "boolean" },
    include_in_costing: { type: "boolean" },
    confidence: nullableNumber,
    warnings: warningsSchema,
  },
};
const agencySettlementExtractionSchema: JsonRecord = {
  type: "object",
  additionalProperties: false,
  required: ["general", "lines", "totals", "warnings"],
  properties: {
    general: agencySettlementGeneralSchema,
    lines: { type: "array", maxItems: 300, items: agencySettlementLineSchema },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["expenses_clp", "taxes_clp", "document_total_clp", "line_count"],
      properties: {
        expenses_clp: nullableNumber,
        taxes_clp: nullableNumber,
        document_total_clp: nullableNumber,
        line_count: { type: "integer", minimum: 0, maximum: 300 },
      },
    },
    warnings: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
  },
};

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  if (!items.length) return [] as R[];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }));
  return results;
}

async function setExtraction(rest: RestClient, documentId: string, status: string, payload: JsonRecord, confidence: number | null, warnings: unknown[], error: string | null, model: string | null, requestId: string) {
  if (status === "extracting") {
    await rpc(rest, "set_foreign_trade_document_extraction", {
      p_document_id: documentId,
      p_status: status,
      p_payload: payload,
      p_confidence: confidence,
      p_warnings: warnings,
      p_error: error,
      p_model: model,
      p_request_id: requestId,
    });
    return;
  }

  const query = `foreign_trade_documents?id=eq.${documentId}&parse_status=eq.extracting&extraction_request_id=eq.${encodeURIComponent(requestId)}`;
  const update = status === "review_required"
    ? {
      parse_status: status,
      extraction_result: payload,
      extraction_confidence: confidence,
      review_warnings: warnings,
      extraction_model: model,
      extraction_completed_at: new Date().toISOString(),
      extraction_error: null,
    }
    : {
      parse_status: "failed",
      extraction_completed_at: new Date().toISOString(),
      extraction_error: String(error || "Error de extracción").slice(0, 2_000),
    };
  const updated = await patchRowsReturning(rest, query, update);
  if (!updated.length) throw new HttpError(409, "foreign_trade_document_request_stale_or_unavailable");
}

async function persistDetectedDocumentScope(
  rest: RestClient,
  documentId: string,
  requestId: string,
  scope: ReturnType<typeof normalizeForeignTradeDocumentScope>,
  model: string,
) {
  const query = `foreign_trade_documents?id=eq.${documentId}&parse_status=eq.extracting&extraction_request_id=eq.${encodeURIComponent(requestId)}`;
  await patchRows(rest, query, {
    extraction_result: {
      extraction_version: FOREIGN_TRADE_EXTRACTION_VERSION,
      pdf_skill_version: FOREIGN_TRADE_PDF_SKILL_VERSION,
      document_scope: scope,
    },
    extraction_model: model,
  }).catch((error) => {
    console.warn("[foreign-trade-documents] early document scope was not persisted", {
      requestId,
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function persistDiscoveredDocumentScope(
  rest: RestClient,
  document: JsonRecord,
  scope: ReturnType<typeof normalizeForeignTradeDocumentScope>,
  model: string,
) {
  const status = String(document.parse_status || "");
  if (!["uploaded", "failed", "extracting", "review_required"].includes(status)) return;
  const previous = asObject(document.extraction_result);
  await patchRows(rest, `foreign_trade_documents?id=eq.${String(document.id)}&parse_status=eq.${status}`, {
    extraction_result: {
      ...previous,
      extraction_version: FOREIGN_TRADE_EXTRACTION_VERSION,
      pdf_skill_version: FOREIGN_TRADE_PDF_SKILL_VERSION,
      document_scope: scope,
    },
    extraction_model: model,
  }).catch((error) => {
    console.warn("[foreign-trade-documents] discovered document scope was not persisted", {
      documentId: String(document.id),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function isPdfDocumentRecord(document: JsonRecord) {
  return String(document.mime_type || "").toLowerCase().includes("pdf")
    || /\.pdf$/i.test(String(document.original_file_name || ""));
}

function isSectionAwareDocumentType(documentType: string) {
  return ["commercial_invoice", "packing_list", "bill_of_lading"].includes(documentType);
}

function normalizeScopeForPdf(
  rawScope: ReturnType<typeof normalizeForeignTradeDocumentScope>,
  pageCount: number,
) {
  const scope = {
    ...rawScope,
    total_pdf_pages: pageCount,
    page_numbers: [...new Set(rawScope.page_numbers)]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
      .sort((left, right) => left - right),
  };
  scope.page_start = scope.page_numbers.length ? Math.min(...scope.page_numbers) : null;
  scope.page_end = scope.page_numbers.length ? Math.max(...scope.page_numbers) : null;
  scope.detected = scope.detected && scope.page_numbers.length > 0;
  return scope;
}

function normalizeManualPageNumbers(value: unknown, pageCount: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number))]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
    .sort((left, right) => left - right);
}

function preferredStoredDocumentScope(document: JsonRecord, documentType: string) {
  const reviewScope = normalizeForeignTradeDocumentScope(
    asObject(document.review_result).document_scope,
    documentType,
  );
  if (reviewScope.detected) return reviewScope;
  const extractionScope = normalizeForeignTradeDocumentScope(
    asObject(document.extraction_result).document_scope,
    documentType,
  );
  return extractionScope.detected ? extractionScope : null;
}

async function downloadPrivateFile(rest: RestClient, bucket: string, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${rest.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, {
    headers: serviceHeaders(rest),
  });
  if (!response.ok) throw new HttpError(response.status, "No se pudo leer el archivo privado desde Storage.");
  return new Uint8Array(await response.arrayBuffer());
}

async function authenticateRequest(req: Request, rest: RestClient) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Debes iniciar sesión.");
  const response = await fetch(`${rest.url}/auth/v1/user`, { headers: { apikey: rest.anonKey, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new HttpError(401, "Sesión inválida o expirada.");
  const user = await response.json() as JsonRecord;
  const id = String(user.id || "");
  if (!id) throw new HttpError(401, "Sesión sin usuario válido.");
  return { id };
}

async function getProfile(rest: RestClient, userId: string): Promise<Profile | null> {
  const rows = await selectRows(rest, `profiles?select=id,role,active&id=eq.${userId}&limit=1`);
  const row = rows[0];
  return row ? { id: String(row.id), role: String(row.role), active: row.active !== false } : null;
}

async function selectRows(rest: RestClient, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${rest.url}/rest/v1/${path}`, { headers: serviceHeaders(rest) });
  if (!response.ok) throw new HttpError(response.status, `No se pudieron leer los datos privados: ${(await response.text()).slice(0, 300)}`);
  return await response.json() as JsonRecord[];
}

async function patchRows(rest: RestClient, path: string, payload: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new HttpError(response.status, `No se pudo conservar la identificación de páginas: ${(await response.text()).slice(0, 300)}`);
  }
}

async function patchRowsReturning(rest: RestClient, path: string, payload: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new HttpError(response.status, `No se pudo actualizar el estado de extracción: ${(await response.text()).slice(0, 300)}`);
  }
  return await response.json().catch(() => []) as JsonRecord[];
}

async function rpc(rest: RestClient, fn: string, body: JsonRecord) {
  const response = await fetch(`${rest.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...serviceHeaders(rest), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const details = data && typeof data === "object" ? String((data as JsonRecord).message || "") : "";
    throw new HttpError(response.status, details || `No se pudo ejecutar ${fn}.`);
  }
  return data;
}

function getRestClient(): RestClient {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  if (!url || !anonKey || !serviceRoleKey) throw new HttpError(500, "Faltan variables internas de Supabase.");
  return { url, anonKey, serviceRoleKey };
}

function serviceHeaders(rest: RestClient) {
  return { apikey: rest.serviceRoleKey, Authorization: `Bearer ${rest.serviceRoleKey}` };
}

function getRoute(url: string) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const index = parts.lastIndexOf("foreign-trade-documents");
  return index >= 0 ? parts.slice(index + 1).join("/") : parts.at(-1) || "";
}

function corsHeaders(req: Request) {
  const appOrigin = Deno.env.get("CRM_APP_URL")?.trim() || "http://localhost:5173";
  const configuredOrigin = new URL(appOrigin).origin;
  const origin = req.headers.get("origin") || "";
  const localOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
  return {
    "Access-Control-Allow-Origin": origin === configuredOrigin || localOrigin ? origin : configuredOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Disposition, X-Document-Pages, X-Document-Total-Pages",
  };
}

function json(data: unknown, status: number, req: Request) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" } });
}

async function readJson(req: Request): Promise<JsonRecord> {
  const size = Number(req.headers.get("content-length") || 0);
  if (size > 100_000) throw new HttpError(413, "Solicitud demasiado grande.");
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "El cuerpo debe ser JSON.");
  return body as JsonRecord;
}

function requiredUuid(value: unknown, label: string) {
  const result = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new HttpError(400, `Identificador de ${label} inválido.`);
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function documentTypeFileLabel(documentType: string) {
  return ({
    commercial_invoice: "Commercial Invoice",
    packing_list: "Packing List",
    bill_of_lading: "Bill of Lading",
    proforma: "Proforma",
    purchase_order: "Purchase Order",
  } as Record<string, string>)[documentType] || "documento seleccionado";
}

function sectionFileName(originalName: string, documentType: string) {
  const base = originalName.replace(/\.pdf$/i, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "documento";
  const suffix = documentTypeFileLabel(documentType).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${base}-${suffix}.pdf`;
}

function extractOutputText(payload: JsonRecord) {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    const content = Array.isArray(asObject(item).content) ? asObject(item).content as unknown[] : [];
    for (const part of content) {
      const block = asObject(part);
      if (block.type === "output_text" && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
