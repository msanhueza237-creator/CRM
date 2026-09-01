import type {
  AccountingBankTransaction,
  AccountingPayable,
  AccountingReceivable,
  AccountingReconciliationCandidate,
} from "../../types/accounting";

export type ReconciliationMovementSort = "date-desc" | "date-asc" | "name-asc" | "name-desc" | "amount-desc";
export type ReconciliationDocumentSort = "relevance" | "date-desc" | "date-asc" | "name-asc";

export interface PayrollEmployeeMatch {
  key: "sisla" | "marco";
  name: "Sisla Muñoz" | "Marco Sanhueza";
  taxId: "14.186.473-4" | "15.427.713-7";
}

export function normalizeAccountingSearch(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9k]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: unknown) {
  return normalizeAccountingSearch(value).replace(/\s+/g, "");
}

function dateAliases(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${value} ${day}-${month}-${year} ${day}/${month}/${year}` : value;
}

function queryTokens(query: string) {
  return normalizeAccountingSearch(query).split(" ").filter(Boolean);
}

function matchesEveryToken(text: string, query: string) {
  const normalized = normalizeAccountingSearch(text);
  const words = normalized.split(" ").filter(Boolean);
  const normalizedCompact = compact(text);
  return queryTokens(query).every((token) =>
    words.some((word) => word.startsWith(token) || word.includes(token)) || normalizedCompact.includes(compact(token))
  );
}

export function filterAndSortReconciliationTransactions(
  rows: AccountingBankTransaction[],
  filters: { query: string; from: string; to: string; sort: ReconciliationMovementSort },
) {
  const filtered = rows.filter((row) => {
    const searchable = `${row.description} ${row.reference || ""} ${row.operation_number || ""} ${dateAliases(row.transaction_date)}`;
    return (!filters.query.trim() || matchesEveryToken(searchable, filters.query))
      && (!filters.from || row.transaction_date >= filters.from)
      && (!filters.to || row.transaction_date <= filters.to);
  });
  return filtered.sort((left, right) => {
    const byDate = left.transaction_date.localeCompare(right.transaction_date);
    const byName = left.description.localeCompare(right.description, "es", { sensitivity: "base", numeric: true });
    if (filters.sort === "date-asc") return byDate || byName;
    if (filters.sort === "name-asc") return byName || -byDate;
    if (filters.sort === "name-desc") return -byName || -byDate;
    if (filters.sort === "amount-desc") return Math.abs(right.amount_clp) - Math.abs(left.amount_clp) || -byDate || byName;
    return -byDate || byName;
  });
}

function documentIdentity(candidate: AccountingReconciliationCandidate) {
  const document = candidate.candidate;
  const receivable = candidate.targetType === "receivable";
  return {
    name: receivable ? (document as AccountingReceivable).customer_name : (document as AccountingPayable).supplier_name,
    taxId: receivable ? (document as AccountingReceivable).customer_tax_id : (document as AccountingPayable).supplier_tax_id,
    documentNumber: document.document_number,
  };
}

function documentSearchScore(candidate: AccountingReconciliationCandidate, query: string) {
  if (!query.trim()) return candidate.score * 100;
  const { name, taxId, documentNumber } = documentIdentity(candidate);
  const searchable = `${name} ${taxId || ""} ${documentNumber}`;
  if (!matchesEveryToken(searchable, query)) return -1;
  const normalizedQuery = normalizeAccountingSearch(query);
  const normalizedName = normalizeAccountingSearch(name);
  const compactQuery = compact(query);
  if (compactQuery && compact(taxId) === compactQuery) return 130;
  if (compactQuery && compact(documentNumber) === compactQuery) return 125;
  if (normalizedName === normalizedQuery) return 120;
  if (normalizedName.startsWith(normalizedQuery)) return 110;
  const words = normalizedName.split(" ");
  if (queryTokens(query).every((token) => words.some((word) => word.startsWith(token)))) return 100;
  return 80;
}

function amountSignal(amount: number, balance: number): AccountingReconciliationCandidate["signals"]["amount"] {
  const tolerance = Math.max(1, Math.max(amount, balance) * 0.001);
  if (Math.abs(amount - balance) <= tolerance) return "exact";
  if (amount < balance - tolerance) return "partial";
  if (amount > balance + tolerance && balance > 0) return "over";
  return "different";
}

function manualCandidate(
  targetType: "receivable" | "payable",
  document: AccountingReceivable | AccountingPayable,
  remainingAmount: number,
): AccountingReconciliationCandidate {
  const signal = amountSignal(remainingAmount, Number(document.balance_clp) || 0);
  return {
    targetType,
    targetId: document.id,
    score: 0,
    confidence: "possible",
    suggestedAmount: Math.min(remainingAmount, Math.max(0, Number(document.balance_clp) || 0)),
    evidence: ["Resultado de búsqueda manual", ...(signal === "partial" ? ["Posible pago parcial"] : [])],
    dateDifferenceDays: null,
    signals: { taxId: false, document: false, name: 0, date: false, amount: signal },
    candidate: document,
  };
}

export function reconciliationDocumentCandidates(input: {
  proposalCandidates: AccountingReconciliationCandidate[];
  receivables: AccountingReceivable[];
  payables: AccountingPayable[];
  incoming: boolean;
  query: string;
  remainingAmount: number;
  sort: ReconciliationDocumentSort;
}) {
  const byId = new Map(input.proposalCandidates.map((candidate) => [candidate.targetId, candidate]));
  if (input.query.trim().length >= 2) {
    const openStatuses = new Set(["pending", "partial", "overdue", "collections"]);
    const documents = input.incoming ? input.receivables : input.payables;
    for (const document of documents) {
      if (!openStatuses.has(document.status) || Number(document.balance_clp) <= 0.5 || byId.has(document.id)) continue;
      const candidate = manualCandidate(input.incoming ? "receivable" : "payable", document, input.remainingAmount);
      if (documentSearchScore(candidate, input.query) >= 0) byId.set(document.id, candidate);
    }
  }

  const visible = [...byId.values()]
    .map((candidate) => ({ candidate, searchScore: documentSearchScore(candidate, input.query) }))
    .filter((item) => item.searchScore >= 0);
  visible.sort((left, right) => {
    const leftIdentity = documentIdentity(left.candidate);
    const rightIdentity = documentIdentity(right.candidate);
    const byDate = left.candidate.candidate.issued_on.localeCompare(right.candidate.candidate.issued_on);
    const byName = leftIdentity.name.localeCompare(rightIdentity.name, "es", { sensitivity: "base", numeric: true });
    if (input.sort === "date-desc") return -byDate || byName;
    if (input.sort === "date-asc") return byDate || byName;
    if (input.sort === "name-asc") return byName || -byDate;
    return right.searchScore - left.searchScore || right.candidate.score - left.candidate.score || byName || -byDate;
  });
  return visible.map((item) => item.candidate);
}

export function identifyPayrollEmployee(description: string): PayrollEmployeeMatch | null {
  const normalized = normalizeAccountingSearch(description);
  const descriptionCompact = compact(description);
  if (descriptionCompact.includes("141864734") || (normalized.includes("sisla") && normalized.includes("munoz"))) {
    return { key: "sisla", name: "Sisla Muñoz", taxId: "14.186.473-4" };
  }
  if (descriptionCompact.includes("154277137") || (normalized.includes("marco") && (normalized.includes("sanhueza") || normalized.includes("emilio")))) {
    return { key: "marco", name: "Marco Sanhueza", taxId: "15.427.713-7" };
  }
  return null;
}

export function payrollClassificationLock(transaction: AccountingBankTransaction) {
  const metadata = transaction.metadata || {};
  if (metadata.classification_locked !== true) return null;
  const classification = String(metadata.verified_classification || "clasificación protegida");
  return classification === "loan_repayment_sisla"
    ? "Protegido: este movimiento forma parte de la devolución de préstamo de $22.000.000 a Sisla."
    : `Protegido: el movimiento ya tiene la clasificación ${classification}.`;
}

export function matchingPostedPayrollDuplicate(
  transaction: AccountingBankTransaction,
  rows: AccountingBankTransaction[],
) {
  const employee = identifyPayrollEmployee(transaction.description);
  if (!employee) return null;
  return rows.find((candidate) => {
    if (candidate.id === transaction.id || candidate.transaction_date !== transaction.transaction_date) return false;
    if (Math.abs(Number(candidate.amount_clp) - Number(transaction.amount_clp)) > 0.5) return false;
    if (identifyPayrollEmployee(candidate.description)?.key !== employee.key) return false;
    const classification = String(candidate.metadata?.verified_classification || "");
    return candidate.reconciliation_status === "matched" && classification === `salary_${employee.key}`;
  }) || null;
}
