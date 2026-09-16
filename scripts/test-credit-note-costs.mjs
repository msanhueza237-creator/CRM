import assert from "node:assert/strict";
import test from "node:test";
import { creditNoteCostReview, creditNoteCostPeriod } from "../supabase/functions/accounting-center/credit-note-costs.ts";
import { aggregateFinancialPeriod, projectedSalesDocument, financialPeriod } from "../supabase/functions/crm-copilot/business-analytics.ts";
import { dashboardDetailRows } from "../src/modules/accounting/dashboardNavigation.ts";

const accounts = [{ id: "income", account_type: "income" },
  { id: "cost", account_type: "cost", classification: "cost_of_sales" },
  { id: "inventory", account_type: "asset", classification: "inventory" }];
const august = { from: "2026-08-01", to: "2026-08-31" };
const doc = (folio, date, net = 1000) => ({ id: `invoice-${folio}`, entity_id: "entity", external_id: `${folio}`,
  source_type: "FACTO", folio: `${folio}`, issued_on: date, currency: "CLP", net_amount: net, exempt_amount: 0,
  tax_amount: net * .19, total_clp: net * 1.19, status: "validated", data_quality: "validated",
  document_type: "sales_invoice", counterpart_tax_id: "12345678-9", counterpart_name: "Prueba" });
const note = (invoice, code = 1, net = invoice.net_amount, date = "2026-08-20") => ({ ...doc(80, date, net), id: "nc-80",
  document_type: "sales_credit_note", raw_payload: { references: [{ document_id: invoice.external_id,
    reference_number: invoice.folio, reference_date: invoice.issued_on, reference_type: code, document_type_taxbureau: "33" }] } });
const pair = (document, cost, date = document.issued_on, suffix = "cost") => [
  { account_id: "cost", debit_clp: Math.max(0, cost), credit_clp: Math.max(0, -cost) },
  { account_id: "inventory", debit_clp: Math.max(0, -cost), credit_clp: Math.max(0, cost) },
].map((line, i) => ({ ...line, id: `${document.id}-${suffix}-${i}`, accounting_journal_entries: {
  id: `${document.id}-${suffix}`, source_document_id: document.id, entry_date: date, status: "posted" } }));
const periodLines = (lines, range = august) => lines.filter(l => l.accounting_journal_entries.entry_date >= range.from && l.accounting_journal_entries.entry_date <= range.to);
const review = (docs, lines) => creditNoteCostReview(docs, lines, accounts, "2026-09-16");

test("Anulacion total descuenta el costo contabilizado exactamente una vez", () => {
  const invoice = doc(1, "2026-08-10"), nc = note(invoice), docs = [invoice, nc];
  const lines = [...pair(invoice, 600), ...pair(nc, -600)];
  const checked = review(docs, lines);
  assert.equal(checked[0].pending, false);
  assert.equal(checked[0].originalCost, 600);
  assert.equal(checked[0].reversedCost, 600);
  const totals = aggregateFinancialPeriod(docs, lines, lines, accounts, august);
  assert.equal(totals.costs, 0);
  assert.equal(totals.sales, 0);
  assert.equal(totals.costCreditNotes, 600, "Informational, already deducted from costs");
  assert.equal(totals.operatingProfit, 0);
  assert.deepEqual(review([...docs, nc], [...lines, ...lines]), checked, "Repeated evidence cannot multiply the reversal");
});

test("La nota de una factura antigua nunca elimina el costo de su reemplazo", () => {
  const old = doc(1534, "2026-07-28", 9091838), replacement = doc(1547, "2026-08-18", 8506330);
  const nc = note(old), lines = pair(replacement, 6000000), docs = [old, nc, replacement];
  const checked = review(docs, lines)[0];
  assert.equal(checked.invoiceId, old.id);
  assert.equal(checked.originalCost, null);
  assert.equal(checked.reversedCost, null);
  assert.equal(checked.pending, true);
  const totals = aggregateFinancialPeriod(docs, lines, lines, accounts, august);
  assert.equal(totals.costs, 6000000);
  assert.equal(totals.creditNoteCostPending, 1);
  assert.equal(totals.salesCreditPriorInvoices, 9091838);
  assert.equal(totals.salesCreditPriorInvoiceDocuments, 1);
  const rows = dashboardDetailRows({ creditCostReview: [checked], detail: { ledgerAvailable: true } }, "credit-prior-invoices", august.from, august.to);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -9091838);
  assert.match(rows[0].status, /2026-07-28/);
  assert.equal(creditNoteCostPeriod([checked], "2026-01-01", august.to).salesCreditPriorInvoices, 0, "July is not outside the annual period");
});

