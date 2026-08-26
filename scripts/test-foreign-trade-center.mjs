import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  EMBEDDED_TEXT_INVOICE_PARSER_VERSION,
  EMBEDDED_TEXT_PACKING_LIST_PARSER_VERSION,
  FOREIGN_TRADE_AGENCY_SETTLEMENT_EXTRACTION_VERSION,
  FOREIGN_TRADE_EXTRACTION_VERSION,
  FOREIGN_TRADE_FUND_REQUEST_EXTRACTION_VERSION,
  FOREIGN_TRADE_FREIGHT_DOCUMENT_EXTRACTION_VERSION,
  buildExtractionRanges,
  mergeCompactVerification,
  mergeExtractionPasses,
  mergeUnnumberedRows,
  missingExtractionRanges,
  normalizeForeignTradeDocumentScope,
  parseEmbeddedTextInvoice,
  parseEmbeddedTextPackingList,
  prepareExtraction,
  prepareAgencySettlementExtraction,
  prepareFundRequestExtraction,
  prepareFreightDocumentExtraction,
} from "../supabase/functions/foreign-trade-documents/extraction-logic.ts";
import {
  FOREIGN_TRADE_PDF_SKILL_VERSION,
  assessPdfExtractionQuality,
  createForeignTradeDocumentScopePrompt,
  createForeignTradePdfReadingSkill,
} from "../supabase/functions/foreign-trade-documents/pdf-reading-skill.ts";
import { calculateForeignTradeCosting } from "../src/modules/foreign-trade/foreignTradeCostEngine.ts";
import { calculateForeignTradeReconciliation } from "../src/modules/foreign-trade/foreignTradeReconciliationEngine.ts";
import { normalizeForeignTradeFundRequestReview } from "../src/modules/foreign-trade/foreignTradeFundRequestReview.ts";
import {
  autoMatchForeignTradeAgencySettlementLines,
  calculateForeignTradeDocumentarySettlement,
  isAgencySettlementSummaryConcept,
  normalizeForeignTradeAgencySettlementReview,
} from "../src/modules/foreign-trade/foreignTradeAgencySettlementReview.ts";
import { normalizeForeignTradeFreightDocumentReview } from "../src/modules/foreign-trade/foreignTradeFreightDocumentReview.ts";
import { hydrateActualAmountsFromCosts } from "../src/modules/foreign-trade/foreignTradeReconciliationHydration.ts";
import {
  isAdCargasInternationales,
  isIncludedInForeignTradeAgencyReconciliation,
  resolveForeignTradeAgencyPaymentScope,
} from "../src/modules/foreign-trade/foreignTradeAgencyPaymentScope.ts";

const documentsPanelSource = await readFile(
  new URL("../src/modules/foreign-trade/ForeignTradeDocumentsPanel.tsx", import.meta.url),
  "utf8",
);
const documentsFunctionSource = await readFile(
  new URL("../supabase/functions/foreign-trade-documents/index.ts", import.meta.url),
  "utf8",
);
const foreignTradeApiSource = await readFile(
  new URL("../src/lib/foreignTradeApi.ts", import.meta.url),
  "utf8",
);
const foreignTradeCostingPanelSource = await readFile(
  new URL("../src/modules/foreign-trade/ForeignTradeCostingPanel.tsx", import.meta.url),
  "utf8",
);
const foreignTradeCostingExportSource = await readFile(
  new URL("../src/modules/foreign-trade/foreignTradeCostingExport.ts", import.meta.url),
  "utf8",
);
assert.match(foreignTradeCostingPanelSource, /Exportar Excel/);
assert.match(foreignTradeCostingPanelSource, /line_duty_percent: settings\.lineDutyPercent/);
assert.match(foreignTradeCostingPanelSource, /line_target_percent: settings\.lineTargetPercent/);
assert.match(foreignTradeCostingExportSource, /addWorksheet\("Resumen"/);
assert.match(foreignTradeCostingExportSource, /addWorksheet\("Productos"/);
assert.match(foreignTradeCostingExportSource, /addWorksheet\("Gastos"/);
assert.match(foreignTradeCostingExportSource, /result\.lines\.forEach/);
assert.match(foreignTradeApiSource, /cl_import_cost_v3_invoice_floor/);
assert.match(documentsPanelSource, /detectForeignTradeDocumentSection\(documentId\)/);
assert.match(documentsPanelSource, /Guardar y analizar/);
assert.match(documentsPanelSource, /await runExtraction\(documentId\)/);
assert.match(documentsFunctionSource, /route === "detect-section"/);
assert.match(documentsFunctionSource, /route === "set-section"/);
assert.match(documentsFunctionSource, /stored section reused/);
assert.match(documentsFunctionSource, /manual_admin_review/);
assert.match(documentsFunctionSource, /createScopedPdfData\(bytes, documentScope\.page_numbers/);
assert.match(documentsFunctionSource, /extractLineRangeSafely\(lineCommon/);
assert.match(documentsFunctionSource, /preferredStoredDocumentScope\(document, documentType\)/);
assert.match(documentsFunctionSource, /SECCION YA RECONOCIDA Y VALIDADA/);
assert.match(documentsPanelSource, /cancelForeignTradeDocumentExtraction\(documentId\)/);
assert.match(documentsPanelSource, /30_000/);
assert.match(documentsFunctionSource, /queueDocumentExtraction/);
assert.match(documentsFunctionSource, /queueDocumentExtraction\(rest, documentId, requestId\), 202/);
assert.match(documentsFunctionSource, /runtime\.waitUntil\(task\)/);
assert.match(documentsFunctionSource, /extractEmbeddedTextInvoiceSafely/);
assert.match(documentsFunctionSource, /npm:unpdf@1\.8\.1/);
assert.match(documentsFunctionSource, /embedded text invoice extraction ready/);
assert.match(documentsFunctionSource, /const embeddedInvoiceResult =/);
assert.match(documentsFunctionSource, /skippedOpenAi: true/);
assert.doesNotMatch(documentsFunctionSource, /embedded-text-invoice-parser\.ts/);
assert.match(documentsFunctionSource, /status: "extracting"/);
assert.match(documentsFunctionSource, /extraction accepted for background processing/);
assert.match(documentsPanelSource, /análisis iniciado\(s\) en segundo plano/);
assert.match(documentsFunctionSource, /OPENAI_INLINE_FILE_MAX_BYTES/);
assert.match(documentsFunctionSource, /https:\/\/api\.openai\.com\/v1\/files/);
assert.match(documentsFunctionSource, /file_id: input\.fileId/);
assert.match(documentsFunctionSource, /sharedOpenAiFile: Boolean\(temporaryFileId\)/);
assert.match(documentsFunctionSource, /analysisBytes: analysisBytes\.byteLength/);
assert.match(documentsFunctionSource, /patchRowsReturning\(rest, query, update\)/);
assert.match(documentsFunctionSource, /foreign_trade_document_request_stale_or_unavailable/);
assert.match(documentsFunctionSource, /transient OpenAI error, retrying/);
assert.match(documentsFunctionSource, /waitForOpenAiFileReady/);
assert.doesNotMatch(documentsFunctionSource, /type: "input_file"[^\n]+detail:/);
assert.match(documentsPanelSource, /staleExtractionTimeoutMs = 5 \* 60_000/);
assert.match(documentsPanelSource, /Se recuperó un análisis interrumpido por el servidor/);
assert.match(foreignTradeApiSource, /new Upload\(file/);
assert.match(foreignTradeApiSource, /upload\/resumable/);
assert.match(foreignTradeApiSource, /50 \* 1024 \* 1024/);
assert.match(foreignTradeApiSource, /onProgress: \(bytesUploaded, bytesTotal\)/);
assert.match(foreignTradeApiSource, /foreign_trade_storage_limit_not_updated/);
assert.match(documentsPanelSource, /Supabase todavía conserva el límite anterior de Storage/);
assert.match(foreignTradeApiSource, /normalizeSupabaseResumableUploadUrl/);
assert.match(foreignTradeApiSource, /candidate\.host = publicStorageUrl\.host/);
assert.match(foreignTradeApiSource, /uploadDataDuringCreation: false/);
assert.match(foreignTradeApiSource, /storeFingerprintForResuming: false/);
assert.match(foreignTradeApiSource, /apikey: credentials\.anonKey/);
assert.match(foreignTradeApiSource, /uploadForeignTradeOriginalCompatible/);
assert.match(foreignTradeApiSource, /new XMLHttpRequest\(\)/);
assert.match(foreignTradeApiSource, /foreign_trade_resumable_upload_stalled/);
assert.match(documentsPanelSource, /activeUploadController\.current\?\.abort\(\)/);
assert.match(foreignTradeApiSource, /foreign_trade_resumable_endpoint_unreachable/);
assert.match(documentsPanelSource, /No se pudo abrir la ruta pública para cargar el archivo/);
assert.match(documentsPanelSource, /setForeignTradeDocumentSection\(document\.id, pageNumbers\)/);
assert.match(documentsPanelSource, /Páginas<\/button>/);
assert.match(documentsPanelSource, /Confirmar y completar empaque/);
assert.match(documentsFunctionSource, /callEmbeddedTextPackingListExtraction/);
assert.match(foreignTradeApiSource, /confirm_foreign_trade_packing_list_document/);
assert.match(foreignTradeApiSource, /confirm_foreign_trade_document_with_reconciliation/);
assert.match(foreignTradeApiSource, /confirm_foreign_trade_document/);
assert.match(foreignTradeApiSource, /isMissingForeignTradeRpc/);

assert.equal(EMBEDDED_TEXT_INVOICE_PARSER_VERSION, "embedded_invoice_text_v2");
assert.equal(EMBEDDED_TEXT_PACKING_LIST_PARSER_VERSION, "embedded_packing_list_text_v1");
const embeddedInvoice = parseEmbeddedTextInvoice([
  [
    "INVOICE HZ26CF296",
    "HANGZHOU LIFENG IMPORT AND EXPORT CO.,LTD",
    "DATE 29-Apr-26",
    "Contract NO TDC12",
    "FROM NINGBO, CHINA TO: SAN ANTONIO, CHILE",
    "39 Capacitor 80 440V 100 pcs $1.8000 $180.00",
    "41 Thermostat Guards BTG-RK 100 pcs $2.1800 $218.00",
    "64 Split A/C valve 1/2 3Way 30 pcs $4.1000 $123.00",
    "64 Flare tube 1/2, R410 50 pcs $5.9700 $298.50",
    "85 Universal A/C Remote Control INVERTER SPLIT 6000 TO",
    "18000BTU 5 pcs $51.0000 $255.00",
    "100 Window exhaust tube 130mm kit: 130mm dia.x1.5m tube,",
    "connector, 2 seal plates 50 pcs $8.9000 $445.00",
    "TOTAL $1,519.50",
  ].join("\n"),
], [7]);
assert.equal(embeddedInvoice.lines.length, 6);
assert.equal(embeddedInvoice.candidateCount, 6);
assert.equal(embeddedInvoice.coverage, 1);
assert.equal(embeddedInvoice.lines[0].source_index, 1);
assert.equal(embeddedInvoice.lines[0].source_page, 7);
assert.equal(embeddedInvoice.lines[1].source_row_label, "41");
assert.equal(embeddedInvoice.lines[3].source_row_label, "64");
assert.equal(embeddedInvoice.lines[4].product_name, "Universal A/C Remote Control INVERTER SPLIT 6000 TO 18000BTU");
assert.equal(embeddedInvoice.lines[5].quantity, 50);
assert.equal(embeddedInvoice.lineTotal, 1519.5);
assert.equal(embeddedInvoice.general.proforma_number, "HZ26CF296");
assert.equal(embeddedInvoice.general.document_date, "2026-04-29");
assert.equal(embeddedInvoice.general.currency, "USD");
assert.equal(embeddedInvoice.general.order_number, "TDC12");
assert.equal(embeddedInvoice.pageNumbers[0], 7);
assert.match(embeddedInvoice.warnings.join(" "), /repitió los números de fila 64/);
assert.match(embeddedInvoice.warnings.join(" "), /omitió los números de fila 40/);

const embeddedPackingList = parseEmbeddedTextPackingList([[
  "PACKING LIST HZ26CF296",
  "DATE 29-Apr-26 Contract NO TDC12 CONT NO. MSKU3215219 SEAL NO. ML-CN6387245",
  "1 BRAND SUPER STARS ST-2BMC 20 pcs 2 CTNS 0.400 CBM 50 KGS 48 KGS",
  "2 BRAND SUPER STARS ST-302 3/8 5 pcs",
  "3 BRAND SUPER STARS ST-302 1/2 5 pcs 1 CTNS 0.100 CBM 12 KGS 10 KGS",
  "540 CTNS 25.00 CBM 6111.00 KGS 5976 KGS",
].join("\n")], [8]);
assert.equal(embeddedPackingList.lines.length, 3);
assert.equal(embeddedPackingList.coverage, 1);
assert.equal(embeddedPackingList.lines[0].box_count, 2);
assert.equal(embeddedPackingList.lines[0].cbm_total, 0.4);
assert.equal(embeddedPackingList.lines[0].quantity_per_box, 10);
assert.equal(embeddedPackingList.lines[1].box_count, null);
assert.equal(embeddedPackingList.lines[2].model, "ST-302");
assert.equal(embeddedPackingList.documentTotals.boxes, 540);
assert.equal(embeddedPackingList.documentTotals.cbm_total, 25);
assert.equal(embeddedPackingList.documentTotals.gross_weight_kg, 6111);
assert.equal(embeddedPackingList.documentTotals.net_weight_kg, 5976);
assert.equal(embeddedPackingList.general.order_number, "TDC12");
assert.match(embeddedPackingList.warnings.join(" "), /compartir cajas/);

const db = new PGlite();
const adminId = "00000000-0000-4000-8000-000000000001";

await db.exec(`
  create role authenticated;
  create role service_role;
  create role anon;
  create schema if not exists auth;
  create schema if not exists storage;
  create type public.app_role as enum ('administrador','vendedor','visualizador');

  create table auth.users (id uuid primary key);
  insert into auth.users(id) values ('${adminId}');

  create table public.profiles (
    id uuid primary key,
    full_name text not null default '',
    role public.app_role not null default 'visualizador',
    active boolean not null default true
  );
  insert into public.profiles(id,full_name,role)
  values ('${adminId}','Administrador de prueba','administrador');

  create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('app.test_user_id', true), '')::uuid,
      '${adminId}'::uuid
    )
  $$;
  create or replace function public.current_role() returns public.app_role language sql stable as $$
    select coalesce(
      nullif(current_setting('app.test_role', true), ''),
      'administrador'
    )::public.app_role
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('app.test_auth_role', true), ''), 'authenticated')
  $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$
  begin
    new.updated_at = now();
    return new;
  end
  $$;

  create table public.content_products (
    id uuid primary key default gen_random_uuid(),
    source_provider text not null default 'tiendanube',
    external_id text not null unique,
    sku text,
    name text not null,
    description_text text,
    category text,
    brand text,
    price numeric(14,2),
    stock integer,
    source_status text not null default 'active',
    sync_status text not null default 'synced',
    primary_image_url text,
    last_synced_at timestamptz not null default now()
  );

  create table public.suppliers (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    country_code text not null default 'CN',
    factory_city text,
    default_production_days integer not null default 45,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.supplier_products (
    id uuid primary key default gen_random_uuid(),
    supplier_id uuid not null references public.suppliers(id),
    sku text not null,
    supplier_sku text,
    unit_cost_usd numeric(14,4) not null default 0,
    minimum_order_qty numeric(14,2) not null default 0,
    production_days integer,
    active boolean not null default true,
    unique(supplier_id,sku)
  );
  create table public.import_shipments (
    id uuid primary key default gen_random_uuid(),
    supplier_id uuid references public.suppliers(id),
    reference text not null unique,
    transport_type text not null default 'sea',
    origin_port text,
    destination_port text,
    order_date date,
    production_ready_date date,
    estimated_departure date,
    estimated_arrival date,
    customs_release_date date,
    warehouse_receipt_date date,
    status text not null default 'planned'
      check (status in ('planned','production','ready','in_transit','customs','received','delayed','cancelled')),
    value_usd numeric(14,2) not null default 0,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.shipment_milestones (
    id uuid primary key default gen_random_uuid(),
    shipment_id uuid not null references public.import_shipments(id) on delete cascade,
    milestone text not null,
    expected_at timestamptz,
    occurred_at timestamptz,
    status text not null default 'pending',
    evidence jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create table public.demand_forecasts (
    id uuid primary key default gen_random_uuid(),
    sku text not null,
    expected_units numeric(14,2) not null default 0
  );
  create table public.replenishment_recommendations (
    id uuid primary key default gen_random_uuid(),
    sku text not null,
    recommended_units numeric(14,2) not null default 0
  );
  create table public.inventory_risk_alerts (
    id uuid primary key default gen_random_uuid(),
    sku text not null,
    severity text not null default 'medium'
  );

  create table public.business_agent_tasks (
    id uuid primary key default gen_random_uuid(),
    agent_type text not null,
    action text not null,
    payload jsonb not null default '{}'::jsonb,
    status text not null default 'pending',
    requested_by uuid references auth.users(id),
    result jsonb,
    created_at timestamptz not null default now()
  );
  create table public.agent_task_events (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.business_agent_tasks(id) on delete cascade,
    level text not null default 'info',
    stage text not null,
    message text not null,
    created_at timestamptz not null default now()
  );
  create table public.action_proposals (
    id uuid primary key default gen_random_uuid(),
    task_id uuid references public.business_agent_tasks(id) on delete set null,
    kind text not null,
    title text not null,
    summary text not null
  );
  create table public.foreign_trade_purchase_drafts (
    id uuid primary key default gen_random_uuid(),
    proposal_id uuid not null unique references public.action_proposals(id) on delete cascade,
    supplier text not null default 'Chinafore',
    title text not null,
    suggested_snapshot jsonb not null default '{}'::jsonb,
    status text not null default 'approved_for_preparation'
  );
  create table public.business_settings (
    key text primary key,
    value jsonb not null,
    description text
  );
  create table public.foreign_trade_actual_orders (
    id uuid primary key default gen_random_uuid(),
    file_name text not null default 'orden.pdf'
  );

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id),
    name text not null
  );

  alter table public.business_agent_tasks enable row level security;
  alter table public.agent_task_events enable row level security;
  alter table public.action_proposals enable row level security;
  alter table public.foreign_trade_purchase_drafts enable row level security;
  alter table public.business_settings enable row level security;
  alter table public.foreign_trade_actual_orders enable row level security;
  alter table storage.objects enable row level security;

  grant usage on schema public, auth, storage to authenticated, service_role, anon;
`);

const migration = (await readFile(
  new URL("../supabase/foreign_trade_center.sql", import.meta.url),
  "utf8",
)).replace(/create extension if not exists pgcrypto;/i, "");

await db.exec(migration);
await db.exec(migration);

const phase2Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase2.sql", import.meta.url),
  "utf8",
);
await db.exec(phase2Migration);
await db.exec(phase2Migration);

const phase3Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase3.sql", import.meta.url),
  "utf8",
);
await db.exec(phase3Migration);
await db.exec(phase3Migration);

const phase4Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase4_costing.sql", import.meta.url),
  "utf8",
);
await db.exec(phase4Migration);
await db.exec(phase4Migration);

const phase5Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase5_reconciliation.sql", import.meta.url),
  "utf8",
);
await db.exec(phase5Migration);
await db.exec(phase5Migration);

const phase6Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase6_fund_requests.sql", import.meta.url),
  "utf8",
);
await db.exec(phase6Migration);
await db.exec(phase6Migration);

const phase7Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase7_agency_settlements.sql", import.meta.url),
  "utf8",
);
await db.exec(phase7Migration);
await db.exec(phase7Migration);

