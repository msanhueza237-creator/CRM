import { Upload } from "tus-js-client";
import { getSupabaseAnonKey, getSupabaseFunctionUrl, getSupabaseStorageUrl, isSupabaseConfigured, supabase } from "./supabase";
import type {
  CreateForeignTradeOperationInput,
  ForeignTradeAuditEvent,
  ForeignTradeCenterData,
  ForeignTradeContainerType,
  ForeignTradeCatalogProduct,
  ForeignTradeCostLine,
  ForeignTradeCostParameter,
  ForeignTradeDashboardSummary,
  ForeignTradeDocument,
  ForeignTradeDocumentExtraction,
  ForeignTradeAgencySettlementExtraction,
  ForeignTradeFundRequestExtraction,
  ForeignTradeFreightDocumentExtraction,
  ForeignTradeDocumentScope,
  ForeignTradeDocumentType,
  ForeignTradeOperation,
  ForeignTradeOperationDetail,
  ForeignTradeOperationLine,
  ForeignTradeOperationStatus,
  ForeignTradeSupplier,
  SaveForeignTradeCostingScenarioInput,
  UpsertForeignTradeCostLineInput,
  UpsertForeignTradeOperationLineInput,
  UpsertForeignTradeSupplierInput,
  ConfirmForeignTradeDocumentResult,
  ConfirmForeignTradeFundRequestResult,
  ConfirmForeignTradeAgencySettlementResult,
  ConfirmForeignTradeFreightDocumentResult,
  ApplyForeignTradeExpenseReconciliationResult,
  AutoFinalizeForeignTradeOperationResult,
  AutoFinalizeForeignTradeReconciliationResult,
  ForeignTradeExpenseReconciliation,
  ForeignTradeProductReconciliationResult,
  SaveForeignTradeExpenseReconciliationInput,
} from "../types/foreignTrade";

const emptySummary: ForeignTradeDashboardSummary = {
  operations_in_preparation: 0,
  proformas: 0,
  purchase_orders: 0,
  active_shipments: 0,
  suppliers: 0,
  total_purchase_usd: 0,
  projected_import_cost_clp: 0,
  projected_profit_clp: 0,
  total_cbm: 0,
  product_lines: 0,
  open_alerts: 0,
  recent_simulations: [],
};

export const FOREIGN_TRADE_MAX_FILE_BYTES = 50 * 1024 * 1024;
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
const UPLOAD_INACTIVITY_TIMEOUT_MS = 60_000;
const UPLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000;

type ForeignTradeUploadStage = "preparing" | "resumable" | "compatible";

function normalizeSupabaseResumableUploadUrl(uploadUrl: string | null) {
  if (!uploadUrl) return null;
  try {
    const publicStorageUrl = new URL(getSupabaseStorageUrl());
    const candidate = new URL(uploadUrl, `${publicStorageUrl.toString().replace(/\/+$/, "")}/`);
    if (candidate.hostname !== publicStorageUrl.hostname) return null;

    const storagePath = publicStorageUrl.pathname.replace(/\/+$/, "");
    if (!candidate.pathname.startsWith(`${storagePath}/`)) {
      if (!candidate.pathname.startsWith("/upload/resumable")) return null;
      candidate.pathname = `${storagePath}${candidate.pathname}`;
    }

    candidate.protocol = publicStorageUrl.protocol;
    candidate.host = publicStorageUrl.host;
    candidate.username = "";
    candidate.password = "";
    return candidate.toString();
  } catch {
    return null;
  }
}

export const emptyForeignTradeCenterData: ForeignTradeCenterData = {
  summary: emptySummary,
  operations: [],
  statuses: [],
  suppliers: [],
  containerTypes: [],
  costParameters: [],
  audit: [],
};