test("Desglose de notas anteriores no vuelve a descontar ventas ni mezcla devoluciones del mismo mes", () => {
  const july = doc(1517, "2026-07-05", 1000), sameMonth = doc(1552, "2026-08-27", 500);
  const first = note(july, 3, 200), second = { ...note(sameMonth, 3, 100, "2026-08-28"), id: "nc-83", folio: "83" };
  const docs = [july, sameMonth, first, second], reviews = review(docs, []);
  const totals = aggregateFinancialPeriod(docs, [], [], accounts, august);
  assert.equal(totals.sales, 200);
  assert.equal(totals.salesCreditPriorInvoices, 200);
  assert.equal(totals.salesCreditPriorInvoiceDocuments, 1);
  const rows = dashboardDetailRows({ creditCostReview: reviews, detail: { ledgerAvailable: true } }, "credit-prior-invoices", august.from, august.to);
  assert.deepEqual(rows.map(r => r.sourceId), [first.id]);
  assert.equal(rows.reduce((sum, r) => sum - r.amount, 0), totals.salesCreditPriorInvoices);
});

test("Devolucion parcial conserva el resto del costo sin prorratear el valor de venta", () => {
  const invoice = doc(1517, "2026-07-05", 3624391), nc = note(invoice, 3, 77167);
  const original = pair(invoice, 2805035), reversal = pair(nc, -47000), docs = [invoice, nc];
  assert.equal(review(docs, original)[0].reversedCost, null);
  assert.equal(review(docs, original)[0].pending, true);
  const lines = [...original, ...reversal], checked = review(docs, lines)[0];
  assert.equal(checked.pending, false);
  assert.equal(checked.reversedCost, 47000);
  const totals = aggregateFinancialPeriod(docs, periodLines(lines), lines, accounts, august);
  assert.equal(totals.costs, -47000);
  const annual = aggregateFinancialPeriod(docs, lines, lines, accounts, { from: "2026-01-01", to: "2026-08-31" });
  assert.equal(annual.costs, 2758035);
});

test("Una reversa en otro mes se reconoce en la fecha del asiento", () => {
  const invoice = doc(1, "2026-07-15"), nc = note(invoice);
  const lines = [...pair(invoice, 600), ...pair(nc, -600, "2026-09-01")];
  const checked = review([invoice, nc], lines);
  assert.equal(creditNoteCostPeriod(checked, august.from, august.to).costCreditNotes, 0);
  assert.equal(creditNoteCostPeriod(checked, "2026-09-01", "2026-09-16").costCreditNotes, 600);
  assert.equal(creditNoteCostReview([invoice, nc], lines, accounts, "2026-08-31")[0].pending, true);
});

test("Varias notas de la misma factura no pueden confirmar una reversa excesiva", () => {
  const invoice = doc(1, "2026-08-10"), nc = note(invoice, 3, 400);
  const another = { ...nc, id: "nc-81", folio: "81" };
  const checked = review([invoice, nc, another], [...pair(invoice, 600), ...pair(nc, -400), ...pair(another, -400)]);
  assert.ok(checked.every(r => r.pending && r.detail.includes("acumuladas")));
});

test("Importes nulos, pares incompletos, borradores y costo incorrecto no confirman reversa", () => {
  const invoice = doc(1, "2026-08-10"), nc = note(invoice), original = pair(invoice, 600);
  const invalidPairs = [pair(nc, -500), pair(nc, -600).slice(0, 1), pair(nc, 600),
    pair(nc, -600).map(l => ({ ...l, debit_clp: null })),
    pair(nc, -600).map(l => ({ ...l, accounting_journal_entries: { ...l.accounting_journal_entries, status: "draft" } })),
    pair(nc, -600, "2026-10-01")];
  for (const reversal of invalidPairs) assert.equal(review([invoice, nc], [...original, ...reversal])[0].pending, true);
  assert.equal(review([invoice, note(invoice, 3, 10)], [...original, ...pair(nc, -700)])[0].pending, true);
});