const phase8Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase8_automatic_reconciliation.sql", import.meta.url),
  "utf8",
);
await db.exec(phase8Migration);
await db.exec(phase8Migration);

const phase9Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase9_freight_documents.sql", import.meta.url),
  "utf8",
);
await db.exec(phase9Migration);
await db.exec(phase9Migration);

const phase10Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase10_product_reconciliation.sql", import.meta.url),
  "utf8",
);
await db.exec(phase10Migration);
await db.exec(phase10Migration);

const phase11Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase11_intelligent_normalization.sql", import.meta.url),
  "utf8",
);
await db.exec(phase11Migration);
await db.exec(phase11Migration);

const phase12Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase12_large_documents.sql", import.meta.url),
  "utf8",
);
await db.exec(phase12Migration);
await db.exec(phase12Migration);

const phase13Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase13_packing_list_enrichment.sql", import.meta.url),
  "utf8",
);
assert.match(phase13Migration, /create or replace function public\.normalize_foreign_trade_product_text\(p_value text\)/i);
assert.match(phase13Migration, /create or replace function public\.normalize_foreign_trade_product_code\(p_value text\)/i);
await db.exec(phase13Migration);
await db.exec(phase13Migration);

const phase14Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase14_direct_supplier_payments.sql", import.meta.url),
  "utf8",
);
assert.match(phase14Migration, /foreign_trade_is_agency_reconciliation_line/i);
assert.match(phase14Migration, /direct_supplier_total_clp/i);
await db.exec(phase14Migration);
await db.exec(phase14Migration);

const phase15Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase15_documentary_settlement_control.sql", import.meta.url),
  "utf8",
);
assert.match(phase15Migration, /foreign_trade_is_reconciliation_summary_line/i);
assert.match(phase15Migration, /documentary_summary_version/i);
assert.match(phase15Migration, /documentary_refund_due_clp/i);
assert.match(phase15Migration, /metadata->>'documentary_summary_amount_clp'/i, "las reaplicaciones deben conservar el monto informativo original");
await db.exec(phase15Migration);
await db.exec(phase15Migration);

const phase16Migration = await readFile(
  new URL("../supabase/foreign_trade_center_phase16_cif_allocation.sql", import.meta.url),
  "utf8",
);
assert.match(phase16Migration, /cif_value/i);
assert.match(phase16Migration, /save_foreign_trade_costing_scenario/i);
await db.exec(phase16Migration);
await db.exec(phase16Migration);

const hydratedInvoiceAmounts = hydrateActualAmountsFromCosts({
  id: "00000000-0000-4000-8000-000000000101",
  applied_cost_line_id: "00000000-0000-4000-8000-000000000102",
  actual_net_clp: 0,
  actual_vat_clp: 0,
  actual_total_clp: 0,
  actual_amount_original: 0,
  actual_currency: "CLP",
  actual_exchange_rate_clp: 1,
}, [{
  id: "00000000-0000-4000-8000-000000000102",
  amount_original: 329.09,
  currency: "USD",
  exchange_rate_clp: 970,
  amount_clp: 319217.3,
  metadata: {
    amount_basis: "net",
    vat_amount_clp: 0,
    gross_amount_clp: 319217.3,
    source_original_amount: 329.09,
    source_currency: "USD",
    source_exchange_rate_clp: 970,
  },
}]);
assert.deepEqual(hydratedInvoiceAmounts, {
  netClp: 319217.3,
  vatClp: 0,
  totalClp: 319217.3,
  amountOriginal: 329.09,
  currency: "USD",
  exchangeRateClp: 970,
  sourceCostLineId: "00000000-0000-4000-8000-000000000102",
});

const preservedInvoiceAmounts = hydrateActualAmountsFromCosts({
  id: "00000000-0000-4000-8000-000000000103",
  applied_cost_line_id: "00000000-0000-4000-8000-000000000102",
  actual_net_clp: 100,
  actual_vat_clp: 19,
  actual_total_clp: 119,
  actual_amount_original: 119,
  actual_currency: "CLP",
  actual_exchange_rate_clp: 1,
}, []);
assert.equal(preservedInvoiceAmounts.totalClp, 119, "los valores explícitos nunca deben reemplazarse con una inferencia");

const preservedInformationalSummary = hydrateActualAmountsFromCosts({
  id: "00000000-0000-4000-8000-000000000104",
  concept: "Honorarios (parte de Factura Agencia)",
  metadata: { informational_summary: true, excluded_from_costing: true },
  applied_cost_line_id: "00000000-0000-4000-8000-000000000102",
  actual_net_clp: 0,
  actual_vat_clp: 0,
  actual_total_clp: 0,
  actual_amount_original: 0,
  actual_currency: "CLP",
  actual_exchange_rate_clp: 1,
}, [{
  id: "00000000-0000-4000-8000-000000000102",
  amount_original: 197659,
  currency: "CLP",
  exchange_rate_clp: 1,
  amount_clp: 197659,
  metadata: { gross_amount_clp: 197659 },
}]);
assert.equal(preservedInformationalSummary.totalClp, 0, "un subtotal documental no debe revivir desde una línea de costo histórica");