export async function getForeignTradeCenterData(): Promise<ForeignTradeCenterData> {
  if (!isSupabaseConfigured || !supabase) return emptyForeignTradeCenterData;

  const [summaryResult, operationResult, statusResult, supplierResult, containerResult, parameterResult, auditResult] = await Promise.all([
    supabase.rpc("foreign_trade_dashboard_summary"),
    supabase
      .from("import_shipments")
      .select("id,supplier_id,reference,title,operation_type,transport_type,origin_port,destination_port,status,value_usd,base_currency,exchange_rate_clp,exchange_rate_source,incoterm,target_container_cbm,order_date,estimated_departure,estimated_arrival,notes,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(300),
    supabase.from("foreign_trade_operation_statuses").select("*").order("sort_order"),
    supabase
      .from("suppliers")
      .select("id,name,company_name,country_code,factory_city,contact_name,email,whatsapp,phone,currency,usual_incoterms,payment_terms,default_production_days,notes,active,created_at,updated_at")
      .order("name"),
    supabase.from("foreign_trade_container_types").select("*").eq("active", true).order("name"),
    supabase.from("foreign_trade_cost_parameters").select("*").eq("active", true).order("category").order("name"),
    supabase.from("foreign_trade_audit_log").select("*").order("created_at", { ascending: false }).limit(100),
  ]);

  const error = summaryResult.error || operationResult.error || statusResult.error || supplierResult.error ||
    containerResult.error || parameterResult.error || auditResult.error;
  if (error) throw error;

  return {
    summary: normalizeSummary(summaryResult.data),
    operations: (operationResult.data ?? []) as unknown as ForeignTradeOperation[],
    statuses: (statusResult.data ?? []) as unknown as ForeignTradeOperationStatus[],
    suppliers: (supplierResult.data ?? []) as unknown as ForeignTradeSupplier[],
    containerTypes: (containerResult.data ?? []) as unknown as ForeignTradeContainerType[],
    costParameters: (parameterResult.data ?? []) as unknown as ForeignTradeCostParameter[],
    audit: (auditResult.data ?? []) as unknown as ForeignTradeAuditEvent[],
  };
}

export async function createForeignTradeOperation(input: CreateForeignTradeOperationInput) {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para crear una simulacion privada.");
  }
  const payload = {
    title: input.title.trim(),
    reference: input.reference?.trim() || null,
    operation_type: input.operationType,
    supplier_id: input.supplierId || null,
    status: input.status,
    transport_type: input.transportType,
    origin_port: input.originPort?.trim() || null,
    destination_port: input.destinationPort?.trim() || null,
    base_currency: input.baseCurrency.trim().toUpperCase() || "USD",
    exchange_rate_clp: decimalOrNull(input.exchangeRateClp),
    exchange_rate_source: input.exchangeRateSource,
    incoterm: input.incoterm?.trim().toUpperCase() || null,
    target_container_cbm: decimalOrNull(input.targetContainerCbm),
    value_usd: decimalOrNull(input.valueUsd) || "0",
    notes: input.notes?.trim() || null,
  };
  const { data, error } = await supabase.rpc("create_foreign_trade_operation", { p_payload: payload });
  if (error) throw error;
  return String(data);
}

export async function getForeignTradeOperationDetail(operationId: string): Promise<ForeignTradeOperationDetail> {
  requireSupabase();
  const { data, error } = await supabase!.rpc("foreign_trade_operation_detail", { p_operation_id: operationId });
  if (error) throw error;
  return normalizeOperationDetail(data);
}

