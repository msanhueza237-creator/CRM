import type {
  AccountingBankTransaction,
  AccountingPayable,
  AccountingReceivable,
  AccountingReconciliationCandidate,
  AccountingReconciliationProposal,
} from "../../types/accounting";

type JsonRecord = Record<string, unknown>;

const confidenceValues = new Set(["exact", "high", "possible"]);
const amountSignalValues = new Set(["exact", "partial", "over", "different"]);

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function targetType(value: unknown, incoming: boolean): "receivable" | "payable" {
  return value === "receivable" || value === "payable"
    ? value
    : incoming ? "receivable" : "payable";
}

function amountSignal(value: unknown, movementAmount: number, documentBalance: number) {
  if (typeof value === "string" && amountSignalValues.has(value)) {
    return value as AccountingReconciliationCandidate["signals"]["amount"];
  }
  if (Math.abs(movementAmount - documentBalance) <= 0.5) return "exact";
  if (movementAmount < documentBalance) return "partial";
  if (movementAmount > documentBalance) return "over";
  return "different";
}

/**
 * Keeps the reconciliation UI compatible while the Edge Function and frontend
 * are deployed independently. It also rejects malformed candidates before
 * React can try to render them.
 */
export function normalizeAccountingReconciliationProposal(value: unknown): AccountingReconciliationProposal {
  const raw = asRecord(value);
  const transactionRecord = asRecord(raw.transaction);
  if (typeof transactionRecord.id !== "string" || !transactionRecord.id) {
    throw new Error("La propuesta de conciliación llegó incompleta. Actualiza la página e inténtalo nuevamente.");
  }

  const transaction = transactionRecord as unknown as AccountingBankTransaction;
  const movementAmount = Math.abs(finiteNumber(transaction.amount_clp));
  const incoming = finiteNumber(transaction.amount_clp) >= 0;
  const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];

  const candidates = rawCandidates.flatMap((candidateValue): AccountingReconciliationCandidate[] => {
    const candidateRecord = asRecord(candidateValue);
    const documentRecord = asRecord(candidateRecord.candidate);
    const id = typeof candidateRecord.targetId === "string" && candidateRecord.targetId
      ? candidateRecord.targetId
      : typeof documentRecord.id === "string" ? documentRecord.id : "";
    if (!id) return [];

    const type = targetType(candidateRecord.targetType, incoming);
    const balance = Math.max(0, finiteNumber(documentRecord.balance_clp));
    const score = Math.max(0, Math.min(1, finiteNumber(candidateRecord.score)));
    const confidence = typeof candidateRecord.confidence === "string" && confidenceValues.has(candidateRecord.confidence)
      ? candidateRecord.confidence as AccountingReconciliationCandidate["confidence"]
      : score >= 0.95 ? "exact" : score >= 0.75 ? "high" : "possible";
    const suggestedAmount = Math.max(0, finiteNumber(candidateRecord.suggestedAmount, Math.min(movementAmount, balance)));
    const evidence = Array.isArray(candidateRecord.evidence)
      ? candidateRecord.evidence.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    const rawSignals = asRecord(candidateRecord.signals);
    const rawDateDifference = Number(candidateRecord.dateDifferenceDays);

    return [{
      targetType: type,
      targetId: id,
      score,
      confidence,
      suggestedAmount,
      evidence,
      dateDifferenceDays: Number.isFinite(rawDateDifference) ? rawDateDifference : null,
      signals: {
        taxId: Boolean(rawSignals.taxId),
        document: Boolean(rawSignals.document),
        name: finiteNumber(rawSignals.name),
        date: Boolean(rawSignals.date),
        amount: amountSignal(rawSignals.amount, movementAmount, balance),
      },
      candidate: documentRecord as unknown as AccountingReceivable | AccountingPayable,
    }];
  });

  const allocatedAmount = Math.max(0, finiteNumber(raw.allocatedAmount));
  const remainingAmount = Math.max(0, finiteNumber(raw.remainingAmount, movementAmount - allocatedAmount));
  const rawPlan = asRecord(raw.suggestedPlan);
  const planLinks = Array.isArray(rawPlan.links)
    ? rawPlan.links.flatMap((linkValue) => {
      const link = asRecord(linkValue);
      if (typeof link.targetId !== "string" || !link.targetId) return [];
      return [{
        targetType: targetType(link.targetType, incoming),
        targetId: link.targetId,
        amount: Math.max(0, finiteNumber(link.amount)),
      }];
    }).filter((link) => link.amount > 0)
    : [];

  return {
    transaction,
    allocatedAmount,
    remainingAmount,
    candidates,
    suggestedPlan: planLinks.length ? {
      links: planLinks,
      score: Math.max(0, Math.min(1, finiteNumber(rawPlan.score))),
      explanation: typeof rawPlan.explanation === "string" ? rawPlan.explanation : "Propuesta calculada por el motor de conciliación.",
    } : null,
  };
}
