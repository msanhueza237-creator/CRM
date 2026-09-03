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
  ledger_account_id: string;
  active: boolean;
}

export interface AccountingBankBalanceSnapshot {
  id: string;
  bank_account_id: string;
  as_of_date: string;
  balance: number;
  currency: string;
  exchange_rate: number;
  balance_clp: number;
  source_type: string;
  source_reference: string;
  status: string;
  notes: string | null;
  created_at: string;
}

export interface AccountingBankRealityAccount {
  key: string;
  bankAccountId: string;
  ledgerAccountId: string;
  institution: string;
  accountName: string;
  accountNumberMasked: string;
  currency: string;
  ledgerBalanceClp: number;
  statementBalance: number | null;
  statementBalanceClp: number | null;
  statementDate: string | null;
  statementFileName: string | null;
  statementStoragePath: string | null;
  verifiedBalance: number | null;
  verifiedBalanceClp: number;
  verifiedAt: string | null;
  verifiedSource: string;
  basis: "verified" | "statement" | "ledger";
  differenceClp: number;
  notes: string;
}

export interface AccountingBankReality {
  asOf: string | null;
  basis: "verified_control" | "statements" | "ledger";
  availableClp: number;
  availableUsdClp: number;
  ledgerClp: number;
  varianceClp: number;
  accounts: AccountingBankRealityAccount[];
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
  metadata: Record<string, unknown>;
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
  reported_paid_amount_clp: number | null;
  reported_balance_clp: number | null;
  reported_at: string | null;
  reported_source_batch_id: string | null;
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
  reported_paid_amount_clp: number | null;
  reported_balance_clp: number | null;
  reported_at: string | null;
  reported_source_batch_id: string | null;
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
  settlement_bank_account_id: string | null;
  source_status: string | null;
  import_batch_id: string | null;
  metadata: Record<string, unknown>;
}

export interface AccountingPaymentEvent {
  id: string;
  source_document_id: string | null;
  receivable_id: string | null;
  payable_id: string | null;
  import_batch_id: string;
  expected_bank_account_id: string | null;
  event_date: string;
  event_time: string | null;
  direction: "receipt" | "payment" | "adjustment";
  document_type: string | null;
  document_number: string | null;
  payment_method: string | null;
  responsible: string | null;
  amount_clp: number;
  signed_amount_clp: number;
  source_profile: string;
  matching_status: "unmatched" | "linked" | "suggested" | "reconciled" | "ignored";
  metadata: Record<string, unknown>;
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
  storage_path: string | null;
  status: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  error_count: number;
  created_at: string;
}