export async function searchForeignTradeCatalog(search = ""): Promise<ForeignTradeCatalogProduct[]> {
  requireSupabase();
  const { data, error } = await supabase!.rpc("foreign_trade_product_catalog", {
    p_search: search.trim() || null,
    p_limit: 60,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as ForeignTradeCatalogProduct[];
}

export async function upsertForeignTradeSupplier(input: UpsertForeignTradeSupplierInput) {
  requireSupabase();
  const payload = {
    id: input.id || null,
    name: input.name.trim(),
    company_name: input.companyName?.trim() || null,
    country_code: input.countryCode.trim().toUpperCase(),
    factory_city: input.factoryCity?.trim() || null,
    contact_name: input.contactName?.trim() || null,
    email: input.email?.trim() || null,
    whatsapp: input.whatsapp?.trim() || null,
    phone: input.phone?.trim() || null,
    currency: input.currency.trim().toUpperCase(),
    usual_incoterms: input.usualIncoterms,
    payment_terms: input.paymentTerms?.trim() || null,
    default_production_days: integerString(input.defaultProductionDays, "días de producción"),
    notes: input.notes?.trim() || null,
    active: input.active,
  };
  const { data, error } = await supabase!.rpc("upsert_foreign_trade_supplier", { p_payload: payload });
  if (error) throw error;
  return String(data);
}

export async function upsertForeignTradeOperationLine(input: UpsertForeignTradeOperationLineInput) {
  requireSupabase();
  const payload = {
    id: input.id || null,
    operation_id: input.operationId,
    content_product_id: input.contentProductId || null,
    supplier_product_id: input.supplierProductId || null,
    product_name: input.productName.trim(),
    sku: input.sku?.trim() || null,
    supplier_sku: input.supplierSku?.trim() || null,
    supplier_model: input.supplierModel?.trim() || null,
    description: input.description?.trim() || null,
    temporary_product: input.temporaryProduct,
    remember_link: input.rememberLink,
    quantity: decimal(input.quantity, "cantidad", true) || "0",
    quantity_per_box: decimal(input.quantityPerBox, "unidades por caja"),
    box_count: decimal(input.boxCount, "cantidad de cajas"),
    currency: input.currency.trim().toUpperCase(),
    unit_factory_cost: decimal(input.unitFactoryCost, "costo unitario"),
    exw_total: decimal(input.exwTotal, "total EXW"),
    fob_total: decimal(input.fobTotal, "total FOB"),
    cif_total: decimal(input.cifTotal, "total CIF"),
    discount_total: decimal(input.discountTotal, "descuento"),
    supplier_charges_total: decimal(input.supplierChargesTotal, "cargos del proveedor"),
    unit_weight_kg: decimal(input.unitWeightKg, "peso unitario"),
    gross_weight_kg: decimal(input.grossWeightKg, "peso bruto"),
    net_weight_kg: decimal(input.netWeightKg, "peso neto"),
    box_length_cm: decimal(input.boxLengthCm, "largo de caja"),
    box_width_cm: decimal(input.boxWidthCm, "ancho de caja"),
    box_height_cm: decimal(input.boxHeightCm, "alto de caja"),
    cbm_per_box: decimal(input.cbmPerBox, "CBM por caja"),
    cbm_total: decimal(input.cbmTotal, "CBM total"),
    hs_code: input.hsCode?.trim() || null,
    country_of_origin: input.countryOfOrigin?.trim().toUpperCase() || null,
    data_source: input.dataSource,
  };
  const { data, error } = await supabase!.rpc("upsert_foreign_trade_operation_line", { p_payload: payload });
  if (error) throw error;
  return String(data);
}

export async function deleteForeignTradeOperationLine(lineId: string) {
  requireSupabase();
  const { error } = await supabase!.rpc("delete_foreign_trade_operation_line", { p_line_id: lineId });
  if (error) throw error;
}

export async function upsertForeignTradeCostLine(input: UpsertForeignTradeCostLineInput) {
  requireSupabase();
  const payload = {
    id: input.id || null,
    operation_id: input.operationId,
    scenario_id: input.scenarioId || null,
    operation_line_id: input.operationLineId || null,
    category: input.category,
    name: input.name.trim(),
    amount_original: decimal(input.amountOriginal, "monto", true) || "0",
    currency: input.currency.trim().toUpperCase(),
    exchange_rate_clp: decimal(input.exchangeRateClp, "tipo de cambio"),
    allocation_method: input.allocationMethod,
    source_type: input.sourceType,
    recoverable_tax: input.recoverableTax,
    metadata: {
      amount_basis: input.amountBasis || "net",
      vat_rate_percent: decimal(input.vatRatePercent, "IVA del gasto") || "0",
    },
    notes: input.notes?.trim() || null,
  };
  const { data, error } = await supabase!.rpc("upsert_foreign_trade_cost_line", { p_payload: payload });
  if (error) throw error;
  return String(data);
}

export async function deleteForeignTradeCostLine(costId: string) {
  requireSupabase();
  const { error } = await supabase!.rpc("delete_foreign_trade_cost_line", { p_cost_id: costId });
  if (error) throw error;
}

export async function saveForeignTradeCostingScenario(input: SaveForeignTradeCostingScenarioInput) {
  requireSupabase();
  const payload = {
    id: input.id || null,
    operation_id: input.operationId,
    name: input.name.trim(),
    status: input.status,
    exchange_rate_clp: input.exchangeRateClp,
    exchange_rate_source: input.exchangeRateSource,
    allocation_method: input.allocationMethod,
    assumptions: { costing: input.assumptions },
    merchandise_total_original: input.merchandiseTotalOriginal,
    merchandise_total_clp: input.merchandiseTotalClp,
    logistics_total_clp: input.logisticsTotalClp,
    duties_total_clp: input.dutiesTotalClp,
    taxes_total_clp: input.taxesTotalClp,
    landed_total_clp: input.landedTotalClp,
    projected_sales_clp: input.projectedSalesClp,
    projected_profit_clp: input.projectedProfitClp,
    projected_margin_percent: input.projectedMarginPercent,
    missing_inputs: input.missingInputs,
    calculation_version: "cl_import_cost_v1",
  };
  const { data, error } = await supabase!.rpc("save_foreign_trade_costing_scenario", { p_payload: payload });
  if (error) throw error;
  return String(data);
}

export async function getForeignTradeDocuments(operationId: string): Promise<ForeignTradeDocument[]> {
  requireSupabase();
  const { data, error } = await supabase!.rpc("foreign_trade_document_list", { p_operation_id: operationId });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as ForeignTradeDocument[];
}

export async function getForeignTradeExpenseReconciliations(operationId: string): Promise<ForeignTradeExpenseReconciliation[]> {
  requireSupabase();
  const { data, error } = await supabase!.rpc("foreign_trade_expense_reconciliation_list", {
    p_operation_id: operationId,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as ForeignTradeExpenseReconciliation[];
}

export async function saveForeignTradeExpenseReconciliation(input: SaveForeignTradeExpenseReconciliationInput) {
  requireSupabase();
  const payload = {
    id: input.id || null,
    operation_id: input.operation_id,
    title: input.title.trim(),
    agency_name: input.agency_name?.trim() || null,
    provision_document_id: input.provision_document_id || null,
    final_document_id: input.final_document_id || null,
    general_estimate_cost_line_id: input.general_estimate_cost_line_id || null,
    provision_reference: input.provision_reference?.trim() || null,
    final_reference: input.final_reference?.trim() || null,
    agency_invoice_number: input.agency_invoice_number?.trim() || null,
    remittance_date: input.remittance_date || null,
    final_invoice_date: input.final_invoice_date || null,
    remittance_amount_clp: decimalInput(input.remittance_amount_clp, "monto depositado"),
    refund_received_clp: decimalInput(input.refund_received_clp, "devolución recibida"),
    refund_received_at: input.refund_received_at || null,
    status: input.status,
    identity_confirmed: input.identity_confirmed,
    notes: input.notes?.trim() || null,
    metadata: input.metadata || {},
    lines: input.lines.map((line, index) => ({
      id: line.id || null,
      position: index,
      line_type: line.line_type,
      cost_category: line.cost_category,
      concept: line.concept.trim(),
      provider_name: line.provider_name?.trim() || null,
      document_number: line.document_number?.trim() || null,
      document_date: line.document_date || null,
      source_page: integerOrNull(line.source_page, "página de respaldo"),
      provision_cost_line_id: line.provision_cost_line_id || null,
      provision_net_clp: decimalInput(line.provision_net_clp, "neto provisionado"),
      provision_vat_clp: decimalInput(line.provision_vat_clp, "IVA provisionado"),
      provision_total_clp: decimalInput(line.provision_total_clp, "total provisionado"),
      provision_amount_original: decimalInputWithScale(line.provision_amount_original, "monto original provisionado", 6),
      provision_currency: currencyInput(line.provision_currency, "moneda provisionada"),
      provision_exchange_rate_clp: optionalDecimalInputWithScale(line.provision_exchange_rate_clp, "tipo de cambio provisionado", 6),
      actual_net_clp: decimalInput(line.actual_net_clp, "neto real"),
      actual_vat_clp: decimalInput(line.actual_vat_clp, "IVA real"),
      actual_total_clp: decimalInput(line.actual_total_clp, "total real"),
      actual_amount_original: decimalInputWithScale(line.actual_amount_original, "monto original real", 6),
      actual_currency: currencyInput(line.actual_currency, "moneda real"),
      actual_exchange_rate_clp: optionalDecimalInputWithScale(line.actual_exchange_rate_clp, "tipo de cambio real", 6),
      recoverable_tax: line.recoverable_tax,
      include_in_costing: line.include_in_costing,
      notes: line.notes?.trim() || null,
      metadata: line.metadata || {},
    })),
  };
  const { data, error } = await supabase!.rpc("save_foreign_trade_expense_reconciliation", { p_payload: payload });
  if (error) throw error;
  return String(data);
}

export async function applyForeignTradeExpenseReconciliation(reconciliationId: string) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("apply_foreign_trade_expense_reconciliation", {
    p_reconciliation_id: reconciliationId,
  });
  if (error) throw error;
  return data as ApplyForeignTradeExpenseReconciliationResult;
}

export async function autoFinalizeForeignTradeExpenseReconciliation(reconciliationId: string) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("auto_finalize_foreign_trade_expense_reconciliation", {
    p_reconciliation_id: reconciliationId,
    p_apply_costs: true,
  });
  if (error) throw error;
  return data as AutoFinalizeForeignTradeReconciliationResult;
}

export async function autoFinalizeForeignTradeOperation(operationId: string) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("auto_finalize_foreign_trade_operation", {
    p_operation_id: operationId,
  });
  if (error) throw error;
  return data as AutoFinalizeForeignTradeOperationResult;
}

export async function uploadForeignTradeDocument(input: {
  operationId: string;
  supplierId?: string | null;
  documentType: ForeignTradeDocumentType;
  file: File;
  onUploadProgress?: (progress: number) => void;
  onUploadStage?: (stage: ForeignTradeUploadStage) => void;
  signal?: AbortSignal;
}) {
  requireSupabase();
  const extension = input.file.name.split(".").pop()?.toLowerCase() || "";
  if (!["pdf", "xls", "xlsx", "csv"].includes(extension)) throw new Error("Selecciona un PDF, Excel o CSV.");
  if (input.file.size <= 0 || input.file.size > FOREIGN_TRADE_MAX_FILE_BYTES) throw new Error("El archivo debe pesar entre 1 byte y 50 MB.");
  const mimeType = input.file.type || ({
    pdf: "application/pdf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
  } as Record<string, string>)[extension];
  const cleanName = input.file.name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(-180);
  const storagePath = `${input.operationId}/${crypto.randomUUID()}-${cleanName}`;
  throwIfUploadAborted(input.signal);
  input.onUploadStage?.("preparing");
  const fileHashPromise = sha256(input.file);
  await uploadForeignTradeOriginal(
    storagePath,
    input.file,
    mimeType,
    input.onUploadProgress,
    input.onUploadStage,
    input.signal,
  );
  const fileHash = await fileHashPromise;
  throwIfUploadAborted(input.signal);

  try {
    const { data, error } = await supabase!.rpc("register_foreign_trade_document", {
      p_payload: {
        operation_id: input.operationId,
        supplier_id: input.supplierId || null,
        document_type: input.documentType,
        original_file_name: input.file.name,
        storage_path: storagePath,
        mime_type: mimeType,
        file_size: String(input.file.size),
        file_hash: fileHash,
      },
    });
    if (error) throw error;
    return String(data);
  } catch (error) {
    await supabase!.storage.from("foreign-trade-orders").remove([storagePath]);
    throw error;
  }
}

async function uploadForeignTradeOriginal(
  storagePath: string,
  file: File,
  mimeType: string,
  onProgress?: (progress: number) => void,
  onStage?: (stage: ForeignTradeUploadStage) => void,
  signal?: AbortSignal,
) {
  const credentials = await getForeignTradeUploadCredentials();
  throwIfUploadAborted(signal);
  if (file.size <= RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
    onStage?.("compatible");
    await uploadForeignTradeOriginalCompatible(storagePath, file, mimeType, credentials, onProgress, signal);
    return;
  }

  onStage?.("resumable");
  try {
    await uploadForeignTradeOriginalResumable(storagePath, file, mimeType, credentials, onProgress, signal);
  } catch (error) {
    if (isUploadAbortError(error) || /foreign_trade_storage_limit_not_updated|foreign_trade_upload_auth_failed/i.test(String(error))) {
      throw error;
    }
    throwIfUploadAborted(signal);
    onStage?.("compatible");
    onProgress?.(0);
    await uploadForeignTradeOriginalCompatible(storagePath, file, mimeType, credentials, onProgress, signal);
  }
}

async function getForeignTradeUploadCredentials() {
  const { data, error } = await supabase!.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  const anonKey = getSupabaseAnonKey();
  if (!token) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  if (!anonKey) throw new Error("Falta configurar VITE_SUPABASE_ANON_KEY.");
  return { token, anonKey };
}

async function uploadForeignTradeOriginalResumable(
  storagePath: string,
  file: File,
  mimeType: string,
  credentials: { token: string; anonKey: string },
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let inactivityTimer = 0;
    let totalTimer = 0;
    let upload: Upload | null = null;

    const cleanup = () => {
      window.clearTimeout(inactivityTimer);
      window.clearTimeout(totalTimer);
      signal?.removeEventListener("abort", abortUpload);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abortUpload = () => {
      void upload?.abort().finally(() => finish(createUploadAbortError()));
    };
    const timeoutUpload = (code: string) => {
      void upload?.abort().finally(() => finish(new Error(code)));
    };
    const refreshInactivityTimer = () => {
      window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(() => timeoutUpload("foreign_trade_resumable_upload_stalled"), UPLOAD_INACTIVITY_TIMEOUT_MS);
    };

    if (signal?.aborted) {
      finish(createUploadAbortError());
      return;
    }
    signal?.addEventListener("abort", abortUpload, { once: true });
    totalTimer = window.setTimeout(() => timeoutUpload("foreign_trade_resumable_upload_timeout"), UPLOAD_TOTAL_TIMEOUT_MS);
    refreshInactivityTimer();

    upload = new Upload(file, {
      endpoint: getSupabaseStorageUrl("upload/resumable"),
      retryDelays: [0, 2_000, 5_000],
      headers: {
        authorization: `Bearer ${credentials.token}`,
        apikey: credentials.anonKey,
      },
      uploadDataDuringCreation: false,
      storeFingerprintForResuming: false,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: "foreign-trade-orders",
        objectName: storagePath,
        contentType: mimeType,
        cacheControl: "3600",
      },
      onUploadUrlAvailable: () => {
        refreshInactivityTimer();
        const normalizedUrl = normalizeSupabaseResumableUploadUrl(upload?.url || null);
        if (!normalizedUrl || !upload) {
          timeoutUpload("foreign_trade_resumable_endpoint_invalid");
          return;
        }
        upload.url = normalizedUrl;
      },
      onBeforeRequest: () => refreshInactivityTimer(),
      onAfterResponse: () => refreshInactivityTimer(),
      onProgress: (bytesUploaded, bytesTotal) => {
        refreshInactivityTimer();
        onProgress?.(bytesTotal > 0 ? bytesUploaded / bytesTotal : 0);
      },
      onError: (error) => {
        const message = String(error.message || "");
        if (/\b413\b|maximum size|payload too large|request entity too large/i.test(message)) {
          finish(new Error("foreign_trade_storage_limit_not_updated"));
          return;
        }
        if (/\b401\b|\b403\b|jwt|unauthorized|forbidden/i.test(message)) {
          finish(new Error("foreign_trade_upload_auth_failed"));
          return;
        }
        finish(new Error(`foreign_trade_resumable_endpoint_unreachable: ${message}`));
      },
      onSuccess: () => {
        onProgress?.(1);
        finish();
      },
    });
    upload.start();
  });
}

