import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { factoHeader, factoIdentity, factoReferenceLabel, isPostableFactoDocument } from "../supabase/functions/accounting-center/facto-document-policy.ts";

const source = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
const calculation = source.slice(source.indexOf("function normalizeFactoDocument("), source.indexOf("function findFactoSourceDocument("));
const javascript = ts.transpileModule(calculation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const normalize = new Function("factoHeader", "asObject", "first", "numeric", "dateValue", "dateTimeValue", `${javascript};return normalizeFactoDocument;`)(factoHeader, v => v && typeof v === "object" ? v : {}, (row, keys) => keys.map(k => row[k]).find(v => v !== null && v !== undefined && v !== ""), v => Number(v) || 0, v => v ? String(v).slice(0, 10) : null, v => v || null);
const note = { document_id: 762, header: { document_number: 80, document_type_taxbureau: "61", received_issued_flag: 1, issue_date: "2026-08-18", currency_id: 39, receiver_legal_name: "ANDREA GARAY" }, totals: { net_amount: 9091838, taxes_amount: 1727449, total_amount: "10819287.00" }, references: [{ reference_number: 1534, reference_date: "2026-07-28", document_id: 731 }] };

test("Details supply nested totals and the original credit reference, never a moved date", () => {
  const result = normalize(note, false, "762");
  assert.equal(result.net, 9091838);
  assert.equal(result.totalClp, 10819287);
  assert.equal(result.documentType, "sales_credit_note");
  assert.equal(result.issuedOn, "2026-08-18");
  assert.deepEqual(result.errors, []);
  assert.equal(factoReferenceLabel(note), "Factura 1534 (2026-07-28)");
});

test("Provider direction and actual document id override a historical wrong resource or hashed external id", () => {
  assert.deepEqual(factoIdentity({ document_id: 564, received_issued_flag: 0 }, "documents", "old-hash"), { purchase: true, externalId: "564" });
  assert.deepEqual(factoIdentity(note, "purchase_document_details", "bad"), { purchase: false, externalId: "762" });
});

test("ADS exempt invoice remains fully recognized without VAT or double counting net and exempt", () => {
  const result = normalize({ document_type_taxbureau: "34", issuer_legal_name: "ADS CARGO", issue_date: "2026-06-03", net_amount: 3128000, exempt_amount: 3128000, total_amount: 3128000, taxes_amount: 0 }, true, "770");
  assert.equal(result.documentType, "purchase_exempt_invoice");
  assert.equal(result.net, 0);
  assert.equal(result.exempt, 3128000);
  assert.equal(result.tax, 0);
  assert.deepEqual(result.errors, []);
});

test("Unknown currency, unknown tax types and inconsistent amounts cannot be silently posted", () => {
  const unknown = normalize({ ...note, header: { ...note.header, currency_id: 999, document_type_taxbureau: "52" } }, false, "762");
  assert.ok(unknown.errors.includes("currency_unknown"));
  assert.ok(unknown.errors.includes("document_type_unsupported"));
  const mismatched = normalize({ ...note, totals: { ...note.totals, total_amount: 3 } }, false, "762");
  assert.ok(mismatched.errors.includes("totals_mismatch"));
  assert.equal(isPostableFactoDocument({ document_type: "sales_credit_note", data_quality: "validated", status: "validated", raw_payload: { header: { received_issued_flag: 0 } } }), false);
  assert.equal(isPostableFactoDocument({ document_type: "sales_quote", data_quality: "validated", status: "validated" }), false);
});

test("Scoped centralization has post permission and never invokes bank adjustments", () => {
  assert.match(source, /route === "ledger\/facto-documents"[\s\S]{0,150}requirePermission\(profile, "post"\)/);
  const scoped = source.slice(source.indexOf("async function centralizeFactoDocuments("), source.indexOf("async function prepareAccountingLedger("));
  assert.ok(!scoped.includes("postBankBalanceAdjustments"));
  assert.ok(scoped.includes("isPostableFactoDocument"));
});

test("Verified foreign type 57 uses its actual CLP amounts and remains purchase evidence", () => {
  const raw = { document_id: 695, header: { document_type_id: 57, document_type_taxbureau: "0", received_issued_flag: 0, currency_id: 39, exchange_rate_value: 1, issuer_legal_name: "Hangzhou Lifeng", document_number: 3, issue_date: "2026-06-22" }, totals: { net_amount: 11365601, taxes_amount: 2159464.19, total_amount: 13525065.19 } };
  const document = normalize(raw, true, "695");
  assert.equal(document.documentType, "purchase_document");
  assert.equal(document.totalClp, 13525065.19);
  assert.deepEqual(document.errors, []);
  assert.ok(isPostableFactoDocument({ document_type: document.documentType, data_quality: "validated", status: "posted", raw_payload: raw }));
});