export interface AccountingFactoSyncRun {
  id: string;
  from_date: string;
  to_date: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  source_records: number;
  in_range_records: number;
  inserted_records: number;
  updated_records: number;
  skipped_records: number;
  inconsistent_records: number;
  receivables: number;
  payables: number;
  source_observed_from: string | null;
  source_observed_to: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AccountingFactoSyncResult {
  runId: string;
  status: AccountingFactoSyncRun["status"];
  fromDate: string;
  toDate: string;
  read: number;
  accepted: number;
  inserted: number;
  updated: number;
  skipped: number;
  inconsistent: number;
  receivables: number;
  payables: number;
  controls: number;
  backups: number;
  reportedBalances: number;
}

export interface AccountingFactoFreshness {
  connectionStatus: string;
  integrationUpdatedAt: string | null;
  accountingSyncedAt: string | null;
  stale: boolean;
}

export interface AccountingSummary {
  as_of: string;
  bank_clp: number;
  bank_usd_clp: number;
  receivables: number;
  receivables_confirmed: number;
  receivables_overdue: number;
  payables: number;
  payables_confirmed: number;
  payables_overdue: number;
  checks_portfolio: number;
  payment_events_pending: number;
  unmatched_bank: number;
  open_controls: number;
  pending_entries: number;
  provisional: boolean;
  bank_balance_basis?: string;
}

export interface AccountingDashboardTotals {
  sales: number;
  costs: number;
  expenses: number;
  otherResults: number;
  grossProfit: number;
  operatingProfit: number;
  grossMargin: number | null;
  operatingMargin: number | null;
}

export interface AccountingDashboardMonth extends AccountingDashboardTotals {
  period: string;
  label: string;
  from: string;
  to: string;
}

export interface AccountingDashboardAnalytics {
  available: boolean;
  basis: "ledger" | "mixed" | "documentary" | "unavailable";
  warnings: string[];
  ledgerLines: number;
  year: number;
  from: string;
  to: string;
  monthly: AccountingDashboardMonth[];
  current: AccountingDashboardTotals;
  previousYear: AccountingDashboardTotals;
  expenseBreakdown: {
    salaries: number;
    pensionContributions: number;
    employerContributions: number;
    laborTotal: number;
    legalFees: number;
    otherOperatingExpenses: number;
    total: number;
  };
  comparison: {
    sales: number | null;
    grossProfit: number | null;
    operatingProfit: number | null;
  };
  costCoverage: {
    totalSalesDocuments: number;
    salesWithExactCost: number;
    missingSalesCost: number;
    percentage: number;
  };
}

export interface AccountingBootstrap {
  entity: AccountingEntity;
  accounts: AccountingAccount[];
  periods: AccountingPeriod[];
  bankAccounts: AccountingBankAccount[];
  bankTransactions: AccountingBankTransaction[];
  bankBalanceSnapshots: AccountingBankBalanceSnapshot[];
  bankReality: AccountingBankReality;
  sources: AccountingSourceDocument[];
  entries: AccountingJournalEntry[];
  receivables: AccountingReceivable[];
  payables: AccountingPayable[];
  checks: AccountingCheck[];
  paymentEvents: AccountingPaymentEvent[];
  controls: AccountingControlFinding[];
  batches: AccountingImportBatch[];
  factoSyncRuns: AccountingFactoSyncRun[];
  summary: AccountingSummary;
  dashboard: AccountingDashboardAnalytics;
  factoFreshness: AccountingFactoFreshness;
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
  status: "new" | "duplicate" | "invalid";
}

export interface AccountingImportPreview {
  batch: AccountingImportBatch;
  bankAccount: AccountingBankAccount;
  suggestedExchangeRate: {
    rate: number;
    rate_date: string;
    source: string;
    status: string;
  } | null;
  summary: { total: number; new: number; duplicates: number; errors: number };
  rows: AccountingImportPreviewRow[];
}

export type AccountingFactoExcelProfile =
  | "facto_unpaid_documents"
  | "facto_checks_banco_estado"
  | "facto_cash"
  | "facto_cash_scotiabank"
  | "facto_cash_mercado_pago";

export interface AccountingFactoExcelPreviewRow {
  row_number: number;
  kind: "document_balance" | "check" | "payment_event";
  fingerprint: string;
  errors: string[];
  data: Record<string, unknown>;
}

export interface AccountingFactoExcelPreview {
  batch: AccountingImportBatch;
  profile: AccountingFactoExcelProfile;
  warnings: string[];
  summary: { total: number; new: number; duplicates: number; errors: number; [key: string]: unknown };
  rows: AccountingFactoExcelPreviewRow[];
}

export interface AccountingFactoExcelResult {
  imported: number;
  linked: number;
  unmatched: number;
  duplicates: number;
  invalid: number;
  status: string;
  existing?: boolean;
}

export interface AccountingReconciliationCandidate {
  targetType: "receivable" | "payable";
  targetId: string;
  score: number;
  confidence: "exact" | "high" | "possible";
  suggestedAmount: number;
  evidence: string[];
  dateDifferenceDays: number | null;
  signals: {
    taxId: boolean;
    document: boolean;
    name: number;
    date: boolean;
    amount: "exact" | "partial" | "over" | "different";
  };
  candidate: AccountingReceivable | AccountingPayable;
}

export interface AccountingReconciliationProposal {
  transaction: AccountingBankTransaction;
  allocatedAmount: number;
  remainingAmount: number;
  candidates: AccountingReconciliationCandidate[];
  suggestedPlan: {
    links: Array<{ targetType: "receivable" | "payable"; targetId: string; amount: number }>;
    score: number;
    explanation: string;
  } | null;
}

export interface AccountingExactReconciliationMatch {
  transactionId: string;
  transactionDate: string;
  description: string;
  amountClp: number;
  targetType: "receivable" | "payable";
  targetId: string;
  links?: Array<{ targetType: "receivable" | "payable"; targetId: string; amount: number }>;
  documentNumber: string;
  counterpartyName: string;
  reason: string;
}

export interface AccountingExactReconciliationPreview {
  entityId: string;
  from: string;
  to: string;
  reviewed: number;
  exact: number;
  untouched: number;
  matches: AccountingExactReconciliationMatch[];
  policy: string;
}

export interface AccountingExactReconciliationRunResult extends AccountingExactReconciliationPreview {
  confirmed: number;
  skipped: number;
  errors: Array<{ transactionId: string; error: string }>;
}

export interface AccountingLedgerCoverage {
  entityId: string;
  from: string;
  to: string;
  factoDocuments: number;
  factoDocumentsPending: number;
  confirmedReconciliations: number;
  reconciliationsPending: number;
  postedEntries: number;
  unmatchedBankTransactions: number;
  documentarySalesClp: number;
  documentaryPurchasesClp: number;
  documentaryDifferenceClp: number;
  profitabilityCertified: boolean;
  profitabilityNote: string;
  complete: boolean;
}

export interface AccountingLedgerPrepareResult {
  posted: number;
  skipped: number;
  errors: Array<{ type: string; id: string; error: string }>;
  remaining: number;
  coverage: AccountingLedgerCoverage;
}

export interface AccountingReportRow {
  [key: string]: unknown;
}

export interface AccountingReport {
  kind: "balance8" | "trial" | "journal" | "ledger" | "income" | "cashflow";
  rows: AccountingReportRow[];
  summary?: {
    totals: Record<string, number>;
    losses: number;
    gains: number;
    netResult: number;
    resultType: "profit" | "loss" | "balanced";
    debitCreditDifference: number;
    balanceDifference: number;
    presentationDifference: number;
    balanced: boolean;
    bankReality: AccountingBankReality;
  };
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
