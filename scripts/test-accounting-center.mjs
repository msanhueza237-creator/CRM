import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  bancoEstadoStatementRange,
  bankIsoDate,
  bankMoney,
} from "../supabase/functions/accounting-center/bank-normalizers.ts";
import {
  buildSuggestedAllocationPlan,
  extractChileanTaxIds,
  rankReconciliationCandidates,
  selectUniqueExactReconciliation,
  selectVerifiedExactAllocation,
} from "../supabase/functions/accounting-center/reconciliation-engine.ts";
import { normalizeAccountingReconciliationProposal } from "../src/modules/accounting/reconciliationCompatibility.ts";
import {
  filterAndSortReconciliationTransactions,
  identifyPayrollEmployee as identifyPayrollEmployeeInUi,
  matchingPostedPayrollDuplicate,
  reconciliationDocumentCandidates,
} from "../src/modules/accounting/reconciliationSearch.ts";
import { buildFactoCurrentStateAdjustment } from "../supabase/functions/accounting-center/facto-current-state.ts";
import {
  identifyPayrollEmployee,
  protectedPayrollClassification,
} from "../supabase/functions/accounting-center/payroll-employees.ts";

const migration = (await readFile(new URL("../supabase/accounting_center.sql", import.meta.url), "utf8"))
  .replace(/create extension if not exists pgcrypto;/i, "");
