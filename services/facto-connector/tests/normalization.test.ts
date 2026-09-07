import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFactoSyncPreview,
  normalizeFactoApiDocument,
  parseFactoBrowserTable,
  parseLocalizedMoney,
} from "../src/normalization.ts";
import { redact } from "../src/logger.ts";
import { limitFactoBrowserResultToPeriod } from "../src/facto-browser-service.ts";
import type {
  FactoApiDocument,
  FactoApiReadResult,
  FactoBrowserReadResult,
  FactoBrowserRow,
} from "../src/types.ts";

test("normaliza el encabezado documentado de Facto sin perder montos", () => {
  const document = normalizeFactoApiDocument({
    document_id: "facto-501",
    document_type_taxbureau: 33,
    document_number: "001552",
    receiver_tax_id_code: "96.892.710-8",
    receiver_legal_name: "MALBEC COMERCIAL Y REPUESTOS S A",
    issue_date: "2026-08-27",
    received_issued_flag: 1,
    currency_id: 39,
    net_amount: "2861195",
    taxes_amount: "543629",
    total_amount: "3404824",
    created_at: "2026-08-27T12:00:00Z",
  }, { "39": "CLP" });

  assert.equal(document.externalId, "facto-501");
  assert.equal(document.documentType, "sales_invoice");
  assert.equal(document.folio, "1552");
  assert.equal(document.customerTaxId, "968927108");
  assert.equal(document.currency, "CLP");
  assert.equal(document.originalAmountClp, 3_404_824);
  assert.deepEqual(document.validationErrors, []);
});

test("interpreta montos chilenos y de exportación sin confundir miles con decimales", () => {
  assert.equal(parseLocalizedMoney("$1.234.567"), 1_234_567);
  assert.equal(parseLocalizedMoney("CLP 3.404.824"), 3_404_824);
  assert.equal(parseLocalizedMoney("USD 1.170,50"), 1_170.5);
  assert.equal(parseLocalizedMoney("1,170.50"), 1_170.5);
  assert.equal(parseLocalizedMoney("-$80.514"), -80_514);
});

test("reconoce factura de exportación USD y bloquea documentos recibidos", () => {
  const exported = normalizeFactoApiDocument({
    document_id: "export-1",
    document_type_taxbureau: 110,
    document_number: "25",
    receiver_tax_id_code: "55.555.555-5",
    receiver_legal_name: "CLIENTE EXTERIOR",
    issue_date: "2026-08-30",
    received_issued_flag: 1,
    currency_id: 5,
    exchange_rate_value: "900",
    net_amount: "100",
    taxes_amount: "0",
    total_amount: "100",
  }, { "5": "USD", "38": "EUR", "39": "CLP" });
  assert.equal(exported.documentType, "sales_export_invoice");
  assert.equal(exported.currency, "USD");
  assert.equal(exported.originalAmountClp, 90_000);
  assert.deepEqual(exported.validationErrors, []);

  const received = normalizeFactoApiDocument({
    ...exported.raw,
    document_id: "received-1",
    document_type_taxbureau: 33,
    currency_id: 39,
    exchange_rate_value: 1,
    total_amount: 119_000,
    received_issued_flag: 0,
  }, { "39": "CLP" });
  assert.ok(received.validationErrors.includes("document_direction_not_issued"));
});

test("extrae saldo, vencimiento y pago parcial desde la tabla web", () => {
  const [row] = parseFactoBrowserTable(browserHeaders, [{
    cells: ["Factura electrónica", "1552", "96.892.710-8", "MALBEC COMERCIAL", "27-08-2026", "26-09-2026", "$3.404.824", "$1.000.000", "$2.404.824", "Parcial"],
    externalId: "facto-501",
    href: "https://minegocio.facto.cl/document/501?token=secret",
  }]);

  assert.equal(row.folio, "1552");
  assert.equal(row.customerTaxId, "968927108");
  assert.equal(row.issuedOn, "2026-08-27");
  assert.equal(row.dueOn, "2026-09-26");
  assert.equal(row.outstandingAmountClp, 1_000_000);
  assert.equal(row.partialPayments[0]?.amount_clp, 2_404_824);
  assert.equal(row.sourceHref, "https://minegocio.facto.cl/document/501");
  assert.deepEqual(row.validationErrors, []);
});

