export type ReconciliationTargetType = "receivable" | "payable";

export interface ReconciliationTransactionInput {
  amountClp: number;
  transactionDate: string;
  description: string;
  reference?: string | null;
  operationNumber?: string | null;
}

export interface ReconciliationDocumentInput<T> {
  targetType: ReconciliationTargetType;
  targetId: string;
  counterpartyName: string;
  counterpartyTaxId?: string | null;
  documentNumber: string;
  issuedOn: string;
  dueOn?: string | null;
  balanceClp: number;
  raw: T;
}

export interface ReconciliationSignals {
  taxId: boolean;
  document: boolean;
  name: number;
  date: boolean;
  amount: "exact" | "partial" | "over" | "different";
}

export interface RankedReconciliationCandidate<T> {
  targetType: ReconciliationTargetType;
  targetId: string;
  document: ReconciliationDocumentInput<T>;
  score: number;
  confidence: "exact" | "high" | "possible";
  suggestedAmount: number;
  evidence: string[];
  dateDifferenceDays: number | null;
  signals: ReconciliationSignals;
  groupKey: string;
}

export interface SuggestedReconciliationPlan {
  links: Array<{ targetType: ReconciliationTargetType; targetId: string; amount: number }>;
  score: number;
  explanation: string;
}

export interface ExactReconciliationSelection<T> {
  candidate: RankedReconciliationCandidate<T>;
  reason: string;
}

const ignoredNameTokens = new Set([
  "abono", "banco", "cargo", "comercial", "deposito", "documento", "documentos", "eirl",
  "empresa", "env", "limitada", "ltda", "pago", "recibido", "sociedad", "spa", "tef", "trf",
  "transferencia", "transferido", "transfer", "importadora", "servicios", "chile", "clp", "rut",
]);

export function normalizeReconciliationText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9k]+/g, " ")
    .trim();
}

export function normalizeChileanTaxId(value: unknown) {
  return String(value ?? "").toUpperCase().replace(/[^0-9K]/g, "");
}

export function isValidChileanTaxId(value: unknown) {
  const taxId = normalizeChileanTaxId(value);
  if (!/^\d{7,8}[0-9K]$/.test(taxId)) return false;
  const body = taxId.slice(0, -1);
  const expected = taxId.slice(-1);
  let sum = 0;
  let factor = 2;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const result = 11 - (sum % 11);
  const verifier = result === 11 ? "0" : result === 10 ? "K" : String(result);
  return verifier === expected;
}

export function extractChileanTaxIds(value: unknown) {
  const text = String(value ?? "");
  const matches = text.match(/\b(?:\d{1,2}(?:\.\d{3}){2}|\d{7,8})-[0-9kK]\b/g) || [];
  return [...new Set(matches.map(normalizeChileanTaxId).filter(isValidChileanTaxId))];
}

function nameTokens(value: unknown) {
  return normalizeReconciliationText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !ignoredNameTokens.has(token));
}

function nameSimilarity(transactionText: string, candidateName: string) {
  const transactionTokens = new Set(nameTokens(transactionText));
  const candidateTokens = [...new Set(nameTokens(candidateName))];
  if (!candidateTokens.length || !transactionTokens.size) return 0;
  const matches = candidateTokens.filter((token) => transactionTokens.has(token)).length;
  const coverage = matches / candidateTokens.length;
  const dice = (2 * matches) / (candidateTokens.length + transactionTokens.size);
  return Math.min(1, Math.max(coverage, (coverage * 0.72) + (dice * 0.28)));
}