async function uploadForeignTradeOriginalCompatible(
  storagePath: string,
  file: File,
  mimeType: string,
  credentials: { token: string; anonKey: string },
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
) {
  throwIfUploadAborted(signal);
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  const uploadUrl = getSupabaseStorageUrl(`object/foreign-trade-orders/${encodedPath}`);
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abortUpload);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abortUpload = () => request.abort();

    request.open("POST", uploadUrl, true);
    request.timeout = UPLOAD_TOTAL_TIMEOUT_MS;
    request.setRequestHeader("Authorization", `Bearer ${credentials.token}`);
    request.setRequestHeader("apikey", credentials.anonKey);
    request.setRequestHeader("Content-Type", mimeType);
    request.setRequestHeader("x-upsert", "false");
    request.upload.onprogress = (event) => onProgress?.(event.lengthComputable && event.total > 0 ? event.loaded / event.total : 0);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(1);
        finish();
        return;
      }
      const detail = parseStorageUploadError(request.responseText);
      if (request.status === 413) finish(new Error("foreign_trade_storage_limit_not_updated"));
      else if (request.status === 401 || request.status === 403) finish(new Error("foreign_trade_upload_auth_failed"));
      else finish(new Error(`No se pudo guardar el archivo (${request.status}): ${detail}`));
    };
    request.onerror = () => finish(new Error("foreign_trade_compatible_upload_network_error"));
    request.ontimeout = () => finish(new Error("foreign_trade_compatible_upload_timeout"));
    request.onabort = () => finish(createUploadAbortError());
    signal?.addEventListener("abort", abortUpload, { once: true });
    request.send(file);
  });
}

