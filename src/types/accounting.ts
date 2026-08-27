export type AccountingRole = "administrador" | "finanzas" | "vendedor" | "visualizador";
export type AccountingView = "dashboard" | "accounts" | "ledger" | "facto" | "banks" | "reconcile" | "receivables" | "payables" | "checks" | "periods" | "reports" | "controls";

export interface AccountingEntity {
  id: string;
  legal_name: string;
  tax_id: string;
  functional_currency: string;
  active: boolean;
}

export interface AccountingAccount {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  parent_id: string | null;
  level: number;
  account_type: "asset" | "liability" | "equity" | "income" | "cost" | "expense" | "result";
  normal_balance: "debit" | "credit";
  classification: string;
  currency: string | null;
  allows_posting: boolean;
  active: boolean;
}

export interface AccountingPeriod {
  id: string;
  entity_id: string;
  fiscal_year: number;
  period_number: number;
  starts_on: string;
  ends_on: string;
  status: "open" | "review" | "closed";
  closed_at: string | null;
  close_note: string | null;
}

export interface AccountingSourceDocument {
  id: string;
  source_type: string;
  source_key: string;
  document_type: string;
  folio: string | null;
  counterpart_tax_id: string | null;
  counterpart_name: string | null;
  issued_on: string | null;
  due_on: string | null;
  currency: string;
  total_amount: number;
  total_clp: number;
  status: string;
  data_quality: string;
  updated_at: string;
}

export interface AccountingJournalEntry {
  id: string;
  entry_number: number;
  period_id: string;
  entry_date: string;
  description: string;
  reference: string | null;
  source_type: string;
  status: "draft" | "suggested" | "pending_review" | "validated" | "posted" | "reversed" | "voided";
  currency: string;
  exchange_rate: number;
  created_at: string;
}

export interface AccountingBankAccount {
  id: string;
  institution: string;
  account_name: string;
  account_number_masked: string;
  currency: string;
}

export interface AccountingBankTransaction {
  id: string;
  bank_account_id: string;
  transaction_date: string;
  value_date: string | null;
  description: string;
  reference: string | null;
  operation_number: string | null;
  debit: number;
  credit: number;
  amount: number;
  balance: number | null;
  currency: string;
  exchange_rate: number;
  amount_clp: number;
  reconciliation_status: "unmatched" | "proposed" | "partial" | "matched" | "ignored";
}

export interface AccountingReceivable {
  id: string;
  customer_name: string;
  customer_tax_id: string | null;
  document_number: string;
  issued_on: string;
  due_on: string | null;
  original_amount_clp: number;
  paid_amount_clp: number;
  balance_clp: number;
  status: string;
  currency: string;
}

export interface AccountingPayable {
  id: string;
  supplier_name: string;
  supplier_tax_id: string | null;
  document_number: string;
  issued_on: string;
  due_on: string | null;
  original_amount_clp: number;
  paid_amount_clp: number;
  balance_clp: number;
  status: string;
  currency: string;
}

export interface AccountingCheck {
  id: string;
  customer_name: string;
  bank_name: string;
  check_number: string;
  amount_clp: number;
  received_on: string;
  due_on: string;
  deposited_on: string | null;
  status: string;
}

export interface AccountingControlFinding {
  id: string;
  control_code: string;
  severity: "error" | "review" | "ok";
  title: string;
  detail: string | null;
  entity_type: string | null;
  entity_reference: string | null;
  amount_clp: number | null;
  detected_at: string;
  status: string;
}

export interface AccountingImportBatch {
  id: string;
  source_type: string;
  import_profile: string;
  file_name: string;
  status: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  error_count: number;
  created_at: string;
}

export interface AccountingSummary {
  as_of: string;
  bank_clp: number;
  bank_usd_clp: number;
  receivables: number;
  receivables_overdue: number;
  payables: number;
  payables_overdue: number;
  checks_portfolio: number;
  unmatched_bank: number;
  open_controls: number;
  pending_entries: number;
  provisional: boolean;
}

export interface AccountingBootstrap {
  entity: AccountingEntity;
  accounts: AccountingAccount[];
  periods: AccountingPeriod[];
  bankAccounts: AccountingBankAccount[];
  bankTransactions: AccountingBankTransaction[];
  sources: AccountingSourceDocument[];
  entries: AccountingJournalEntry[];
  receivables: AccountingReceivable[];
  payables: AccountingPayable[];
  checks: AccountingCheck[];
  controls: AccountingControlFinding[];
  batches: AccountingImportBatch[];
  summary: AccountingSummary;
  profile: { role: AccountingRole; permissions: string[] };
}

export interface AccountingImportPreviewRow {
  row_number: number;
  transaction_date: string | null;
  value_date: string | null;
  description: string;
  reference: string | null;
  operation_number: string | null;
  debit: number;
  credit: number;
  amount: number;
  balance: number | null;
  currency: string;
  fingerprint: string;
  errors: string[];
}

export interface AccountingImportPreview {
  batch: AccountingImportBatch;
  bankAccount: AccountingBankAccount;
  summary: { total: number; new: number; duplicates: number; errors: number };
  rows: AccountingImportPreviewRow[];
}

export interface AccountingReconciliationCandidate {
  targetType: "receivable" | "payable";
  targetId: string;
  score: number;
  confidence: "exact" | "high" | "possible";
  suggestedAmount: number;
  candidate: AccountingReceivable | AccountingPayable;
}

export interface AccountingReportRow {
  [key: string]: unknown;
}

export interface AccountingReport {
  kind: "balance8" | "trial" | "journal" | "ledger" | "income" | "cashflow";
  rows: AccountingReportRow[];
}

export interface AccountingJournalDraft {
  entity_id: string;
  entry_date: string;
  description: string;
  reference?: string;
  currency: string;
  exchange_rate: number;
  status: "draft" | "pending_review" | "validated";
  lines: Array<{
    account_id: string;
    description?: string;
    debit_clp: number;
    credit_clp: number;
    original_amount?: number | null;
    currency?: string;
    exchange_rate?: number;
    cost_center?: string;
  }>;
}