test("combina API y cartera completa, propone pago parcial y cierre con evidencia", () => {
  const open = apiDocument({ externalId: "api-open", folio: "1547", originalAmountClp: 10_122_533 });
  const closed = apiDocument({ externalId: "api-closed", folio: "1546", originalAmountClp: 343_612 });
  const creditNote = apiDocument({
    externalId: "api-credit",
    folio: "61",
    documentType: "sales_credit_note",
    originalAmountClp: 50_000,
    validationErrors: ["document_type_requires_review"],
  });
  const browserOpen = browserRow({
    externalId: "api-open",
    folio: "1547",
    originalAmountClp: 10_122_533,
    outstandingAmountClp: 6_748_355,
    partialPayments: [{ amount_clp: 3_374_178, source: "facto_unpaid_grid", bank_confirmed: false }],
  });
  const preview = buildFactoSyncPreview(
    apiResult([open, closed, creditNote]),
    browserResult([browserOpen], true),
    "2026-09-07T12:00:00.000Z",
  );

  assert.equal(preview.items.length, 2);
  const partial = preview.items.find((item) => item.normalized.folio === "1547");
  const paid = preview.items.find((item) => item.normalized.folio === "1546");
  assert.equal(partial?.normalized.outstanding_amount_clp, 6_748_355);
  assert.equal(partial?.normalized.reported_paid_amount_clp, 3_374_178);
  assert.equal(partial?.normalized.closure_evidence, false);
  assert.equal(paid?.normalized.outstanding_amount_clp, 0);
  assert.equal(paid?.normalized.closure_evidence, true);
  assert.equal(preview.partialPaymentDocuments, 1);
  assert.equal(preview.overdueDocuments, 0);
  assert.match(preview.warnings.join(" "), /no cobrables se excluyeron/i);
});

test("una lectura incompleta nunca propone cerrar documentos ausentes", () => {
  const open = apiDocument({ externalId: "api-open", folio: "1547", originalAmountClp: 10_122_533 });
  const absent = apiDocument({ externalId: "api-absent", folio: "1546", originalAmountClp: 343_612 });
  const preview = buildFactoSyncPreview(
    apiResult([open, absent]),
    browserResult([browserRow({ externalId: "api-open", folio: "1547", originalAmountClp: 10_122_533, outstandingAmountClp: 6_748_355 })], false),
    "2026-09-07T12:00:00.000Z",
  );

  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].normalized.folio, "1547");
  assert.equal(preview.coverage.complete, false);
  assert.match(preview.warnings.join(" "), /no se proponen cierres/i);
});

test("una boleta anónima ausente de la cartera completa no bloquea facturas cobrables", () => {
  const invoice = apiDocument({ externalId: "invoice-1", folio: "1552" });
  const anonymousReceipt = apiDocument({
    externalId: "receipt-1",
    documentType: "sales_receipt",
    folio: "185421",
    customerTaxId: "",
    customerName: "",
    validationErrors: ["customer_tax_id_missing", "customer_name_missing"],
  });
  const preview = buildFactoSyncPreview(apiResult([invoice, anonymousReceipt]), browserResult([], true));
  assert.deepEqual(preview.items.map((item) => item.normalized.folio), ["1552"]);
  assert.match(preview.warnings.join(" "), /boleta.*sin cliente identificado/i);
});

test("una API incompleta tampoco permite cierres aunque la cartera web haya terminado", () => {
  const absent = apiDocument({ externalId: "api-absent", folio: "1546", originalAmountClp: 343_612 });
  const incompleteApi = { ...apiResult([absent]), pageCount: 2, pagesRead: 1, totalItems: 2, complete: false };
  const preview = buildFactoSyncPreview(incompleteApi, browserResult([], true));
  assert.equal(preview.items.length, 0);
  assert.equal(preview.coverage.complete, false);
  assert.equal(preview.coverage.api_complete, false);
  assert.match(preview.warnings.join(" "), /API de Facto no tuvo cobertura completa/i);
});