const provisionLinesForMatching = [
  { id: "gate", concept: "GATE-IN", document_number: null, line_type: "operating_expense", cost_category: "chile_port", provision_total_clp: 304002 },
  { id: "insurance", concept: "SEGURO CARGA", document_number: null, line_type: "operating_expense", cost_category: "insurance", provision_total_clp: 215000 },
  { id: "freight", concept: "FLETE", document_number: null, line_type: "operating_expense", cost_category: "national_transport", provision_total_clp: 571200 },
];
const settlementLinesForMatching = [
  { source_index: 1, concept: "GATE IN - MAERSK LOGISTICS & SERVICES CHILE SPA", reconciliation_line_id: null, line_type: "operating_expense", cost_category: "national_transport", document_number: "1592828", actual_total_clp: 178500, actual_net_clp: 150000, actual_vat_clp: 28500, amount_original: 178500, currency: "CLP", exchange_rate_clp: 1 },
  { source_index: 2, concept: "SERVICIO DE TRANSPORTES - TRASLADO DE CONTENEDOR FULL 1X20", reconciliation_line_id: null, line_type: "operating_expense", cost_category: "national_transport", document_number: "2264", actual_total_clp: 571200, actual_net_clp: 480000, actual_vat_clp: 91200, amount_original: 571200, currency: "CLP", exchange_rate_clp: 1 },
  { source_index: 3, concept: "ASESORIAS EN SEGUROS DE TRANSPORTE INTERNACIONAL", reconciliation_line_id: null, line_type: "agency_fee", cost_category: "other", document_number: "18122", actual_total_clp: 192530, actual_net_clp: 192530, actual_vat_clp: 0, amount_original: 211.8, currency: "USD", exchange_rate_clp: null },
];
const matchedSettlementLines = autoMatchForeignTradeAgencySettlementLines(settlementLinesForMatching, provisionLinesForMatching);
assert.deepEqual(matchedSettlementLines.map((line) => line.reconciliation_line_id), ["gate", "freight", "insurance"]);
assert.equal(isAgencySettlementSummaryConcept("Total Desembolsos"), true);
assert.equal(isAgencySettlementSummaryConcept("TOTAL FACTURA AGENCIA"), true);
assert.equal(isAgencySettlementSummaryConcept("Total Derechos Aduana"), true);
assert.equal(isAgencySettlementSummaryConcept("Honorarios (parte de Factura Agencia)"), true);
assert.equal(isAgencySettlementSummaryConcept("Remesa"), true);
assert.equal(isAgencySettlementSummaryConcept("Pago Directo"), true);
assert.equal(isAgencySettlementSummaryConcept("TOTAL A SU FAVOR"), true);
const normalizedSettlementSummary = normalizeForeignTradeAgencySettlementReview({
  extraction_version: "agency_settlement_v1",
  document_kind: "agency_settlement",
  general: {},
  totals: {},
  lines: [{ source_index: 1, concept: "Total Desembolsos", include: true, actual_total_clp: 1054711 }],
  warnings: [],
});
assert.equal(normalizedSettlementSummary.review.lines[0].include, false, "los subtotales no deben duplicar gastos reales");
assert.equal(normalizedSettlementSummary.review.lines[0].include_in_costing, false);
const normalizedAgencyInvoiceComponent = normalizeForeignTradeAgencySettlementReview({
  extraction_version: "agency_settlement_v2_documentary_summary",
  document_kind: "agency_settlement",
  general: {},
  totals: {},
  lines: [{
    source_index: 1,
    concept: "Honorarios (parte de Factura Agencia)",
    include: true,
    actual_total_clp: 197659,
  }],
  warnings: [],
});
assert.equal(normalizedAgencyInvoiceComponent.review.lines[0].include, false, "un componente ya incluido en la factura de agencia debe quedar informativo");
assert.equal(normalizedAgencyInvoiceComponent.review.lines[0].include_in_costing, false);
const invoice25868Summary = prepareAgencySettlementExtraction({
  general: {
    reference: "51082",
    agency_name: "JORGE ARMANDO RODRIGUEZ PALMA",
    invoice_number: "25868",
    document_date: "2026-06-23",
    currency: "CLP",
    declared_total_clp: 11265545,
    confidence: 0.99,
    warnings: [],
  },
  lines: [
    { source_index: 1, source_page: 1, include: true, line_type: "agency_fee", cost_category: "customs_agency", concept: "Total Factura Agencia", actual_total_clp: 319467, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
    { source_index: 9, source_page: 1, include: true, line_type: "agency_fee", cost_category: "customs_agency", concept: "Gasto despacho", actual_net_clp: 40801, actual_vat_clp: 7752, actual_total_clp: 48553, currency: "CLP", include_in_costing: true, recoverable_tax: true, confidence: 0.99, warnings: [] },
    { source_index: 10, source_page: 1, include: true, line_type: "agency_fee", cost_category: "customs_agency", concept: "Movilización puerto", actual_net_clp: 30000, actual_vat_clp: 5700, actual_total_clp: 35700, currency: "CLP", include_in_costing: true, recoverable_tax: true, confidence: 0.99, warnings: [] },
    { source_index: 11, source_page: 1, include: true, line_type: "agency_fee", cost_category: "customs_agency", concept: "Honorarios agencia", actual_net_clp: 197659, actual_vat_clp: 37555, actual_total_clp: 235214, currency: "CLP", include_in_costing: true, recoverable_tax: true, confidence: 0.99, warnings: [] },
    { source_index: 2, source_page: 1, include: true, line_type: "customs_duty", cost_category: "duties", concept: "Derechos ad valorem", actual_total_clp: 422198, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
    { source_index: 3, source_page: 1, include: true, line_type: "import_vat", cost_category: "taxes", concept: "IVA importación", actual_total_clp: 9469169, currency: "CLP", include_in_costing: false, recoverable_tax: true, confidence: 0.99, warnings: [] },
    { source_index: 4, source_page: 1, include: true, line_type: "operating_expense", cost_category: "chile_port", concept: "Columbus Maersk Chile", actual_total_clp: 80263, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
    { source_index: 5, source_page: 1, include: true, line_type: "operating_expense", cost_category: "chile_port", concept: "Maersk Logistics & Services Chile", actual_total_clp: 178500, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
    { source_index: 6, source_page: 1, include: true, line_type: "operating_expense", cost_category: "chile_port", concept: "STI", actual_total_clp: 32218, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
    { source_index: 7, source_page: 1, include: true, line_type: "operating_expense", cost_category: "national_transport", concept: "Transportes Judith Duran Luna", actual_total_clp: 571200, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
    { source_index: 8, source_page: 1, include: true, line_type: "operating_expense", cost_category: "insurance", concept: "Equal Servicios Profesionales", actual_total_clp: 192530, currency: "CLP", include_in_costing: true, recoverable_tax: false, confidence: 0.99, warnings: [] },
  ],
  totals: {
    expenses_clp: 1374178,
    taxes_clp: 9891367,
    agency_invoice_total_clp: 319467,
    disbursements_total_clp: 1054711,
    customs_total_clp: 9891367,
    document_total_clp: 11265545,
    remittance_clp: 11301000,
    documentary_direct_payment_clp: 0,
    refund_due_clp: 35455,
    line_count: 11,
  },
  warnings: [],
});
const invoice25868Documentary = calculateForeignTradeDocumentarySettlement(invoice25868Summary.extraction.totals);
assert.equal(invoice25868Summary.extraction.lines[0].include, false, "el total de agencia no debe duplicar sus conceptos detallados");
assert.equal(invoice25868Documentary.componentsTotalClp, 11265545);
assert.equal(invoice25868Documentary.calculatedRefundDueClp, 35455);
assert.equal(invoice25868Documentary.isDocumentBalanced, true);
assert.equal(invoice25868Documentary.isRefundBalanced, true);
const reconciliationWithoutDuplicatedSubtotal = calculateForeignTradeReconciliation(0, 0, [
  { concept: "Servicio CAM", line_type: "operating_expense", provision_total_clp: 0, actual_net_clp: 100, actual_vat_clp: 19, actual_total_clp: 119 },
  { concept: "Total Desembolsos", line_type: "operating_expense", provision_total_clp: 0, actual_net_clp: 0, actual_vat_clp: 0, actual_total_clp: 119 },
  { concept: "Honorarios (parte de Factura Agencia)", line_type: "agency_fee", provision_total_clp: 0, actual_net_clp: 0, actual_vat_clp: 0, actual_total_clp: 197659 },
]);
assert.equal(reconciliationWithoutDuplicatedSubtotal.actualExpensesClp, 119, "los subtotales históricos tampoco deben inflar la rendición");
assert.equal(isAdCargasInternationales("ADS INTERNACIONAL CARGO SPA"), true);
assert.equal(isAdCargasInternationales("AD Cargas Internacionales"), true);
assert.equal(resolveForeignTradeAgencyPaymentScope({ provider_name: "ADS" }), "direct_supplier");
assert.equal(resolveForeignTradeAgencyPaymentScope({
  provider_name: "ADS INTERNACIONAL CARGO SPA",
  metadata: {
    payment_scope: "agency",
    exclude_from_agency_reconciliation: true,
  },
}), "direct_supplier", "la exclusión explícita debe prevalecer ante metadatos históricos contradictorios");
assert.equal(isIncludedInForeignTradeAgencyReconciliation({ provider_name: "Agencia de Aduanas" }), true);
const directSupplierReconciliation = calculateForeignTradeReconciliation(1_000_000, 0, [
  { concept: "Honorarios", provider_name: "Agencia de Aduanas", line_type: "agency_fee", provision_total_clp: 119000, actual_net_clp: 100000, actual_vat_clp: 19000, actual_total_clp: 119000 },
  { concept: "Flete marítimo", provider_name: "ADS INTERNACIONAL CARGO SPA", line_type: "operating_expense", provision_total_clp: 0, actual_net_clp: 4690000, actual_vat_clp: 0, actual_total_clp: 4690000 },
]);
assert.equal(directSupplierReconciliation.actualExpensesClp, 119000, "el pago directo no debe inflar la rendición de la agencia");
assert.equal(directSupplierReconciliation.refundDueClp, 881000, "el saldo usa solo importes rendidos por la agencia");

const freightExtraction = prepareFreightDocumentExtraction({
  general: {
    reference: "ROECHN25062759",
    carrier_name: "ADS INTERNACIONAL CARGO SPA",
    document_number: "979",
    document_date: "2025-07-31",
    currency: "USD",
    declared_total_clp: 4690000,
    origin_port: "Shanghai, China",
    destination_port: "San Antonio, Chile",
    bill_of_lading: "ROECHN25062759",
    observations: "Factura exenta",
    confidence: 0.99,
    warnings: [],
  },
  lines: [{
    source_index: 1,
    source_page: 1,
    include: true,
    cost_category: "international_freight",
    concept: "Flete maritimo resto del mundo",
    provider_name: "ADS INTERNACIONAL CARGO SPA",
    document_number: "979",
    document_date: "2025-07-31",
    net_clp: 4690000,
    vat_clp: 0,
    total_clp: 4690000,
    amount_original: 4690,
    currency: "USD",
    exchange_rate_clp: 1000,
    recoverable_tax: false,
    include_in_costing: true,
    confidence: 0.99,
    warnings: [],
  }],
  totals: { net_clp: 4690000, vat_clp: 0, document_total_clp: 4690000, line_count: 1 },
  warnings: [],
});
assert.equal(freightExtraction.extraction.extraction_version, FOREIGN_TRADE_FREIGHT_DOCUMENT_EXTRACTION_VERSION);
assert.equal(freightExtraction.extraction.lines[0].amount_original, 4690);
assert.equal(freightExtraction.extraction.lines[0].exchange_rate_clp, 1000);
const normalizedFreight = normalizeForeignTradeFreightDocumentReview(freightExtraction.extraction);
assert.equal(normalizedFreight.isCompatible, true);
assert.equal(normalizedFreight.review.totals.document_total_clp, 4690000);

const costingParameters = await db.query(
  "select code,numeric_value from public.foreign_trade_cost_parameters where code like 'cl_%' order by code",
);
assert.equal(costingParameters.rows.length, 3, "la fase 4 debe versionar tres parametros legales base");

const pdfCifClp = 54144.04 * 904.54;
const effectiveDutyPercent = 255713 / pdfCifClp * 100;
const pdfCosting = calculateForeignTradeCosting([
  { id: "pdf-line", product_name: "Mercaderia despacho 49194", sku: null, quantity: 1, currency: "USD", fob_total: 51962.83 },
], [], {
  exchangeRateClp: 904.54,
  cifOverrideOriginal: 54144.04,
  generalDutyPercent: effectiveDutyPercent,
  importVatPercent: 19,
  salesVatPercent: 19,
  importVatRecoverable: true,
  pricingMethod: "markup_on_cost",
  targetPercent: 45,
  allocationMethod: "fob_value",
  lineDutyPercent: {},
  lineTargetPercent: {},
});
assert.equal(pdfCosting.cifClp, 48975449.94, "el CIF del despacho 49194 debe conservar centavos CLP");
assert.equal(pdfCosting.dutyClp, 255713, "el derecho debe calcularse desde CIF y la tasa efectiva");
assert.equal(pdfCosting.recoverableVatClp, pdfCosting.importVatClp, "el IVA recuperable se separa del costo economico");
assert.ok(
  Math.abs(pdfCosting.lines[0].netSaleUnitClp - pdfCosting.lines[0].landedUnitClp * 1.45) < 0.02,
  "un objetivo de 45% como markup debe aplicarse sobre costo",
);

const cifAllocatedCosting = calculateForeignTradeCosting([
  { id: "cif-a", product_name: "Producto CIF A", sku: "A", quantity: 10, currency: "CLP", fob_total: 500, cif_total: 1000 },
  { id: "cif-b", product_name: "Producto CIF B", sku: "B", quantity: 10, currency: "CLP", fob_total: 500, cif_total: 3000 },
], [
  { id: "national", operation_line_id: null, category: "national_transport", name: "Flete nacional", amount_clp: 400, allocation_method: "operation", recoverable_tax: false, metadata: {} },
  { id: "agency", operation_line_id: null, category: "customs_agency", name: "Agencia", amount_clp: 100, allocation_method: "operation", recoverable_tax: true, metadata: { vat_rate_percent: 19 } },
  { id: "ocean", operation_line_id: null, category: "international_freight", name: "Flete internacional ya incluido en CIF", amount_clp: 900, allocation_method: "operation", recoverable_tax: false, metadata: {} },
], {
  exchangeRateClp: 1,
  cifOverrideOriginal: null,
  generalDutyPercent: 0,
  importVatPercent: 0,
  salesVatPercent: 0,
  importVatRecoverable: true,
  pricingMethod: "markup_on_cost",
  targetPercent: 0,
  allocationMethod: "cif_value",
  lineDutyPercent: {},
  lineTargetPercent: {},
});
assert.equal(cifAllocatedCosting.operatingExpensesEconomicClp, 500, "el flete nacional y la agencia deben incorporarse al costo economico");
assert.equal(cifAllocatedCosting.lines[0].allocatedExpensesClp, 125, "los gastos deben repartirse por participacion CIF");
assert.equal(cifAllocatedCosting.lines[1].allocatedExpensesClp, 375, "la linea con 75% del CIF debe absorber 75% de gastos");
assert.equal(cifAllocatedCosting.landedTotalClp, 4500, "el costo en bodega suma CIF y gastos locales sin duplicar flete internacional");
assert.equal(cifAllocatedCosting.cifAllocationEstimated, false, "con CIF por linea la distribucion no debe marcarse estimada");

const invoiceFloorCosting = calculateForeignTradeCosting([
  { id: "invoice-floor-a", product_name: "Difusor 8", sku: null, quantity: 32, currency: "USD", unit_factory_cost: 3.8 },
  { id: "invoice-floor-b", product_name: "Producto economico", sku: null, quantity: 100, currency: "USD", unit_factory_cost: 1 },
], [
  { id: "invoice-floor-freight", operation_line_id: null, category: "international_freight", name: "Flete internacional", amount_clp: 22000, allocation_method: "operation", recoverable_tax: false, metadata: {} },
  { id: "invoice-floor-local", operation_line_id: null, category: "national_transport", name: "Flete nacional", amount_clp: 13200, allocation_method: "operation", recoverable_tax: false, metadata: {} },
], {
  exchangeRateClp: 990,
  cifOverrideOriginal: null,
  generalDutyPercent: 0,
  importVatPercent: 19,
  salesVatPercent: 19,
  importVatRecoverable: true,
  pricingMethod: "margin_on_sale",
  targetPercent: 45,
  allocationMethod: "units",
  lineDutyPercent: {},
  lineTargetPercent: {},
});
assert.equal(invoiceFloorCosting.lines[0].invoiceUnitClp, 3762, "el costo unitario de factura debe conservar USD 3,80 por CLP 990");
assert.ok(invoiceFloorCosting.lines[0].cifClp >= 121.6 * 990, "distribuir por unidades nunca puede bajar el CIF de la linea bajo su factura");
assert.ok(invoiceFloorCosting.lines[0].landedUnitClp > 3762, "los gastos locales deben aumentar el costo unitario de factura");
assert.equal(
  invoiceFloorCosting.lines.reduce((sum, line) => sum + line.cifClp, 0),
  invoiceFloorCosting.cifClp,
  "el CIF protegido por linea debe seguir cuadrando con el total de la operacion",
);

for (const allocationMethod of ["fob_value", "cif_value", "units", "weight", "cbm", "combined"]) {
  const protectedCosting = calculateForeignTradeCosting([
    { id: `${allocationMethod}-a`, product_name: "Producto de mayor costo", sku: null, quantity: 32, currency: "USD", unit_factory_cost: 3.8, gross_weight_kg: 80, cbm_total: 2 },
    { id: `${allocationMethod}-b`, product_name: "Producto de menor costo", sku: null, quantity: 100, currency: "USD", unit_factory_cost: 1, gross_weight_kg: 20, cbm_total: 8 },
  ], [
    { id: `${allocationMethod}-freight`, operation_line_id: null, category: "international_freight", name: "Flete internacional", amount_clp: 22000, allocation_method: "operation", recoverable_tax: false, metadata: {} },
  ], {
    exchangeRateClp: 990,
    cifOverrideOriginal: null,
    generalDutyPercent: 0,
    importVatPercent: 19,
    salesVatPercent: 19,
    importVatRecoverable: true,
    pricingMethod: "margin_on_sale",
    targetPercent: 45,
    allocationMethod,
    lineDutyPercent: {},
    lineTargetPercent: {},
  });
  for (const line of protectedCosting.lines) {
    assert.ok(
      line.cifClp + 0.01 >= line.invoiceTotalClp,
      `${allocationMethod}: ningun producto puede recibir un CIF menor que su costo de factura`,
    );
  }
  assert.ok(
    Math.abs(protectedCosting.lines.reduce((sum, line) => sum + line.cifClp, 0) - protectedCosting.cifClp) <= 0.02,
    `${allocationMethod}: la distribucion protegida debe cuadrar con el CIF total`,
  );
}

const invoiceReconciliation = calculateForeignTradeReconciliation(18220000, 0, [
  { line_type: "agency_fee", provision_total_clp: 655322, actual_net_clp: 402233, actual_vat_clp: 76424, actual_total_clp: 478657 },
  { line_type: "operating_expense", provision_total_clp: 528544, actual_net_clp: 444155, actual_vat_clp: 84389, actual_total_clp: 528544 },
  { line_type: "operating_expense", provision_total_clp: 319142, actual_net_clp: 319142, actual_vat_clp: 0, actual_total_clp: 319142, actual_amount_original: 329.09, actual_currency: "USD", actual_exchange_rate_clp: null },
  { line_type: "operating_expense", provision_total_clp: 416500, actual_net_clp: 350000, actual_vat_clp: 66500, actual_total_clp: 416500 },
  { line_type: "operating_expense", provision_total_clp: 33534, actual_net_clp: 28180, actual_vat_clp: 5354, actual_total_clp: 33534 },
  { line_type: "operating_expense", provision_total_clp: 155000, actual_net_clp: 155000, actual_vat_clp: 0, actual_total_clp: 155000, actual_amount_original: 155, actual_currency: "USD", actual_exchange_rate_clp: 1000 },
  { line_type: "operating_expense", provision_total_clp: 95200, actual_net_clp: 80000, actual_vat_clp: 15200, actual_total_clp: 95200 },
  { line_type: "customs_duty", provision_total_clp: 168708, actual_net_clp: 168708, actual_vat_clp: 0, actual_total_clp: 168708, actual_amount_original: 173.91, actual_currency: "USD", actual_exchange_rate_clp: 970.09 },
  { line_type: "import_vat", provision_total_clp: 15848050, actual_net_clp: 15848050, actual_vat_clp: 0, actual_total_clp: 15848050, actual_amount_original: 16336.68, actual_currency: "USD", actual_exchange_rate_clp: 970.09 },
]);
assert.equal(invoiceReconciliation.actualExpensesClp, 2026577);
assert.equal(invoiceReconciliation.actualTaxesClp, 16016758);
assert.equal(invoiceReconciliation.actualTotalClp, 18043335);
assert.equal(invoiceReconciliation.refundDueClp, 176665);
assert.equal(invoiceReconciliation.lineConversions[2].actualConvertedClp, null, "sin TC explicito debe respetar el total CLP declarado");
assert.equal(invoiceReconciliation.lineConversions[2].actualImpliedExchangeRateClp, 969.771187);
assert.equal(invoiceReconciliation.lineConversions[5].actualConvertedClp, 155000);
assert.equal(invoiceReconciliation.lineConversions[5].conversionVarianceClp, 0);
assert.equal(invoiceReconciliation.lineConversions[7].conversionVarianceClp, -0.35);
assert.equal(invoiceReconciliation.lineConversions[8].conversionVarianceClp, 0.1);

const statuses = await db.query(
  "select count(*)::integer as count from public.foreign_trade_operation_statuses",
);
assert.equal(statuses.rows[0].count, 16, "la migracion repetida no debe duplicar estados");

const containers = await db.query(
  "select count(*)::integer as count from public.foreign_trade_container_types",
);
assert.equal(containers.rows[0].count, 4, "debe sembrar los contenedores referenciales");

const agentPermissions = await db.query(`
  select agent_type, bool_and(allowed) as all_allowed
  from public.foreign_trade_agent_permissions
  group by agent_type
  order by agent_type
`);
assert.deepEqual(agentPermissions.rows, [
  { agent_type: "commercial", all_allowed: false },
  { agent_type: "foreign_trade", all_allowed: true },
]);

await db.exec("set role service_role");
const serviceAgentCheck = await db.query(`
  select
    public.foreign_trade_agent_has_permission('foreign_trade','foreign_trade.read') as foreign_trade,
    public.foreign_trade_agent_has_permission('commercial','foreign_trade.read') as commercial
`);
assert.deepEqual(serviceAgentCheck.rows[0], { foreign_trade: true, commercial: false });
await db.exec("reset role");

const supplier = await db.query("select public.upsert_foreign_trade_supplier($1::jsonb) as id", [
  JSON.stringify({
    name: "Proveedor prueba",
    company_name: "Proveedor prueba Ltd.",
    country_code: "CN",
    currency: "USD",
    usual_incoterms: ["EXW", "FOB"],
    default_production_days: "50",
    active: true,
  }),
]);

const created = await db.query(
  "select public.create_foreign_trade_operation($1::jsonb) as id",
  [
    JSON.stringify({
      title: "Simulacion contenedor agosto",
      operation_type: "simulation",
      status: "quotation",
      supplier_id: supplier.rows[0].id,
      exchange_rate_clp: "980.250000",
      exchange_rate_source: "conservative",
      value_usd: "52100.125000",
      target_container_cbm: "67.700000",
    }),
  ],
);
const operationId = created.rows[0].id;

const operation = await db.query(
  "select title,exchange_rate_clp,value_usd,active_scenario_id from public.import_shipments where id=$1",
  [operationId],
);
assert.equal(operation.rows[0].title, "Simulacion contenedor agosto");
assert.equal(operation.rows[0].exchange_rate_clp, "980.250000");
assert.equal(operation.rows[0].value_usd, "52100.125000");
assert.ok(operation.rows[0].active_scenario_id, "debe crear y vincular el escenario base");

const baseline = await db.query(
  "select status,exchange_rate_clp from public.foreign_trade_scenarios where operation_id=$1",
  [operationId],
);
assert.deepEqual(baseline.rows[0], { status: "baseline", exchange_rate_clp: "980.250000" });

const catalogProduct = await db.query(`
  insert into public.content_products(external_id,sku,name,category,brand,price,stock)
  values ('tn-001','HVAC-001','Herramienta HVAC','Herramientas','Clima Activa',29990,12)
  returning id
`);

const lineResult = await db.query(
  "select public.upsert_foreign_trade_operation_line($1::jsonb) as id",
  [JSON.stringify({
    operation_id: operationId,
    content_product_id: catalogProduct.rows[0].id,
    product_name: "Herramienta HVAC",
    sku: "HVAC-001",
    supplier_sku: "CN-HVAC-001",
    quantity: "10",
    unit_factory_cost: "8.400000",
    quantity_per_box: "5",
    box_count: "2",
    box_length_cm: "40",
    box_width_cm: "30",
    box_height_cm: "20",
    gross_weight_kg: "15.500000",
    currency: "USD",
    country_of_origin: "CN",
    data_source: "configured",
    remember_link: true,
  })],
);
const lineId = lineResult.rows[0].id;
const line = await db.query(
  "select product_name,quantity,unit_factory_cost,cbm_per_box,cbm_total,source_snapshot from public.foreign_trade_operation_lines where id=$1",
  [lineId],
);
assert.equal(line.rows[0].quantity, "10.000000");
assert.equal(line.rows[0].unit_factory_cost, "8.400000");
assert.equal(line.rows[0].cbm_per_box, "0.024000");
assert.equal(line.rows[0].cbm_total, "0.048000");
assert.equal(line.rows[0].source_snapshot.name, "Herramienta HVAC");

const supplierMapping = await db.query(
  "select supplier_sku,content_product_id from public.supplier_products where supplier_id=$1 and sku='HVAC-001'",
  [supplier.rows[0].id],
);
assert.equal(supplierMapping.rows[0].supplier_sku, "CN-HVAC-001");
assert.equal(supplierMapping.rows[0].content_product_id, catalogProduct.rows[0].id);

const catalog = await db.query("select public.foreign_trade_product_catalog('HVAC',10) as products");
assert.equal(catalog.rows[0].products.length, 1);
assert.equal(catalog.rows[0].products[0].sku, "HVAC-001");

const costResult = await db.query(
  "select public.upsert_foreign_trade_cost_line($1::jsonb) as id",
  [JSON.stringify({
    operation_id: operationId,
    category: "international_freight",
    name: "Flete marítimo",
    amount_original: "100.000000",
    currency: "USD",
    exchange_rate_clp: "980.250000",
    allocation_method: "cbm",
    source_type: "configured",
    recoverable_tax: true,
    metadata: { amount_basis: "gross", vat_rate_percent: 19 },
  })],
);
const costId = costResult.rows[0].id;
const cost = await db.query(
  "select amount_original,amount_clp,allocation_method,recoverable_tax,metadata from public.foreign_trade_cost_lines where id=$1",
  [costId],
);
assert.deepEqual(cost.rows[0], {
  amount_original: "100.000000",
  amount_clp: "98025.000000",
  allocation_method: "cbm",
  recoverable_tax: true,
  metadata: { amount_basis: "gross", vat_rate_percent: 19 },
});

const savedScenario = await db.query(
  "select public.save_foreign_trade_costing_scenario($1::jsonb) as id",
  [JSON.stringify({
    id: operation.rows[0].active_scenario_id,
    operation_id: operationId,
    name: "Escenario base",
    status: "baseline",
    exchange_rate_clp: 980.25,
    exchange_rate_source: "conservative",
    allocation_method: "cbm",
    assumptions: { costing: { general_duty_percent: 6, import_vat_percent: 19, sales_vat_percent: 19, import_vat_recoverable: true, pricing_method: "markup_on_cost", target_percent: 45 } },
    merchandise_total_original: 84,
    merchandise_total_clp: 82341,
    logistics_total_clp: 82373.95,
    duties_total_clp: 4940.46,
    taxes_total_clp: 16583.48,
    landed_total_clp: 169655.41,
    projected_sales_clp: 246000.34,
    projected_profit_clp: 76344.93,
    projected_margin_percent: 31.0345,
    missing_inputs: [],
    calculation_version: "cl_import_cost_v1",
  })],
);
assert.equal(savedScenario.rows[0].id, operation.rows[0].active_scenario_id);
const costingScenario = await db.query(
  "select allocation_method,target_margin_percent,calculation_version,assumptions->'costing'->>'pricing_method' as pricing_method from public.foreign_trade_scenarios where id=$1",
  [savedScenario.rows[0].id],
);
assert.deepEqual(costingScenario.rows[0], {
  allocation_method: "cbm",
  target_margin_percent: "45.000000",
  calculation_version: "cl_import_cost_v1",
  pricing_method: "markup_on_cost",
});

const detail = await db.query("select public.foreign_trade_operation_detail($1) as detail", [operationId]);
assert.equal(detail.rows[0].detail.lines.length, 1);
assert.equal(detail.rows[0].detail.costs.length, 1);
assert.equal(detail.rows[0].detail.totals.registered_merchandise, 84);
assert.equal(detail.rows[0].detail.totals.total_cbm, 0.048);
assert.equal(detail.rows[0].detail.totals.costs_clp, 98025);

const preparedExtraction = prepareExtraction({
  document_scope: {
    selected_document_type: "commercial_invoice",
    detected: true,
    page_start: 3,
    page_end: 5,
    page_numbers: [3, 4, 5],
    total_pdf_pages: 9,
    confidence: 0.96,
    evidence: ["COMMERCIAL INVOICE"],
    warnings: [],
  },
  general: { supplier_name: "Proveedor prueba", currency: "USD", confidence: 0.9, warnings: [] },
  lines: [{
    source_index: 1,
    source_page: 1,
    source_row_label: "1",
    product_name: "Herramienta documental",
    quantity: 10,
    unit_price: 8.4,
    total_price: 90,
    box_count: 2,
    box_length_cm: 40,
    box_width_cm: 30,
    box_height_cm: 20,
    cbm_total: 0.1,
    confidence: 0.8,
    warnings: [],
  }],
  document_totals: { cbm_total: 0.1, line_count: 1 },
  warnings: [],
});
assert.equal(preparedExtraction.extraction.lines[0].recalculated_cbm_total, 0.048);
assert.equal(preparedExtraction.extraction.lines[0].cbm_per_box, 0.05);
assert.equal(preparedExtraction.extraction.lines[0].cbm_per_unit, 0.01);
assert.equal(preparedExtraction.extraction.lines[0].source_page, 1);
assert.equal(preparedExtraction.extraction.extraction_version, FOREIGN_TRADE_EXTRACTION_VERSION);
assert.deepEqual(preparedExtraction.extraction.document_scope?.page_numbers, [3, 4, 5]);
assert.ok(preparedExtraction.warnings.some((warning) => warning.code === "line_total_mismatch"));
assert.ok(preparedExtraction.warnings.some((warning) => warning.code === "cbm_mismatch"));

assert.deepEqual(
  normalizeForeignTradeDocumentScope({
    selected_document_type: "packing_list",
    detected: true,
    page_start: 6,
    page_end: 8,
    page_numbers: [],
    total_pdf_pages: 9,
    confidence: 1.4,
    evidence: ["PACKING LIST"],
    warnings: [],
  }, "packing_list"),
  {
    selected_document_type: "packing_list",
    detected: true,
    page_start: 6,
    page_end: 8,
    page_numbers: [6, 7, 8],
    total_pdf_pages: 9,
    confidence: 1,
    evidence: ["PACKING LIST"],
    warnings: [],
  },
);

const preparedFundRequest = prepareFundRequestExtraction({
  general: {
    reference: "49194",
    agency_name: "Agencia de Aduanas",
    document_date: "2026-08-20",
    currency: "CLP",
    declared_total_clp: 16853872,
    remittance_amount_clp: 16853872,
    confidence: 0.94,
    warnings: [],
  },
  lines: [
    { source_index: 1, source_page: 1, include: true, line_type: "agency_fee", cost_category: "customs_agency", concept: "Honorarios agencia", provision_net_clp: 400000, provision_vat_clp: 76000, provision_total_clp: 476000, amount_original: 476000, currency: "CLP", exchange_rate_clp: 1, recoverable_tax: true, include_in_costing: true, confidence: 0.95, warnings: [] },
    { source_index: 2, source_page: 1, include: true, line_type: "customs_duty", cost_category: "duties", concept: "Derechos ad valorem", provision_total_clp: 529822, amount_original: 546.16, currency: "USD", exchange_rate_clp: 970.09, recoverable_tax: false, include_in_costing: true, confidence: 0.9, warnings: [] },
    { source_index: 3, source_page: 1, include: true, line_type: "import_vat", cost_category: "taxes", concept: "IVA importación", provision_total_clp: 15848050, amount_original: 16336.68, currency: "USD", exchange_rate_clp: 970.09, recoverable_tax: false, include_in_costing: true, confidence: 0.9, warnings: [] },
  ],
  totals: { expenses_clp: 476000, taxes_clp: 16377872, document_total_clp: 16853872, line_count: 3 },
  warnings: [],
});
assert.equal(preparedFundRequest.extraction.extraction_version, FOREIGN_TRADE_FUND_REQUEST_EXTRACTION_VERSION);
assert.equal(preparedFundRequest.extraction.lines[2].recoverable_tax, true);
assert.equal(preparedFundRequest.extraction.lines[2].include_in_costing, false);
assert.equal(preparedFundRequest.extraction.totals.expenses_clp, 476000);
assert.equal(preparedFundRequest.extraction.totals.taxes_clp, 16377872);

const normalizedFundRequestReview = normalizeForeignTradeFundRequestReview(preparedFundRequest.extraction);
assert.equal(normalizedFundRequestReview.isCompatible, true);
assert.equal(normalizedFundRequestReview.review.lines.length, 3);
assert.equal(normalizedFundRequestReview.review.lines[2].include_in_costing, false);
assert.deepEqual(normalizedFundRequestReview.review.lines[0].warnings, []);

const legacyFundRequestReview = normalizeForeignTradeFundRequestReview({
  extraction_version: "pdf_skill_v10",
  general: { supplier_name: "Agencia de Aduanas", currency: "CLP" },
  lines: [{ source_index: 1, product_name: "Derechos aduaneros", total_price: 529822 }],
  document_totals: { total: 529822, line_count: 1 },
});
assert.equal(legacyFundRequestReview.isCompatible, false);
assert.equal(legacyFundRequestReview.review.lines.length, 0);
assert.equal(legacyFundRequestReview.review.general.currency, "CLP");

const preparedAgencySettlement = prepareAgencySettlementExtraction({
  general: {
    reference: "49194",
    agency_name: "Agencia de Aduanas",
    invoice_number: "23177",
    document_date: "2026-08-22",
    currency: "CLP",
    declared_total_clp: 1007201,
    confidence: 0.96,
    warnings: [],
  },
  lines: [
    { source_index: 1, source_page: 1, include: true, line_type: "agency_fee", cost_category: "customs_agency", concept: "Honorarios agencia", provider_name: "Agencia de Aduanas", document_number: "23177", document_date: "2026-08-22", actual_net_clp: 402233, actual_vat_clp: 76424, actual_total_clp: 478657, amount_original: 478657, currency: "CLP", exchange_rate_clp: 1, recoverable_tax: true, include_in_costing: true, confidence: 0.97, warnings: [] },
    { source_index: 2, source_page: 2, include: true, line_type: "operating_expense", cost_category: "chile_port", concept: "Servicios portuarios", provider_name: "AGUNSA", document_number: "2082486", document_date: "2026-08-20", actual_net_clp: 444155, actual_vat_clp: 84389, actual_total_clp: 528544, amount_original: 528544, currency: "CLP", exchange_rate_clp: 1, recoverable_tax: true, include_in_costing: true, confidence: 0.94, warnings: [] },
  ],
  totals: {
    expenses_clp: 1007201,
    taxes_clp: 0,
    agency_invoice_total_clp: 478657,
    disbursements_total_clp: 528544,
    customs_total_clp: 0,
    document_total_clp: 1007201,
    remittance_clp: null,
    documentary_direct_payment_clp: 0,
    refund_due_clp: null,
    line_count: 2,
  },
  warnings: [],
});
assert.equal(preparedAgencySettlement.extraction.extraction_version, FOREIGN_TRADE_AGENCY_SETTLEMENT_EXTRACTION_VERSION);
assert.equal(preparedAgencySettlement.extraction.document_kind, "agency_settlement");
assert.equal(preparedAgencySettlement.extraction.lines[0].actual_total_clp, 478657);
assert.ok(!preparedAgencySettlement.warnings.some((warning) => warning.code === "agency_settlement_total_mismatch"));
const normalizedAgencySettlement = normalizeForeignTradeAgencySettlementReview(preparedAgencySettlement.extraction);
assert.equal(normalizedAgencySettlement.isCompatible, true);
assert.equal(normalizedAgencySettlement.review.lines.length, 2);
assert.equal(normalizedAgencySettlement.review.identity_confirmed, false);

const extractionRanges = buildExtractionRanges(89, 40);
assert.deepEqual(extractionRanges, [
  { start: 1, end: 40 },
  { start: 41, end: 80 },
  { start: 81, end: 89 },
]);
const mergedExtraction = mergeExtractionPasses({
  general: {
    supplier_name: "CHINAFORE CORPORATION",
    proforma_number: null,
    order_number: "26TDC12",
    document_date: "2026-03-03",
    currency: "USD",
    warnings: [],
  },
  document_totals: { total: 69452.33, boxes: 539.7, gross_weight_kg: 5599.55, cbm_total: 26.84, line_count: 89 },
  warnings: [],
}, extractionRanges.map((range) => ({
  ...range,
  data: {
    lines: Array.from({ length: range.end - range.start + 1 }, (_, offset) => ({
      source_index: range.start + offset,
      source_page: Math.ceil((range.start + offset) / 30),
      source_row_label: String(range.start + offset),
      product_name: `Producto ${range.start + offset}`,
      quantity: 10,
      unit_price: 2,
      total_price: 20,
      box_count: 2,
      cbm_total: 0.1,
      confidence: 0.9,
      warnings: [],
    })),
    warnings: [],
  },
})));
assert.equal(mergedExtraction.lines.length, 89);
assert.deepEqual(missingExtractionRanges(89, mergedExtraction.lines), []);

const compactlyVerifiedExtraction = mergeCompactVerification(
  {
    general: { supplier_name: "Proveedor prueba", currency: "USD" },
    document_totals: { line_count: 2, cbm_total: 0.6, gross_weight_kg: 6 },
    lines: [
      { source_index: 1, product_name: "Producto 1", quantity: 1, cbm_total: 0.1, gross_weight_kg: 1 },
      { source_index: 2, product_name: "Producto 2", quantity: 1, cbm_total: 9, gross_weight_kg: 9 },
    ],
    warnings: [],
  },
  {
    lines: [
      { source_index: 1, source_page: 1, source_row_label: "1", product_name: "Producto 1", quantity: 1, cbm_total: 0.1, gross_weight_kg: 1 },
      { source_index: 2, source_page: 1, source_row_label: "2", product_name: "Producto 2", quantity: 1, cbm_total: 0.2, gross_weight_kg: 2 },
      { source_index: 3, source_page: 2, source_row_label: null, product_name: "Producto sin numero impreso", quantity: 1, cbm_total: 0.3, gross_weight_kg: 3 },
    ],
    warnings: [],
  },
);
assert.equal(compactlyVerifiedExtraction.lines.length, 3);
assert.equal(compactlyVerifiedExtraction.document_totals.line_count, 3);
assert.equal(compactlyVerifiedExtraction.lines[1].cbm_total, 0.2);
assert.equal(compactlyVerifiedExtraction.lines[1].gross_weight_kg, 2);
assert.equal(compactlyVerifiedExtraction.lines[2].product_name, "Producto sin numero impreso");

const duplicateAggregateExtraction = mergeCompactVerification(
  {
    document_totals: { line_count: 3, cbm_total: 1.8 },
    lines: [
      { source_index: 1, product_name: "Producto 1", cbm_total: 1.8, confidence: 0.8 },
      { source_index: 2, product_name: "Producto 2", cbm_total: 1.8, confidence: 0.9 },
      { source_index: 3, product_name: "Producto 3", cbm_total: 1.8, confidence: 0.95 },
    ],
    warnings: [],
  },
  { lines: [], warnings: [] },
);
assert.equal(duplicateAggregateExtraction.lines[0].cbm_total, null);
assert.equal(duplicateAggregateExtraction.lines[1].cbm_total, null);
assert.equal(duplicateAggregateExtraction.lines[2].cbm_total, 1.8);
assert.ok(duplicateAggregateExtraction.warnings.some((message) => message.includes("CBM duplicados")));

const extractionWithUnnumberedRow = mergeUnnumberedRows(
  {
    document_totals: { line_count: 2, total: 60 },
    lines: [
      { source_index: 1, source_row_label: "1", product_name: "Producto 1", quantity: 1, unit_price: 10 },
      { source_index: 2, source_row_label: "2", product_name: "Producto 2", quantity: 1, unit_price: 20 },
    ],
    warnings: [],
  },
  {
    lines: [{ source_index: 2, source_row_label: null, product_name: "Producto sin numero", quantity: 1, unit_price: 30 }],
    warnings: [],
  },
);
assert.equal(extractionWithUnnumberedRow.lines.length, 3);
assert.equal(extractionWithUnnumberedRow.document_totals.line_count, 3);
assert.equal(extractionWithUnnumberedRow.lines[1].product_name, "Producto sin numero");
assert.equal(extractionWithUnnumberedRow.lines[2].source_index, 3);

const completeProforma = prepareExtraction(mergedExtraction);
assert.equal(completeProforma.extraction.general.proforma_number, "26TDC12");
assert.equal(completeProforma.extraction.document_totals.line_count, 89);
assert.ok(!completeProforma.warnings.some((warning) => warning.code === "incomplete_line_extraction"));

const incompleteProforma = prepareExtraction({
  ...mergedExtraction,
  lines: mergedExtraction.lines.slice(0, 3),
});
assert.ok(incompleteProforma.warnings.some((warning) => warning.code === "incomplete_line_extraction" && warning.severity === "error"));
assert.deepEqual(missingExtractionRanges(6, mergedExtraction.lines.slice(0, 3)), [{ start: 4, end: 6 }]);

const pdfSkill = createForeignTradePdfReadingSkill("proforma");
assert.equal(pdfSkill.version, FOREIGN_TRADE_PDF_SKILL_VERSION);
assert.match(pdfSkill.headerPrompt, /todas las páginas/i);
assert.match(pdfSkill.headerPrompt, /document_scope/i);
assert.match(pdfSkill.linePrompt({ start: 31, end: 60 }, "verify"), /source_page/);
const billOfLadingSkill = createForeignTradePdfReadingSkill("bill_of_lading");
assert.match(billOfLadingSkill.headerPrompt, /bill of lading/i);
assert.match(billOfLadingSkill.headerPrompt, /omitir por completo/i);
const invoiceScopePrompt = createForeignTradeDocumentScopePrompt("commercial_invoice");
assert.match(invoiceScopePrompt, /páginas de continuación/i);
assert.match(invoiceScopePrompt, /excluye por completo Bill of Lading/i);
assert.match(invoiceScopePrompt, /page_numbers vacío/i);
const qualityExtraction = {
  document_totals: { total: 40, boxes: 4, gross_weight_kg: 8, cbm_total: 0.2, line_count: 2 },
  lines: [
    { source_index: 1, source_page: 1, total_price: 20, box_count: 2, gross_weight_kg: 4, cbm_total: 0.1 },
    { source_index: 2, source_page: 1, total_price: 20, box_count: 2, gross_weight_kg: 4, cbm_total: 0.1 },
  ],
};
const goodPdfQuality = assessPdfExtractionQuality(qualityExtraction);
assert.equal(goodPdfQuality.requiresVerification, false);
assert.equal(goodPdfQuality.score, 100);
const badPdfQuality = assessPdfExtractionQuality({ ...qualityExtraction, lines: qualityExtraction.lines.slice(0, 1) });
assert.equal(badPdfQuality.requiresVerification, true);
assert.equal(badPdfQuality.critical, true);

const documentResult = await db.query(
  "select public.register_foreign_trade_document($1::jsonb) as id",
  [JSON.stringify({
    operation_id: operationId,
    supplier_id: supplier.rows[0].id,
    document_type: "proforma",
    original_file_name: "proforma-prueba.xlsx",
    storage_path: `${operationId}/proforma-prueba.xlsx`,
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    file_size: "2048",
    file_hash: "a".repeat(64),
  })],
);
const documentId = documentResult.rows[0].id;

await db.exec("set role service_role");
await db.query(
  "select public.set_foreign_trade_document_extraction($1,'review_required',$2::jsonb,$3,$4::jsonb,null,'gpt-test','request-test')",
  [documentId, JSON.stringify(preparedExtraction.extraction), preparedExtraction.confidence, JSON.stringify(preparedExtraction.warnings)],
);
await db.exec("reset role");

const documentList = await db.query("select public.foreign_trade_document_list($1) as documents", [operationId]);
assert.equal(documentList.rows[0].documents[0].parse_status, "review_required");
assert.equal(documentList.rows[0].documents[0].extraction_model, "gpt-test");

const review = structuredClone(preparedExtraction.extraction);
review.general.supplier_id = supplier.rows[0].id;
review.general.proforma_number = "PI-2026-001";
review.general.document_date = "2026-08-22";
review.general.incoterm = "FOB";
review.lines[0].sku = "DOC-001";
review.lines[0].supplier_sku = "CN-DOC-001";
review.lines[0].total_price = 84;
review.lines[0].cbm_total = 0.048;
const confirmation = await db.query(
  "select public.confirm_foreign_trade_document($1,$2::jsonb) as result",
  [documentId, JSON.stringify(review)],
);
assert.equal(confirmation.rows[0].result.inserted_lines, 1);
const importedDocumentLine = await db.query(
  "select data_source,source_document_id,source_line_index,extraction_confidence from public.foreign_trade_operation_lines where source_document_id=$1",
  [documentId],
);
assert.deepEqual(importedDocumentLine.rows[0], {
  data_source: "document",
  source_document_id: documentId,
  source_line_index: 1,
  extraction_confidence: "0.800000",
});
const confirmedDocument = await db.query(
  "select parse_status,confirmed_at,review_result->'general'->>'proforma_number' as proforma_number from public.foreign_trade_documents where id=$1",
  [documentId],
);
assert.equal(confirmedDocument.rows[0].parse_status, "confirmed");
assert.ok(confirmedDocument.rows[0].confirmed_at);
assert.equal(confirmedDocument.rows[0].proforma_number, "PI-2026-001");
await assert.rejects(
  db.query("select public.confirm_foreign_trade_document($1,$2::jsonb)", [documentId, JSON.stringify(review)]),
  /foreign_trade_document_not_ready/,
  "un documento confirmado no puede materializar líneas por segunda vez",
);

const packingOperation = await db.query(
  "insert into public.import_shipments(supplier_id,reference,title,status) values ($1,'PACKING-001','Prueba Packing List','proforma_received') returning id",
  [supplier.rows[0].id],
);
const packingOperationId = packingOperation.rows[0].id;
const packingInvoiceDocument = await db.query(`
  insert into public.foreign_trade_documents(
    operation_id,supplier_id,document_type,original_file_name,storage_path,mime_type,
    file_size,parse_status,extraction_result,review_result,confirmed_at,uploaded_by
  ) values ($1,$2,'commercial_invoice','invoice-packing.pdf',$3,'application/pdf',1024,'confirmed','{}'::jsonb,'{}'::jsonb,now(),$4)
  returning id
`, [packingOperationId, supplier.rows[0].id, `${packingOperationId}/invoice-packing.pdf`, adminId]);
const packingInvoiceDocumentId = packingInvoiceDocument.rows[0].id;
const firstPackingProduct = await db.query(
  "select public.upsert_foreign_trade_operation_line($1::jsonb) as id",
  [JSON.stringify({
    operation_id: packingOperationId,
    product_name: "Li-battery vacuum pump BRAND SUPER STARS ST-2BMC",
    supplier_model: "ST-2BMC",
    quantity: "20",
    currency: "USD",
    unit_factory_cost: "38",
    data_source: "document",
  })],
);
const secondPackingProduct = await db.query(
  "select public.upsert_foreign_trade_operation_line($1::jsonb) as id",
  [JSON.stringify({
    operation_id: packingOperationId,
    product_name: "BRAND SUPER STARS ST-302 3/8; 1/2",
    supplier_model: "ST-302",
    quantity: "10",
    currency: "USD",
    unit_factory_cost: "2",
    data_source: "document",
  })],
);
const thirdPackingProduct = await db.query(
  "select public.upsert_foreign_trade_operation_line($1::jsonb) as id",
  [JSON.stringify({
    operation_id: packingOperationId,
    product_name: 'Difussor whit dampers circular 8"',
    description: 'Difussor whit dampers circular 8"',
    quantity: "32",
    currency: "USD",
    unit_factory_cost: "4",
    data_source: "document",
  })],
);
await db.query(
  "update public.foreign_trade_operation_lines set source_document_id=$1 where id in ($2,$3,$4)",
  [packingInvoiceDocumentId, firstPackingProduct.rows[0].id, secondPackingProduct.rows[0].id, thirdPackingProduct.rows[0].id],
);
const packingDocument = await db.query(`
  insert into public.foreign_trade_documents(
    operation_id,supplier_id,document_type,original_file_name,storage_path,mime_type,
    file_size,parse_status,extraction_result,uploaded_by
  ) values ($1,$2,'packing_list','packing-list.pdf',$3,'application/pdf',1024,'review_required',$4::jsonb,$5)
  returning id
`, [packingOperationId, supplier.rows[0].id, `${packingOperationId}/packing-list.pdf`, JSON.stringify({}), adminId]);
const packingDocumentId = packingDocument.rows[0].id;
const packingReview = {
  extraction_version: FOREIGN_TRADE_EXTRACTION_VERSION,
  general: { supplier_id: supplier.rows[0].id, order_number: "TDC12", currency: "USD" },
  document_totals: { boxes: 3, cbm_total: 0.5, gross_weight_kg: 62, net_weight_kg: 58, line_count: 3 },
  lines: [
    ...embeddedPackingList.lines.map((line) => ({ ...line, include: true })),
    {
      source_index: 4,
      product_name: 'Difussor whit dampers circular 8"',
      description_original: 'Difussor whit dampers circular 8"',
      quantity: 32,
      box_count: 8,
      cbm_total: 0.22,
      gross_weight_kg: 18,
      net_weight_kg: 16,
      confidence: 0.98,
      include: true,
    },
  ],
  warnings: embeddedPackingList.warnings,
};
const packingConfirmation = await db.query(
  "select public.confirm_foreign_trade_packing_list_document($1,$2::jsonb) as result",
  [packingDocumentId, JSON.stringify(packingReview)],
);
assert.equal(packingConfirmation.rows[0].result.inserted_lines, 0);
assert.equal(packingConfirmation.rows[0].result.updated_lines, 3);
assert.equal(packingConfirmation.rows[0].result.unmatched_lines, 0);
const enrichedPackingProducts = await db.query(
  "select product_name,quantity,quantity_per_box,box_count,cbm_total,gross_weight_kg,net_weight_kg,source_snapshot from public.foreign_trade_operation_lines where operation_id=$1 order by line_number",
  [packingOperationId],
);
assert.equal(enrichedPackingProducts.rows.length, 3, "Packing List no debe crear productos duplicados");
assert.equal(Number(enrichedPackingProducts.rows[0].box_count), 2);
assert.equal(Number(enrichedPackingProducts.rows[0].cbm_total), 0.4);
assert.equal(Number(enrichedPackingProducts.rows[0].quantity_per_box), 10);
assert.equal(Number(enrichedPackingProducts.rows[1].box_count), 1);
assert.equal(Number(enrichedPackingProducts.rows[1].cbm_total), 0.1);
assert.equal(Number(enrichedPackingProducts.rows[1].quantity_per_box), 10);
assert.equal(enrichedPackingProducts.rows[1].source_snapshot.packing_list_document_id, packingDocumentId);
assert.equal(Number(enrichedPackingProducts.rows[2].box_count), 8, "nombre y descripcion iguales no deben romper la conciliacion textual");
assert.equal(Number(enrichedPackingProducts.rows[2].cbm_total), 0.22);
assert.equal(
  (await db.query("select parse_status from public.foreign_trade_documents where id=$1", [packingDocumentId])).rows[0].parse_status,
  "confirmed",
);
await db.query("delete from public.import_shipments where id=$1", [packingOperationId]);

await db.query("select public.upsert_foreign_trade_operation_line($1::jsonb)", [
  JSON.stringify({
    id: lineId,
    operation_id: operationId,
    content_product_id: catalogProduct.rows[0].id,
    product_name: "Herramienta HVAC",
    sku: "HVAC-001",
    supplier_sku: "CN-HVAC-001",
    quantity: "12",
    unit_factory_cost: "8.400000",
    currency: "USD",
    data_source: "configured",
  }),
]);
assert.equal(
  (await db.query("select quantity from public.foreign_trade_operation_lines where id=$1", [lineId])).rows[0].quantity,
  "12.000000",
  "editar una línea debe conservar el mismo registro histórico",
);

const temporaryLine = await db.query("select public.upsert_foreign_trade_operation_line($1::jsonb) as id", [
  JSON.stringify({
    operation_id: operationId,
    product_name: "Producto temporal de negociación",
    temporary_product: true,
    quantity: "1",
    currency: "USD",
    data_source: "simulated",
  }),
]);
await db.query("select public.delete_foreign_trade_operation_line($1)", [temporaryLine.rows[0].id]);
assert.equal(
  (await db.query("select count(*)::integer as count from public.foreign_trade_operation_lines where id=$1", [temporaryLine.rows[0].id])).rows[0].count,
  0,
);

const temporaryCost = await db.query("select public.upsert_foreign_trade_cost_line($1::jsonb) as id", [
  JSON.stringify({
    operation_id: operationId,
    category: "other",
    name: "Costo temporal",
    amount_original: "1",
    currency: "CLP",
    allocation_method: "operation",
    source_type: "simulated",
  }),
]);
await db.query("select public.delete_foreign_trade_cost_line($1)", [temporaryCost.rows[0].id]);
assert.equal(
  (await db.query("select count(*)::integer as count from public.foreign_trade_cost_lines where id=$1", [temporaryCost.rows[0].id])).rows[0].count,
  0,
);

const provisionDocument = await db.query("select public.register_foreign_trade_document($1::jsonb) as id", [JSON.stringify({
  operation_id: operationId,
  supplier_id: supplier.rows[0].id,
  document_type: "fund_request",
  original_file_name: "solicitud-fondos.pdf",
  storage_path: `${operationId}/solicitud-fondos.pdf`,
  mime_type: "application/pdf",
  file_size: "4096",
  file_hash: "b".repeat(64),
})]);
const settlementDocument = await db.query("select public.register_foreign_trade_document($1::jsonb) as id", [JSON.stringify({
  operation_id: operationId,
  supplier_id: supplier.rows[0].id,
  document_type: "agency_settlement",
  original_file_name: "rendicion-final.pdf",
  storage_path: `${operationId}/rendicion-final.pdf`,
  mime_type: "application/pdf",
  file_size: "8192",
  file_hash: "c".repeat(64),
})]);

const supportingDocumentStatuses = await db.query(
  "select id,parse_status from public.foreign_trade_documents where id in ($1,$2) order by id",
  [provisionDocument.rows[0].id, settlementDocument.rows[0].id],
);
assert.deepEqual(
  supportingDocumentStatuses.rows.map((document) => document.parse_status),
  ["uploaded", "uploaded"],
  "provisiones y rendiciones deben quedar guardadas sin iniciar extracción de productos",
);

const extractedProvisionDocument = await db.query("select public.register_foreign_trade_document($1::jsonb) as id", [JSON.stringify({
  operation_id: operationId,
  supplier_id: supplier.rows[0].id,
  document_type: "fund_request",
  original_file_name: "solicitud-fondos-extraida.pdf",
  storage_path: `${operationId}/solicitud-fondos-extraida.pdf`,
  mime_type: "application/pdf",
  file_size: "4096",
  file_hash: "e".repeat(64),
})]);
await db.exec("set role service_role");
await db.query(
  "select public.set_foreign_trade_document_extraction($1,'extracting','{}'::jsonb,null,'[]'::jsonb,null,null,$2)",
  [extractedProvisionDocument.rows[0].id, "fund-request-test"],
);
await db.query(
  "select public.set_foreign_trade_document_extraction($1,'review_required',$2::jsonb,$3,$4::jsonb,null,'gpt-test',$5)",
  [extractedProvisionDocument.rows[0].id, JSON.stringify(preparedFundRequest.extraction), preparedFundRequest.confidence, JSON.stringify(preparedFundRequest.warnings), "fund-request-test"],
);
await db.exec("reset role");
const confirmedFundRequest = await db.query(
  "select public.confirm_foreign_trade_fund_request_document($1,$2::jsonb) as result",
  [extractedProvisionDocument.rows[0].id, JSON.stringify(preparedFundRequest.extraction)],
);
assert.equal(confirmedFundRequest.rows[0].result.inserted_lines, 3);
assert.equal(
  (await db.query("select parse_status from public.foreign_trade_documents where id=$1", [extractedProvisionDocument.rows[0].id])).rows[0].parse_status,
  "confirmed",
);
const extractedReconciliation = await db.query(
  "select r.remittance_amount_clp,count(l.id)::integer as lines,sum(case when l.line_type in ('customs_duty','import_vat') then l.provision_total_clp else 0 end) as taxes from public.foreign_trade_expense_reconciliations r join public.foreign_trade_expense_reconciliation_lines l on l.reconciliation_id=r.id where r.id=$1 group by r.id",
  [confirmedFundRequest.rows[0].result.reconciliation_id],
);
assert.equal(extractedReconciliation.rows[0].remittance_amount_clp, "16853872.00");
assert.equal(extractedReconciliation.rows[0].lines, 3);
assert.equal(extractedReconciliation.rows[0].taxes, "16377872.00");

await db.query(
  "update public.foreign_trade_expense_reconciliations set remittance_amount_clp=0 where id=$1",
  [confirmedFundRequest.rows[0].result.reconciliation_id],
);
await db.query(
  "update public.foreign_trade_documents set review_result=jsonb_set(review_result,'{general,remittance_amount_clp}','0'::jsonb,true) where id=$1",
  [extractedProvisionDocument.rows[0].id],
);

const extractedSettlementDocument = await db.query("select public.register_foreign_trade_document($1::jsonb) as id", [JSON.stringify({
  operation_id: operationId,
  supplier_id: supplier.rows[0].id,
  document_type: "agency_settlement",
  original_file_name: "rendicion-final-extraida.pdf",
  storage_path: `${operationId}/rendicion-final-extraida.pdf`,
  mime_type: "application/pdf",
  file_size: "8192",
  file_hash: "f".repeat(64),
})]);
await db.exec("set role service_role");
await db.query(
  "select public.set_foreign_trade_document_extraction($1,'extracting','{}'::jsonb,null,'[]'::jsonb,null,null,$2)",
  [extractedSettlementDocument.rows[0].id, "agency-settlement-test"],
);
await db.query(
  "select public.set_foreign_trade_document_extraction($1,'review_required',$2::jsonb,$3,$4::jsonb,null,'gpt-test',$5)",
  [extractedSettlementDocument.rows[0].id, JSON.stringify(preparedAgencySettlement.extraction), preparedAgencySettlement.confidence, JSON.stringify(preparedAgencySettlement.warnings), "agency-settlement-test"],
);
await db.exec("reset role");
const provisionLinesForSettlement = await db.query(
  "select id,concept from public.foreign_trade_expense_reconciliation_lines where reconciliation_id=$1 order by position",
  [confirmedFundRequest.rows[0].result.reconciliation_id],
);
const reviewedSettlement = structuredClone(preparedAgencySettlement.extraction);
reviewedSettlement.lines[0].reconciliation_line_id = provisionLinesForSettlement.rows[0].id;
const confirmedSettlement = await db.query(
  "select public.confirm_foreign_trade_agency_settlement_document($1,$2,$3::jsonb) as result",
  [extractedSettlementDocument.rows[0].id, confirmedFundRequest.rows[0].result.reconciliation_id, JSON.stringify(reviewedSettlement)],
);
assert.equal(confirmedSettlement.rows[0].result.updated_lines, 1);
assert.equal(confirmedSettlement.rows[0].result.inserted_lines, 1);
assert.equal(
  (await db.query("select parse_status from public.foreign_trade_documents where id=$1", [extractedSettlementDocument.rows[0].id])).rows[0].parse_status,
  "confirmed",
);
const settlementReconciliation = await db.query(
  "select final_document_id,provision_reference,final_reference,agency_name,agency_invoice_number,remittance_date::text,final_invoice_date::text,remittance_amount_clp,status,metadata->>'automatic_reconciliation_version' as automation_version from public.foreign_trade_expense_reconciliations where id=$1",
  [confirmedFundRequest.rows[0].result.reconciliation_id],
);
assert.deepEqual(settlementReconciliation.rows[0], {
  provision_reference: "49194",
  final_reference: "49194",
  agency_name: "Agencia de Aduanas",
  remittance_date: "2026-08-20",
  final_invoice_date: "2026-08-22",
  remittance_amount_clp: "16853872.00",
  final_document_id: extractedSettlementDocument.rows[0].id,
  agency_invoice_number: "23177",
  status: "refund_pending",
  automation_version: "document_refs_v1",
});
assert.equal(
  (await db.query("select count(*)::integer as count from public.foreign_trade_expense_reconciliation_lines where reconciliation_id=$1 and actual_total_clp > 0", [confirmedFundRequest.rows[0].result.reconciliation_id])).rows[0].count,
  2,
  "la rendición debe actualizar una provisión coincidente y agregar el costo real no provisionado",
);
const automaticCosts = await db.query(
  "select count(*)::integer as count,sum(amount_clp) as amount from public.foreign_trade_cost_lines where metadata->>'reconciliation_id'=$1 and coalesce((metadata->>'excluded_from_costing')::boolean,false)=false",
  [confirmedFundRequest.rows[0].result.reconciliation_id],
);
assert.deepEqual(automaticCosts.rows[0], { count: 2, amount: "846388.000000" });
const repeatedAutomaticReconciliation = await db.query(
  "select public.auto_finalize_foreign_trade_expense_reconciliation($1,true) as result",
  [confirmedFundRequest.rows[0].result.reconciliation_id],
);
assert.equal(repeatedAutomaticReconciliation.rows[0].result.applied_lines, 2);
assert.equal(
  (await db.query("select count(*)::integer as count from public.foreign_trade_cost_lines where metadata->>'reconciliation_id'=$1", [confirmedFundRequest.rows[0].result.reconciliation_id])).rows[0].count,
  2,
  "la resincronización automática debe ser idempotente",
);

await db.query("select public.update_foreign_trade_document_type($1,$2)", [settlementDocument.rows[0].id, "proforma"]);
const reclassifiedExtractable = await db.query(
  "select document_type,parse_status,extraction_error from public.foreign_trade_documents where id=$1",
  [settlementDocument.rows[0].id],
);
assert.equal(reclassifiedExtractable.rows[0].document_type, "proforma");
assert.equal(reclassifiedExtractable.rows[0].parse_status, "failed");
assert.match(reclassifiedExtractable.rows[0].extraction_error, /Inicia nuevamente/);

await db.query("select public.update_foreign_trade_document_type($1,$2)", [settlementDocument.rows[0].id, "agency_settlement"]);
const reclassifiedSupporting = await db.query(
  "select document_type,parse_status,extraction_error from public.foreign_trade_documents where id=$1",
  [settlementDocument.rows[0].id],
);
assert.equal(reclassifiedSupporting.rows[0].document_type, "agency_settlement");
assert.equal(reclassifiedSupporting.rows[0].parse_status, "uploaded");
assert.equal(reclassifiedSupporting.rows[0].extraction_error, null);

await db.exec("set role service_role");
await db.query(
  "select public.set_foreign_trade_document_extraction($1,'extracting','{}'::jsonb,null,'[]'::jsonb,null,null,$2)",
  [settlementDocument.rows[0].id, "request-before-cancel"],
);
await db.exec("reset role");
await db.query("select public.cancel_foreign_trade_document_extraction($1)", [settlementDocument.rows[0].id]);
const cancelledDocument = await db.query(
  "select parse_status,extraction_request_id,extraction_error from public.foreign_trade_documents where id=$1",
  [settlementDocument.rows[0].id],
);
assert.equal(cancelledDocument.rows[0].parse_status, "failed");
assert.match(cancelledDocument.rows[0].extraction_request_id, /^cancelled:/);
assert.match(cancelledDocument.rows[0].extraction_error, /detenido/i);

await db.exec("set role service_role");
await assert.rejects(
  db.query(
    "select public.set_foreign_trade_document_extraction($1,'review_required',$2::jsonb,$3,$4::jsonb,null,'gpt-test',$5)",
    [settlementDocument.rows[0].id, JSON.stringify(preparedExtraction.extraction), preparedExtraction.confidence, JSON.stringify(preparedExtraction.warnings), "request-before-cancel"],
  ),
  /foreign_trade_document_request_stale_or_unavailable/,
  "una respuesta tardía no debe revivir un análisis cancelado",
);
await db.exec("reset role");
await db.query("select public.update_foreign_trade_document_type($1,$2)", [settlementDocument.rows[0].id, "agency_settlement"]);

const removableDocument = await db.query("select public.register_foreign_trade_document($1::jsonb) as id", [JSON.stringify({
  operation_id: operationId,
  supplier_id: supplier.rows[0].id,
  document_type: "other",
  original_file_name: "documento-reemplazable.pdf",
  storage_path: `${operationId}/documento-reemplazable.pdf`,
  mime_type: "application/pdf",
  file_size: "1024",
  file_hash: "d".repeat(64),
})]);
const deletedDocument = await db.query(
  "select public.delete_foreign_trade_document($1) as result",
  [removableDocument.rows[0].id],
);
assert.equal(deletedDocument.rows[0].result.storage_path, `${operationId}/documento-reemplazable.pdf`);
assert.equal(
  (await db.query("select count(*)::integer as count from public.foreign_trade_documents where id=$1", [removableDocument.rows[0].id])).rows[0].count,
  0,
);
await assert.rejects(
  db.query("select public.delete_foreign_trade_document($1)", [documentId]),
  /foreign_trade_document_not_found_or_confirmed/,
  "un documento confirmado no puede eliminarse",
);

const reconciliationLines = [
  { line_type: "agency_fee", cost_category: "customs_agency", concept: "Factura agencia", provider_name: "Agencia de Aduana", document_number: "23177", source_page: 1, provision_total_clp: 655322, actual_net_clp: 402233, actual_vat_clp: 76424, actual_total_clp: 478657, recoverable_tax: true, include_in_costing: true },
  { line_type: "operating_expense", cost_category: "chile_port", concept: "Servicios portuarios AGUNSA", provider_name: "AGUNSA", document_number: "2082486", source_page: 2, provision_total_clp: 528544, actual_net_clp: 444155, actual_vat_clp: 84389, actual_total_clp: 528544, recoverable_tax: true, include_in_costing: true },
  { line_type: "operating_expense", cost_category: "insurance", concept: "Seguro de transporte", provider_name: "Equal Servicios", document_number: "13366", source_page: 3, provision_total_clp: 319142, actual_net_clp: 319142, actual_vat_clp: 0, actual_total_clp: 319142, actual_amount_original: 329.09, actual_currency: "USD", actual_exchange_rate_clp: null, recoverable_tax: false, include_in_costing: true },
  { line_type: "operating_expense", cost_category: "national_transport", concept: "Transporte contenedor a bodega", provider_name: "Transportes Judith", document_number: "1935", source_page: 4, provision_total_clp: 416500, actual_net_clp: 350000, actual_vat_clp: 66500, actual_total_clp: 416500, recoverable_tax: true, include_in_costing: true },
  { line_type: "operating_expense", cost_category: "chile_port", concept: "Seguridad y control documental", provider_name: "STI", document_number: "4105930", source_page: 5, provision_total_clp: 33534, actual_net_clp: 28180, actual_vat_clp: 5354, actual_total_clp: 33534, recoverable_tax: true, include_in_costing: true },
  { line_type: "operating_expense", cost_category: "chile_port", concept: "DTHC", provider_name: "ADS", document_number: "980", source_page: 6, provision_total_clp: 155000, actual_net_clp: 155000, actual_vat_clp: 0, actual_total_clp: 155000, actual_amount_original: 155, actual_currency: "USD", actual_exchange_rate_clp: 1000, recoverable_tax: false, include_in_costing: true },
  { line_type: "operating_expense", cost_category: "chile_port", concept: "Emisión BL", provider_name: "ADS", document_number: "289", source_page: 7, provision_total_clp: 95200, actual_net_clp: 80000, actual_vat_clp: 15200, actual_total_clp: 95200, recoverable_tax: true, include_in_costing: true },
  { line_type: "customs_duty", cost_category: "duties", concept: "Derechos ad valorem", provider_name: "Tesorería General de la República", document_number: "4470046943-0", source_page: 1, provision_total_clp: 168708, actual_net_clp: 168708, actual_vat_clp: 0, actual_total_clp: 168708, actual_amount_original: 173.91, actual_currency: "USD", actual_exchange_rate_clp: 970.09, recoverable_tax: false, include_in_costing: true },
  { line_type: "import_vat", cost_category: "taxes", concept: "IVA importación", provider_name: "Tesorería General de la República", document_number: "4470046943-0", source_page: 1, provision_total_clp: 15848050, actual_net_clp: 15848050, actual_vat_clp: 0, actual_total_clp: 15848050, actual_amount_original: 16336.68, actual_currency: "USD", actual_exchange_rate_clp: 970.09, recoverable_tax: true, include_in_costing: true },
].map((line, position) => ({
  position,
  provision_net_clp: 0,
  provision_vat_clp: 0,
  provision_amount_original: line.provision_total_clp,
  provision_currency: "CLP",
  provision_exchange_rate_clp: 1,
  actual_amount_original: line.actual_total_clp,
  actual_currency: "CLP",
  actual_exchange_rate_clp: 1,
  notes: null,
  metadata: {},
  ...line,
}));

const mismatchedReconciliation = {
  operation_id: operationId,
  title: "Rendición factura 23177",
  agency_name: "Agencia de Aduana",
  provision_document_id: provisionDocument.rows[0].id,
  final_document_id: settlementDocument.rows[0].id,
  general_estimate_cost_line_id: costId,
  provision_reference: "49194",
  final_reference: "46943",
  agency_invoice_number: "23177",
  remittance_amount_clp: 18220000,
  refund_received_clp: 0,
  status: "reviewed",
  identity_confirmed: false,
  lines: reconciliationLines,
};
await assert.rejects(
  db.query("select public.save_foreign_trade_expense_reconciliation($1::jsonb)", [JSON.stringify(mismatchedReconciliation)]),
  /foreign_trade_reconciliation_identity_mismatch/,
  "referencias distintas deben bloquear una conciliación silenciosa",
);

const savedReconciliation = await db.query(
  "select public.save_foreign_trade_expense_reconciliation($1::jsonb) as id",
  [JSON.stringify({ ...mismatchedReconciliation, identity_confirmed: true })],
);
const reconciliationId = savedReconciliation.rows[0].id;
const reconciliationList = await db.query(
  "select public.foreign_trade_expense_reconciliation_list($1) as items",
  [operationId],
);
assert.equal(reconciliationList.rows[0].items[0].totals.actual_expenses_clp, 1776377);
assert.equal(reconciliationList.rows[0].items[0].totals.actual_taxes_clp, 16016758);
assert.equal(reconciliationList.rows[0].items[0].totals.actual_total_clp, 17793135);
assert.equal(reconciliationList.rows[0].items[0].totals.direct_supplier_total_clp, 250200);
assert.equal(reconciliationList.rows[0].items[0].totals.refund_due_clp, 426865);
const savedMixedCurrencyLines = reconciliationList.rows[0].items[0].lines;
const savedInsuranceLine = savedMixedCurrencyLines.find((line) => line.document_number === "13366");
const savedDthcLine = savedMixedCurrencyLines.find((line) => line.document_number === "980");
assert.equal(Number(savedInsuranceLine.actual_amount_original), 329.09);
assert.equal(savedInsuranceLine.actual_currency, "USD");
assert.equal(savedInsuranceLine.actual_exchange_rate_clp, null);
assert.equal(Number(savedDthcLine.actual_exchange_rate_clp), 1000);

const appliedReconciliation = await db.query(
  "select public.apply_foreign_trade_expense_reconciliation($1) as result",
  [reconciliationId],
);
assert.equal(appliedReconciliation.rows[0].result.applied_lines, 9);
assert.equal(appliedReconciliation.rows[0].result.direct_supplier_total_clp, 250200);
assert.equal(appliedReconciliation.rows[0].result.refund_due_clp, 426865);
const reconciliationState = await db.query(
  "select status from public.foreign_trade_expense_reconciliations where id=$1",
  [reconciliationId],
);
assert.equal(reconciliationState.rows[0].status, "refund_pending");
const appliedCosts = await db.query(
  "select count(*)::integer as count from public.foreign_trade_cost_lines where metadata->>'reconciliation_id'=$1",
  [reconciliationId],
);
assert.equal(appliedCosts.rows[0].count, 9, "aplicar dos veces no debe duplicar costos");
const mixedCurrencyCosts = await db.query(
  "select name, amount_original, currency, exchange_rate_clp, amount_clp, metadata from public.foreign_trade_cost_lines where metadata->>'reconciliation_id'=$1 and name in ('Seguro de transporte','DTHC','Derechos ad valorem') order by name",
  [reconciliationId],
);
const insuranceCost = mixedCurrencyCosts.rows.find((line) => line.name === "Seguro de transporte");
const dthcCost = mixedCurrencyCosts.rows.find((line) => line.name === "DTHC");
const dutiesCost = mixedCurrencyCosts.rows.find((line) => line.name === "Derechos ad valorem");
assert.equal(Number(insuranceCost.amount_original), 329.09);
assert.equal(insuranceCost.currency, "USD");
assert.equal(insuranceCost.exchange_rate_clp, null);
assert.equal(Number(insuranceCost.metadata.implied_exchange_rate_clp), 969.771187);
assert.equal(Number(dthcCost.exchange_rate_clp), 1000);
assert.equal(Number(dthcCost.amount_clp), 155000);
assert.equal(Number(dutiesCost.metadata.conversion_variance_clp), -0.35);
assert.equal(
  (await db.query("select (metadata->>'excluded_from_costing')::boolean as excluded from public.foreign_trade_cost_lines where id=$1", [costId])).rows[0].excluded,
  true,
  "el gasto general queda como historial y sale del costeo activo",
);
await db.query("select public.apply_foreign_trade_expense_reconciliation($1)", [reconciliationId]);
assert.equal(
  (await db.query("select count(*)::integer as count from public.foreign_trade_cost_lines where metadata->>'reconciliation_id'=$1", [reconciliationId])).rows[0].count,
  9,
  "los reintentos de aplicación deben ser idempotentes",
);
const detailAfterReconciliation = await db.query("select public.foreign_trade_operation_detail($1) as detail", [operationId]);
assert.equal(detailAfterReconciliation.rows[0].detail.totals.costs_clp, 18641856);

const freightOperation = await db.query(
  "select public.create_foreign_trade_operation($1::jsonb) as id",
  [JSON.stringify({
    title: "Prueba flete maritimo",
    operation_type: "simulation",
    status: "quotation",
    supplier_id: supplier.rows[0].id,
    exchange_rate_clp: "1000",
    exchange_rate_source: "manual",
  })],
);
const freightOperationId = freightOperation.rows[0].id;
async function insertFreightDocument(suffix) {
  const result = await db.query(`
    insert into public.foreign_trade_documents(
      operation_id,supplier_id,document_type,original_file_name,storage_path,mime_type,
      file_size,parse_status,extraction_result,extraction_confidence,extraction_model,uploaded_by
    ) values ($1,$2,'freight_quote',$3,$4,'application/pdf',637806,'review_required',$5::jsonb,0.99,'gpt-4.1-mini',$6)
    returning id
  `, [
    freightOperationId,
    supplier.rows[0].id,
    `F979-${suffix}.pdf`,
    `${freightOperationId}/F979-${suffix}.pdf`,
    JSON.stringify(freightExtraction.extraction),
    adminId,
  ]);
  return result.rows[0].id;
}
const firstFreightDocumentId = await insertFreightDocument("a");
const firstFreightConfirmation = await db.query(
  "select public.confirm_foreign_trade_freight_document($1,$2::jsonb) as result",
  [firstFreightDocumentId, JSON.stringify(freightExtraction.extraction)],
);
assert.equal(firstFreightConfirmation.rows[0].result.inserted_costs, 1);
assert.equal(firstFreightConfirmation.rows[0].result.total_cost_clp, 4690000);
const secondFreightDocumentId = await insertFreightDocument("b");
const secondFreightConfirmation = await db.query(
  "select public.confirm_foreign_trade_freight_document($1,$2::jsonb) as result",
  [secondFreightDocumentId, JSON.stringify(freightExtraction.extraction)],
);
assert.equal(secondFreightConfirmation.rows[0].result.inserted_costs, 0);
assert.equal(secondFreightConfirmation.rows[0].result.linked_existing_costs, 1, "un respaldo repetido no debe duplicar el flete real");
const freightCosts = await db.query(
  "select amount_original,currency,exchange_rate_clp,amount_clp,allocation_method,metadata from public.foreign_trade_cost_lines where operation_id=$1",
  [freightOperationId],
);
assert.equal(freightCosts.rows.length, 1);
assert.equal(Number(freightCosts.rows[0].amount_original), 4690);
assert.equal(freightCosts.rows[0].currency, "USD");
assert.equal(Number(freightCosts.rows[0].exchange_rate_clp), 1000);
assert.equal(freightCosts.rows[0].allocation_method, "cbm");
assert.equal(freightCosts.rows[0].metadata.document_number, "979");
await db.query("delete from public.import_shipments where id=$1", [freightOperationId]);

const summary = await db.query("select public.foreign_trade_dashboard_summary() as summary");
assert.equal(summary.rows[0].summary.operations_in_preparation, 1);
assert.equal(summary.rows[0].summary.suppliers, 1);
assert.equal(summary.rows[0].summary.total_purchase_usd, 52100.125);

const auditBeforeDelete = await db.query(
  "select count(*)::integer as count from public.foreign_trade_audit_log where record_id=$1",
  [operationId],
);
assert.ok(auditBeforeDelete.rows[0].count >= 2, "debe auditar creacion y escenario activo");

await db.query("delete from public.import_shipments where id=$1", [operationId]);
const deleteAudit = await db.query(
  "select operation_id,new_values,old_values from public.foreign_trade_audit_log where record_id=$1 and action='delete'",
  [operationId],
);
assert.equal(deleteAudit.rows.length, 1, "el delete debe conservar auditoria sin bloquearse");
assert.equal(deleteAudit.rows[0].operation_id, null);
assert.equal(deleteAudit.rows[0].new_values && Object.keys(deleteAudit.rows[0].new_values).length, 0);
assert.equal(deleteAudit.rows[0].old_values.title, "Simulacion contenedor agosto");

await db.exec("select set_config('app.test_role','vendedor',false)");
assert.equal(
  (await db.query("select public.foreign_trade_has_permission('foreign_trade.view') as allowed"))
    .rows[0].allowed,
  false,
  "un vendedor no obtiene permisos sensibles",
);
await db.exec("insert into public.demand_forecasts(sku,expected_units) values ('PRIVADO-001',25)");
await db.exec("set role authenticated");
assert.equal(
  (await db.query("select count(*)::integer as count from public.suppliers")).rows[0].count,
  0,
  "RLS debe ocultar proveedores al rol vendedor",
);
assert.equal(
  (await db.query("select count(*)::integer as count from public.demand_forecasts")).rows[0].count,
  0,
  "RLS debe ocultar proyecciones de compra al rol vendedor",
);
await db.exec("reset role");
await db.exec("select set_config('app.test_role','administrador',false)");

// Conciliacion de productos: equivalencias por proveedor sin tocar el catalogo maestro.
async function createMatchProduct(sku, name, externalId = crypto.randomUUID()) {
  const result = await db.query(
    "insert into public.content_products(external_id,sku,name,category,brand) values ($1,$2,$3,'Herramientas','Clima Activa') returning id",
    [externalId, sku, name],
  );
  return result.rows[0].id;
}
async function createMatchSupplier(name) {
  const result = await db.query(
    "insert into public.suppliers(name,country_code) values ($1,'CN') returning id",
    [name],
  );
  return result.rows[0].id;
}
async function createMatchDocument(supplierId, line) {
  const operation = await db.query(
    "insert into public.import_shipments(supplier_id,reference,title,status) values ($1,$2,$3,'quotation') returning id",
    [supplierId, `MATCH-${crypto.randomUUID()}`, `Conciliacion ${line.product_name}`],
  );
  const operationId = operation.rows[0].id;
  const extraction = {
    extraction_version: "pdf_skill_v11_product_reconciliation",
    general: { supplier_id: supplierId, currency: "USD" },
    lines: [{ source_index: 1, source_page: 1, source_row_label: "1", include: true, remember_link: false, ...line }],
    document_totals: { line_count: 1 },
    warnings: [],
  };
  const document = await db.query(`
    insert into public.foreign_trade_documents(
      operation_id,supplier_id,document_type,original_file_name,storage_path,mime_type,
      file_size,parse_status,extraction_result,uploaded_by
    ) values ($1,$2,'proforma',$3,$4,'application/pdf',1024,'review_required',$5::jsonb,$6)
    returning id
  `, [operationId, supplierId, `match-${crypto.randomUUID()}.pdf`, `${operationId}/${crypto.randomUUID()}.pdf`, JSON.stringify(extraction), adminId]);
  return { operationId, documentId: document.rows[0].id, extraction };
}
async function reconcileMatchDocument(documentId, supplierId) {
  const result = await db.query(
    "select public.reconcile_foreign_trade_document($1,$2) as result",
    [documentId, supplierId],
  );
  return result.rows[0].result;
}
async function confirmMatchDocument(document, productId, remember = true) {
  const line = {
    ...document.extraction.lines[0],
    content_product_id: productId,
    remember_link: remember,
    sku: null,
    quantity: 1,
    unit_price: 1,
    currency: "USD",
    warnings: [],
  };
  return db.query(
    "select public.confirm_foreign_trade_document_with_reconciliation($1,$2::jsonb) as result",
    [document.documentId, JSON.stringify({ ...document.extraction, lines: [line] })],
  );
}

const matchSupplierA = await createMatchSupplier("Proveedor conciliacion A");
const matchSupplierB = await createMatchSupplier("Proveedor conciliacion B");
const exactProductId = await createMatchProduct("RCM-100", "Recuperadora RCM 100 220V");
const voltage110ProductId = await createMatchProduct("MOTOR-110", "Motor condensador industrial 110V");
const voltage220ProductId = await createMatchProduct("MOTOR-220", "Motor condensador industrial 220V");
const vacuumProductId = await createMatchProduct("VAC-9", "Bomba de vacio compacta 9CFM");
await db.query(`
  insert into public.supplier_products(
    supplier_id,sku,supplier_sku,content_product_id,supplier_model,supplier_description,source
  ) values ($1,'VAC-9','MODEL-VAC-9',$2,'VAC-9','Bomba de vacio compacta','document')
`, [matchSupplierA, vacuumProductId]);

assert.equal(
  (await db.query("select public.normalize_foreign_trade_product_text('Bomba 4 CFM 220 V / 50 HZ') as value")).rows[0].value,
  "bomba 4cfm 220v 50hz",
  "las unidades separadas deben normalizarse como atributos técnicos comparables",
);

// 1. Un codigo no se asume como SKU interno: se sugiere y no altera el maestro.
const catalogCountBefore = Number((await db.query("select count(*) as count from public.content_products")).rows[0].count);
const exactDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "RCM-100",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  sku: "RCM-100",
  product_name: "Recuperadora RCM 100 220V",
  description: "Recuperadora RCM 100 220V",
});
const exactMatch = await reconcileMatchDocument(exactDocument.documentId, matchSupplierA);
assert.equal(exactMatch.lines[0].status, "suggested");
assert.equal(exactMatch.lines[0].selected_product_id, null);
const firstConfirmation = await confirmMatchDocument(exactDocument, exactProductId);
assert.equal(firstConfirmation.rows[0].result.inserted_lines, 1);
assert.equal(Number((await db.query("select count(*) as count from public.content_products")).rows[0].count), catalogCountBefore);
const reopenedConfirmation = await confirmMatchDocument(exactDocument, exactProductId);
assert.equal(reopenedConfirmation.rows[0].result.inserted_lines, 0, "reabrir la conciliacion no debe duplicar lineas importadas");

// 2. Codigo diferente y descripcion similar: sugiere, pero no confirma solo.
const similarDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "OTRO-999",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Recuperadora RCM 100 220V",
  description: "Recuperadora RCM 100 220V",
});
const similarMatch = await reconcileMatchDocument(similarDocument.documentId, matchSupplierA);
assert.equal(similarMatch.lines[0].status, "suggested");
assert.equal(similarMatch.lines[0].selected_product_id, null);

// 3. Modelo sin columna SKU: el modelo exacto puede actuar como codigo fuerte.
const modelDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: null,
  supplier_sku: null,
  supplier_reference: null,
  model: "VAC-9",
  product_name: "Bomba de vacio",
  description: "Bomba de vacio compacta",
});
const modelMatch = await reconcileMatchDocument(modelDocument.documentId, matchSupplierA);
assert.equal(modelMatch.lines[0].status, "auto_matched");
assert.equal(modelMatch.lines[0].selected_product_id, vacuumProductId);

