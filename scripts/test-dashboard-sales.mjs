import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { accountingToday, dashboardDocumentSales, dashboardSalesEvidence, dashboardSalesPeriodBridge } from "../supabase/functions/accounting-center/dashboard-sales.ts";
import { dashboardSalesComparison, previousSalesCutoff } from "../supabase/functions/accounting-center/dashboard-sales-comparison.ts";
import { dashboardPurchaseEvidence, dashboardDocumentTotals } from "../supabase/functions/accounting-center/dashboard-purchases.ts";
import { isPostableFactoDocument } from "../supabase/functions/accounting-center/facto-document-policy.ts";
import { confirmedCostSourceIds } from "../supabase/functions/accounting-center/facto-cost-evidence.ts";
import { creditNoteCostReview, creditNoteCostPeriod } from "../supabase/functions/accounting-center/credit-note-costs.ts";
import { dashboardDetailRows } from "../src/modules/accounting/dashboardNavigation.ts";

// Exercise the actual edge calculation with read-only REST fixtures, without starting Deno.
const source = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
const calculation = source.slice(source.indexOf("type DashboardResultTotals ="), source.indexOf("async function createAccount("));
assert.ok(calculation.includes("async function buildDashboardAnalytics("));
const javascript = ts.transpileModule(calculation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const accounts = [{ id: "income", account_type: "income" }, { id: "cost", account_type: "cost", classification: "cost_of_sales" }, { id: "inventory", account_type: "asset", classification: "inventory" }, { id: "expense", account_type: "expense" }, { id: "result", account_type: "result" }];
const doc = (id, net = 149421, date = "2026-09-08", extra = {}) => ({ id, folio: id, issued_on: date,
  currency: "CLP", net_amount: net, exempt_amount: 0, tax_amount: Math.round(net * .19), total_clp: Math.round(net * 1.19),
  document_type: "sales_invoice", status: "validated", data_quality: "validated", ...extra });
const line = (id, amount, date = "2026-09-08", account = "income", status = "posted") => ({ account_id: account,
  debit_clp: account === "income" ? 0 : amount, credit_clp: account === "income" ? amount : 0,
  accounting_journal_entries: { id: `${account}:${id}`, source_document_id: id, entry_date: date, status, idempotency_key: `${account}:${id}` } });
const inventoryLine = cost => ({ ...cost, account_id: "inventory", debit_clp: cost.credit_clp, credit_clp: cost.debit_clp });

async function build(documents, lines, { failLedger = false, asOf = "2026-09-09", includeDetails = false } = {}) {
  const selectAllRows = async (_rest, path) => {
    if (path.startsWith("accounting_journal_lines?")) {
      assert.ok(!path.includes("entry_date=gte."), "Historical postings must remain available for identity deduplication");
      if (failLedger) throw new Error("fixture ledger unavailable");
      return lines.filter(l => l.accounting_journal_entries.entry_date <= asOf && ["posted", "reversed"].includes(l.accounting_journal_entries.status));
    }
    throw new Error(`Unexpected query: ${path}`);
  };
  const run = new Function("selectAllRows", "asObject", "numeric", "dashboardSalesEvidence", "dashboardPurchaseEvidence", "dashboardDocumentTotals", "isPostableFactoDocument", "dashboardSalesPeriodBridge", "confirmedCostSourceIds", "creditNoteCostReview", "creditNoteCostPeriod", "dashboardSalesComparison", "previousSalesCutoff", `${javascript}\nreturn buildDashboardAnalytics;`)(
    selectAllRows, value => value && typeof value === "object" ? value : {}, value => Number(value) || 0, dashboardSalesEvidence, dashboardPurchaseEvidence, dashboardDocumentTotals, isPostableFactoDocument, dashboardSalesPeriodBridge, confirmedCostSourceIds, creditNoteCostReview, creditNoteCostPeriod, dashboardSalesComparison, previousSalesCutoff);
  return run({}, "entity", asOf, documents, accounts, includeDetails);
}

test("Full bootstrap drill-downs exactly reconcile with the actual dashboard calculation", async () => {
  const docs = Array.from({ length: 162 }, (_, i) => doc(`sale-${i}`, 1000, i < 3 ? "2026-09-09" : "2026-08-18", { counterpart_name: `Cliente ${i}` }));
  docs.push(doc("credit", 300, "2026-01-20", { document_type: "sales_credit_note" }));
  const lines = docs.filter(row => !["sale-0", "sale-1", "sale-2"].includes(row.id)).map(row => line(row.id, row.id === "credit" ? -300 : 1000, row.id === "credit" ? "2026-09-09" : row.issued_on));
  for (let i = 50; i < 162; i++) {
    const cost = line(`sale-${i}`, 450, "2026-08-18", "cost");
    cost.accounting_journal_entries.idempotency_key = `facto-cost:sale-${i}`;
    lines.push(cost, inventoryLine(cost));
  }
  lines.push(line(null, 10), line(null, 50, "2026-09-09", "expense"), line(null, -70, "2026-09-09", "result"));
  lines.forEach((row, i) => { row.id = `line-${i}`; row.accounting_journal_entries.entry_number = i; });
  const result = await build(docs, lines, { includeDetails: true });
  const sum = values => values.reduce((total, row) => total + row.amount, 0);
  for (const period of [result, ...result.monthly]) {
    const totals = period === result ? result.current : period;
    const rows = metric => dashboardDetailRows(result, metric, period.from, period.to);
    assert.equal(rows("sales-pending").length, totals.salesPendingDocuments);
    assert.equal(rows("cost-missing").length, totals.salesCostMissingDocuments);
    for (const [metric, key] of [["sales-pending", "salesPending"], ["sales-issued", "salesIssued"], ["sales-ledger", "salesLedger"], ["sales-result", "sales"], ["sales-adjustments", "salesOtherAdjustments"], ["costs", "costs"], ["expenses", "expenses"], ["gross-profit", "grossProfit"], ["operating-profit", "operatingProfit"]]) assert.equal(sum(rows(metric)), totals[key], `${period.from} ${metric}`);
  }
  assert.equal(dashboardDetailRows(result, "cost-missing", result.from, result.to).length, 50);
  assert.equal(result.detail.sales.find(row => row.id === "sale-0").counterpart, "Cliente 0");
  assert.equal((await build(docs, lines)).detail, undefined, "Summary stays lightweight");
});

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

test("Credit-note cost control reconciles dashboard, detail and posted net cost", async () => {
  const identity = { entity_id: "entity", source_type: "FACTO", counterpart_tax_id: "12345678-9" };
  const invoice = doc("invoice", 1000, "2026-08-01", { ...identity, external_id: "100", folio: "10" });
  const credit = doc("credit", 200, "2026-08-20", { ...identity, folio: "80", document_type: "sales_credit_note", raw_payload: { references: [
    { document_id: 100, reference_number: 10, reference_date: "2026-08-01", reference_type: 3, document_type_taxbureau: 33 },
  ] } });
  const cost = line(invoice.id, 600, invoice.issued_on, "cost");
  const lines = [cost, inventoryLine(cost)];
  const options = { asOf: "2026-08-31", includeDetails: true };
  const before = await build([invoice, credit], lines, options);
  assert.equal(before.current.creditNoteCostPending, 1);
  const rows = dashboardDetailRows(before, "credit-cost-review", before.from, before.to);
  assert.equal(rows.length, before.current.creditNoteCostPending);
  assert.equal(rows[0].amount, null);
  assert.ok(before.warnings.some(w => w.includes("notas de credito")));
  const reversal = line(credit.id, -120, credit.issued_on, "cost");
  const after = await build([invoice, credit], [...lines, reversal, inventoryLine(reversal)], options);
  assert.equal(after.current.costs, 480);
  assert.equal(after.monthly.at(-1).costs, 480);
  assert.equal(after.current.costCreditNotes, 120);
  assert.equal(after.current.creditNoteCostPending, 0);
  assert.deepEqual(dashboardDetailRows(after, "credit-cost-review", after.from, after.to), []);
  assert.equal(after.current.operatingProfit, before.current.operatingProfit + 120);
});

test("September journal refresh incorporates four exact costs without doubling invoices or losing the credit note", async () => {
  const docs = [["1557", 149421], ["1558", 22009], ["1559", 16330], ["1560", 34476], ["1561", 448272], ["1562", 5031969], ["1563", 1101413]]
    .map(([id, net]) => doc(id, net));
  docs.push(doc("85", 223465, "2026-09-08", { document_type: "sales_credit_note" }));
  const lines = [line("1557", 149421), line(null, 450000, "2026-09-08", "expense")];
  const before = (await build(docs, lines)).monthly.at(-1);
  assert.equal(before.salesPendingDocuments, 7);
  assert.equal(before.salesCostMissingDocuments, 7);
  assert.equal(before.sales, 6580425);
  for (const [id, amount] of [["1557", 91328], ["1561", 286050], ["1562", 2419866], ["1563", 894270]]) {
    if (id !== "1557") lines.push(line(id, docs.find(row => row.id === id).net_amount));
    const cost = line(id, amount, "2026-09-08", "cost");
    lines.push(cost, inventoryLine(cost));
  }
  const after = (await build(docs, lines)).monthly.at(-1);
  assert.equal(after.sales, before.sales);
  assert.equal(after.salesIssuedCreditNotes, 223465);
  assert.equal(after.salesPendingDocuments, 4);
  assert.equal(after.salesCostMissingDocuments, 3);
  assert.equal(after.costs, 3691514);
  assert.equal(after.operatingProfit, 2438911);
});

test("Six verified missing costs update September once without reposting sales or collections", async () => {
  const values = [["1558", 22009, 11432], ["1559", 16330, 10206], ["1560", 34476, 15022],
    ["1564", 27477, 9021], ["1565", 86246, 44800], ["1566", 166407, 97628]];
  const docs = values.map(([id, net]) => doc(id, net));
  const before = (await build(docs, [])).monthly.at(-1);
  const lines = values.flatMap(([id, , amount]) => {
    const cost = line(id, amount, "2026-09-08", "cost");
    return [cost, inventoryLine(cost)];
  });
  const after = (await build(docs, lines)).monthly.at(-1);
  assert.equal(after.sales, before.sales);
  assert.equal(after.salesPendingDocuments, 6, "Cost imports must not falsely confirm income entries");
  assert.equal(after.salesCostMissingDocuments, 0);
  assert.equal(after.costs, 188109);
  assert.equal(after.operatingProfit, before.operatingProfit - 188109);
  assert.deepEqual((await build(docs, lines)).monthly.at(-1), after, "Repeated reads must not accumulate cost");
});

test("September separates its single invoice from January notes and a corrective reversal", async () => {
  const docs = [doc("1557"), ...[1211750, 415915, 310640].map((amount, i) =>
    doc(`note-${i}`, amount, `2026-01-${10 + i}`, { document_type: "sales_credit_note" }))];
  const lines = [line("1557", 149421), ...[1211750, 415915, 310640].map((amount, i) => line(`note-${i}`, -amount)),
    line(null, 6418), line(null, 350000, "2026-09-04", "expense")];
  const result = await build(docs, lines);
  const september = result.monthly.at(-1);
  assert.equal(september.salesIssuedDocuments, 1);
  assert.equal(september.salesIssued, 149421);
  assert.equal(september.salesIssuedCreditNotes, 0);
  assert.equal(september.salesPeriodNet, 149421);
  assert.equal(september.salesPriorCreditAdjustments, -1938305);
  assert.equal(september.salesOtherAdjustments, 6418);
  assert.equal(september.salesCostMissingDocuments, 1, "Zero posted cost is not confirmed zero cost");
  assert.equal(september.sales, -1782466);
  assert.equal(september.operatingProfit, -2132466, "The presentation must not alter booked amounts");
  for (const total of [...result.monthly, result.current]) {
    assert.equal(total.salesPeriodNet + total.salesPriorCreditAdjustments + total.salesOtherAdjustments, total.sales);
  }
  assert.equal(result.current.salesPriorCreditAdjustments, 0, "January and September belong to the same annual period");
  const costLine = line("1557", 50000, "2026-09-08", "cost");
  costLine.accounting_journal_entries.idempotency_key = "facto-cost:1557";
  const withCost = await build(docs, [...lines, costLine, inventoryLine(costLine)]);
  assert.equal(withCost.monthly.at(-1).salesCostMissingDocuments, 0);
});

test("Period bridge includes notes in their issue period and keeps zero-document periods explicit", () => {
  const documents = dashboardSalesEvidence([doc("sale", 500), doc("note", 100, "2026-09-08", { document_type: "sales_credit_note" })], [], new Set(), "2026-09-09");
  const period = dashboardSalesPeriodBridge(documents, "2026-09-01", "2026-09-09", 400, new Set());
  assert.equal(period.salesIssuedDocuments, 1);
  assert.equal(period.salesIssued, 500);
  assert.equal(period.salesIssuedCreditNotes, 100);
  assert.equal(period.salesPeriodNet, 400);
  assert.equal(period.salesOtherAdjustments, 0);
  assert.equal(dashboardSalesPeriodBridge(documents, "2026-08-01", "2026-08-31", 0, new Set()).salesIssuedDocuments, 0);
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

test("Annual comparison includes all prior months, compares like-for-like and never counts journal adjustments twice", async () => {
  const documents = [doc("prior-jan", 1000, "2025-01-01"), doc("prior-sep", 200, "2025-09-09"),
    doc("prior-later", 700, "2025-09-10"), doc("prior-dec", 300, "2025-12-31"),
    doc("current-jan", 1200, "2026-01-02"), doc("current-sep", 600),
    doc("note", 100, "2026-09-09", { document_type: "sales_credit_note" }),
    doc("void", 9999, "2025-01-01", { status: "voided" }), doc("future", 100, "2026-09-10")];
  const result = await build(documents, [line("prior-jan", 1000, "2025-01-01"), line("current-sep", 600), line(null, 2)]);
  const c = result.salesComparison;
  assert.equal(c.previousAnnual.netClp, 2200);
  assert.equal(c.previous.netClp, 1200);
  assert.equal(c.current.netClp, 1700);
  assert.equal(c.difference, 500);
  assert.equal(c.growth, 500 / 1200 * 100);
  assert.equal(result.current.sales, 1702, "The income report remains unchanged");
  assert.equal(c.monthly.length, 12);
  assert.equal(c.monthly[8].partial, true);
  assert.equal(c.monthly[8].previous.netClp, 200);
  assert.equal(c.monthly[8].previousFull.netClp, 900);
  assert.equal(c.monthly[8].current.netClp, 500);
  assert.equal(c.monthly[8].growth, 150);
  assert.equal(c.monthly[11].current, null);
  assert.equal(c.monthly[11].growth, null);
  assert.equal(c.monthly[11].previous.netClp, 300);
  assert.equal(c.monthly[11].elapsed, false);
  const detailed = await build(documents, [], { includeDetails: true });
  for (const period of [c.current, c.previous, c.previousAnnual, ...c.monthly.flatMap(m => [m.current, m.previous, m.previousFull]).filter(Boolean)]) {
    const rows = dashboardDetailRows(detailed, "sales-period-net", period.from, period.to);
    assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), period.netClp ?? 0);
    assert.equal(rows.length, period.documents);
  }
  assert.equal((await build(documents, [], { failLedger: true })).salesComparison.current.netClp, 1700);
});

test("Zero, negative, absent and incomplete-year comparison bases are explicit", async () => {
  const c = (await build([doc("zero-sale", 100, "2025-01-01"),
    doc("zero-note", 100, "2025-01-02", { document_type: "sales_credit_note" }),
    doc("negative", 50, "2025-02-01", { document_type: "sales_credit_note" }),
    doc("current", 100, "2026-01-01"), doc("feb", 100, "2026-02-01")], [])).salesComparison;
  assert.equal(c.monthly[0].previous.netClp, 0);
  assert.equal(c.monthly[0].growth, null);
  assert.equal(c.monthly[0].difference, 100);
  assert.equal(c.monthly[1].previous.netClp, -50);
  assert.equal(c.monthly[1].growth, null);
  assert.equal(c.monthly[2].current.netClp, null);
  const empty = (await build([], [])).salesComparison;
  assert.equal(empty.previousAnnual.netClp, null);
  assert.equal(empty.growth, null);
  assert.equal(empty.current.netClp, null);
});

test("Year-end, leap February, current partial February and year rollover use valid comparable cutoffs", async () => {
  assert.equal(previousSalesCutoff("2024-02-29"), "2023-02-28");
  assert.equal(previousSalesCutoff("2025-02-28"), "2024-02-29");
  assert.equal(previousSalesCutoff("2024-02-28"), "2023-02-28");
  assert.equal(previousSalesCutoff("2026-09-20"), "2025-09-20");
  const leap = (await build([doc("leap", 100, "2024-02-29")], [], { asOf: "2025-02-28" })).salesComparison;
  assert.equal(leap.previous.netClp, 100);
  assert.equal(leap.monthly[1].partial, false);
  const full = (await build([doc("prior", 100, "2025-12-31"), doc("current", 200, "2026-12-31")], [], { asOf: "2026-12-31" })).salesComparison;
  assert.deepEqual(full.previous, full.previousAnnual);
  assert.equal(full.growth, 100);
  assert.ok(full.monthly.every(m => m.elapsed && !m.partial));
  const rollover = (await build([doc("prior", 200, "2026-12-31")], [], { asOf: "2027-01-01" })).salesComparison;
  assert.equal(rollover.previousYear, 2026);
  assert.equal(rollover.previousAnnual.netClp, 200);
  assert.equal(rollover.previous.netClp, null);
  assert.equal(rollover.monthly.filter(m => m.elapsed).length, 1);
});

test("Read failures retain documentary evidence and clearly warn about provisional results", async () => {
  const docs = [doc("1557")];
  const result = await build(docs, [], { failLedger: true });
  assert.equal(result.current.sales, 149421);
  assert.equal(result.basis, "documentary");
  assert.ok(result.warnings.some(w => w.includes("libro mayor")));
  const reused = await build(docs, []);
  assert.equal(reused.current.sales, 149421, "Use the complete bootstrap snapshot without another document read");
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
  const foreign = doc("foreign", 11365601, "2026-06-22", { document_type: "purchase_document", raw_payload: { header: { document_id: 695, document_type_id: 57, received_issued_flag: 0 } } });
  const result = await build([receipt, receipt, foreign, doc("ads", 0, "2026-06-03", { document_type: "purchase_exempt_invoice", exempt_amount: 3128000, tax_amount: 0 }), doc("supplier-note", 100, "2026-06-10", { document_type: "purchase_credit_note" }), { ...receipt, id: "proforma", document_type: "import_operation" }], []);
  assert.equal(result.monthly[5].purchasesInternational, 11365601);
  assert.equal(result.monthly[5].purchasesDomestic, 3127900);
  assert.equal(result.current.purchaseCreditNotes, 100);
  assert.equal(result.current.costs, 0);
  assert.equal(result.current.operatingProfit, 0);
  assert.equal(result.purchaseDocuments.length, 3);
});

test("A received supplier note must never reduce sales even when its resource was documents", () => {
  assert.equal(dashboardDocumentSales(doc("wrong", 48722, "2026-05-12", { document_type: "sales_credit_note", raw_payload: { received_issued_flag: 0 } })), null);
});

test("A closed January note regularized in September is deducted once in the posting month", async () => {
  const note = doc("january-note", 310640, "2026-01-20", { document_type: "sales_credit_note" });
  const result = await build([note], [line("january-note", -310640, "2026-09-10")], { asOf: "2026-09-10" });
  assert.equal(result.monthly[0].sales, 0);
  assert.equal(result.monthly[0].salesCreditNotes, 0);
  assert.equal(result.monthly[8].sales, -310640);
  assert.equal(result.monthly[8].salesCreditNotes, 310640);
  assert.equal(result.current.sales, -310640);
  assert.equal(result.current.grossMargin, null);
  assert.equal(result.current.operatingMargin, null);
  assert.equal(result.current.salesPendingDocuments, 0);
  assert.equal(result.salesAdjustments[0].issuedOn, "2026-01-20");
  assert.equal(result.salesAdjustments[0].recognizedOn, "2026-09-10");
  assert.equal(result.costCoverage.totalSalesDocuments, 0, "Credit notes are not additional invoices for cost coverage");
});

test("All June foreign invoices are counted, without inventory receipt or duplicate provider evidence", async () => {
  const invoice = (id, folio, amount, date) => doc(id, amount, date, { folio, document_type: "purchase_document", raw_payload: { header: { document_id: id, document_type_id: 57, received_issued_flag: 0 } } });
  const third = invoice("695", "3", 11365601, "2026-06-22");
  const result = await build([invoice("692", "1", 26365341, "2026-06-20"), invoice("694", "2", 18889846, "2026-06-22"), third,
    { ...third, id: "duplicate-695" }, doc("domestic", 5533462, "2026-06-03", { document_type: "purchase_invoice" }),
    { id: "receipt", issued_on: "2026-06-23", document_type: "inventory_receipt", status: "posted", data_quality: "validated", raw_payload: { merchandise_clp: 51097978.8 } }], []);
  assert.equal(result.monthly[5].purchasesInternational, 56620788);
  assert.equal(result.monthly[5].purchasesNet, 62154250);
  assert.equal(result.purchaseDocuments.length, 4);
});
