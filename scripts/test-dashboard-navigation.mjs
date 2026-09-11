import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardDetailRows, dashboardDetailLink, exactDocumentLink } from "../src/modules/accounting/dashboardNavigation.ts";
import { dashboardSalesPeriodBridge } from "../supabase/functions/accounting-center/dashboard-sales.ts";
import { readAllRecords } from "../src/lib/readAllRecords.ts";

const from = "2026-01-01", to = "2026-09-11";
const sales = Array.from({ length: 162 }, (_, i) => ({ id: `sale-${i}`, folio: `${1400 + i}`,
  issuedOn: i < 3 ? "2026-09-11" : "2026-08-18", recognizedOn: i < 3 ? "2026-09-11" : "2026-08-18",
  netClp: 1000, posted: i >= 3, creditNote: false, exactCost: i >= 50, counterpart: `Cliente ${i}` }));
const note = { id: "nc", folio: "72", issuedOn: "2026-01-20", recognizedOn: "2026-09-09", netClp: -300,
  posted: true, creditNote: true, exactCost: false, counterpart: "Cliente 0" };
const line = (id, accountType, debit, credit, date = "2026-09-11") => ({ id, accountType, debit, credit, date,
  sourceId: "", issuedOn: "", entryNumber: id, accountCode: "5.1", accountName: accountType, status: "posted", description: `Detalle ${id}` });
const analytics = { detail: { ledgerAvailable: true, sales: [...sales, note], ledger: [
  line("income-aug", "income", 0, 159000, "2026-08-18"),
  { ...line("nc", "income", 300, 0, "2026-09-09"), sourceId: "nc", issuedOn: note.issuedOn },
  line("manual", "income", 0, 20), line("cost", "cost", 500, 0), line("expense", "expense", 200, 0),
  line("other", "result", 0, 70), line("cost-reversal", "cost", 0, 50),
] }, purchaseDocuments: [
  { id: "local", folio: "100", issuedOn: "2026-09-01", netClp: 100, kind: "domestic", counterpart: "Proveedor" },
  { id: "foreign", folio: "100", issuedOn: "2026-06-01", netClp: 59000000, kind: "international", counterpart: "Exterior" },
  { id: "buy-credit", folio: "100", issuedOn: "2026-09-02", netClp: -30, kind: "domestic", counterpart: "Proveedor" },
] };
const rows = (metric, start = from, end = to) => dashboardDetailRows(analytics, metric, start, end);
const sum = values => values.reduce((total, row) => total + row.amount, 0);

test("The three unposted and fifty uncosted documents are exact, distinct sets", () => {
  assert.equal(rows("sales-pending").length, 3);
  assert.equal(rows("cost-missing").length, 50);
  assert.equal(rows("cost-confirmed").length, 112);
  assert.equal(new Set(rows("cost-missing").map(row => row.sourceId)).size, 50);
  assert.equal(rows("cost-missing", "2026-09-01").length, 3);
  assert.equal(rows("cost-missing", "2026-08-01", "2026-08-31").length, 47);
  assert.equal(rows("sales-pending", "2026-08-01", "2026-08-31").length, 0);
  const bridge = dashboardSalesPeriodBridge(analytics.detail.sales, from, to, sum(rows("sales-result")), new Set(sales.filter(row => row.exactCost).map(row => row.id)));
  assert.equal(rows("cost-missing").length, bridge.salesCostMissingDocuments);
  assert.equal(sum(rows("sales-issued")), bridge.salesIssued);
  assert.equal(sum(rows("sales-period-net")), bridge.salesPeriodNet);
  assert.equal(sum(rows("sales-adjustments")), bridge.salesOtherAdjustments);
});

test("Monthly credit adjustments preserve original issue date and reconcile to the ledger", () => {
  assert.equal(rows("sales-issued-credit", "2026-09-01").length, 0);
  assert.equal(rows("sales-credit", "2026-09-01").length, 1);
  assert.equal(rows("prior-credit", "2026-09-01")[0].issuedOn, "2026-01-20");
  assert.equal(rows("prior-credit", "2026-09-01")[0].date, "2026-09-09");
  assert.equal(sum(rows("sales-result", "2026-09-01")), 2720);
  assert.equal(sum(rows("sales-adjustments", "2026-09-01")), 20);
  assert.equal(sum(rows("costs", "2026-09-01")), 450);
  assert.equal(sum(rows("gross-profit", "2026-09-01")), 2270);
  assert.equal(sum(rows("operating-profit", "2026-09-01")), 2140, "Includes other result accounts and cost reversals, without duplicating purchases");
});

test("Purchase details retain direction, exact identity and selected date boundaries", () => {
  assert.equal(sum(rows("purchases")), 59000070);
  assert.equal(sum(rows("domestic")), 70);
  assert.equal(sum(rows("international")), 59000000);
  assert.equal(sum(rows("purchase-credit")), -30);
  assert.deepEqual(rows("international", "2026-09-01"), []);
  const url = new URL(exactDocumentLink("id & +/#", "2026-06-01"), "https://example.invalid");
  assert.equal(url.searchParams.get("document"), "id & +/#");
  assert.equal(url.searchParams.get("from"), "2026-06-01");
  assert.equal(url.searchParams.has("search"), false, "Folio collisions cannot select another supplier's invoice");
  const link = new URL(dashboardDetailLink("cost-missing", from, to), url);
  assert.equal(link.searchParams.get("metric"), "cost-missing");
  assert.equal(link.searchParams.get("to"), to);
});

test("Unavailable ledger or detail never reports zero pending cases", () => {
  assert.equal(dashboardDetailRows({}, "cost-missing", from, to), null);
  const unavailable = structuredClone(analytics); unavailable.detail.ledgerAvailable = false;
  for (const metric of ["cost-missing", "sales-pending", "operating-profit", "prior-credit"]) assert.equal(dashboardDetailRows(unavailable, metric, from, to), null);
  assert.equal(rows("sales-pending", to, from), null);
});

test("Full list reads include all pages even if the server returns shorter pages", async () => {
  const all = Array.from({ length: 1261 }, (_, i) => ({ id: String(i) })), offsets = [];
  const result = await readAllRecords(async (start, end) => {
    offsets.push(start); assert.equal(end, start + 499);
    return { data: all.slice(start, start + 400), count: all.length, error: null };
  });
  assert.deepEqual(result, all); assert.deepEqual(offsets, [0, 400, 800, 1200]);
  assert.deepEqual(await readAllRecords(async () => ({ data: [], count: 0, error: null })), []);
});

test("A truncated or changing query is an error, never an apparently complete list", async () => {
  await assert.rejects(readAllRecords(async () => ({ data: [], count: 50, error: null })), /completar/);
  await assert.rejects(readAllRecords(async () => ({ data: [{ id: "same" }], count: 50, error: null })), /repiti/);
  await assert.rejects(readAllRecords(async () => ({ data: [], count: null, error: null })), /lectura/);
  await assert.rejects(readAllRecords(async start => ({ data: [{ id: String(start) }], count: 50 + start, error: null })), /lectura/);
  await assert.rejects(readAllRecords(async () => ({ data: null, count: null, error: { message: "Unavailable" } })), /Unavailable/);
});
