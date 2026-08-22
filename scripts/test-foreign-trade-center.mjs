import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { prepareExtraction } from "../supabase/functions/foreign-trade-documents/extraction-logic.ts";

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
  })],
);
const costId = costResult.rows[0].id;
const cost = await db.query(
  "select amount_original,amount_clp,allocation_method from public.foreign_trade_cost_lines where id=$1",
  [costId],
);
assert.deepEqual(cost.rows[0], {
  amount_original: "100.000000",
  amount_clp: "98025.000000",
  allocation_method: "cbm",
});

const detail = await db.query("select public.foreign_trade_operation_detail($1) as detail", [operationId]);
assert.equal(detail.rows[0].detail.lines.length, 1);
assert.equal(detail.rows[0].detail.costs.length, 1);
assert.equal(detail.rows[0].detail.totals.registered_merchandise, 84);
assert.equal(detail.rows[0].detail.totals.total_cbm, 0.048);
assert.equal(detail.rows[0].detail.totals.costs_clp, 98025);

const preparedExtraction = prepareExtraction({
  general: { supplier_name: "Proveedor prueba", currency: "USD", confidence: 0.9, warnings: [] },
  lines: [{
    source_index: 1,
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
  document_totals: { cbm_total: 0.1 },
  warnings: [],
});
assert.equal(preparedExtraction.extraction.lines[0].recalculated_cbm_total, 0.048);
assert.ok(preparedExtraction.warnings.some((warning) => warning.code === "line_total_mismatch"));
assert.ok(preparedExtraction.warnings.some((warning) => warning.code === "cbm_mismatch"));

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

console.log("Centro de Comercio Exterior: migracion, permisos, RPC y auditoria OK");