function parseStorageUploadError(responseText: string) {
  try {
    const payload = JSON.parse(responseText) as { message?: string; error?: string };
    return payload.message || payload.error || "respuesta no reconocida";
  } catch {
    return responseText.slice(0, 240) || "respuesta vacía";
  }
}

function createUploadAbortError() {
  return new DOMException("Carga detenida por el usuario.", "AbortError");
}

function throwIfUploadAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createUploadAbortError();
}

function isUploadAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export async function extractForeignTradeDocument(documentId: string, signal?: AbortSignal) {
  return foreignTradeDocumentRequest<{
    documentId: string;
    status: "extracting";
    requestId: string;
  }>("extract", { document_id: documentId }, signal);
}

export async function detectForeignTradeDocumentSection(documentId: string, signal?: AbortSignal) {
  return foreignTradeDocumentRequest<{
    documentId: string;
    status: string;
    scope: ForeignTradeDocumentScope;
  }>("detect-section", { document_id: documentId }, signal);
}

export async function setForeignTradeDocumentSection(documentId: string, pageNumbers: number[]) {
  return foreignTradeDocumentRequest<{
    documentId: string;
    status: string;
    scope: ForeignTradeDocumentScope;
  }>("set-section", { document_id: documentId, page_numbers: pageNumbers });
}