test("si Facto no ofrece fechas, limita localmente solo después de leer toda la cartera", () => {
  const january = browserRow({ sourceRow: 1, issuedOn: "2026-01-10", folio: "10" });
  const august = browserRow({ sourceRow: 2, issuedOn: "2026-08-10", folio: "20" });
  const result = limitFactoBrowserResultToPeriod(browserResult([january, august], true), "2026-08-01", "2026-08-31");
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].folio, "20");
  assert.equal(result.expectedRows, 1);

  const uncertain = limitFactoBrowserResultToPeriod(
    browserResult([august, browserRow({ sourceRow: 3, issuedOn: "", folio: "30" })], true),
    "2026-08-01",
    "2026-08-31",
  );
  assert.equal(uncertain.complete, false);
  assert.equal(uncertain.expectedRows, null);
  assert.match(uncertain.warnings.join(" "), /sin fecha/i);
});

test("dos saldos web contradictorios para el mismo documento bloquean la previsualización", () => {
  const document = apiDocument({ externalId: "api-duplicate", folio: "1500", originalAmountClp: 500_000 });
  const first = browserRow({ externalId: "api-duplicate", folio: "1500", originalAmountClp: 500_000, outstandingAmountClp: 200_000 });
  const second = browserRow({ externalId: "api-duplicate", folio: "1500", originalAmountClp: 500_000, outstandingAmountClp: 100_000 });
  const preview = buildFactoSyncPreview(apiResult([document]), browserResult([first, second], true));

  assert.equal(preview.items.length, 1);
  assert.ok(preview.items[0].validation_errors.includes("conflicting_browser_rows"));
});

test("el registro técnico oculta secretos y parámetros de URL", () => {
  const value = redact({
    password: "visible-no",
    authorization: "Bearer abc.def",
    source_url: "https://example.com/path?token=abc#private",
    nested: { client_secret: "visible-no" },
  });
  assert.deepEqual(value, {
    password: "[REDACTED]",
    authorization: "[REDACTED]",
    source_url: "https://example.com/path",
    nested: { client_secret: "[REDACTED]" },
  });
});

const browserHeaders = [
  "Tipo documento",
  "Folio",
  "RUT cliente",
  "Razón social",
  "Fecha emisión",
  "Fecha vencimiento",
  "Monto original",
  "Saldo pendiente",
  "Pagado",
  "Estado",
];

function apiDocument(overrides: Partial<FactoApiDocument>): FactoApiDocument {
  const originalAmountClp = overrides.originalAmountClp ?? 119_000;
  return {
    externalId: "api-1",
    documentType: "sales_invoice",
    folio: "100",
    customerTaxId: "777243829",
    customerName: "IMPORTADORA LATIN CHILE LIMITADA",
    issuedOn: "2026-08-18",
    currency: "CLP",
    exchangeRate: 1,
    netAmount: originalAmountClp / 1.19,
    taxAmount: originalAmountClp - originalAmountClp / 1.19,
    exemptAmount: 0,
    originalAmount: originalAmountClp,
    originalAmountClp,
    sourceCreatedAt: "2026-08-18T12:00:00.000Z",
    receivedIssuedFlag: "1",
    raw: {},
    validationErrors: [],
    ...overrides,
  };
}

function browserRow(overrides: Partial<FactoBrowserRow>): FactoBrowserRow {
  return {
    sourceRow: 1,
    externalId: "api-1",
    documentType: "sales_invoice",
    documentTypeLabel: "Factura electrónica",
    folio: "100",
    customerTaxId: "777243829",
    customerName: "IMPORTADORA LATIN CHILE LIMITADA",
    issuedOn: "2026-08-18",
    dueOn: "2026-09-18",
    currency: "CLP",
    originalAmountClp: 119_000,
    outstandingAmountClp: 119_000,
    status: "Pendiente",
    daysOverdue: 0,
    partialPayments: [],
    sourceHref: null,
    validationErrors: [],
    rawColumns: {},
    ...overrides,
  };
}

function apiResult(documents: FactoApiDocument[]): FactoApiReadResult {
  return { documents, pageCount: 1, pagesRead: 1, totalItems: documents.length, issuedFlag: "0", complete: true };
}

function browserResult(rows: FactoBrowserRow[], complete: boolean): FactoBrowserReadResult {
  return {
    section: "Documentos impagos",
    rows,
    pagesRead: 1,
    expectedRows: rows.length,
    complete,
    verifiedZero: complete && rows.length === 0,
    warnings: [],
  };
}