const factoHistoryMigration = await readFile(new URL("../supabase/accounting_facto_history.sql", import.meta.url), "utf8");
const factoExcelMigration = await readFile(new URL("../supabase/accounting_facto_excel_imports.sql", import.meta.url), "utf8");
const factoCheckSettlementMigration = await readFile(new URL("../supabase/accounting_facto_check_settlements.sql", import.meta.url), "utf8");
const factoOutstandingSnapshotMigration = await readFile(new URL("../supabase/accounting_facto_outstanding_snapshot.sql", import.meta.url), "utf8");
const controlsRefreshFix = await readFile(new URL("../supabase/accounting_control_findings_refresh_fix.sql", import.meta.url), "utf8");
const bankRealityMigration = await readFile(new URL("../supabase/accounting_bank_reality.sql", import.meta.url), "utf8");
const sislaLoanMigration = await readFile(new URL("../supabase/accounting_reclassify_sisla_loan_repayment.sql", import.meta.url), "utf8");
const edgeSource = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
const parserSource = await readFile(new URL("../supabase/functions/accounting-center/bank-parsers.ts", import.meta.url), "utf8");
const factoExcelParserSource = await readFile(new URL("../supabase/functions/accounting-center/facto-excel-parsers.ts", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../src/modules/accounting/AccountingCenterPage.tsx", import.meta.url), "utf8");

assert.match(edgeSource, /route === "facto\/sync"/);
assert.match(edgeSource, /route === "facto\/cost-entry"/);
assert.match(edgeSource, /facto-cost:/);
assert.match(edgeSource, /sourceModule: "facto_accounting_entry"/);
assert.match(edgeSource, /facto_account_code: "5101"/);
assert.match(edgeSource, /facto_account_code: "1201"/);
assert.match(edgeSource, /route === "facto-excel\/preview"/);
assert.match(edgeSource, /route === "facto-excel\/confirm"/);
assert.match(edgeSource, /accounting_payment_events/);
assert.match(edgeSource, /existingFactoExcelDuplicates/);
assert.match(edgeSource, /expectedBankAccount\(rest, entityId, "BancoEstado"\)/);
assert.match(edgeSource, /accounting_facto_sync_runs/);
assert.match(edgeSource, /accounting_facto_sync_records/);
assert.match(edgeSource, /fromDate/);
assert.match(edgeSource, /selectAllRows/);
assert.match(edgeSource, /facto:.*purchase.*sale|facto:.*sale.*purchase/);
assert.match(edgeSource, /\["documents", "purchase_documents", "document_details", "purchase_document_details"\]/);
assert.match(edgeSource, /receiver_legal_name/);
assert.match(edgeSource, /issuer_name/);
assert.match(edgeSource, /issuer_tax_id_code/);
assert.match(edgeSource, /taxes_amount/);
assert.match(edgeSource, /Consumidor final/);
assert.match(edgeSource, /backups = backupKeys\.size/);
assert.match(controlsRefreshFix, /is not distinct from/);
assert.match(controlsRefreshFix, /accounting_refresh_controls/);
assert.match(edgeSource, /route === "foreign-trade\/sync"/);
assert.match(edgeSource, /route === "accounts\/create"/);
assert.match(edgeSource, /route === "imports\/preview"/);
assert.match(edgeSource, /existingBankFingerprints/);
assert.match(edgeSource, /index \+= 40/);
assert.match(edgeSource, /suggestedExchangeRate/);
assert.match(edgeSource, /Ingresa un tipo de cambio .*\/CLP válido/);
assert.match(edgeSource, /route === "reconciliation\/confirm"/);
assert.match(edgeSource, /route === "reconciliation\/payroll"/);
assert.match(edgeSource, /route === "reconciliation\/exact-preview"/);
assert.match(edgeSource, /route === "reconciliation\/exact-confirm"/);
assert.match(edgeSource, /route === "ledger\/coverage"/);
assert.match(edgeSource, /route === "ledger\/prepare"/);
assert.match(edgeSource, /route === "ledger\/payroll-accruals"/);
assert.match(edgeSource, /route === "ledger\/verified-classifications"/);
assert.match(edgeSource, /route === "ledger\/facto-check-settlements"/);
assert.match(edgeSource, /route === "ledger\/facto-current-state"/);
assert.match(edgeSource, /representedSourceDocumentIds/);
assert.match(edgeSource, /accountedSourceDocumentIds/);
assert.match(edgeSource, /status: "posted"/);
assert.match(edgeSource, /physicalCheckBusinessKey/);
assert.match(edgeSource, /facto-check-receivable:/);
assert.match(edgeSource, /facto-check-opening:/);
assert.match(edgeSource, /sales_opening_receivable/);
assert.match(edgeSource, /no es venta del ejercicio 2026/);
assert.match(edgeSource, /bank-reconciliation:/);
assert.match(factoCheckSettlementMigration, /source_business_key/);
assert.match(factoCheckSettlementMigration, /accounting_reconciliation_check_target_uidx/);
assert.match(factoOutstandingSnapshotMigration, /accounting_apply_facto_outstanding_snapshot/);
assert.match(factoOutstandingSnapshotMigration, /No crea evidencia ni conciliaciones bancarias/);
assert.match(edgeSource, /bank-payroll-settlement:/);
assert.match(edgeSource, /bank-internal-transfer:/);
assert.match(edgeSource, /verified_payroll_description/);
assert.match(edgeSource, /exact_own_company_pair/);
assert.match(edgeSource, /ensureFactoWorkbookDocument/);
assert.match(edgeSource, /facto-workbook:/);
assert.match(edgeSource, /batch\.status === "imported"/);
assert.match(edgeSource, /bank-transaction:/);
assert.match(edgeSource, /bank-statement-balance:/);
assert.match(edgeSource, /suspense_liability/);
assert.match(edgeSource, /accountCode = source === "BANCO_ESTADO"/);
assert.match(bankRealityMigration, /bank_bancoestado_clp/);
assert.match(bankRealityMigration, /payroll_expense/);
assert.match(bankRealityMigration, /status='portfolio'/);
assert.doesNotMatch(bankRealityMigration, /status in \('portfolio','deposited'\)/);
assert.match(edgeSource, /Cache-Control.*no-store/s);
assert.match(sislaLoanMigration, /22000000/);
assert.match(sislaLoanMigration, /loan_repayment_sisla/);
assert.match(sislaLoanMigration, /classification_locked/);
assert.match(sislaLoanMigration, /related_party_loan_payable/);
assert.match(edgeSource, /profitabilityCertified: false/);
assert.match(edgeSource, /buildDashboardAnalytics/);
assert.match(edgeSource, /payroll_contributions_expense/);
assert.match(edgeSource, /expenseBreakdown/);
assert.match(edgeSource, /accounting_income_statement/);
assert.match(edgeSource, /salesWithExactCost/);
assert.match(edgeSource, /dashboard ledger detail unavailable/);
assert.match(edgeSource, /accounting_journal_lines\?select=account_id,debit_clp,credit_clp/);
assert.match(edgeSource, /Ventas recuperadas desde documentos Facto validados/);
assert.match(edgeSource, /basis,/);
assert.match(pageSource, /Alcance de la lectura/);
assert.match(edgeSource, /source_type,accounting_journal_lines/);
assert.match(edgeSource, /previouslyAllocated/);
assert.match(edgeSource, /saldo disponible del movimiento bancario/);
assert.match(edgeSource, /route === "checks\/create"/);
assert.match(edgeSource, /accounting_create_journal_entry/);
assert.match(edgeSource, /saldo_acumulado_clp/);
assert.match(parserSource, /banco_estado/);
assert.match(parserSource, /scotiabank/);
assert.match(parserSource, /mercado_pago/);
assert.match(parserSource, /fingerprint/);
assert.match(parserSource, /findBankTable\(workbook, \["movimientos", "registros"\]/);
assert.match(parserSource, /findBankTable\(workbook, \["data", "movimientos", "registros"\]/);
assert.match(parserSource, /findHeaderAliases/);
assert.match(parserSource, /"numero documento", "n operacion", "numero operacion"/);
assert.match(factoExcelParserSource, /facto_unpaid_documents/);
assert.match(factoExcelParserSource, /facto_checks_banco_estado/);
assert.match(factoExcelParserSource, /facto_cash_scotiabank/);
assert.match(factoExcelParserSource, /facto_cash_mercado_pago/);
assert.match(factoExcelParserSource, /nota de credito/);
assert.match(factoExcelParserSource, /includes\("extranjera"\)/);
assert.match(pageSource, /Balance de 8 columnas/);
assert.match(pageSource, /Estado de Resultados/);
assert.match(pageSource, /Flujo de Caja bancario/);
assert.match(pageSource, /Nueva cuenta/);
assert.match(pageSource, /Factura, pago, movimiento bancario, conciliación y asiento/);
assert.match(pageSource, /Carga histórica con respaldo/);
assert.match(pageSource, /2026-01-01/);
assert.match(pageSource, /Documentos pendientes \/ impagos/);
assert.match(pageSource, /Cheques Facto · flujo BancoEstado/);
assert.match(pageSource, /Importar cartola real/);
assert.match(pageSource, /Descargar cartola original/);
assert.match(pageSource, /accounting-bank-history/);
assert.match(pageSource, /Se conservará el monto original y se guardará su equivalente contable en CLP/);
assert.match(pageSource, /Usar propuesta/);
assert.match(pageSource, /Buscar en todos los documentos abiertos/);
assert.match(pageSource, /Asignar a sueldos/);
assert.match(pageSource, /Conciliar coincidencias exactas/);
assert.match(pageSource, /Preparar libro/);
assert.match(pageSource, /Rentabilidad todavía no certificada/);
assert.match(pageSource, /Posición y desempeño financiero/);
assert.match(pageSource, /Ventas, costos y resultado/);
assert.match(pageSource, /Cobertura del costo/);
assert.match(pageSource, /Sueldos y obligaciones previsionales/);
assert.match(pageSource, /PREVIRED \/ cotizaciones/);
assert.match(pageSource, /ya están incluidos una sola vez/);
assert.match(pageSource, /fallbackDashboard/);
assert.match(pageSource, /ReconciliationErrorBoundary/);
assert.match(pageSource, /No se pudo mostrar esta propuesta/);

const orderedMovements = filterAndSortReconciliationTransactions([
  {
    id: "movement-marco", bank_account_id: "bank", transaction_date: "2026-08-31", value_date: null,
    description: "TEF 15427713-7 Marco Emilio Sanhueza", reference: "5807565278", operation_number: null,
    debit: 153040, credit: 0, amount: -153040, balance: null, currency: "CLP", exchange_rate: 1,
    amount_clp: -153040, reconciliation_status: "unmatched", metadata: {},
  },
  {
    id: "movement-sisla", bank_account_id: "bank", transaction_date: "2026-07-29", value_date: null,
    description: "TEF 14186473-4 Sisla Muñoz", reference: "5807577526", operation_number: null,
    debit: 500000, credit: 0, amount: -500000, balance: null, currency: "CLP", exchange_rate: 1,
    amount_clp: -500000, reconciliation_status: "unmatched", metadata: {},
  },
], { query: "marco sanh", from: "2026-08-01", to: "2026-08-31", sort: "name-asc" });
assert.deepEqual(orderedMovements.map((movement) => movement.id), ["movement-marco"]);
assert.equal(filterAndSortReconciliationTransactions(orderedMovements, {
  query: "31/08/2026", from: "", to: "", sort: "date-desc",
}).length, 1);
assert.equal(identifyPayrollEmployeeInUi("TEF 15427713-7 Marco Emilio Sa")?.key, "marco");
assert.equal(matchingPostedPayrollDuplicate(orderedMovements[0], [{
  ...orderedMovements[0],
  id: "movement-marco-posted",
  reconciliation_status: "matched",
  metadata: { verified_classification: "salary_marco" },
}])?.id, "movement-marco-posted");
assert.equal(identifyPayrollEmployee("TEF 14186473-4 Sisla Munoz")?.key, "sisla");
assert.match(protectedPayrollClassification({
  classification_locked: true,
  verified_classification: "loan_repayment_sisla",
})?.message || "", /devolución de préstamo/i);

const searchedDocuments = reconciliationDocumentCandidates({
  proposalCandidates: [{
    targetType: "receivable",
    targetId: "marba",
    score: 0.26,
    confidence: "possible",
    suggestedAmount: 219527,
    evidence: ["Posible pago parcial"],
    dateDifferenceDays: 2,
    signals: { taxId: false, document: false, name: 0.2, date: true, amount: "partial" },
    candidate: {
      id: "marba", customer_name: "MARBA - Refrigeración, Aire Acondicionado SPA", customer_tax_id: "76.919.986-1",
      document_number: "1549", issued_on: "2026-08-24", due_on: null, original_amount_clp: 473207,
      paid_amount_clp: 0, balance_clp: 473207, reported_paid_amount_clp: null, reported_balance_clp: null,
      reported_at: null, reported_source_batch_id: null, status: "pending", currency: "CLP",
    },
  }],
  receivables: [{
    id: "acondiparts", customer_name: "Acondiparts Center SPA", customer_tax_id: "77.111.222-3",
    document_number: "1550", issued_on: "2026-08-28", due_on: null, original_amount_clp: 500000,
    paid_amount_clp: 0, balance_clp: 500000, reported_paid_amount_clp: null, reported_balance_clp: null,
    reported_at: null, reported_source_batch_id: null, status: "pending", currency: "CLP",
  }],
  payables: [],
  incoming: true,
  query: "acondi",
  remainingAmount: 219527,
  sort: "relevance",
});
assert.deepEqual(searchedDocuments.map((candidate) => candidate.targetId), ["acondiparts", "marba"]);
assert.equal(searchedDocuments[0].signals.amount, "partial");

const legacyProposal = normalizeAccountingReconciliationProposal({
  transaction: {
    id: "legacy-transaction",
    amount_clp: 500000,
    transaction_date: "2026-07-29",
    description: "TEF 15427713-7 MARCO SANHUEZA",
  },
  candidates: [{
    targetType: "receivable",
    targetId: "legacy-receivable",
    score: 0.82,
    confidence: "high",
    suggestedAmount: 300000,
    candidate: {
      id: "legacy-receivable",
      customer_name: "Cliente prueba",
      document_number: "1001",
      balance_clp: 300000,
    },
  }],
});
assert.equal(legacyProposal.remainingAmount, 500000);
assert.deepEqual(legacyProposal.candidates[0].evidence, []);
assert.equal(legacyProposal.candidates[0].signals.amount, "over");
assert.equal(legacyProposal.suggestedPlan, null);

const currentProposal = normalizeAccountingReconciliationProposal({
  transaction: {
    id: "current-transaction",
    amount_clp: -500000,
    transaction_date: "2026-07-29",
    description: "TEF proveedor",
  },
  candidates: [{
    targetType: "payable",
    targetId: "current-payable",
    score: 0.78,
    document: {
      targetId: "current-payable",
      counterpartyName: "Proveedor prueba",
      counterpartyTaxId: "76.123.456-7",
      raw: {
        id: "current-payable",
        document_number: "F-200",
        balance_clp: 604388,
      },
    },
  }],
});
assert.equal(currentProposal.candidates[0].candidate.id, "current-payable");
assert.equal(currentProposal.candidates[0].candidate.document_number, "F-200");
assert.equal(currentProposal.candidates[0].candidate.balance_clp, 604388);
assert.equal(currentProposal.candidates[0].candidate.supplier_name, "Proveedor prueba");
assert.equal(currentProposal.candidates[0].candidate.supplier_tax_id, "76.123.456-7");
assert.deepEqual(currentProposal.candidates[0].evidence, []);

const incompleteProposal = normalizeAccountingReconciliationProposal({
  transaction: { id: "incomplete-transaction", amount_clp: 1000 },
  candidates: [{ targetType: "receivable", targetId: "incomplete-receivable", candidate: {} }],
});
assert.equal(incompleteProposal.transaction.description, "Movimiento bancario sin descripción");
assert.equal(incompleteProposal.candidates[0].candidate.document_number, "Sin folio");
assert.equal(incompleteProposal.candidates[0].candidate.customer_name, "Cliente sin identificar");
assert.match(pageSource, /Permite pagos parciales, varias facturas por pago y varios abonos por factura/);

const bancoEstadoRange = bancoEstadoStatementRange([
  ["Fecha Inicio", "", "", "", "11/03/2026"],
  ["Fecha Final", "", "", "", "08/06/2026"],
]);
assert.deepEqual(bancoEstadoRange, { from: "2026-03-11", to: "2026-06-08", defaultYear: 2026 });
assert.equal(bankIsoDate("11/03", bancoEstadoRange), "2026-03-11");
assert.equal(bankIsoDate("08/06", bancoEstadoRange), "2026-06-08");
assert.equal(bankIsoDate("13/03", bancoEstadoRange), "2026-03-13");
assert.equal(bankMoney("$204.250"), 204250);
assert.equal(bankMoney("$5,000,000"), 5000000);
assert.equal(bankMoney("US$1,25"), 1.25);

const reconciliationTransaction = {
  amountClp: 1_500_000,
  transactionDate: "2026-07-29",
  description: "TEF 77724382-9 IMPORTADORA LATIN CHILE",
  reference: "Pago facturas",
  operationNumber: "580760089",
};
assert.deepEqual(extractChileanTaxIds(reconciliationTransaction.description), ["777243829"]);
const reconciliationDocuments = [
  {
    targetType: "receivable",
    targetId: "00000000-0000-4000-8000-000000000101",
    counterpartyName: "Importadora Latin Chile Limitada",
    counterpartyTaxId: "77.724.382-9",
    documentNumber: "F-100",
    issuedOn: "2026-07-01",
    dueOn: "2026-07-29",
    balanceClp: 1_000_000,
    raw: { id: "first" },
  },
  {
    targetType: "receivable",
    targetId: "00000000-0000-4000-8000-000000000102",
    counterpartyName: "Importadora Latin Chile Ltda",
    counterpartyTaxId: "77.724.382-9",
    documentNumber: "F-101",
    issuedOn: "2026-07-10",
    dueOn: "2026-08-10",
    balanceClp: 800_000,
    raw: { id: "second" },
  },
  {
    targetType: "receivable",
    targetId: "00000000-0000-4000-8000-000000000103",
    counterpartyName: "Cliente sin relación",
    counterpartyTaxId: "76.411.321-7",
    documentNumber: "F-999",
    issuedOn: "2026-07-29",
    dueOn: "2026-07-29",
    balanceClp: 1_500_000,
    raw: { id: "unrelated" },
  },
];
const rankedReconciliation = rankReconciliationCandidates(reconciliationTransaction, reconciliationDocuments, 1_500_000);
assert.equal(rankedReconciliation[0].signals.taxId, true);
assert.equal(rankedReconciliation[0].confidence, "high");
assert.ok(rankedReconciliation[0].evidence.includes("RUT exacto"));
const multiInvoicePlan = buildSuggestedAllocationPlan(rankedReconciliation, 1_500_000);
assert.ok(multiInvoicePlan);
assert.equal(multiInvoicePlan.links.length, 2);
assert.deepEqual(multiInvoicePlan.links.map((link) => link.amount), [1_000_000, 500_000]);

const partialRank = rankReconciliationCandidates(
  { ...reconciliationTransaction, amountClp: 300_000 },
  [reconciliationDocuments[0]],
  300_000,
);
assert.equal(partialRank[0].signals.amount, "partial");
assert.equal(partialRank[0].suggestedAmount, 300_000);
assert.ok(partialRank[0].evidence.includes("Posible pago parcial"));

const factoCurrentState = buildFactoCurrentStateAdjustment({
  currentReceivablesClp: 86_297_839,
  targetReceivablesClp: 13_643_913,
  currentPayablesClp: 31_121_939.19,
  targetPayablesClp: 12_707_744.19,
});
assert.equal(factoCurrentState.receivablesDelta, -72_653_926);
assert.equal(factoCurrentState.payablesDelta, -18_414_195);
assert.equal(factoCurrentState.lines.length, 4);
assert.equal(
  factoCurrentState.lines.reduce((sum, line) => sum + line.debit, 0),
  factoCurrentState.lines.reduce((sum, line) => sum + line.credit, 0),
);
assert.deepEqual(
  factoCurrentState.lines.map((line) => line.classification),
  ["suspense_asset", "receivables", "payables", "suspense_liability"],
);
const factoCurrentStateRestore = buildFactoCurrentStateAdjustment({
  currentReceivablesClp: 100,
  targetReceivablesClp: 250,
  currentPayablesClp: 100,
  targetPayablesClp: 175,
});
assert.deepEqual(
  factoCurrentStateRestore.lines.map((line) => line.classification),
  ["receivables", "suspense_asset", "suspense_liability", "payables"],
);

const exactRank = rankReconciliationCandidates(
  { ...reconciliationTransaction, amountClp: 1_000_000, reference: "F-100" },
  [reconciliationDocuments[0]],
  1_000_000,
);
assert.equal(exactRank[0].confidence, "exact");
assert.equal(exactRank[0].signals.document, true);
const exactSelection = selectUniqueExactReconciliation(exactRank, 1_000_000);
assert.ok(exactSelection);
assert.equal(exactSelection.candidate.targetId, reconciliationDocuments[0].targetId);
assert.match(exactSelection.reason, /coinciden exactamente/i);

const ambiguousExactRank = rankReconciliationCandidates(
  { ...reconciliationTransaction, amountClp: 1_000_000, reference: "F-100" },
  [reconciliationDocuments[0], { ...reconciliationDocuments[0], targetId: "00000000-0000-4000-8000-000000000104" }],
  1_000_000,
);
assert.equal(selectUniqueExactReconciliation(ambiguousExactRank, 1_000_000), null);
assert.equal(selectUniqueExactReconciliation(partialRank, 300_000), null);

const verifiedExactSelection = selectVerifiedExactAllocation(exactRank, 1_000_000);
assert.ok(verifiedExactSelection);
assert.deepEqual(verifiedExactSelection.links, [{
  targetType: "receivable",
  targetId: reconciliationDocuments[0].targetId,
  amount: 1_000_000,
}]);

const verifiedPartialSelection = selectVerifiedExactAllocation(partialRank, 300_000);
assert.ok(verifiedPartialSelection);
assert.deepEqual(verifiedPartialSelection.links, [{
  targetType: "receivable",
  targetId: reconciliationDocuments[0].targetId,
  amount: 300_000,
}]);
assert.match(verifiedPartialSelection.reason, /abono parcial verificable/i);

const ambiguousPartialRank = rankReconciliationCandidates(
  { ...reconciliationTransaction, amountClp: 300_000 },
  reconciliationDocuments.slice(0, 2),
  300_000,
);
assert.equal(selectVerifiedExactAllocation(ambiguousPartialRank, 300_000), null);

const multiExactRank = rankReconciliationCandidates(
  { ...reconciliationTransaction, amountClp: 1_800_000 },
  reconciliationDocuments.slice(0, 2),
  1_800_000,
);
const multiExactSelection = selectVerifiedExactAllocation(multiExactRank, 1_800_000);
assert.ok(multiExactSelection);
assert.deepEqual(multiExactSelection.links.map((link) => link.amount), [1_000_000, 800_000]);
assert.match(multiExactSelection.reason, /2 documentos abiertos/i);
assert.equal(selectVerifiedExactAllocation(multiExactRank, 1_700_000), null);

const nameOnlyPartialRank = rankReconciliationCandidates(
  {
    amountClp: 300_000,
    transactionDate: "2026-07-29",
    description: "Importadora Latin Chile Limitada",
    reference: "Pago cliente",
    operationNumber: "580760099",
  },
  [{ ...reconciliationDocuments[0], counterpartyTaxId: "" }],
  300_000,
);
assert.equal(selectVerifiedExactAllocation(nameOnlyPartialRank, 300_000), null);

const db = new PGlite();
const adminId = "00000000-0000-4000-8000-000000000001";

await db.exec(`
  create role authenticated;
  create role service_role;
  create role anon;
  create schema auth;
  create schema storage;
  create type public.app_role as enum ('administrador','vendedor','visualizador');

  create table auth.users (id uuid primary key);
  insert into auth.users(id) values ('${adminId}');

  create table public.profiles (
    id uuid primary key,
    full_name text not null default '',
    role public.app_role not null default 'visualizador',
    active boolean not null default true
  );
  insert into public.profiles(id, full_name, role)
  values ('${adminId}', 'Administración', 'administrador');

  create function auth.uid() returns uuid language sql stable as $$
    select '${adminId}'::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select 'service_role'::text
  $$;
  create function public.current_role() returns public.app_role language sql stable as $$
    select 'administrador'::public.app_role
  $$;

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null,
    name text not null
  );
  create table public.accounting_snapshots (id uuid primary key default gen_random_uuid());
`);

const transactionStart = migration.indexOf("begin;");
await db.exec(migration.slice(0, transactionStart));
await db.exec(migration.slice(transactionStart));
await db.exec(factoHistoryMigration);
await db.exec(factoExcelMigration);
await db.exec(factoCheckSettlementMigration);
await db.exec(factoOutstandingSnapshotMigration);
await db.exec(bankRealityMigration);

const entity = await db.query(`select id from public.accounting_entities where tax_id='77.724.382-9'`);
assert.equal(entity.rows.length, 1);
const entityId = entity.rows[0].id;

const syncRun = await db.query(`
  insert into public.accounting_facto_sync_runs(entity_id,from_date,to_date,status,requested_by)
  values ($1,'2026-01-01','2026-08-27','completed',$2)
  returning id
`, [entityId, adminId]);
assert.ok(syncRun.rows[0].id);
const syncRange = await db.query(`select to_char(from_date,'YYYY-MM-DD') from_date,to_char(to_date,'YYYY-MM-DD') to_date,status from public.accounting_facto_sync_runs where id=$1`, [syncRun.rows[0].id]);
assert.equal(syncRange.rows[0].from_date, "2026-01-01");
assert.equal(syncRange.rows[0].to_date, "2026-08-27");

const accounts = await db.query(`
  select id, code from public.accounting_accounts
  where entity_id=$1 and code in ('1.1.02','4.1.01') order by code
`, [entityId]);
assert.equal(accounts.rows.length, 2);
const bankId = accounts.rows.find((row) => row.code === "1.1.02").id;
const salesId = accounts.rows.find((row) => row.code === "4.1.01").id;

const sourceDocument = await db.query(`
  insert into public.accounting_source_documents(
    entity_id,source_type,source_key,document_type,folio,counterpart_name,issued_on,total_amount,total_clp
  ) values ($1,'FACTO','test:invoice:100','sales_invoice','100','Cliente prueba','2026-01-10',119000,119000)
  returning id
`, [entityId]);
const sourceDocumentId = sourceDocument.rows[0].id;
const receivable = await db.query(`
  insert into public.accounting_receivables(
    entity_id,source_document_id,customer_name,document_number,issued_on,original_amount,original_amount_clp
  ) values ($1,$2,'Cliente prueba','100','2026-01-10',119000,119000)
  returning id
`, [entityId, sourceDocumentId]);
const receivableId = receivable.rows[0].id;
const paymentBatch = await db.query(`
  insert into public.accounting_import_batches(
    entity_id,source_type,import_profile,status,file_name,file_hash,row_count,new_count,imported_by
  ) values ($1,'PAYMENTS','facto_cash','previewed','Movimiento de caja.xlsx','payment-hash',1,1,$2)
  returning id
`, [entityId, adminId]);
const paymentBatchId = paymentBatch.rows[0].id;
const paymentRow = await db.query(`
  insert into public.accounting_import_rows(batch_id,row_number,fingerprint,status,normalized_data)
  values ($1,2,'payment-fingerprint','imported','{"kind":"payment_event"}'::jsonb)
  returning id
`, [paymentBatchId]);
await db.query(`
  insert into public.accounting_payment_events(
    entity_id,source_document_id,receivable_id,import_batch_id,source_row_id,event_date,direction,
    amount_clp,signed_amount_clp,source_profile,fingerprint,matching_status
  ) values ($1,$2,$3,$4,$5,'2026-01-20','receipt',50000,50000,'facto_cash','payment-fingerprint','linked')
`, [entityId, sourceDocumentId, receivableId, paymentBatchId, paymentRow.rows[0].id]);
await assert.rejects(
  db.query(`
    insert into public.accounting_payment_events(
      entity_id,source_document_id,receivable_id,import_batch_id,source_row_id,event_date,direction,
      amount_clp,signed_amount_clp,source_profile,fingerprint
    ) values ($1,$2,$3,$4,$5,'2026-01-20','receipt',50000,50000,'facto_cash_scotiabank','payment-fingerprint')
  `, [entityId, sourceDocumentId, receivableId, paymentBatchId, paymentRow.rows[0].id]),
  /unique|duplicate/i,
);
await db.query(`
  update public.accounting_receivables
  set reported_paid_amount_clp=50000, reported_balance_clp=69000, reported_source_batch_id=$2
  where id=$1
`, [receivableId, paymentBatchId]);

const bancoEstado = await db.query(`
  insert into public.accounting_bank_accounts(
    entity_id,institution,account_name,account_number_masked,currency,ledger_account_id
  ) values ($1,'BancoEstado','Pendiente cartola Facto','Pendiente cartola Facto','CLP',$2)
  returning id
`, [entityId, bankId]);
const checkBatch = await db.query(`
  insert into public.accounting_import_batches(
    entity_id,source_type,import_profile,status,file_name,file_hash,row_count,new_count,imported_by
  ) values ($1,'CHECKS','facto_checks_banco_estado','imported','Listado_cheques.xlsx','check-hash',1,1,$2)
  returning id
`, [entityId, adminId]);
const checkRow = await db.query(`
  insert into public.accounting_import_rows(batch_id,row_number,fingerprint,status,normalized_data)
  values ($1,2,'check-fingerprint','imported','{"kind":"check"}'::jsonb)
  returning id
`, [checkBatch.rows[0].id]);
await db.query(`
  insert into public.accounting_checks(
    entity_id,receivable_id,customer_name,bank_name,check_number,amount_clp,received_on,due_on,
    import_batch_id,source_row_id,settlement_bank_account_id,source_status,metadata
  ) values ($1,$2,'Cliente prueba','Santander','12345',50000,'2026-01-20','2026-02-20',$3,$4,$5,'Inactivo',
    '{"expected_settlement_institution":"BancoEstado"}'::jsonb)
  returning id
`, [entityId, receivableId, checkBatch.rows[0].id, checkRow.rows[0].id, bancoEstado.rows[0].id]);
const expectedSettlement = await db.query(`
  select c.bank_name,b.institution,c.metadata->>'expected_settlement_institution' expected
  from public.accounting_checks c join public.accounting_bank_accounts b on b.id=c.settlement_bank_account_id
  where c.entity_id=$1
`, [entityId]);
assert.deepEqual(expectedSettlement.rows[0], { bank_name: "Santander", institution: "BancoEstado", expected: "BancoEstado" });

await db.query(`
  insert into public.accounting_checks(
    entity_id,customer_name,bank_name,check_number,amount_clp,received_on,due_on,
    source_business_key,facto_collected_on,source_status
  ) values
    ($1,'Cliente repetido','Santander','311',409360,'2026-03-01','2026-03-15','santander|311|2026-03-01|2026-03-15|111111111','2026-03-15','Inactivo'),
    ($1,'Cliente repetido','Santander','311',409360,'2026-04-01','2026-04-15','santander|311|2026-04-01|2026-04-15|111111111','2026-04-15','Inactivo')
`, [entityId]);
const repeatedChecks = await db.query(`select count(*)::int count from public.accounting_checks where entity_id=$1 and bank_name='Santander' and check_number='311'`, [entityId]);
assert.equal(repeatedChecks.rows[0].count, 2);
await assert.rejects(
  db.query(`
    insert into public.accounting_checks(
      entity_id,customer_name,bank_name,check_number,amount_clp,received_on,source_business_key
    ) values ($1,'Duplicado','Santander','311',409360,'2026-03-01','santander|311|2026-03-01|2026-03-15|111111111')
  `, [entityId]),
  /unique|duplicate/i,
);

const payload = {
  entity_id: entityId,
  entry_date: "2026-01-15",
  description: "Venta contable de prueba",
  reference: "TEST-001",
  currency: "CLP",
  exchange_rate: 1,
  status: "validated",
  lines: [
    { account_id: bankId, debit_clp: 119000, credit_clp: 0, description: "Ingreso banco" },
    { account_id: salesId, debit_clp: 0, credit_clp: 119000, description: "Venta" },
  ],
};

const created = await db.query(
  `select public.accounting_create_journal_entry($1::jsonb,$2::uuid) as id`,
  [JSON.stringify(payload), adminId],
);
const entryId = created.rows[0].id;
assert.ok(entryId);

await assert.rejects(
  db.query(
    `select public.accounting_create_journal_entry($1::jsonb,$2::uuid)`,
    [JSON.stringify({ ...payload, reference: "BAD", lines: [payload.lines[0], { ...payload.lines[1], credit_clp: 118999 }] }), adminId],
  ),
  /descuadrado/i,
);

await db.query(`select public.accounting_post_journal_entry($1::uuid)`, [entryId]);
const posted = await db.query(`select status from public.accounting_journal_entries where id=$1`, [entryId]);
assert.equal(posted.rows[0].status, "posted");

await assert.rejects(
  db.query(`update public.accounting_journal_entries set description='Alterado' where id=$1`, [entryId]),
  /inmutables/i,
);

const trial = await db.query(
  `select * from public.accounting_trial_balance($1::uuid,'2026-01-01','2026-01-31')`,
  [entityId],
);
assert.equal(Number(trial.rows.reduce((sum, row) => sum + Number(row.debits), 0)), 119000);
assert.equal(Number(trial.rows.reduce((sum, row) => sum + Number(row.credits), 0)), 119000);

const balance = await db.query(
  `select * from public.accounting_balance_eight_columns($1::uuid,'2026-01-01','2026-01-31')`,
  [entityId],
);
assert.ok(balance.rows.some((row) => row.code === "1.1.02"));
assert.ok(balance.rows.some((row) => row.code === "4.1.01"));

const income = await db.query(
  `select * from public.accounting_income_statement($1::uuid,'2026-01-01','2026-01-31')`,
  [entityId],
);
assert.equal(Number(income.rows.find((row) => row.code === "4.1.01").amount_clp), 119000);

const cashFlow = await db.query(
  `select * from public.accounting_cash_flow($1::uuid,'2026-01-01','2026-01-31')`,
  [entityId],
);
assert.equal(cashFlow.rows.length, 0);

const reversed = await db.query(
  `select public.accounting_reverse_journal_entry($1::uuid,'2026-01-20','Corrección controlada de prueba') as id`,
  [entryId],
);
assert.ok(reversed.rows[0].id);
const original = await db.query(`select status from public.accounting_journal_entries where id=$1`, [entryId]);
assert.equal(original.rows[0].status, "reversed");

const summary = await db.query(`select public.accounting_dashboard_summary($1::uuid,'2026-01-31') as value`, [entityId]);
assert.equal(summary.rows.length, 1);
assert.equal(Number(summary.rows[0].value.receivables), 69000);
assert.equal(Number(summary.rows[0].value.receivables_confirmed), 119000);
assert.equal(Number(summary.rows[0].value.payment_events_pending), 1);

const january = await db.query(`select id from public.accounting_periods where entity_id=$1 and starts_on='2026-01-01'`, [entityId]);
await db.query(`select public.accounting_close_period($1::uuid,'Cierre de prueba')`, [january.rows[0].id]);
await assert.rejects(
  db.query(
    `select public.accounting_create_journal_entry($1::jsonb,$2::uuid)`,
    [JSON.stringify({ ...payload, reference: "CLOSED" }), adminId],
  ),
  /período abierto/i,
);

console.log("Centro contable: migración, doble partida, inmutabilidad, reversa, balances y cierre verificados.");