export async function updateForeignTradeDocumentType(documentId: string, documentType: ForeignTradeDocumentType) {
  requireSupabase();
  const { error } = await supabase!.rpc("update_foreign_trade_document_type", {
    p_document_id: documentId,
    p_document_type: documentType,
  });
  if (error) throw error;
}

export async function cancelForeignTradeDocumentExtraction(documentId: string) {
  requireSupabase();
  const { error } = await supabase!.rpc("cancel_foreign_trade_document_extraction", {
    p_document_id: documentId,
  });
  if (error) throw error;
}

export async function deleteForeignTradeDocument(documentId: string, includeConfirmed = false) {
  requireSupabase();
  const { data, error } = await supabase!.rpc(
    includeConfirmed ? "delete_foreign_trade_document_admin" : "delete_foreign_trade_document",
    {
    p_document_id: documentId,
    },
  );
  if (error) throw error;
  const deleted = data as { storage_bucket?: string; storage_path?: string } | null;
  if (!deleted?.storage_bucket || !deleted.storage_path) return;
  const { error: storageError } = await supabase!.storage
    .from(deleted.storage_bucket)
    .remove([deleted.storage_path]);
  if (storageError) {
    throw new Error("El documento se eliminó del CRM, pero no se pudo limpiar el archivo privado de Storage.");
  }
}

