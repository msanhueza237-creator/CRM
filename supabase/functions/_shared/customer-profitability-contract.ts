export interface ProfitabilityIssue {
  code: "identity" | "ambiguous_identity" | "sales_validation" | "missing_cost" | "credit_reversal";
  documentId: string; folio: string; issuedOn: string; source: string;
  reason: string; action: string; path: string;
  products: string[]; relatedDocumentId?: string | null;
}
export interface ProfitabilityCompleteness {
  universeCustomers: number; verifiedCustomers: number; provisionalCustomers: number; uncalculatedCustomers: number;
  documents: number; coveredDocuments: number; documentCoverage: number | null;
  identifiedCustomers: number; scope: "filtered_universe"; generatedAt: string;
  sourceObservedAt: string | null; freshness: "unknown" | "old" | "recent";
  sources: string[];
}
export interface CustomerProfitabilityRow {
  issues?: ProfitabilityIssue[];
  salesComplete?: boolean;
  excludedSalesDocuments?: number;
  customerKey: string;
  customer: string;
  taxId: string;
  sales: number;
  knownCost: number;
  knownSales: number;
  knownDocuments: number;
  analysis: {
    status: "verified" | "provisional" | "partial" | "unavailable";
    sales: number | null;
    cost: number | null;
    grossProfit: number | null;
    margin: number | null;
  };
  cost: number | null;
  grossProfit: number | null;
  margin: number | null;
  documents: number;
  missingCostDocuments: number;
  pendingCreditNotes: number;
  coverage: number;
  status: "complete" | "pending" | "unidentified" | "no_positive_sales";
}
export interface CustomerProfitabilityReport {
  excludedEvidence?: ProfitabilityIssue[];
  completeness?: ProfitabilityCompleteness;
  cohort?: string;
  matchedCustomers?: number;
  companyId?: string;
  companyTaxId?: string;
  from: string;
  to: string;
  basis: "document_issue_date";
  currency: "CLP";
  customers: number;
  offset: number;
  limit: number;
  rankedCustomers: number;
  salesCustomers: number;
  pendingCustomers: number;
  excludedDocuments: number;
  missingCostDocuments: number;
  pendingCreditNotes: number;
  topProfit: CustomerProfitabilityRow[];
  topMargin: CustomerProfitabilityRow[];
  topSales: CustomerProfitabilityRow[];
  matches: CustomerProfitabilityRow[];
  pending: CustomerProfitabilityRow[];
  warnings: string[];
}