// 4. Dos productos parecidos: el atributo tecnico evita elegir el voltaje incorrecto.
const voltageDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "SIN-CODIGO-220",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Motor condensador industrial 220V",
  description: "Motor condensador industrial para equipo 220V",
});
const voltageMatch = await reconcileMatchDocument(voltageDocument.documentId, matchSupplierA);
assert.equal(voltageMatch.lines[0].candidates[0].product_id, voltage220ProductId);
assert.notEqual(voltageMatch.lines[0].candidates[0].product_id, voltage110ProductId);

// 5. El mismo codigo repetido reutiliza la equivalencia confirmada.
const repeatedDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "RCM-100",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Nombre abreviado por proveedor",
  description: "Nombre abreviado por proveedor",
});
const repeatedMatch = await reconcileMatchDocument(repeatedDocument.documentId, matchSupplierA);
assert.equal(repeatedMatch.lines[0].matching_method, "learned_mapping");
assert.equal(repeatedMatch.lines[0].selected_product_id, exactProductId);

// 6. Una equivalencia nunca se comparte entre proveedores distintos.
const isolatedDocument = await createMatchDocument(matchSupplierB, {
  supplier_product_code: "RCM-100",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Nombre abreviado por otro proveedor",
  description: "Nombre abreviado por otro proveedor",
});
const isolatedMatch = await reconcileMatchDocument(isolatedDocument.documentId, matchSupplierB);
assert.notEqual(isolatedMatch.lines[0].matching_method, "learned_mapping");

