import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { factoPostingPreview, assertUnpostedFactoSource, assertFactoPostingSaved } from "../supabase/functions/accounting-center/facto-posting-preview.ts";
import { isPostableFactoDocument, assertFactoDocumentNotRejected, factoPostingDate } from "../supabase/functions/accounting-center/facto-document-policy.ts";

const document = { id: "doc", entity_id: "entity", source_type: "FACTO", document_type: "sales_invoice", folio: "1572",
  issued_on: "2026-09-27", currency: "CLP", net_amount: 99840, tax_amount: 18970, total_clp: 118810,
  data_quality: "validated", status: "posted", counterpart_tax_id: "77777777-7", raw_payload: { header: { taxbureau_validation_status: 3 } } };
const accounts = ["receivables", "net_sales", "vat_debit", "inventory", "cost_of_sales"].map(classification => ({ id: classification, classification, active: true, allows_posting: true }));
const periods = [{ id: "september", starts_on: "2026-09-01", ends_on: "2026-09-30", status: "open" }];
const preview = factoPostingPreview(document);
const savedEntry = { id: "saved", status: "posted", source_document_id: "doc", entry_date: "2026-09-27" };
const savedLines = [
  { account_id: "receivables", debit_clp: 118810, credit_clp: 0 },
  { account_id: "net_sales", debit_clp: 0, credit_clp: 99840 },
  { account_id: "vat_debit", debit_clp: 0, credit_clp: 18970 },
];
test("Preview preserves exact signed accounting amounts, and never derives inventory", () => {
  assert.deepEqual([preview.net, preview.tax, preview.total, preview.creditNote], [99840, 18970, 118810, false]);
  const note = factoPostingPreview({ ...document, document_type: "sales_credit_note", net_amount: 223465, tax_amount: 42458, total_clp: 265923 });
  assert.deepEqual([note.net, note.tax, note.total, note.creditNote], [223465, 42458, 265923, true]);
  assert.doesNotThrow(() => assertFactoPostingSaved(preview, savedEntry, savedLines, accounts));
  assert.doesNotThrow(() => assertFactoPostingSaved({ ...preview, creditNote: true }, savedEntry, savedLines.map(l => ({ ...l, debit_clp: l.credit_clp, credit_clp: l.debit_clp })), accounts));
});
test("Preview rejects unsupported types, unknown fiscal status and inconsistent amounts", () => {
  for (const patch of [{ document_type: "sales_dispatch_guide" }, { document_type: "purchase_invoice" }, { currency: "USD" },
    { source_type: "MANUAL" }, { status: "draft" }, { data_quality: "inconsistent" }, { total_clp: 1 },
    { net_amount: null }, { tax_amount: NaN }, { net_amount: -1 }, { total_clp: 118810.2 },
    { raw_payload: {} }, { raw_payload: { header: { taxbureau_validation_status: 5 } } }])
    assert.throws(() => factoPostingPreview({ ...document, ...patch }));
});
test("Review key detects amounts, dates, type, entity, customer and credit-reference changes, not refresh timestamps", () => {
  assert.equal(factoPostingPreview({ ...document, updated_at: "later" }).reviewKey, preview.reviewKey);
  for (const patch of [{ issued_on: "2026-09-26" }, { entity_id: "other" }, { counterpart_tax_id: "other" },
    { document_type: "sales_credit_note" }, { net_amount: 99841, total_clp: 118811 },
    { raw_payload: { header: { taxbureau_validation_status: 3, references: [{ reference_number: 12 }] } } }])
    assert.notEqual(factoPostingPreview({ ...document, ...patch }).reviewKey, preview.reviewKey);
});
test("No duplicate revenue under another key, including drafts and reversals; costs alone are not revenue", () => {
  for (const status of ["draft", "validated", "posted", "reversed", "voided"]) {
    assert.throws(() => assertUnpostedFactoSource([{ id: "old", status, idempotency_key: "manual-other" }], [{ entry_id: "old", account_id: "net_sales" }], accounts));
    assert.throws(() => assertUnpostedFactoSource([{ id: "old", status, idempotency_key: "facto-document:doc" }], [], accounts));
  }
  assert.doesNotThrow(() => assertUnpostedFactoSource([{ id: "old", idempotency_key: "facto-cost:doc" }], [{ entry_id: "old", account_id: "cost_of_sales" }], accounts));
});
test("Persisted verification rejects draft, wrong date/source, different amounts and extra ledger lines", () => {
  for (const patch of [{ status: "validated" }, { status: "reversed" }, { entry_date: "2026-09-28" }, { source_document_id: "other" }])
    assert.throws(() => assertFactoPostingSaved(preview, { ...savedEntry, ...patch }, savedLines, accounts));
  for (const lines of [savedLines.slice(0, 2), [...savedLines, savedLines[0]],
    savedLines.map((l, i) => i ? l : { ...l, debit_clp: 118811 }),
    savedLines.map((l, i) => i ? l : { ...l, debit_clp: 118811, credit_clp: 1 })])
    assert.throws(() => assertFactoPostingSaved(preview, savedEntry, lines, accounts));
});