test("Identidad exige empresa, RUT, tipo, folio, fecha y referencia explicita", () => {
  const invoice = doc(1, "2026-08-10"), nc = note(invoice);
  for (const change of [{ entity_id: "other" }, { counterpart_tax_id: "87654321-0" }, { document_type: "sales_exempt_invoice" },
    { folio: "2" }, { issued_on: "2026-08-09" }, { external_id: "2" }]) {
    const checked = review([{ ...invoice, ...change }, nc], [])[0];
    assert.equal(checked.invoiceId, null);
    assert.equal(checked.pending, true);
  }
  assert.equal(review([invoice, { ...invoice, id: "ambiguous" }, nc], [])[0].invoiceId, null);
  const multiple = structuredClone(nc); multiple.raw_payload.references.push({ ...nc.raw_payload.references[0] });
  assert.equal(review([invoice, multiple], [])[0].invoiceId, null);
});

test("Notas recibidas y no validadas se excluyen; correccion de texto no rebaja costo", () => {
  const invoice = doc(1, "2026-08-10"), nc = note(invoice);
  assert.deepEqual(review([invoice, { ...nc, status: "draft" }], []), []);
  assert.deepEqual(review([invoice, projectedSalesDocument({ ...nc, direction_4: 0 })], []), []);
  const checked = review([invoice, note(invoice, 2)], pair(invoice, 600))[0];
  assert.equal(checked.pending, false);
  assert.equal(checked.reversedCost, null);
  const projected = projectedSalesDocument({ ...nc, raw_payload: {}, credit_references: nc.raw_payload.references });
  assert.equal(review([invoice, projected], [])[0].invoiceId, invoice.id);
});

test("Detalle usa el mismo conjunto pendiente y conserva importes desconocidos", () => {
  const invoice = doc(1, "2026-08-10"), nc = note(invoice);
  const checked = review([invoice, nc], pair(invoice, 600));
  const analytics = { creditCostReview: checked, detail: { ledgerAvailable: true } };
  const rows = dashboardDetailRows(analytics, "credit-cost-review", august.from, august.to);
  assert.equal(rows.length, creditNoteCostPeriod(checked, august.from, august.to).creditNoteCostPending);
  assert.equal(rows[0].sourceId, nc.id);
  assert.equal(rows[0].amount, null);
  assert.match(rows[0].label, /Factura 1/);
  assert.deepEqual(dashboardDetailRows(analytics, "credit-cost-review", "2026-09-01", "2026-09-30"), []);
  assert.equal(dashboardDetailRows({ ...analytics, detail: { ledgerAvailable: false } }, "credit-cost-review", august.from, august.to), null);
});

test("Copiloto resuelve una factura del mes anterior con consultas acotadas y advierte la reversa faltante", async () => {
  const invoice = { ...doc(1, "2026-07-10"), id: "00000000-0000-4000-8000-000000000001" };
  const nc = { ...note(invoice), id: "00000000-0000-4000-8000-000000000002" };
  const lines = pair(invoice, 600), queries = [];
  const source = { entity: async () => "entity", all: async (path, limit) => {
    queries.push(path);
    assert.ok(path.includes("entity_id=eq.entity"), "Every query stays scoped to the business");
    if (path.startsWith("accounting_accounts?")) return accounts;
    if (path.startsWith("accounting_source_documents?")) {
      assert.ok(!path.includes("select=*"));
      assert.ok(path.includes("credit_references:raw_payload->references"));
      if (path.includes("external_id=in.(1)")) { assert.equal(limit, 100); return [invoice]; }
      return [{ ...nc, credit_references: nc.raw_payload.references, raw_payload: undefined }];
    }
    if (path.includes("source_document_id=in.")) return lines;
    if (path.startsWith("accounting_journal_lines?")) return [];
    throw new Error(`Unexpected fixture query ${path}`);
  } };
  const result = await financialPeriod(source, august);
  assert.equal(queries.filter(q => q.includes("external_id=in.(1)")).length, 1);
  assert.equal(result.data.totals.creditNoteCostPending, 1);
  assert.equal(result.data.creditNoteCosts[0].originalCost, 600);
  assert.ok(result.warnings.some(w => w.includes("notas de credito")));
  assert.equal(result.data.totals.costs, 0, "Never bring the original July cost into August");
});