// 7. Sin codigo: una descripcion confirmada puede aprenderse de forma especifica por proveedor.
const descriptionOnly = {
  supplier_product_code: null,
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Bomba vacio compacta exclusiva 9CFM",
  description: "Bomba vacio compacta exclusiva 9CFM",
};
const descriptionDocument = await createMatchDocument(matchSupplierA, descriptionOnly);
await confirmMatchDocument(descriptionDocument, vacuumProductId);
const descriptionRepeatedDocument = await createMatchDocument(matchSupplierA, descriptionOnly);
const descriptionRepeatedMatch = await reconcileMatchDocument(descriptionRepeatedDocument.documentId, matchSupplierA);
assert.equal(descriptionRepeatedMatch.lines[0].matching_method, "learned_mapping");
assert.equal(descriptionRepeatedMatch.lines[0].selected_product_id, vacuumProductId);

// 8. Una correccion manual queda como la fuente prioritaria en documentos futuros.
const correctionDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "CORR-77",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Motor condensador",
  description: "Motor condensador",
});
await confirmMatchDocument(correctionDocument, voltage110ProductId);
const correctionRepeated = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "CORR-77",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Texto diferente del mismo codigo",
  description: "Texto diferente del mismo codigo",
});
const correctedMatch = await reconcileMatchDocument(correctionRepeated.documentId, matchSupplierA);
assert.equal(correctedMatch.lines[0].matching_method, "learned_mapping");
assert.equal(correctedMatch.lines[0].selected_product_id, voltage110ProductId);

