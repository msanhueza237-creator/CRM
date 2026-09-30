import { assertFactoDocumentNotRejected, factoHeader, isPostableFactoDocument } from "./facto-document-policy.ts";
import type { FactoPostingPreview } from "../_shared/facto-posting-contract.ts";

type Row = Record<string, unknown>;

export function factoPostingPreview(document: Row): FactoPostingPreview {
  assertFactoDocumentNotRejected(document);
  const header = factoHeader((document.raw_payload || {}) as Row);
  if (document.source_type !== "FACTO" || !isPostableFactoDocument(document)
    || !["sales_invoice", "sales_receipt", "sales_credit_note"].includes(String(document.document_type))
    || document.currency !== "CLP") throw new Error("La revision individual requiere una venta o nota Facto validada en CLP.");
  if (!["3", "4"].includes(String(header.taxbureau_validation_status))) throw new Error("Falta confirmar la aceptacion del documento por el SII en Facto.");
  const value = (v: unknown) => v === null || v === undefined || v === "" ? NaN : Number(v);
  const net = value(document.net_amount), tax = value(document.tax_amount), total = value(document.total_clp);
  const exempt = document.exempt_amount == null ? 0 : value(document.exempt_amount);
  if (![net, tax, total, exempt].every(n => Number.isSafeInteger(n) && n >= 0)
    || total <= 0 || net + tax + exempt !== total) throw new Error("Los importes del documento no cuadran en pesos CLP. Revisar antes de contabilizar.");
  const result = { id: String(document.id), folio: String(document.folio || ""), date: String(document.issued_on || ""),
    type: String(document.document_type), net: net + exempt, tax, total,
    creditNote: document.document_type === "sales_credit_note" };
  // Compare the financial facts reviewed by the user, not volatile sync timestamps.
  return { ...result, reviewKey: JSON.stringify({ ...result, entity: document.entity_id,
    counterpart: document.counterpart_tax_id, currency: document.currency,
    sii: header.taxbureau_validation_status, references: header.references || [] }) };
}

export function assertFactoPostingSaved(preview: FactoPostingPreview, entry: Row, lines: Row[], accounts: Row[]) {
  if (entry.status !== "posted" || entry.entry_date !== preview.date || entry.source_document_id !== preview.id)
    throw new Error("El asiento guardado no esta contabilizado con la fecha y documento revisados.");
  const ids = new Map(accounts.map(a => [String(a.id), String(a.classification)]));
  const sign = preview.creditNote ? -1 : 1;
  const expectedLines: Array<[string, number]> = [["receivables", preview.total * sign], ["net_sales", -preview.net * sign], ["vat_debit", -preview.tax * sign]];
  const expected = new Map(expectedLines.filter(([, n]) => n !== 0));
  if (lines.length !== expected.size) throw new Error("El asiento guardado tiene una estructura distinta a la revisada.");
  for (const line of lines) {
    const classification = ids.get(String(line.account_id)) || "";
    const value = expected.get(classification);
    if (typeof value !== "number" || Number(line.debit_clp) !== Math.max(0, value) || Number(line.credit_clp) !== Math.max(0, -value))
      throw new Error("El asiento guardado no coincide con los importes revisados.");
    expected.delete(classification);
  }
}

export function assertUnpostedFactoSource(entries: Row[], lines: Row[], accounts: Row[]) {
  const financialAccounts = new Set(accounts.filter(a => ["net_sales", "vat_debit"].includes(String(a.classification))).map(a => String(a.id)));
  const conflicts = new Set(lines.filter(l => financialAccounts.has(String(l.account_id))).map(l => String(l.entry_id)));
  // Costs and payments do not prove a sale posting. Any income draft, reversal or
  // alternative key must be reviewed instead of making a second revenue entry.
  if (entries.some(e => conflicts.has(String(e.id)) || String(e.idempotency_key || "").startsWith("facto-document:")))
    throw new Error("Ya existe un asiento de venta, borrador o reversa asociado. Actualiza y revisa el libro; no se duplico el documento.");
}
