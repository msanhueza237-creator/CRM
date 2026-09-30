export interface CustomerProfitabilityRow {
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