function dateDistance(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return null;
  const a = Date.parse(`${left.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${right.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(Math.abs(a - b) / 86_400_000);
}

function dateSignal(transactionDate: string, issuedOn: string, dueOn?: string | null) {
  const issued = dateDistance(transactionDate, issuedOn);
  const due = dateDistance(transactionDate, dueOn);
  const distance = due === null ? issued : issued === null ? due : Math.min(issued, due);
  if (distance === null) return { score: 0, distance: null, matches: false };
  if (distance <= 3) return { score: 0.12, distance, matches: true };
  if (distance <= 15) return { score: 0.1, distance, matches: true };
  if (distance <= 45) return { score: 0.07, distance, matches: true };
  if (distance <= 120) return { score: 0.035, distance, matches: true };
  return { score: 0, distance, matches: false };
}

function amountSignal(amount: number, balance: number) {
  const tolerance = Math.max(1, Math.max(amount, balance) * 0.001);
  if (Math.abs(amount - balance) <= tolerance) return { kind: "exact" as const, score: 0.3 };
  if (amount < balance - tolerance) return { kind: "partial" as const, score: 0.14 };
  if (amount > balance + tolerance && balance > 0) return { kind: "over" as const, score: 0.08 };
  return { kind: "different" as const, score: 0 };
}

export function rankReconciliationCandidates<T>(
  transaction: ReconciliationTransactionInput,
  documents: Array<ReconciliationDocumentInput<T>>,
  availableAmount: number,
) {
  const transactionText = `${transaction.description || ""} ${transaction.reference || ""} ${transaction.operationNumber || ""}`;
  const normalizedTransaction = normalizeReconciliationText(transactionText);
  const transactionTaxIds = extractChileanTaxIds(transactionText);
  const amount = Math.max(0, Math.abs(availableAmount));

  return documents.map((document): RankedReconciliationCandidate<T> => {
    const taxId = normalizeChileanTaxId(document.counterpartyTaxId);
    const taxIdMatch = Boolean(taxId && transactionTaxIds.includes(taxId));
    const documentNumber = normalizeReconciliationText(document.documentNumber);
    const documentMatch = Boolean(documentNumber && (` ${normalizedTransaction} `).includes(` ${documentNumber} `));
    const similarity = nameSimilarity(transactionText, document.counterpartyName);
    const dates = dateSignal(transaction.transactionDate, document.issuedOn, document.dueOn);
    const amounts = amountSignal(amount, Math.max(0, document.balanceClp));
    const score = Math.min(1,
      (taxIdMatch ? 0.38 : 0)
      + (documentMatch ? 0.3 : 0)
      + (similarity * 0.25)
      + dates.score
      + amounts.score,
    );
    const strongIdentity = taxIdMatch || documentMatch || similarity >= 0.72;
    const confidence = score >= 0.8 && strongIdentity && amounts.kind === "exact"
      ? "exact"
      : score >= 0.55 && strongIdentity
        ? "high"
        : "possible";
    const evidence: string[] = [];
    if (taxIdMatch) evidence.push("RUT exacto");
    if (documentMatch) evidence.push("Folio en cartola");
    if (similarity >= 0.35) evidence.push(`Nombre ${Math.round(similarity * 100)}%`);
    if (amounts.kind === "exact") evidence.push("Monto exacto");
    if (amounts.kind === "partial") evidence.push("Posible pago parcial");
    if (amounts.kind === "over") evidence.push("Puede cubrir varias facturas");
    if (dates.matches && dates.distance !== null) evidence.push(`Fecha a ${dates.distance} día${dates.distance === 1 ? "" : "s"}`);
    return {
      targetType: document.targetType,
      targetId: document.targetId,
      document,
      score,
      confidence,
      suggestedAmount: Math.min(amount, Math.max(0, document.balanceClp)),
      evidence,
      dateDifferenceDays: dates.distance,
      signals: {
        taxId: taxIdMatch,
        document: documentMatch,
        name: similarity,
        date: dates.matches,
        amount: amounts.kind,
      },
      groupKey: taxIdMatch ? `rut:${taxId}` : `name:${nameTokens(document.counterpartyName).join("-")}`,
    };
  })
    .filter((candidate) => candidate.score >= 0.22)
    .sort((left, right) => right.score - left.score || left.document.issuedOn.localeCompare(right.document.issuedOn))
    .slice(0, 50);
}

export function buildSuggestedAllocationPlan<T>(
  ranked: Array<RankedReconciliationCandidate<T>>,
  availableAmount: number,
): SuggestedReconciliationPlan | null {
  const amount = Math.max(0, availableAmount);
  const top = ranked[0];
  if (!top || amount <= 0 || (top.confidence !== "exact" && top.confidence !== "high")) return null;
  const related = ranked
    .filter((candidate) => candidate.groupKey === top.groupKey && candidate.confidence !== "possible")
    .sort((left, right) => {
      if (left.signals.document !== right.signals.document) return left.signals.document ? -1 : 1;
      const leftDate = left.document.dueOn || left.document.issuedOn;
      const rightDate = right.document.dueOn || right.document.issuedOn;
      return leftDate.localeCompare(rightDate) || right.score - left.score;
    });
  const links: SuggestedReconciliationPlan["links"] = [];
  let remaining = amount;
  let weightedScore = 0;
  for (const candidate of related) {
    if (remaining <= 0.5) break;
    const allocation = Math.min(remaining, Math.max(0, candidate.document.balanceClp));
    if (allocation <= 0) continue;
    links.push({ targetType: candidate.targetType, targetId: candidate.targetId, amount: allocation });
    weightedScore += candidate.score * allocation;
    remaining -= allocation;
  }
  if (!links.length) return null;
  const assigned = amount - remaining;
  return {
    links,
    score: assigned > 0 ? weightedScore / assigned : top.score,
    explanation: links.length > 1
      ? `Distribución sugerida entre ${links.length} documentos de la misma contraparte, desde los más antiguos.`
      : top.signals.amount === "partial"
        ? "Abono parcial sugerido sobre el documento con mejor coincidencia."
        : "Coincidencia sugerida por identidad, fecha y monto.",
  };
}

export function selectUniqueExactReconciliation<T>(
  ranked: Array<RankedReconciliationCandidate<T>>,
  availableAmount: number,
): ExactReconciliationSelection<T> | null {
  const amount = Math.max(0, Math.abs(availableAmount));
  if (amount <= 0.5) return null;
  const exact = ranked.filter((candidate) => {
    const amountTolerance = Math.max(0.5, amount * 0.000001);
    const fullBalanceMatch = Math.abs(candidate.document.balanceClp - amount) <= amountTolerance;
    const strongVerifiedIdentity = candidate.signals.taxId || candidate.signals.document;
    return candidate.confidence === "exact"
      && candidate.signals.amount === "exact"
      && fullBalanceMatch
      && strongVerifiedIdentity;
  });
  if (exact.length !== 1) return null;
  const candidate = exact[0];
  return {
    candidate,
    reason: candidate.signals.taxId && candidate.signals.document
      ? "Monto, RUT y folio coinciden exactamente."
      : candidate.signals.taxId
        ? "Monto y RUT coinciden exactamente."
        : "Monto y folio coinciden exactamente.",
  };
}
