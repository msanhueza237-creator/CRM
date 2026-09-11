import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { planFactoDocumentMirror, mirrorFactoDocuments } from "../supabase/functions/crm-agent/facto-document-mirror.ts";

const entities = [{ id: "company", tax_id: "77.724.382-9" }];
const invoice = (id = "832", folio = 1558) => ({ id: "integration-" + id, external_id: id,
  observed_at: "2026-09-11T14:00:00.000Z", updated_at: "2026-09-11T14:00:00.000Z",
  payload: { document_id: id, header: { document_id: id, document_number: folio, document_status: 1,
    received_issued_flag: 1, document_type_taxbureau: "33", issuer_tax_id_code: "77724382-9",
    receiver_tax_id_code: "12345678-9", receiver_legal_name: "Cliente de prueba", issue_date: "2026-09-11", currency_id: 39 },
  totals: { net_amount: 22009, taxes_amount: 4181, total_amount: 26190 } } });
const prior = (extra = {}) => ({ id: "source", entity_id: "company", source_key: "facto:sale:832",
  external_id: "832", document_type: "sales_invoice", status: "validated", source_updated_at: "2026-09-10T10:00:00+00:00", ...extra });

test("A new issued invoice becomes a validated document with the original amount, identity and date", () => {
  const { row } = planFactoDocumentMirror(invoice(), "documents", entities, []);
  assert.equal(row.net_amount, 22009);
  assert.equal(row.total_clp, 26190);
  assert.equal(row.issued_on, "2026-09-11");
  assert.equal(row.source_key, "facto:sale:832");
  assert.equal(row.source_id, "integration-832");
  assert.equal(row.status, "validated");
  assert.ok(!("paid_amount" in row));
});

test("Paid invoices are sales too; payment conditions do not filter them", () => {
  const record = invoice(); record.payload.header.payment_conditions = "0";
  record.payload.paid_amount = 26190;
  assert.ok(planFactoDocumentMirror(record, "documents", entities, []).row);
});

test("Posted, reversed or voided sources cannot be rewritten by automatic synchronization", () => {
  for (const status of ["posted", "reversed", "voided"]) {
    assert.equal(planFactoDocumentMirror(invoice(), "documents", entities, [prior({ status })]).skip, "protected_accounting_state");
  }
  assert.equal(planFactoDocumentMirror(invoice(), "documents", entities,
    [prior({ source_updated_at: "2026-09-11T14:00:00+00:00" })]).skip, "already_observed");
});

test("No inferred company, duplicate identity, missing direction or invalid totals are accepted", () => {
  assert.equal(planFactoDocumentMirror(invoice(), "documents", [], []).skip, "company_unverified");
  assert.equal(planFactoDocumentMirror(invoice(), "documents", entities, [prior(), prior({ id: "other" })]).skip, "ambiguous_identity");
  const unknown = invoice(); delete unknown.payload.header.received_issued_flag;
  assert.equal(planFactoDocumentMirror(unknown, "documents", entities, []).skip, "direction_unverified");
  const invalid = invoice(); invalid.payload.totals.total_amount = 1;
  assert.equal(planFactoDocumentMirror(invalid, "documents", entities, []).skip, "invalid_document");
});

test("Credit notes retain their type and reference, without creating positive receivables", () => {
  const record = invoice(); record.payload.header.document_type_taxbureau = "61";
  record.payload.references = [{ reference_number: 1547, reference_date: "2026-08-18" }];
  const { row } = planFactoDocumentMirror(record, "documents", entities, []);
  assert.equal(row.document_type, "sales_credit_note");
  assert.deepEqual(row.raw_payload.references, record.payload.references);
  assert.equal(row.issued_on, "2026-09-11");
});

test("Exempt purchases use the correct direction and do not duplicate workbook identities", () => {
  const record = invoice(); Object.assign(record.payload.header, { received_issued_flag: 0,
    document_type_taxbureau: "34", issuer_legal_name: "ADS de prueba", issuer_tax_id_code: "12345678-9", receiver_tax_id_code: "77724382-9" });
  record.payload.totals = { net_amount: 30000, taxes_amount: 0, total_amount: 30000 };
  assert.equal(planFactoDocumentMirror(record, "documents", entities, []).skip, "wrong_resource");
  const { row } = planFactoDocumentMirror(record, "purchase_documents", entities, []);
  assert.equal(row.document_type, "purchase_exempt_invoice");
  assert.equal(row.exempt_amount, 30000); assert.equal(row.net_amount, 0);
  assert.equal(planFactoDocumentMirror(record, "purchase_documents", entities,
    [{ ...row, id: "excel", external_id: "excel-1558", source_key: "facto-workbook:purchase:1558" }]).skip, "workbook_identity_requires_review");
});

function fakeDb() {
  const sources = [], writes = [], tables = [];
  return { sources, writes, tables, from(table) {
    tables.push(table);
    const filters = []; let operation, row, opts;
    const query = {
      select() { return query; }, in() { return query; }, order() { return query; }, range() { return query; },
      eq(key, value) { filters.push([key, value]); return query; }, is(key, value) { filters.push([key, value]); return query; },
      update(value) { operation = "update"; row = value; return query; },
      upsert(value, options) { operation = "upsert"; row = value; opts = options; return query; },
      then(resolve, reject) { try {
        if (table === "accounting_entities") return Promise.resolve({ data: entities }).then(resolve, reject);
        if (!operation) return Promise.resolve({ data: sources.filter(source => filters.every(([key, value]) => source[key] === value)) }).then(resolve, reject);
        writes.push({ table, operation, row, filters, opts });
        let saved;
        if (operation === "upsert") {
          saved = sources.find(source => source.source_key === row.source_key);
          if (saved) return Promise.resolve({ data: [] }).then(resolve, reject);
          saved = { ...row, id: "new-source" }; sources.push(saved);
        } else {
          saved = sources.find(source => filters.every(([key, value]) => source[key] === value));
          if (!saved) return Promise.resolve({ data: [] }).then(resolve, reject);
          Object.assign(saved, row);
        }
        return Promise.resolve({ data: [saved] }).then(resolve, reject);
      } catch (error) { return Promise.reject(error).then(resolve, reject); } },
    }; return query;
  } };
}

test("The runtime stages once, replays without duplicates and never touches payments or the ledger", async () => {
  const db = fakeDb();
  assert.equal((await mirrorFactoDocuments(db, "documents", [invoice()])).staged, 1);
  assert.equal((await mirrorFactoDocuments(db, "documents", [invoice()])).staged, 0);
  assert.equal(db.sources.length, 1);
  assert.ok(db.tables.every(table => ["accounting_entities", "accounting_source_documents"].includes(table)));
  assert.equal(db.writes[0].opts.ignoreDuplicates, true);
  const later = invoice(); later.updated_at = "2026-09-11T14:05:00.000Z";
  assert.equal((await mirrorFactoDocuments(db, "documents", [later])).staged, 1);
  assert.ok(db.writes.at(-1).filters.some(([key, value]) => key === "status" && value === "validated"));
});

test("Dashboard refresh is bounded, visibility aware and cleans up listeners", async () => {
  const source = await readFile(new URL("../src/modules/dashboard/useDashboardOverview.ts", import.meta.url), "utf8");
  assert.match(source, /setInterval\(onVisible, 60000\)/);
  assert.match(source, /!document.hidden/);
  assert.match(source, /if \(running.current/);
  assert.match(source, /removeEventListener\("visibilitychange", onVisible\)/);
});
