import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { accountingToday, dashboardDocumentSales, dashboardSalesEvidence } from "../supabase/functions/accounting-center/dashboard-sales.ts";
import { dashboardPurchaseEvidence, dashboardDocumentTotals } from "../supabase/functions/accounting-center/dashboard-purchases.ts";

// Exercise the actual edge calculation with read-only REST fixtures, without starting Deno.
const source = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
const calculation = source.slice(source.indexOf("type DashboardResultTotals ="), source.indexOf("async function createAccount("));
assert.ok(calculation.includes("async function buildDashboardAnalytics("));
const javascript = ts.transpileModule(calculation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const accounts = [{ id: "income", account_type: "income" }, { id: "cost", account_type: "cost" }, { id: "expense", account_type: "expense" }];
const doc = (id, net = 149421, date = "2026-09-08", extra = {}) => ({ id, folio: id, issued_on: date,
  currency: "CLP", net_amount: net, exempt_amount: 0, tax_amount: Math.round(net * .19), total_clp: Math.round(net * 1.19),
  document_type: "sales_invoice", status: "validated", data_quality: "validated", ...extra });
const line = (id, amount, date = "2026-09-08", account = "income", status = "posted") => ({ account_id: account,
  debit_clp: account === "income" ? 0 : amount, credit_clp: account === "income" ? amount : 0,
  accounting_journal_entries: { source_document_id: id, entry_date: date, status, idempotency_key: `${account}:${id}` } });

async function build(documents, lines, { failLedger = false, failDocuments = false, asOf = "2026-09-09" } = {}) {
  const selectAllRows = async (_rest, path) => {
    if (path.startsWith("accounting_journal_lines?")) {
      assert.ok(!path.includes("entry_date=gte."), "Historical postings must remain available for identity deduplication");
      if (failLedger) throw new Error("fixture ledger unavailable");
      return lines.filter(l => l.accounting_journal_entries.entry_date <= asOf && ["posted", "reversed"].includes(l.accounting_journal_entries.status));
    }
    if (path.startsWith("accounting_source_documents?")) {
      assert.ok(path.endsWith("order=issued_on.asc,id.asc"));
      if (failDocuments) throw new Error("fixture documents unavailable");
      return documents;
    }
    throw new Error(`Unexpected query: ${path}`);
  };
  const run = new Function("selectAllRows", "asObject", "numeric", "dashboardSalesEvidence", "dashboardPurchaseEvidence", "dashboardDocumentTotals", `${javascript}\nreturn buildDashboardAnalytics;`)(
    selectAllRows, value => value && typeof value === "object" ? value : {}, value => Number(value) || 0, dashboardSalesEvidence, dashboardPurchaseEvidence, dashboardDocumentTotals);
  return run({}, "entity", asOf, documents, accounts);
}

test("September includes an unposted invoice even with booked sales in previous months", async () => {
  const docs = [doc("old", 1000, "2026-08-20"), doc("1557")];
  const lines = [line("old", 1000, "2026-08-20"), line(null, 350000, "2026-09-04", "expense")];
  const result = await build(docs, lines);
  const september = result.monthly.at(-1);
  assert.equal(september.sales, 149421);
  assert.equal(september.salesLedger, 0);
  assert.equal(september.salesPending, 149421);
  assert.equal(september.salesPendingDocuments, 1);
  assert.equal(september.expenses, 350000);
  assert.equal(september.operatingProfit, -200579);
  assert.equal(result.current.sales, 150421);
  assert.equal(result.basis, "mixed");
  assert.equal(result.latestSales[0].folio, "1557");
  assert.equal(result.latestSales[0].issuedOn, "2026-09-08", "Do not rewrite the issue date to today");
  const posted = await build(docs, [...lines, line("1557", 149421)]);
  assert.equal(posted.current.sales, result.current.sales);
  assert.equal(posted.current.salesPendingDocuments, 0);
  assert.equal(posted.basis, "ledger");
});

test("Mixed coverage in the same month, draft and cost entries never suppress a sale", async () => {
  const result = await build([doc("booked", 100), doc("pending", 200)], [
    line("booked", 100), line("pending", 50, "2026-09-08", "cost"), line("pending", 200, "2026-09-08", "income", "draft"),
  ]);
  assert.equal(result.monthly.at(-1).sales, 300);
  assert.equal(result.current.salesPendingDocuments, 1);
  assert.equal(result.current.costs, 50);
});

test("Credit notes reduce net sales; zero net periods still show pending evidence", async () => {
  const docs = [doc("invoice", 100), doc("credit", 100, "2026-09-09", { document_type: "sales_credit_note" })];
  const result = await build(docs, []);
  assert.equal(result.current.sales, 0);
  assert.equal(result.current.salesPendingDocuments, 2);
  assert.equal(result.basis, "documentary");
});

test("Reversed, historical, zero and multiple income lines do not re-add their document", async () => {
  const docs = [doc("reversed", 100), doc("prior", 200), doc("split", 300), doc("zero", 0)];
  const result = await build(docs, [line("reversed", 100, "2026-09-08", "income", "reversed"),
    line("reversed", -100), line("prior", 200, "2024-12-31"), line("split", 100), line("split", 200), line("zero", 0)]);
  assert.equal(result.current.sales, 300);
  assert.equal(result.current.salesPendingDocuments, 0);
});

test("Only validated sales documents, not quotes, voids, purchases or future dates", async () => {
  const valid = doc("valid");
  const result = await build([valid, valid, doc("quote", 100, "2026-09-08", { document_type: "sales_quote" }),
    doc("void", 100, "2026-09-08", { status: "voided" }), doc("bad", 100, "2026-09-08", { data_quality: "inconsistent" }),
    doc("purchase", 100, "2026-09-08", { document_type: "purchase_invoice" }), doc("future", 100, "2026-09-10")], []);
  assert.equal(result.current.sales, 149421);
  assert.equal(result.costCoverage.totalSalesDocuments, 1);
});

test("Net sales include exempt amounts, exclude VAT and require a known exchange rate", () => {
  assert.equal(dashboardDocumentSales(doc("mixed", 100, "2026-09-08", { exempt_amount: 50 })), 150);
  assert.equal(dashboardDocumentSales(doc("exempt", 0, "2026-09-08", { exempt_amount: 120 })), 120);
  assert.equal(dashboardDocumentSales(doc("gross", 0, "2026-09-08", { total_clp: 119, tax_amount: 19 })), 100);
  assert.equal(dashboardDocumentSales(doc("usd", 100, "2026-09-08", { currency: "USD" })), null);
  assert.equal(dashboardDocumentSales(doc("usd", 100, "2026-09-08", { currency: "USD", exchange_rate: 950 })), 95000);
});

test("Comparative prior-year sales also use document coverage, not a zero balance", async () => {
  const result = await build([doc("booked", 600, "2025-09-01"), doc("pending", 200, "2025-09-08")], [line("booked", 600, "2025-09-01")]);
  assert.equal(result.previousYear.sales, 800);
});

test("Read failures retain documentary evidence and clearly warn about provisional results", async () => {
  const docs = [doc("1557")];
  const result = await build(docs, [], { failLedger: true });
  assert.equal(result.current.sales, 149421);
  assert.equal(result.basis, "documentary");
  assert.ok(result.warnings.some(w => w.includes("libro mayor")));
  const fallback = await build(docs, [], { failDocuments: true });
  assert.equal(fallback.current.sales, 149421);
  assert.ok(fallback.warnings.some(w => w.includes("cobertura documental")));
});

test("Business cutoff uses Santiago at UTC midnight and across DST", () => {
  assert.equal(accountingToday(new Date("2026-09-10T01:30:00Z")), "2026-09-09");
  assert.equal(accountingToday(new Date("2026-09-10T03:01:00Z")), "2026-09-10");
  assert.equal(accountingToday(new Date("2026-07-10T03:30:00Z")), "2026-07-09");
});

test("Cross-month cancellation uses the note date and does not double the reissued invoice", async () => {
  const docs = [doc("1534", 9091838, "2026-07-28"), doc("80", 9091838, "2026-08-18", { document_type: "sales_credit_note" }), doc("1547", 8506330, "2026-08-18")];
  const result = await build(docs, [line("1534", 9091838, "2026-07-28"), line("1547", 8506330, "2026-08-18"), line("1547", 6000000, "2026-08-18", "cost")]);
  assert.equal(result.monthly[6].sales, 9091838);
  assert.equal(result.monthly[7].sales, -585508);
  assert.equal(result.current.sales, 8506330);
  assert.equal(result.current.salesCreditNotes, 9091838);
  assert.equal(result.current.costs, 6000000);
});

test("Domestic exempt purchases, supplier notes and received imports remain separate from profit", async () => {
  const receipt = { id: "receipt", source_type: "COMERCIO_EXTERIOR", document_type: "inventory_receipt", issued_on: "2026-06-23", status: "posted", data_quality: "validated", raw_payload: { operation_id: "op", merchandise_clp: 51097978.8, landed_inventory_clp: 55918958.51 } };
  const result = await build([receipt, receipt, doc("ads", 0, "2026-06-03", { document_type: "purchase_exempt_invoice", exempt_amount: 3128000, tax_amount: 0 }), doc("supplier-note", 100, "2026-06-10", { document_type: "purchase_credit_note" }), { ...receipt, id: "proforma", document_type: "import_operation" }], []);
  assert.equal(result.monthly[5].purchasesInternational, 51097978.8);
  assert.equal(result.monthly[5].purchasesDomestic, 3127900);
  assert.equal(result.current.purchaseCreditNotes, 100);
  assert.equal(result.current.costs, 0);
  assert.equal(result.current.operatingProfit, 0);
  assert.equal(result.purchaseDocuments.length, 3);
});

test("A received supplier note must never reduce sales even when its resource was documents", () => {
  assert.equal(dashboardDocumentSales(doc("wrong", 48722, "2026-05-12", { document_type: "sales_credit_note", raw_payload: { received_issued_flag: 0 } })), null);
});
