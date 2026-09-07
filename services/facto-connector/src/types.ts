export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type FactoDocumentKind =
  | "sales_invoice"
  | "sales_exempt_invoice"
  | "sales_receipt"
  | "sales_exempt_receipt"
  | "sales_export_invoice"
  | "sales_export_debit_note"
  | "sales_export_credit_note"
  | "sales_debit_note"
  | "sales_credit_note"
  | "sales_other";

export interface FactoApiDocument {
  externalId: string;
  documentType: FactoDocumentKind;
  folio: string;
  customerTaxId: string;
  customerName: string;
  issuedOn: string;
  currency: string;
  exchangeRate: number;
  netAmount: number;
  taxAmount: number;
  exemptAmount: number;
  originalAmount: number;
  originalAmountClp: number;
  sourceCreatedAt: string | null;
  receivedIssuedFlag: string;
  raw: JsonObject;
  validationErrors: string[];
}

export interface FactoBrowserRow {
  sourceRow: number;
  externalId: string | null;
  documentType: FactoDocumentKind;
  documentTypeLabel: string;
  folio: string;
  customerTaxId: string;
  customerName: string;
  issuedOn: string;
  dueOn: string | null;
  currency: string;
  originalAmountClp: number | null;
  outstandingAmountClp: number;
  status: string;
  daysOverdue: number | null;
  partialPayments: JsonObject[];
  sourceHref: string | null;
  validationErrors: string[];
  rawColumns: Record<string, string>;
}

export interface FactoApiReadResult {
  documents: FactoApiDocument[];
  pageCount: number;
  pagesRead: number;
  totalItems: number;
  issuedFlag: string;
  complete: boolean;
}

export interface FactoBrowserReadResult {
  section: string;
  rows: FactoBrowserRow[];
  pagesRead: number;
  expectedRows: number | null;
  complete: boolean;
  verifiedZero: boolean;
  warnings: string[];
}

export interface FactoCanonicalReceivable {
  external_id: string;
  document_type: FactoDocumentKind;
  folio: string;
  customer_tax_id: string;
  customer_name: string;
  issued_on: string;
  due_on: string | null;
  currency: string;
  exchange_rate: number;
  net_amount: number;
  tax_amount: number;
  exempt_amount: number;
  original_amount: number;
  original_amount_clp: number;
  outstanding_amount_clp: number;
  reported_paid_amount_clp: number;
  status: string;
  days_overdue: number | null;
  partial_payments: JsonObject[];
  api_verified: boolean;
  browser_verified: boolean;
  closure_evidence: boolean;
  observed_at: string;
  source_created_at: string | null;
}

export interface FactoSyncPreviewItem {
  canonical_key: string;
  normalized: FactoCanonicalReceivable;
  validation_errors: string[];
  raw_payload_hash: string;
  evidence: {
    api: JsonObject;
    browser: JsonObject;
    matching: JsonObject;
  };
}

export interface FactoSyncPreview {
  items: FactoSyncPreviewItem[];
  sourceAsOf: string;
  apiDocuments: number;
  browserRows: number;
  overdueDocuments: number;
  partialPaymentDocuments: number;
  coverage: {
    complete: boolean;
    verified_zero: boolean;
    section: string;
    pages_read: number;
    expected_rows: number | null;
    extracted_rows: number;
    api_pages_read: number;
    api_page_count: number;
    api_total_items: number;
    api_complete: boolean;
  };
  warnings: string[];
}

export interface ClaimedFactoTask {
  id: string;
  action: "sync_facto_receivables";
  payload: {
    run_id: string;
    entity_id: string;
    from_date: string;
    to_date: string;
    mode: "dry_run";
    read_only: true;
  };
}

export interface FactoTaskLease {
  task: ClaimedFactoTask;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface FactoApiReader {
  readIssuedDocuments(fromDate: string, toDate: string): Promise<FactoApiReadResult>;
}

export interface FactoBrowserReader {
  readUnpaidDocuments(fromDate: string, toDate: string): Promise<FactoBrowserReadResult>;
}
