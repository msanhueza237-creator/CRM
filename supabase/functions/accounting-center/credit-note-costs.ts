import { factoHeader, isPostableFactoDocument } from "./facto-document-policy.ts";
import { dashboardDocumentSales, dashboardSalesEvidence } from "./dashboard-sales.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => String(value ?? "");
const taxId = (value: unknown) => text(value).replace(/[^\dkK]/g, "").toUpperCase();
const amount = (value: unknown) => value === null || value === undefined || value === "" ? NaN : Number(value);
const round = (value: number) => Math.round(value * 10000) / 10000;

export function creditNoteReferences(document: Row): Row[] {
  const refs = factoHeader(object(document.raw_payload)).references;
  return Array.isArray(refs) ? refs.map(object) : [];
}

export interface CreditNoteCostReview {
  id: string; folio: string; issuedOn: string; recognizedOn: string; counterpart: string; netClp: number;
  invoiceId: string | null; invoiceFolio: string | null; invoiceIssuedOn: string | null;
  kind: "cancellation" | "partial" | "text" | "unresolved";
  originalCost: number | null; reversedCost: number | null;
  pending: boolean; detail: string;
  reversals: Array<{ id: string; date: string; amount: number }>;
}

// A note's sale amount is never its inventory cost. Only balanced posted evidence
// can confirm a reversal; this read model must not synthesize accounting entries.
export function creditNoteCostReview(documents: Row[], lines: Row[], accounts: Row[], asOf: string): CreditNoteCostReview[] {
  const accountMap = new Map(accounts.map(a => [text(a.id), a]));
  const evidence = dashboardSalesEvidence(documents, lines, new Set(accounts.filter(a => a.account_type === "income").map(a => text(a.id))), asOf);
  const sales = new Map(evidence.map(d => [d.id, d]));
  const unique = [...new Map(documents.map(d => [text(d.id), d])).values()];
  const entries = new Map<string, { id: string; sourceId: string; date: string; cost: number; inventory: number; valid: boolean }>();
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.id && seen.has(text(line.id))) continue;
    if (line.id) seen.add(text(line.id));
    const entry = object(line.accounting_journal_entries), account = accountMap.get(text(line.account_id));
    if (!entry.id || !entry.source_document_id || !account || !["posted", "reversed"].includes(text(entry.status))
      || !/^\d{4}-\d{2}-\d{2}$/.test(text(entry.entry_date)) || text(entry.entry_date) > asOf
      || !["cost_of_sales", "inventory"].includes(text(account.classification))) continue;
    const key = text(entry.id), value = amount(line.debit_clp) - amount(line.credit_clp);
    const total = entries.get(key) || { id: key, sourceId: text(entry.source_document_id), date: text(entry.entry_date), cost: 0, inventory: 0, valid: true };
    total.valid &&= Number.isFinite(value);
    if (account.classification === "cost_of_sales") total.cost += value;
    else total.inventory += value;
    entries.set(key, total);
  }
  const costs = (id: string) => [...entries.values()].filter(e => e.sourceId === id);
  const exactCost = (id: string) => {
    const rows = costs(id);
    return rows.length && rows.every(e => e.valid && Math.abs(e.cost + e.inventory) < 0.005)
      ? round(rows.reduce((n, e) => n + e.cost, 0)) : null;
  };
  const reviews: CreditNoteCostReview[] = unique.filter(d => d.document_type === "sales_credit_note" && sales.has(text(d.id))).map(note => {
    const ev = sales.get(text(note.id))!, refs = creditNoteReferences(note), ref = refs.length === 1 ? refs[0] : {};
    const code = text(ref.reference_type);
    const kind = code === "1" ? "cancellation" : code === "3" ? "partial" : code === "2" ? "text" : "unresolved";
    const matches = unique.filter(d => {
      if (!isPostableFactoDocument(d) || !["sales_invoice", "sales_exempt_invoice", "sales_receipt", "sales_exempt_receipt"].includes(text(d.document_type))
        || !note.entity_id || d.entity_id !== note.entity_id || note.source_type !== "FACTO" || d.source_type !== "FACTO"
        || !taxId(note.counterpart_tax_id) || taxId(d.counterpart_tax_id) !== taxId(note.counterpart_tax_id)
        || !ref.reference_number || text(d.folio) !== text(ref.reference_number)
        || !ref.reference_date || text(d.issued_on) !== text(ref.reference_date)
        || text(d.issued_on) > ev.issuedOn) return false;
      const types: Record<string, string> = { sales_invoice: "33", sales_exempt_invoice: "34", sales_receipt: "39", sales_exempt_receipt: "41" };
      return text(ref.document_type_taxbureau) === types[text(d.document_type)]
        && (!ref.document_id || text(ref.document_id) === text(d.external_id));
    });
    const invoice = matches.length === 1 ? matches[0] : undefined;
    const original = invoice ? exactCost(text(invoice.id)) : null, noteCost = exactCost(ev.id);
    const reversedCost = noteCost !== null && noteCost <= 0 ? -noteCost || 0 : null;
    const reversals = reversedCost !== null ? costs(ev.id).map(e => ({ id: e.id, date: e.date, amount: round(-e.cost) })) : [];
    let pending = true, detail = "Referencia de factura no confirmada; revisar costo de la nota en Facto.";
    if (kind === "text") { pending = false; detail = "Correccion de texto; no autoriza descontar mercaderia."; }
    else if (invoice) {
      if (kind === "cancellation" && Math.abs((dashboardDocumentSales(invoice) ?? NaN) + ev.netClp) <= 1) {
        if (original !== null && original >= 0 && reversedCost !== null && Math.abs(original - reversedCost) < 0.005) {
          pending = false; detail = "Costo y reversa contabilizados; ya incluidos una sola vez en el resultado.";
        } else if (original === null) detail = "Factura anulada sin costo original confirmado en CRM; no se inventa una rebaja.";
        else detail = "Anulacion con costo pendiente de conciliar contra su reversa en Facto.";
      } else if (kind === "partial") {
        if (reversedCost !== null && reversedCost > 0 && original !== null && reversedCost <= original) {
          pending = false; detail = "Reversa parcial registrada, ya descontada del costo; no elimina el costo completo de la factura.";
        } else detail = "Nota parcial: falta verificar el costo de la mercaderia afectada; no se prorratea por el monto de venta.";
      } else detail = "Tipo o monto de referencia inconsistente; requiere revision antes de ajustar costos.";
    }
    return { id: ev.id, folio: ev.folio, issuedOn: ev.issuedOn, recognizedOn: ev.recognizedOn, counterpart: text(note.counterpart_name), netClp: ev.netClp,
      invoiceId: invoice ? text(invoice.id) : null, invoiceFolio: invoice ? text(invoice.folio) : null, invoiceIssuedOn: invoice ? text(invoice.issued_on) : null, kind,
      originalCost: original, reversedCost, reversals, pending, detail };
  });
  const reversedByInvoice = new Map<string, number>();
  for (const row of reviews) if (row.invoiceId && row.reversedCost !== null)
    reversedByInvoice.set(row.invoiceId, (reversedByInvoice.get(row.invoiceId) || 0) + row.reversedCost);
  for (const row of reviews) if (row.invoiceId && row.originalCost !== null && (reversedByInvoice.get(row.invoiceId) || 0) > row.originalCost + 0.005) {
    row.pending = true;
    row.detail = "Las reversas acumuladas superan el costo conocido de la factura; conciliar antes de confirmar.";
  }
  return reviews;
}

export function creditNoteCostPeriod(reviews: CreditNoteCostReview[], from: string, to: string) {
  const within = (date: string) => date >= from && date <= to;
  const priorInvoices = reviews.filter(r => within(r.recognizedOn) && r.invoiceIssuedOn && r.invoiceIssuedOn < from);
  return {
    salesCreditPriorInvoices: round(-priorInvoices.reduce((total, r) => total + r.netClp, 0)) || 0,
    salesCreditPriorInvoiceDocuments: priorInvoices.length,
    creditNoteCostPending: reviews.filter(r => r.pending && within(r.recognizedOn)).length,
    costCreditNotes: round(reviews.reduce((total, r) => total + r.reversals.filter(e => within(e.date)).reduce((n, e) => n + e.amount, 0), 0)),
  };
}
