export interface LoanDraft {
  id: string;
  entity_id: string;
  liability_account_id: string;
  lender_name: string;
  lender_tax_id: string | null;
  principal_clp: number;
  received_on: string;
  due_on: string | null;
  interest_terms: "unknown" | "none" | "agreed";
  terms_notes: string;
  purpose: string;
  invoice_reference: string;
}
export interface LoanMovement {
  id: string;
  kind: "received" | "repayment";
  amount_clp: number;
  bank_transaction_id: string;
  entry_id: string;
  accounting_journal_entries: { status: string; entry_date: string; entry_number: number };
}
export interface AccountingLoan extends LoanDraft {
  accounting_loan_movements: LoanMovement[];
}
export interface LoanPosting {
  loanId: string;
  kind: LoanMovement["kind"];
  transactionId: string;
}
export interface LoanPreview {
  loanId: string;
  existing: boolean;
  entryId?: string;
  amountClp: number;
  date?: string;
  staged?: boolean;
  balanceAfter?: number;
  lines?: Array<{ account_id: string; debit_clp: number; credit_clp: number }>;
}
export function loanFigures(loan: AccountingLoan) {
  const movements = loan.accounting_loan_movements || [];
  const posted = movements.filter(m => m.accounting_journal_entries?.status === "posted");
  const received = posted.filter(m => m.kind === "received").reduce((v,m) => v + Number(m.amount_clp), 0);
  const repaid = posted.filter(m => m.kind === "repayment").reduce((v,m) => v + Number(m.amount_clp), 0);
  const review = movements.some(m => m.accounting_journal_entries?.status !== "posted");
  return { received, repaid, balance: review ? null : received - repaid,
    status: review ? "review" : !movements.length ? "draft" : received === repaid ? "paid" : "open" };
}