export async function deleteForeignTradeOperation(operationId: string, confirmationReference: string) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("delete_foreign_trade_operation", {
    p_operation_id: operationId,
    p_confirmation_reference: confirmationReference,
  });
  if (error) throw error;

  const result = data as {
    operation_id: string;
    reference: string;
    documents?: Array<{ storage_bucket?: string; storage_path?: string }>;
    deleted_counts?: Record<string, number>;
    storage_cleanup_failed?: boolean;
  };
  const documentsByBucket = new Map<string, string[]>();
  for (const document of result.documents || []) {
    if (!document.storage_bucket || !document.storage_path) continue;
    const paths = documentsByBucket.get(document.storage_bucket) || [];
    paths.push(document.storage_path);
    documentsByBucket.set(document.storage_bucket, paths);
  }

  for (const [bucket, paths] of documentsByBucket) {
    const { error: storageError } = await supabase!.storage.from(bucket).remove(paths);
    if (storageError) {
      result.storage_cleanup_failed = true;
    }
  }
  return result;
}

export async function confirmForeignTradeDocument(documentId: string, review: ForeignTradeDocumentExtraction) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("confirm_foreign_trade_document_with_reconciliation", {
    p_document_id: documentId,
    p_review: review,
  });
  if (error) throw error;
  return data as ConfirmForeignTradeDocumentResult;
}

export async function reconcileForeignTradeDocument(documentId: string, supplierId?: string | null) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("reconcile_foreign_trade_document", {
    p_document_id: documentId,
    p_supplier_id: supplierId || null,
  });
  if (error) throw error;
  return data as ForeignTradeProductReconciliationResult;
}

export async function deleteForeignTradeProductSupplierMapping(mappingId: string) {
  requireSupabase();
  const { error } = await supabase!.rpc("delete_product_supplier_mapping", {
    p_mapping_id: mappingId,
  });
  if (error) throw error;
}

export async function confirmForeignTradeFundRequestDocument(documentId: string, review: ForeignTradeFundRequestExtraction) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("confirm_foreign_trade_fund_request_document", {
    p_document_id: documentId,
    p_review: review,
  });
  if (error) throw error;
  return data as ConfirmForeignTradeFundRequestResult;
}

export async function confirmForeignTradeAgencySettlementDocument(
  documentId: string,
  reconciliationId: string,
  review: ForeignTradeAgencySettlementExtraction,
) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("confirm_foreign_trade_agency_settlement_document", {
    p_document_id: documentId,
    p_reconciliation_id: reconciliationId,
    p_review: review,
  });
  if (error) throw error;
  return data as ConfirmForeignTradeAgencySettlementResult;
}

export async function confirmForeignTradeFreightDocument(
  documentId: string,
  review: ForeignTradeFreightDocumentExtraction,
) {
  requireSupabase();
  const { data, error } = await supabase!.rpc("confirm_foreign_trade_freight_document", {
    p_document_id: documentId,
    p_review: review,
  });
  if (error) throw error;
  return data as ConfirmForeignTradeFreightDocumentResult;
}

export async function getForeignTradeDocumentUrl(document: ForeignTradeDocument) {
  requireSupabase();
  const { data, error } = await supabase!.storage
    .from(document.storage_bucket)
    .createSignedUrl(document.storage_path, 120);
  if (error) throw error;
  return data.signedUrl;
}

export async function downloadForeignTradeDocumentSection(documentId: string) {
  requireSupabase();
  const { data } = await supabase!.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  let response: Response;
  try {
    response = await fetch(getSupabaseFunctionUrl("foreign-trade-documents", "download-section"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: documentId }),
    });
  } catch {
    throw new Error("No se pudo contactar el servicio de documentos.");
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `El servicio respondió con error ${response.status}.`);
  }
  const contentDisposition = response.headers.get("content-disposition") || "";
  const fileName = /filename="([^"]+)"/i.exec(contentDisposition)?.[1] || "seccion-documento.pdf";
  const pages = (response.headers.get("x-document-pages") || "").split(",").map(Number).filter(Number.isFinite);
  const totalPages = Number(response.headers.get("x-document-total-pages") || 0) || null;
  return { blob: await response.blob(), fileName, pages, totalPages };
}

