import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readSourceDocumentSummaries } from "../supabase/functions/accounting-center/source-document-read-model.ts";
import { factoHeader, factoReferenceLabel, isPostableFactoDocument } from "../supabase/functions/accounting-center/facto-document-policy.ts";
import { dashboardDocumentSales } from "../supabase/functions/accounting-center/dashboard-sales.ts";
import { dashboardPurchaseEvidence } from "../supabase/functions/accounting-center/dashboard-purchases.ts";

const base = { id: "1", entity_id: "entity", document_type: "purchase_document", source_type: "FACTO", issued_on: "2026-06-22",
  status: "validated", data_quality: "validated", currency: "CLP", net_amount: 100, tax_amount: 0, exempt_amount: 0, total_clp: 100 };
const header = { document_id: 695, document_type_id: 57, received_issued_flag: 0,
  references: [{ reference_number: 1547, reference_date: "2026-08-18" }] };

test("Small pages preserve every document, identity and financial evidence without mutating originals", async () => {
  const original = Array.from({ length: 70 }, (_, index) => ({ ...base, id: String(index), raw_payload: {
    electronic_document: { pdf: "large PDF", xml: "large XML" },
    header, data: { document: { header, electronic_document: "nested XML" } },
    details: [{ quantity: 3, net_amount: 100 }],
    evidence: "Facto Excel complementario", normalized_data: { direction: "purchase", document_type_label: "Factura extranjera" },
  } }));
  const before = JSON.stringify(original);
  const offsets = [];
  const result = await readSourceDocumentSummaries(async path => {
    const query = new URLSearchParams(path.split("?")[1]);
    assert.equal(query.get("entity_id"), "eq.entity");
    assert.equal(query.get("order"), "issued_on.desc.nullslast,id.asc");
    assert.equal(query.get("limit"), "25");
    const offset = Number(query.get("offset"));
    offsets.push(offset);
    return original.slice(offset, offset + 25);
  }, "entity");
  assert.deepEqual(offsets, [0, 25, 50]);
  assert.equal(result.length, 70);
  assert.equal(JSON.stringify(original), before);
  for (let index = 0; index < result.length; index++) {
    const row = result[index];
    assert.equal(row.raw_payload.electronic_document, undefined);
    assert.equal(row.raw_payload.data.document.electronic_document, undefined);
    assert.deepEqual(row.raw_payload.details, original[index].raw_payload.details);
    assert.equal(factoHeader(row.raw_payload).document_id, 695);
    assert.equal(factoReferenceLabel(row.raw_payload), factoReferenceLabel(original[index].raw_payload));
    assert.equal(isPostableFactoDocument(row), isPostableFactoDocument(original[index]));
    assert.deepEqual(dashboardPurchaseEvidence([row], "2026-09-10"), dashboardPurchaseEvidence([original[index]], "2026-09-10"));
    const sale = { ...row, document_type: "sales_credit_note", raw_payload: { ...row.raw_payload, header: { received_issued_flag: 1 } } };
    assert.equal(dashboardDocumentSales(sale), -100);
  }
});

test("Incomplete pages fail closed instead of returning a partial financial snapshot", async () => {
  let calls = 0;
  await assert.rejects(readSourceDocumentSummaries(async () => {
    if (++calls === 2) throw new Error("source unavailable");
    return Array.from({ length: 25 }, () => ({ ...base }));
  }, "entity"), /source unavailable/);
  assert.deepEqual(await readSourceDocumentSummaries(async () => [], "entity"), []);
});

test("Bootstrap reads source evidence once and dashboard reuses the same snapshot", async () => {
  const code = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
  const bootstrap = code.slice(code.indexOf("async function bootstrap("), code.indexOf("async function buildBankReality("));
  assert.match(bootstrap, /readSourceDocumentSummaries\(path => selectRows\(rest, path\), entityId\)/);
  assert.doesNotMatch(bootstrap, /selectAllRows\(rest, `accounting_source_documents/);
  const dashboard = code.slice(code.indexOf("async function buildDashboardAnalytics("), code.indexOf("async function createAccount("));
  assert.doesNotMatch(dashboard, /accounting_source_documents\?/);
});

test("370 electronic documents can be summarized under a 64 MB Node heap", () => {
  const moduleUrl = new URL("../supabase/functions/accounting-center/source-document-read-model.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { readSourceDocumentSummaries } from ${JSON.stringify(moduleUrl)};
    const rows = await readSourceDocumentSummaries(async path => {
      const query = new URLSearchParams(path.split('?')[1]);
      const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
      return JSON.parse(JSON.stringify(Array.from({ length: Math.min(limit, 370 - offset) }, (_, i) => ({
        id: String(offset + i), raw_payload: { electronic_document: 'A'.repeat(115000), header: { document_id: offset + i } }
      }))));
    }, 'entity');
    assert.equal(rows.length, 370);
    assert.ok(JSON.stringify(rows).length < 100000);
    console.log('memory regression passed');
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /memory regression passed/);
});
