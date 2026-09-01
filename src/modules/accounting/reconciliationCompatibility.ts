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

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

  const transaction: AccountingBankTransaction = {
    id: transactionRecord.id,
    bank_account_id: textValue(transactionRecord.bank_account_id),
    transaction_date: textValue(transactionRecord.transaction_date),
    value_date: nullableText(transactionRecord.value_date),
    description: textValue(transactionRecord.description, "Movimiento bancario sin descripción"),
    reference: nullableText(transactionRecord.reference),
    operation_number: nullableText(transactionRecord.operation_number),
    debit: finiteNumber(transactionRecord.debit),
    credit: finiteNumber(transactionRecord.credit),
    amount: finiteNumber(transactionRecord.amount),
    balance: transactionRecord.balance === null ? null : finiteNumber(transactionRecord.balance),
    currency: textValue(transactionRecord.currency, "CLP"),
    exchange_rate: finiteNumber(transactionRecord.exchange_rate, 1),
    amount_clp: finiteNumber(transactionRecord.amount_clp),
    reconciliation_status: ["unmatched", "proposed", "partial", "matched", "ignored"].includes(String(transactionRecord.reconciliation_status))
      ? transactionRecord.reconciliation_status as AccountingBankTransaction["reconciliation_status"]
      : "unmatched",
    metadata: asRecord(transactionRecord.metadata),
  };
  const movementAmount = Math.abs(finiteNumber(transaction.amount_clp));
  const incoming = finiteNumber(transaction.amount_clp) >= 0;
  const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];

  const candidates = rawCandidates.flatMap((candidateValue): AccountingReconciliationCandidate[] => {
    const candidateRecord = asRecord(candidateValue);
    const documentContainer = asRecord(candidateRecord.document);
    const documentRecord = Object.keys(asRecord(candidateRecord.candidate)).length
      ? asRecord(candidateRecord.candidate)
      : Object.keys(asRecord(documentContainer.raw)).length
        ? asRecord(documentContainer.raw)
        : documentContainer;
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

    const commonDocument = {
      id,
      document_number: textValue(documentRecord.document_number, "Sin folio"),
      issued_on: textValue(documentRecord.issued_on),
      due_on: nullableText(documentRecord.due_on),
      original_amount_clp: Math.max(0, finiteNumber(documentRecord.original_amount_clp, balance)),
      paid_amount_clp: Math.max(0, finiteNumber(documentRecord.paid_amount_clp)),
      balance_clp: balance,
      reported_paid_amount_clp: documentRecord.reported_paid_amount_clp === null || documentRecord.reported_paid_amount_clp === undefined
        ? null
        : Math.max(0, finiteNumber(documentRecord.reported_paid_amount_clp)),
      reported_balance_clp: documentRecord.reported_balance_clp === null || documentRecord.reported_balance_clp === undefined
        ? null
        : Math.max(0, finiteNumber(documentRecord.reported_balance_clp)),
      reported_at: nullableText(documentRecord.reported_at),
      reported_source_batch_id: nullableText(documentRecord.reported_source_batch_id),
      status: textValue(documentRecord.status, "pending"),
      currency: textValue(documentRecord.currency, "CLP"),
    };
    const document = type === "receivable"
      ? {
        ...commonDocument,
        customer_name: textValue(documentRecord.customer_name, textValue(documentContainer.counterpartyName, "Cliente sin identificar")),
        customer_tax_id: nullableText(documentRecord.customer_tax_id) || nullableText(documentContainer.counterpartyTaxId),
      } as AccountingReceivable
      : {
        ...commonDocument,
        supplier_name: textValue(documentRecord.supplier_name, textValue(documentContainer.counterpartyName, "Proveedor sin identificar")),
        supplier_tax_id: nullableText(documentRecord.supplier_tax_id) || nullableText(documentContainer.counterpartyTaxId),
      } as AccountingPayable;

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
      candidate: document,
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