const source = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("async function centralizeFactoDocuments("), source.indexOf("async function prepareAccountingLedger("));
const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function fixture({ doc = document, periods: dates = periods, entries = [], lines = [], saved = savedEntry, persistedLines = savedLines, allAccounts = accounts } = {}) {
  const writes = [];
  const dependencies = {
    requiredUuid: x => x, requiredDate: x => x, accountingToday: () => "2026-09-29", HttpError,
    isPostableFactoDocument, assertFactoDocumentNotRejected, factoPostingDate, factoPostingPreview, assertUnpostedFactoSource, assertFactoPostingSaved,
    selectAllRows: async (_, path) => {
      if (path.startsWith("accounting_source_documents?")) return [doc];
      if (path.startsWith("accounting_periods?")) return dates;
      if (path.startsWith("accounting_accounts?")) return allAccounts;
      if (path.startsWith("accounting_journal_entries?")) return entries;
      if (path.startsWith("accounting_journal_lines?")) return path.includes("entry_id=eq.saved") ? persistedLines : lines;
      throw new Error(path);
    },
    selectRows: async () => [saved],
    postFactoDocument: async (_, __, doc) => { writes.push({ operation: "post", id: doc.id }); return { id: "saved" }; },
    patchRows: async (_, table) => writes.push({ operation: "patch", table }),
  };
  const run = new Function(...Object.keys(dependencies), `${compiled};return centralizeFactoDocuments;`)(...Object.values(dependencies));
  return { writes, run: extra => run({}, {}, { entityId: "entity", documentIds: ["doc"], ...extra }) };
}
test("Authenticated preview is read-only even when the document is ready to post", async () => {
  const f = fixture();
  const result = await f.run({ preview: true });
  assert.equal(result.preview.reviewKey, preview.reviewKey);
  assert.equal(result.bankBalanceAdjustments, 0);
  assert.deepEqual(f.writes, []);
});
test("Confirmation creates only the selected revenue posting and verifies saved values before success", async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ reviewKey: preview.reviewKey, confirmed: true }), { documents: [{ id: "doc", folio: "1572" }], bankBalanceAdjustments: 0 });
  assert.deepEqual(f.writes, [{ operation: "post", id: "doc" }, { operation: "patch", table: "accounting_source_documents" }]);
  assert.ok(!body.includes("postBankBalanceAdjustments"));
  assert.ok(!body.includes("postFactoCostEntry"));
});
test("Stale or unconfirmed preview and non-open periods never create entries", async () => {
  for (const payload of [{ reviewKey: "stale", confirmed: true }, { reviewKey: preview.reviewKey }, { reviewKey: preview.reviewKey, confirmed: false },
    { preview: true, closedPeriodAdjustmentDate: "2026-09-29" }]) {
    const f = fixture(); await assert.rejects(() => f.run(payload)); assert.equal(f.writes.length, 0);
  }
  for (const status of ["closed", "review"]) {
    const f = fixture({ periods: [{ ...periods[0], status }] }); await assert.rejects(() => f.run({ preview: true })); assert.equal(f.writes.length, 0);
  }
});
test("A concurrent or partial saved entry is not falsely marked as completed", async () => {
  for (const saved of [{ ...savedEntry, status: "validated" }, { ...savedEntry, entry_date: "2026-09-28" }]) {
    const f = fixture({ saved }); await assert.rejects(() => f.run({ reviewKey: preview.reviewKey, confirmed: true }));
    assert.deepEqual(f.writes.map(w => w.operation), ["post"]);
  }
});
test("Duplicate income on an inactive account still blocks preview and confirmation", async () => {
  for (const payload of [{ preview: true }, { reviewKey: preview.reviewKey, confirmed: true }]) {
    const f = fixture({ allAccounts: [...accounts, { id: "legacy", classification: "net_sales", active: false, allows_posting: false }],
      entries: [{ id: "legacy-entry", status: "posted", idempotency_key: "another-key" }],
      lines: [{ entry_id: "legacy-entry", account_id: "legacy" }] });
    await assert.rejects(() => f.run(payload), /Ya existe/);
    assert.deepEqual(f.writes, []);
  }
});
test("Rejected, future or changed documents and ambiguous account configuration fail without writes", async () => {
  const cases = [{ doc: { ...document, raw_payload: { header: { taxbureau_validation_status: 5 } } } },
    { doc: { ...document, issued_on: "2026-09-30" } },
    { doc: { ...document, net_amount: 99841, total_clp: 118811 } },
    { allAccounts: [...accounts, { ...accounts[0], id: "extra" }] },
    { allAccounts: accounts.filter(a => a.classification !== "vat_debit") }];
  for (const options of cases) {
    const f = fixture(options);
    await assert.rejects(() => f.run({ reviewKey: preview.reviewKey, confirmed: true }));
    assert.deepEqual(f.writes, []);
  }
});
test("Posting permission gates the route and frontend never auto-confirms", async () => {
  assert.match(source, /route === "ledger\/facto-document-review"[\s\S]{0,150}requirePermission\(profile, "post"\)/);
  const ui = await readFile(new URL("../src/modules/accounting/FactoPostingReview.tsx", import.meta.url), "utf8");
  assert.match(ui, /if \(!preview \|\| !confirmed \|\| running.current \|\| result \|\| uncertain\) return/);
  assert.match(ui, /setUncertain\(true\)/);
  assert.ok(!ui.includes("useEffect"));
});
test("Preview uses a new route so an older backend cannot execute it as a legacy posting", async () => {
  const api = await readFile(new URL("../src/lib/accountingApi.ts", import.meta.url), "utf8");
  const wrappers = api.slice(api.indexOf("export function previewFactoPosting"), api.indexOf("export function getAccountingLoans"));
  assert.equal((wrappers.match(/ledger\/facto-document-review/g) || []).length, 2);
  assert.ok(!wrappers.includes('"ledger/facto-documents"'));
  const route = source.slice(source.indexOf('if (route === "ledger/facto-document-review"'), source.indexOf('if (route === "ledger/facto-documents"'));
  assert.match(route, /payload\.preview !== true/);
  assert.match(route, /typeof payload\.reviewKey !== "string" \|\| payload\.confirmed !== true/);
  assert.match(route, /throw new HttpError\(400/);
});