async function foreignTradeDocumentRequest<T>(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  requireSupabase();
  const { data } = await supabase!.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  let response: Response;
  try {
    response = await fetch(getSupabaseFunctionUrl("foreign-trade-documents", route), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (requestError) {
    if (requestError instanceof DOMException && requestError.name === "AbortError") throw requestError;
    throw new Error("No se pudo contactar el servicio de documentos.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `El servicio respondió con error ${response.status}.`);
  return result as T;
}

async function sha256(file: File) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decimalOrNull(value?: string) {
  const normalized = String(value || "").trim().replace(",", ".");
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,8})?$/.test(normalized)) {
    throw new Error("Ingresa valores numericos positivos y usa hasta 8 decimales.");
  }
  return normalized;
}

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error("Conecta Supabase para administrar Comercio Exterior.");
  }
}

function decimal(value: string | undefined, label: string, required = false) {
  const normalized = String(value || "").trim().replace(",", ".");
  if (!normalized && !required) return null;
  if (!normalized || !/^\d+(?:\.\d{1,8})?$/.test(normalized)) {
    throw new Error(`Revisa ${label}. Usa un valor positivo con hasta 8 decimales.`);
  }
  return normalized;
}

function integerString(value: string, label: string) {
  const normalized = String(value || "").trim();
  if (!/^\d{1,3}$/.test(normalized)) throw new Error(`Revisa ${label}.`);
  return normalized;
}

function integerOrNull(value: string | number | null | undefined, label: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) throw new Error(`Revisa ${label}.`);
  return normalized;
}

function decimalInput(value: string | number, label: string) {
  const normalized = String(value ?? "").trim().replace(",", ".") || "0";
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Revisa ${label}. Usa un valor positivo con hasta 2 decimales.`);
  }
  return normalized;
}

function decimalInputWithScale(value: string | number, label: string, scale: number) {
  const normalized = String(value ?? "").trim().replace(",", ".") || "0";
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(normalized)) {
    throw new Error(`Revisa ${label}. Usa un valor positivo con hasta ${scale} decimales.`);
  }
  return normalized;
}

function optionalDecimalInputWithScale(value: string | number | null | undefined, label: string, scale: number) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  return decimalInputWithScale(normalized, label, scale);
}

function currencyInput(value: string, label: string) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error(`Revisa ${label}. Usa un código de tres letras, por ejemplo CLP o USD.`);
  return normalized;
}

function normalizeOperationDetail(value: unknown): ForeignTradeOperationDetail {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals as Record<string, unknown> : {};
  return {
    operation: raw.operation as ForeignTradeOperation,
    supplier: (raw.supplier || null) as ForeignTradeSupplier | null,
    lines: (Array.isArray(raw.lines) ? raw.lines : []) as ForeignTradeOperationLine[],
    costs: (Array.isArray(raw.costs) ? raw.costs : []) as ForeignTradeCostLine[],
    scenarios: (Array.isArray(raw.scenarios) ? raw.scenarios : []) as ForeignTradeOperationDetail["scenarios"],
    totals: {
      line_count: numberValue(totals.line_count),
      units: numberValue(totals.units),
      registered_merchandise: numberValue(totals.registered_merchandise),
      total_cbm: numberValue(totals.total_cbm),
      gross_weight_kg: numberValue(totals.gross_weight_kg),
      costs_clp: numberValue(totals.costs_clp),
      costs_without_clp: numberValue(totals.costs_without_clp),
    },
  };
}

function normalizeSummary(value: unknown): ForeignTradeDashboardSummary {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const recent = Array.isArray(raw.recent_simulations) ? raw.recent_simulations : [];
  return {
    operations_in_preparation: numberValue(raw.operations_in_preparation),
    proformas: numberValue(raw.proformas),
    purchase_orders: numberValue(raw.purchase_orders),
    active_shipments: numberValue(raw.active_shipments),
    suppliers: numberValue(raw.suppliers),
    total_purchase_usd: numberValue(raw.total_purchase_usd),
    projected_import_cost_clp: numberValue(raw.projected_import_cost_clp),
    projected_profit_clp: numberValue(raw.projected_profit_clp),
    total_cbm: numberValue(raw.total_cbm),
    product_lines: numberValue(raw.product_lines),
    open_alerts: numberValue(raw.open_alerts),
    recent_simulations: recent as ForeignTradeDashboardSummary["recent_simulations"],
  };
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
