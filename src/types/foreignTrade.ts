export type ForeignTradeOperationType =
  | "simulation"
  | "quotation"
  | "proforma"
  | "purchase_order"
  | "shipment";

export type ForeignTradeExchangeRateSource = "manual" | "current" | "conservative" | "custom";

export interface ForeignTradeDashboardSummary {
  operations_in_preparation: number;
  proformas: number;
  purchase_orders: number;
  active_shipments: number;
  suppliers: number;
  total_purchase_usd: number;
  projected_import_cost_clp: number;
  projected_profit_clp: number;
  total_cbm: number;
  product_lines: number;
  open_alerts: number;
  recent_simulations: Array<{
    id: string;
    reference: string;
    title: string;
    operation_type: ForeignTradeOperationType;
    status: string;
    value_usd: number;
    exchange_rate_clp: number | null;
    created_at: string;
  }>;
}

export interface ForeignTradeOperationStatus {
  code: string;
  name: string;
  sort_order: number;
  color: "neutral" | "info" | "warning" | "success" | "danger" | string;
  active: boolean;
  final_state: boolean;
  description: string;
}

export interface ForeignTradeSupplier {
  id: string;
  name: string;
  company_name: string | null;
  country_code: string;
  factory_city: string | null;
  contact_name: string | null;
  email: string | null;
  whatsapp: string | null;
  phone: string | null;
  currency: string;
  usual_incoterms: string[];
  payment_terms: string | null;
  default_production_days: number;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ForeignTradeOperation {
  id: string;
  supplier_id: string | null;
  reference: string;
  title: string;
  operation_type: ForeignTradeOperationType;
  transport_type: string;
  origin_port: string | null;
  destination_port: string | null;
  status: string;
  value_usd: number;
  base_currency: string;
  exchange_rate_clp: number | null;
  exchange_rate_source: ForeignTradeExchangeRateSource;
  incoterm: string | null;
  target_container_cbm: number | null;
  order_date: string | null;
  estimated_departure: string | null;
  estimated_arrival: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ForeignTradeContainerType {
  id: string;
  code: string;
  name: string;
  transport_type: string;
  reference_capacity_cbm: number | null;
  max_weight_kg: number | null;
  active: boolean;
  notes: string | null;
}

export interface ForeignTradeCostParameter {
  id: string;
  code: string;
  name: string;
  category: string;
  value_type: "percentage" | "fixed" | "reference";
  numeric_value: number | null;
  currency: string | null;
  applies_to: string;
  source_label: string;
  valid_from: string;
  valid_until: string | null;
  active: boolean;
  notes: string | null;
}

export interface ForeignTradeAuditEvent {
  id: string;
  operation_id: string | null;
  entity_type: string;
  record_id: string | null;
  action: string;
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  origin: string;
  actor_id: string | null;
  agent_type: string | null;
  created_at: string;
}

export interface ForeignTradeCenterData {
  summary: ForeignTradeDashboardSummary;
  operations: ForeignTradeOperation[];
  statuses: ForeignTradeOperationStatus[];
  suppliers: ForeignTradeSupplier[];
  containerTypes: ForeignTradeContainerType[];
  costParameters: ForeignTradeCostParameter[];
  audit: ForeignTradeAuditEvent[];
}

export interface CreateForeignTradeOperationInput {
  title: string;
  reference?: string;
  operationType: ForeignTradeOperationType;
  supplierId?: string;
  status: string;
  transportType: "sea" | "air" | "land" | "multimodal";
  originPort?: string;
  destinationPort?: string;
  baseCurrency: string;
  exchangeRateClp?: string;
  exchangeRateSource: ForeignTradeExchangeRateSource;
  incoterm?: string;
  targetContainerCbm?: string;
  valueUsd?: string;
  notes?: string;
}

export type ForeignTradeDataSource = "real" | "document" | "configured" | "estimated" | "simulated";

export interface ForeignTradeCatalogProduct {
  id: string;
  external_id: string;
  sku: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  price: number | null;
  stock: number | null;
  source_status: string;
  sync_status: string;
  primary_image_url: string | null;
  last_synced_at: string;
}

export interface ForeignTradeOperationLine {
  id: string;
  operation_id: string;
  supplier_product_id: string | null;
  content_product_id: string | null;
  line_number: number;
  sku: string | null;
  supplier_sku: string | null;
  product_name: string;
  supplier_model: string | null;
  description: string | null;
  temporary_product: boolean;
  linked_manually: boolean;
  quantity: number;
  quantity_per_box: number | null;
  box_count: number | null;
  currency: string;
  unit_factory_cost: number | null;
  exw_total: number | null;
  fob_total: number | null;
  cif_total: number | null;
  discount_total: number | null;
  supplier_charges_total: number | null;
  unit_weight_kg: number | null;
  gross_weight_kg: number | null;
  net_weight_kg: number | null;
  box_length_cm: number | null;
  box_width_cm: number | null;
  box_height_cm: number | null;
  cbm_per_box: number | null;
  cbm_total: number | null;
  hs_code: string | null;
  country_of_origin: string | null;
  data_source: ForeignTradeDataSource;
  source_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  catalog_name: string | null;
  primary_image_url: string | null;
  catalog_sync_status: string | null;
}

export type ForeignTradeCostCategory =
  | "merchandise"
  | "origin"
  | "international_freight"
  | "insurance"
  | "chile_port"
  | "storage"
  | "customs_agency"
  | "national_transport"
  | "inspection"
  | "certificate"
  | "duties"
  | "taxes"
  | "supplier_charge"
  | "other";

export interface ForeignTradeCostLine {
  id: string;
  operation_id: string;
  scenario_id: string | null;
  operation_line_id: string | null;
  category: ForeignTradeCostCategory;
  name: string;
  amount_original: number;
  currency: string;
  exchange_rate_clp: number | null;
  amount_clp: number | null;
  allocation_method: "operation" | "fob_value" | "units" | "weight" | "cbm" | "manual" | "combined";
  source_type: ForeignTradeDataSource;
  recoverable_tax: boolean;
  notes: string | null;
  metadata: {
    amount_basis?: "net" | "gross";
    vat_rate_percent?: number | string;
    vat_amount_clp?: number | string;
    gross_amount_clp?: number | string;
    excluded_from_costing?: boolean;
    superseded_by_reconciliation_id?: string;
    reconciliation_id?: string;
    reconciliation_line_id?: string;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
}

export type ForeignTradePricingMethod = "markup_on_cost" | "margin_on_sale";

export interface ForeignTradeCostingAssumptions {
  cif_total_original?: number | null;
  general_duty_percent?: number;
  import_vat_percent?: number;
  sales_vat_percent?: number;
  import_vat_recoverable?: boolean;
  pricing_method?: ForeignTradePricingMethod;
  target_percent?: number;
  line_duty_percent?: Record<string, number>;
  line_target_percent?: Record<string, number>;
}

export interface ForeignTradeScenario {
  id: string;
  operation_id: string;
  name: string;
  status: "draft" | "baseline" | "archived";
  exchange_rate_clp: number;
  exchange_rate_source: ForeignTradeExchangeRateSource;
  allocation_method: "fob_value" | "units" | "weight" | "cbm" | "manual" | "combined";
  target_margin_percent: number | null;
  minimum_margin_percent: number | null;
  merchandise_total_original: number | null;
  merchandise_total_clp: number | null;
  logistics_total_clp: number | null;
  duties_total_clp: number | null;
  taxes_total_clp: number | null;
  landed_total_clp: number | null;
  projected_sales_clp: number | null;
  projected_profit_clp: number | null;
  projected_margin_percent: number | null;
  assumptions: { costing?: ForeignTradeCostingAssumptions; [key: string]: unknown };
  missing_inputs: string[];
  calculation_version: string;
  calculated_at: string | null;
  created_at: string;
}

export interface ForeignTradeOperationTotals {
  line_count: number;
  units: number;
  registered_merchandise: number;
  total_cbm: number;
  gross_weight_kg: number;
  costs_clp: number;
  costs_without_clp: number;
}

export interface ForeignTradeOperationDetail {
  operation: ForeignTradeOperation;
  supplier: ForeignTradeSupplier | null;
  lines: ForeignTradeOperationLine[];
  costs: ForeignTradeCostLine[];
  scenarios: ForeignTradeScenario[];
  totals: ForeignTradeOperationTotals;
}

export type ForeignTradeReconciliationStatus = "draft" | "reviewed" | "applied" | "refund_pending" | "settled";
export type ForeignTradeReconciliationLineType = "operating_expense" | "agency_fee" | "customs_duty" | "import_vat" | "adjustment";

export interface ForeignTradeExpenseReconciliationLine {
  id: string;
  reconciliation_id: string;
  operation_id: string;
  position: number;
  line_type: ForeignTradeReconciliationLineType;
  cost_category: ForeignTradeCostCategory;
  concept: string;
  provider_name: string | null;
  document_number: string | null;
  document_date: string | null;
  source_page: number | null;
  provision_cost_line_id: string | null;
  applied_cost_line_id: string | null;
  provision_net_clp: number;
  provision_vat_clp: number;
  provision_total_clp: number;
  provision_amount_original: number;
  provision_currency: string;
  provision_exchange_rate_clp: number | null;
  actual_net_clp: number;
  actual_vat_clp: number;
  actual_total_clp: number;
  actual_amount_original: number;
  actual_currency: string;
  actual_exchange_rate_clp: number | null;
  recoverable_tax: boolean;
  include_in_costing: boolean;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ForeignTradeExpenseReconciliationTotals {
  provision_expenses_clp: number;
  actual_expenses_clp: number;
  provision_taxes_clp: number;
  actual_taxes_clp: number;
  provision_total_clp: number;
  actual_total_clp: number;
  balance_clp: number;
  refund_due_clp: number;
  additional_payment_clp: number;
}

export interface ForeignTradeExpenseReconciliation {
  id: string;
  operation_id: string;
  title: string;
  agency_name: string | null;
  provision_document_id: string | null;
  final_document_id: string | null;
  general_estimate_cost_line_id: string | null;
  provision_reference: string | null;
  final_reference: string | null;
  agency_invoice_number: string | null;
  remittance_date: string | null;
  final_invoice_date: string | null;
  remittance_amount_clp: number;
  refund_received_clp: number;
  refund_received_at: string | null;
  status: ForeignTradeReconciliationStatus;
  identity_confirmed: boolean;
  notes: string | null;
  metadata: Record<string, unknown>;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
  lines: ForeignTradeExpenseReconciliationLine[];
  totals: ForeignTradeExpenseReconciliationTotals;
}

export interface SaveForeignTradeExpenseReconciliationInput {
  id?: string;
  operation_id: string;
  title: string;
  agency_name?: string | null;
  provision_document_id?: string | null;
  final_document_id?: string | null;
  general_estimate_cost_line_id?: string | null;
  provision_reference?: string | null;
  final_reference?: string | null;
  agency_invoice_number?: string | null;
  remittance_date?: string | null;
  final_invoice_date?: string | null;
  remittance_amount_clp: string | number;
  refund_received_clp: string | number;
  refund_received_at?: string | null;
  status: "draft" | "reviewed";
  identity_confirmed: boolean;
  notes?: string | null;
  metadata?: Record<string, unknown>;
  lines: Array<{
    id?: string;
    position: number;
    line_type: ForeignTradeReconciliationLineType;
    cost_category: ForeignTradeCostCategory;
    concept: string;
    provider_name?: string | null;
    document_number?: string | null;
    document_date?: string | null;
    source_page?: string | number | null;
    provision_cost_line_id?: string | null;
    provision_net_clp: string | number;
    provision_vat_clp: string | number;
    provision_total_clp: string | number;
    provision_amount_original: string | number;
    provision_currency: string;
    provision_exchange_rate_clp?: string | number | null;
    actual_net_clp: string | number;
    actual_vat_clp: string | number;
    actual_total_clp: string | number;
    actual_amount_original: string | number;
    actual_currency: string;
    actual_exchange_rate_clp?: string | number | null;
    recoverable_tax: boolean;
    include_in_costing: boolean;
    notes?: string | null;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ApplyForeignTradeExpenseReconciliationResult {
  reconciliation_id: string;
  applied_lines: number;
  actual_total_clp: number;
  balance_clp: number;
  refund_due_clp: number;
}

export type ForeignTradeDocumentType =
  | "proforma"
  | "purchase_order"
  | "commercial_invoice"
  | "packing_list"
  | "bill_of_lading"
  | "certificate_of_origin"
  | "customs_document"
  | "payment_receipt"
  | "freight_quote"
  | "fund_request"
  | "agency_settlement"
  | "other";

export type ForeignTradeDocumentParseStatus =
  | "uploaded"
  | "queued"
  | "extracting"
  | "review_required"
  | "confirmed"
  | "failed";

export interface ForeignTradeExtractionWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  line_index: number | null;
}

export interface ForeignTradeExtractionGeneral {
  supplier_id: string | null;
  supplier_name: string | null;
  proforma_number: string | null;
  document_date: string | null;
  valid_until: string | null;
  currency: string | null;
  incoterm: string | null;
  origin_port: string | null;
  destination_port: string | null;
  payment_terms: string | null;
  production_days: number | null;
  order_number: string | null;
  observations: string | null;
  confidence: number | null;
  warnings: string[];
}

export interface ForeignTradeExtractedLine {
  source_index: number;
  source_page: number | null;
  source_row_label: string | null;
  include: boolean;
  content_product_id: string | null;
  remember_link: boolean;
  supplier_sku: string | null;
  sku: string | null;
  product_name: string;
  description: string | null;
  model: string | null;
  quantity: number | null;
  quantity_per_box: number | null;
  box_count: number | null;
  currency: string | null;
  unit_price: number | null;
  total_price: number | null;
  exw_total: number | null;
  fob_total: number | null;
  cif_total: number | null;
  discount_total: number | null;
  supplier_charges_total: number | null;
  unit_weight_kg: number | null;
  gross_weight_kg: number | null;
  net_weight_kg: number | null;
  box_length_cm: number | null;
  box_width_cm: number | null;
  box_height_cm: number | null;
  cbm_per_box: number | null;
  cbm_total: number | null;
  cbm_per_unit: number | null;
  recalculated_cbm_total: number | null;
  country_of_origin: string | null;
  hs_code: string | null;
  confidence: number | null;
  warnings: string[];
}

export interface ForeignTradeDocumentExtraction {
  extraction_version?: string;
  pdf_skill_version?: string | null;
  general: ForeignTradeExtractionGeneral;
  lines: ForeignTradeExtractedLine[];
  document_totals: {
    subtotal: number | null;
    total: number | null;
    cbm_total: number | null;
    gross_weight_kg: number | null;
    net_weight_kg: number | null;
    boxes: number | null;
    line_count: number | null;
  };
  warnings: string[];
}

export interface ForeignTradeFundRequestGeneral {
  reference: string | null;
  agency_name: string | null;
  document_date: string | null;
  currency: string | null;
  declared_total_clp: number | null;
  remittance_amount_clp: number | null;
  observations: string | null;
  confidence: number | null;
  warnings: string[];
}

export interface ForeignTradeFundRequestLine {
  source_index: number;
  source_page: number | null;
  include: boolean;
  line_type: ForeignTradeReconciliationLineType;
  cost_category: ForeignTradeCostCategory;
  concept: string;
  provider_name: string | null;
  document_number: string | null;
  document_date: string | null;
  provision_net_clp: number | null;
  provision_vat_clp: number | null;
  provision_total_clp: number | null;
  amount_original: number | null;
  currency: string;
  exchange_rate_clp: number | null;
  recoverable_tax: boolean;
  include_in_costing: boolean;
  confidence: number | null;
  warnings: string[];
}

export interface ForeignTradeFundRequestExtraction {
  extraction_version: string;
  document_kind: "fund_request";
  general: ForeignTradeFundRequestGeneral;
  lines: ForeignTradeFundRequestLine[];
  totals: {
    expenses_clp: number | null;
    taxes_clp: number | null;
    document_total_clp: number | null;
    line_count: number;
  };
  warnings: string[];
}

export type ForeignTradeAnyDocumentExtraction =
  | ForeignTradeDocumentExtraction
  | ForeignTradeFundRequestExtraction;

export interface ForeignTradeDocument {
  id: string;
  operation_id: string;
  supplier_id: string | null;
  document_type: ForeignTradeDocumentType;
  original_file_name: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  file_hash: string | null;
  parse_status: ForeignTradeDocumentParseStatus;
  extraction_result: ForeignTradeAnyDocumentExtraction | Record<string, never>;
  extraction_confidence: number | null;
  review_warnings: ForeignTradeExtractionWarning[];
  review_result: ForeignTradeAnyDocumentExtraction | Record<string, never>;
  review_version: number;
  extraction_model: string | null;
  extraction_request_id: string | null;
  extraction_started_at: string | null;
  extraction_completed_at: string | null;
  extraction_error: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConfirmForeignTradeDocumentResult {
  document_id: string;
  operation_id: string;
  inserted_lines: number;
  skipped_lines: number;
  status: "confirmed";
}

export interface ConfirmForeignTradeFundRequestResult {
  document_id: string;
  operation_id: string;
  reconciliation_id: string;
  inserted_lines: number;
  skipped_lines: number;
  status: "confirmed";
}

export interface UpsertForeignTradeSupplierInput {
  id?: string;
  name: string;
  companyName?: string;
  countryCode: string;
  factoryCity?: string;
  contactName?: string;
  email?: string;
  whatsapp?: string;
  phone?: string;
  currency: string;
  usualIncoterms: string[];
  paymentTerms?: string;
  defaultProductionDays: string;
  notes?: string;
  active: boolean;
}

export interface UpsertForeignTradeOperationLineInput {
  id?: string;
  operationId: string;
  contentProductId?: string;
  supplierProductId?: string;
  productName: string;
  sku?: string;
  supplierSku?: string;
  supplierModel?: string;
  description?: string;
  temporaryProduct: boolean;
  rememberLink: boolean;
  quantity: string;
  quantityPerBox?: string;
  boxCount?: string;
  currency: string;
  unitFactoryCost?: string;
  exwTotal?: string;
  fobTotal?: string;
  cifTotal?: string;
  discountTotal?: string;
  supplierChargesTotal?: string;
  unitWeightKg?: string;
  grossWeightKg?: string;
  netWeightKg?: string;
  boxLengthCm?: string;
  boxWidthCm?: string;
  boxHeightCm?: string;
  cbmPerBox?: string;
  cbmTotal?: string;
  hsCode?: string;
  countryOfOrigin?: string;
  dataSource: ForeignTradeDataSource;
}

export interface UpsertForeignTradeCostLineInput {
  id?: string;
  operationId: string;
  scenarioId?: string;
  operationLineId?: string;
  category: ForeignTradeCostCategory;
  name: string;
  amountOriginal: string;
  currency: string;
  exchangeRateClp?: string;
  allocationMethod: ForeignTradeCostLine["allocation_method"];
  sourceType: ForeignTradeDataSource;
  recoverableTax: boolean;
  amountBasis?: "net" | "gross";
  vatRatePercent?: string;
  notes?: string;
}

export interface SaveForeignTradeCostingScenarioInput {
  id?: string;
  operationId: string;
  name: string;
  status: "draft" | "baseline";
  exchangeRateClp: number;
  exchangeRateSource: ForeignTradeExchangeRateSource;
  allocationMethod: Exclude<ForeignTradeScenario["allocation_method"], "manual">;
  assumptions: ForeignTradeCostingAssumptions;
  merchandiseTotalOriginal: number;
  merchandiseTotalClp: number;
  logisticsTotalClp: number;
  dutiesTotalClp: number;
  taxesTotalClp: number;
  landedTotalClp: number;
  projectedSalesClp: number;
  projectedProfitClp: number;
  projectedMarginPercent: number;
  missingInputs: string[];
}
