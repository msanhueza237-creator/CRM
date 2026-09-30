import { creditNoteCostReview } from "./credit-note-costs.ts";
import { factoPostingPreview } from "./facto-posting-preview.ts";
import type { FactoCostReturnPreview } from "../_shared/facto-cost-return-contract.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" ? value as Row : {};
const text = (value: unknown) => String(value ?? "");

// The first controlled return for an invoice owns one database-unique key.
// Further notes require joint reconciliation, not concurrent independent refunds.
export const costReturnKey = (invoiceId: string) => `facto-cost-return:${invoiceId}`;

export function previewFactoCostReturn(input: Row, documents: Row[], lines: Row[], accounts: Row[], periods: Row[], entries: Row[], today: string): FactoCostReturnPreview {
  const note = documents.find(d => d.id === input.sourceDocumentId && d.entity_id === input.entityId);
  if (!note || note.document_type !== "sales_credit_note") throw new Error("Selecciona una nota de credito Facto de esta empresa.");
  const notePreview = factoPostingPreview(note);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(notePreview.date) || notePreview.date > today) throw new Error("La fecha de la nota no es valida o es futura.");
  const amount = Number(input.amountClp), evidence = text(input.evidence).trim();
  if (!Number.isSafeInteger(amount) || amount <= 0 || evidence.length < 20 || evidence.length > 500)
    throw new Error("Indica pesos CLP positivos y evidencia comprobada del costo y su reversa en Facto (20 a 500 caracteres).");
  if (input.saleableReturnConfirmed !== true) throw new Error("Confirma la devolucion fisica disponible para venta. Un equipo en revision no cumple esta condicion.");
  const period = periods.find(p => p.entity_id === input.entityId && p.status === "open" && notePreview.date >= text(p.starts_on) && notePreview.date <= text(p.ends_on));
  if (!period) throw new Error("La fecha de la nota no corresponde a un periodo abierto.");
  const entityDocs = documents.filter(d => d.entity_id === input.entityId);
  const entityLines = lines.filter(l => object(l.accounting_journal_entries).entity_id === input.entityId);
  const entityAccounts = accounts.filter(a => a.entity_id === input.entityId);
  for (const classification of ["cost_of_sales", "inventory"]) {
    const active = entityAccounts.filter(a => a.classification === classification && a.active === true);
    if (active.length !== 1 || active[0].allows_posting !== true)
      throw new Error("Se requiere un mapeo unico y activo de costo e inventario.");
  }
  const reviews = creditNoteCostReview(entityDocs, entityLines, entityAccounts, "9999-12-31");
  const review = reviews.find(r => r.id === note.id);
  if (!review?.invoiceId || !["partial", "cancellation"].includes(review.kind) || review.originalCost === null || review.originalCost <= 0)
    throw new Error("Falta una factura de origen unica con costo historico balanceado. No se estima el costo desde la venta.");
  const invoice = entityDocs.find(d => d.id === review.invoiceId)!;
  const invoicePreview = factoPostingPreview(invoice);
  const related = reviews.filter(r => r.invoiceId === review.invoiceId);
  const relatedIds = new Set([review.invoiceId, ...related.map(r => r.id)]);
  const costIds = new Set(entityAccounts.filter(a => ["cost_of_sales", "inventory"].includes(text(a.classification))).map(a => a.id));
  const relatedLines = entityLines.filter(l => costIds.has(l.account_id) && relatedIds.has(text(object(l.accounting_journal_entries).source_document_id)));
  if (relatedLines.some(l => text(object(l.accounting_journal_entries).source_document_id) === review.id))
    throw new Error("La nota ya tiene costo, borrador o reversa vinculado. Revisar el existente; no se repetira.");
  if (relatedLines.some(l => object(l.accounting_journal_entries).status !== "posted"))
    throw new Error("Hay costos en borrador o reversados en la factura o sus notas; requieren conciliacion conjunta.");
  if (related.some(r => r.id !== review.id && r.reversedCost === null && relatedLines.some(l => object(l.accounting_journal_entries).source_document_id === r.id)))
    throw new Error("Hay una reversa relacionada sin evidencia balanceada; requiere conciliacion conjunta.");
  if (relatedLines.some(l => /costo estimado|margen promedio|politica porcentual/i.test(text(object(l.accounting_journal_entries).description))))
    throw new Error("El costo original esta identificado como estimado; no puede importarse como historico verificado.");
  if (entries.some(e => e.entity_id === input.entityId && (e.idempotency_key === costReturnKey(review.invoiceId) || e.idempotency_key === `facto-cost:${review.id}`)))
    throw new Error("Existe un registro previo de devolucion. Una segunda nota de esta factura requiere conciliacion conjunta.");
  const otherReversals = related.filter(r => r.id !== review.id).reduce((n, r) => n + (r.reversedCost || 0), 0);
  if (!Number.isFinite(otherReversals) || otherReversals < 0 || amount + otherReversals > review.originalCost)
    throw new Error("La reversa excede el costo disponible de la factura.");
  if (review.kind === "cancellation" && (notePreview.net !== invoicePreview.net || amount + otherReversals !== review.originalCost))
    throw new Error("La anulacion requiere conciliar el costo completo y las reversas previas de la factura.");
  const result = { id: review.id, folio: review.folio, date: notePreview.date, invoiceId: review.invoiceId,
    invoiceFolio: review.invoiceFolio!, originalCost: review.originalCost, otherReversals, amountClp: amount,
    remainingCost: review.originalCost - otherReversals - amount };
  return { ...result, reviewKey: JSON.stringify({ result, evidence, note: notePreview.reviewKey, invoice: invoicePreview.reviewKey,
    period: period.id, accounts: entityAccounts.filter(a => costIds.has(a.id)).map(a => [a.id, a.classification, a.active, a.allows_posting]).sort(),
    lines: relatedLines.map(l => [l.id, l.account_id, l.debit_clp, l.credit_clp, object(l.accounting_journal_entries).id, object(l.accounting_journal_entries).entry_date]).sort() }) };
}