const correctionMapping = await db.query(
  "select id from public.product_supplier_mappings where supplier_id=$1 and normalized_key='CORR77'",
  [matchSupplierA],
);
await db.query("select public.delete_product_supplier_mapping($1)", [correctionMapping.rows[0].id]);
const afterForgetDocument = await createMatchDocument(matchSupplierA, {
  supplier_product_code: "CORR-77",
  supplier_sku: null,
  supplier_reference: null,
  model: null,
  product_name: "Texto sin identidad suficiente",
  description: "Texto sin identidad suficiente",
});
const afterForgetMatch = await reconcileMatchDocument(afterForgetDocument.documentId, matchSupplierA);
assert.notEqual(afterForgetMatch.lines[0].matching_method, "learned_mapping", "una equivalencia eliminada no debe reutilizarse");

await db.query("delete from public.import_shipments where supplier_id in ($1,$2)", [matchSupplierA, matchSupplierB]);
await db.query("delete from public.supplier_products where supplier_id in ($1,$2)", [matchSupplierA, matchSupplierB]);
await db.query("delete from public.suppliers where id in ($1,$2)", [matchSupplierA, matchSupplierB]);
await db.query("delete from public.content_products where id in ($1,$2,$3,$4)", [exactProductId, voltage110ProductId, voltage220ProductId, vacuumProductId]);

