import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { confirmedCostSourceIds, assertExistingFactoCost } from "../supabase/functions/accounting-center/facto-cost-evidence.ts";

const accounts = [{ id: "cost", classification: "cost_of_sales" }, { id: "inventory", classification: "inventory" }, { id: "income", classification: "net_sales" }];
function pair(amount = 91328, entryId = "entry", status = "posted", date = "2026-09-08") {
  const accounting_journal_entries = { id: entryId, source_document_id: "1557", entry_date: date, status, idempotency_key: "combined-facto-journal" };
  return [
    { account_id: "cost", debit_clp: amount, credit_clp: 0, accounting_journal_entries },
    { account_id: "inventory", debit_clp: 0, credit_clp: amount, accounting_journal_entries },
  ];
}
const ids = lines => [...confirmedCostSourceIds(lines, accounts, "2026-09-14")];
test("Combined Facto journal and split cost imports both confirm cost by ledger evidence, not a key prefix", () => {
  assert.deepEqual(ids(pair()), ["1557"]);
  const lines = pair();
  lines[0].accounting_journal_entries.idempotency_key = "facto-cost:1557";
  assert.deepEqual(ids(lines), ["1557"]);
});
test("Income alone, incomplete cost, imbalance, drafts, future dates and full reversals do not confirm cost", () => {
  assert.deepEqual(ids(pair().slice(0, 1)), []);
  const wrong = pair(); wrong[1].credit_clp = 1;
  assert.deepEqual(ids(wrong), []);
  assert.deepEqual(ids(pair(0)), []);
  assert.deepEqual(ids(pair(1, "draft", "draft")), []);
  assert.deepEqual(ids(pair(1, "future", "posted", "2026-09-15")), []);
  assert.deepEqual(ids([...pair(100, "original", "reversed"), ...pair(-100, "reverse")]), []);
  assert.deepEqual(ids([{ ...pair()[0], account_id: "income" }]), []);
});
test("Partial reversals retain only real remaining cost; unrelated inventory cannot complete an entry", () => {
  assert.deepEqual(ids([...pair(100, "original", "reversed"), ...pair(-50, "reverse")]), ["1557"]);
  const lines = pair(); lines[1] = { ...lines[1], accounting_journal_entries: { ...lines[1].accounting_journal_entries, id: "other" } };
  assert.deepEqual(ids(lines), []);
});
test("Repeated imports report actual saved cost and reject changed, reversed or incomplete entries", () => {
  assert.equal(assertExistingFactoCost({ status: "posted" }, pair(), "cost", "inventory", 91328, false), 91328);
  assert.throws(() => assertExistingFactoCost({ status: "posted" }, pair(), "cost", "inventory", 50000, false), /difiere/);
  assert.throws(() => assertExistingFactoCost({ status: "reversed" }, pair(), "cost", "inventory", 91328, false), /vigente/);
  assert.throws(() => assertExistingFactoCost({ status: "validated" }, pair(), "cost", "inventory", 91328, false), /vigente/);
  assert.throws(() => assertExistingFactoCost({ status: "posted" }, pair().slice(0, 1), "cost", "inventory", 91328, false), /estructura/);
  assert.equal(assertExistingFactoCost({ status: "posted" }, pair(-91328), "cost", "inventory", 91328, true), 91328);
});

const source = await readFile("supabase/functions/accounting-center/index.ts", "utf8");
const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const handler = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "postFactoCostEntry").getText(tree);
const code = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const document = { id: "document", document_type: "sales_invoice", issued_on: "2026-09-08", folio: "1557" };
const payload = { entityId: "entity", sourceDocumentId: "document", amountClp: 91328, evidence: "Libro Diario Facto 1557: 5101 contra 1201" };
function handlerFixture({ existing, existingLines = pair(), otherCost = false, postable = true, savedLines = pair() } = {}) {
  let writes = 0;
  const context = {
    requiredUuid: x => x, requiredDate: x => x, optionalText: x => x, HttpError, assertExistingFactoCost,
    isPostableFactoDocument: () => postable, postingAccount: (map, key) => map.get(key),
    selectRows: async (_, path) => {
      if (path.startsWith("accounting_source_documents?")) return [document];
      if (path.startsWith("accounting_periods?")) return [];
      if (path.startsWith("accounting_accounts?")) return accounts;
      if (path.startsWith("accounting_journal_entries?")) return path.includes("id=eq.new") ? [{ id: "new", status: "posted" }] : existing ? [existing] : [];
      if (path.includes("entry_id=eq.")) return path.includes("entry_id=eq.new") ? savedLines : existingLines;
      if (path.startsWith("accounting_journal_lines?")) {
        assert.match(path, /select=id,accounting_journal_entries!inner/);
        return otherCost ? [{ id: "other" }] : [];
      }
      throw new Error(`Unexpected query: ${path}`);
    },
    postAutomatedEntry: async () => { writes++; return { id: "new" }; },
    postingLine: (map, key, debit, credit, description) => ({ accountId: map.get(key), debit, credit, description }),
    periodForDate: () => "period", insertRows: async () => { writes++; }, rpc: async () => {}, requestIdToUuid: x => x,
  };
  const run = new Function(...Object.keys(context), `${code}; return postFactoCostEntry;`)(...Object.values(context));
  return { run: body => run({}, { id: "user" }, "request", body), writes: () => writes };
}
test("Handler blocks conflicting/repeated costs without financial writes", async () => {
  const same = handlerFixture({ existing: { id: "old", status: "posted" } });
  assert.equal((await same.run(payload)).existing, true);
  assert.equal(same.writes(), 0);
  await assert.rejects(() => same.run({ ...payload, amountClp: 1 }), error => error.status === 409);
  const other = handlerFixture({ otherCost: true });
  await assert.rejects(() => other.run(payload), error => error.status === 409);
  assert.equal(other.writes(), 0);
});
test("Handler requires positive amount, validated sale and evidence before any write", async () => {
  for (const amountClp of [-1, 0, NaN, Infinity, "no"]) {
    const fixture = handlerFixture();
    await assert.rejects(() => fixture.run({ ...payload, amountClp }), error => error.status === 400);
    assert.equal(fixture.writes(), 0);
  }
  await assert.rejects(() => handlerFixture({ postable: false }).run(payload), error => error.status === 409);
  await assert.rejects(() => handlerFixture().run({ ...payload, evidence: "" }), error => error.status === 400);
  const fixture = handlerFixture();
  const result = await fixture.run(payload);
  assert.equal(result.existing, false);
  assert.equal(result.amountClp, 91328);
  assert.equal(fixture.writes(), 2);
});
test("Concurrent idempotency winner with a different persisted amount is not reported as a successful update", async () => {
  const fixture = handlerFixture({ savedLines: pair(1) });
  await assert.rejects(() => fixture.run(payload), error => error.status === 409);
  assert.equal(fixture.writes(), 1, "No successful import audit is written after a persisted-cost mismatch");
});