const lifecycleOperation = await db.query(
  "select public.create_foreign_trade_operation($1::jsonb) as id",
  [JSON.stringify({
    title: "Operacion eliminable con documentos",
    operation_type: "shipment",
    status: "quotation",
    exchange_rate_clp: "980",
    exchange_rate_source: "manual",
  })],
);
const lifecycleOperationId = lifecycleOperation.rows[0].id;
const lifecycleReference = (await db.query(
  "select reference from public.import_shipments where id=$1",
  [lifecycleOperationId],
)).rows[0].reference;
const confirmedLifecycleDocument = await db.query(
  "select public.register_foreign_trade_document($1::jsonb) as id",
  [JSON.stringify({
    operation_id: lifecycleOperationId,
    document_type: "other",
    original_file_name: "factura-confirmada.pdf",
    storage_path: `${lifecycleOperationId}/factura-confirmada.pdf`,
    mime_type: "application/pdf",
    file_size: "2048",
    file_hash: "e".repeat(64),
  })],
);
const confirmedLifecycleDocumentId = confirmedLifecycleDocument.rows[0].id;
await db.query(
  "update public.foreign_trade_documents set parse_status='confirmed',confirmed_at=now() where id=$1",
  [confirmedLifecycleDocumentId],
);
const lifecycleLine = await db.query(
  "select public.upsert_foreign_trade_operation_line($1::jsonb) as id",
  [JSON.stringify({
    operation_id: lifecycleOperationId,
    product_name: "Producto temporal del documento",
    temporary_product: true,
    quantity: "2",
    currency: "USD",
    unit_factory_cost: "10",
    fob_total: "20",
    cbm_total: "0.04",
    data_source: "document",
  })],
);
await db.query(
  "update public.foreign_trade_operation_lines set source_document_id=$1 where id=$2",
  [confirmedLifecycleDocumentId, lifecycleLine.rows[0].id],
);
await db.query(
  `insert into public.foreign_trade_cost_lines(operation_id,category,name,amount_original,currency,amount_clp,source_type,metadata)
   values ($1,'other','Costo respaldado',1000,'CLP',1000,'real',jsonb_build_object('source_document_id',$2::text))`,
  [lifecycleOperationId, confirmedLifecycleDocumentId],
);

const adminDeletedDocument = await db.query(
  "select public.delete_foreign_trade_document_admin($1) as result",
  [confirmedLifecycleDocumentId],
);
assert.equal(adminDeletedDocument.rows[0].result.was_confirmed, true);
assert.equal(
  Number((await db.query("select count(*) as count from public.foreign_trade_operation_lines where operation_id=$1", [lifecycleOperationId])).rows[0].count),
  0,
  "eliminar un documento confirmado debe retirar sus productos derivados",
);
assert.equal(
  Number((await db.query("select count(*) as count from public.foreign_trade_cost_lines where operation_id=$1 and metadata->>'source_document_id'=$2", [lifecycleOperationId, confirmedLifecycleDocumentId])).rows[0].count),
  0,
  "eliminar un documento confirmado debe retirar sus costos derivados",
);

await db.query(
  "select public.register_foreign_trade_document($1::jsonb)",
  [JSON.stringify({
    operation_id: lifecycleOperationId,
    document_type: "other",
    original_file_name: "respaldo-operacion.pdf",
    storage_path: `${lifecycleOperationId}/respaldo-operacion.pdf`,
    mime_type: "application/pdf",
    file_size: "1024",
    file_hash: "f".repeat(64),
  })],
);
await assert.rejects(
  db.query("select public.delete_foreign_trade_operation($1,$2)", [lifecycleOperationId, "REFERENCIA INCORRECTA"]),
  /foreign_trade_operation_confirmation_mismatch/,
  "la eliminación total exige escribir la referencia exacta",
);
const deletedLifecycleOperation = await db.query(
  "select public.delete_foreign_trade_operation($1,$2) as result",
  [lifecycleOperationId, lifecycleReference],
);
assert.equal(deletedLifecycleOperation.rows[0].result.reference, lifecycleReference);
assert.equal(deletedLifecycleOperation.rows[0].result.documents.length, 1);
assert.equal(
  Number((await db.query("select count(*) as count from public.import_shipments where id=$1", [lifecycleOperationId])).rows[0].count),
  0,
);
assert.equal(
  Number((await db.query("select count(*) as count from public.foreign_trade_audit_log where origin='crm_admin_delete' and old_values->>'reference'=$1", [lifecycleReference])).rows[0].count),
  1,
  "la eliminación debe conservar una auditoría sin secretos",
);

console.log("Centro de Comercio Exterior: migracion, permisos, RPC y auditoria OK");
