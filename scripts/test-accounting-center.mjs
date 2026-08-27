import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = (await readFile(new URL("../supabase/accounting_center.sql", import.meta.url), "utf8"))
  .replace(/create extension if not exists pgcrypto;/i, "");
const factoHistoryMigration = await readFile(new URL("../supabase/accounting_facto_history.sql", import.meta.url), "utf8");
const edgeSource = await readFile(new URL("../supabase/functions/accounting-center/index.ts", import.meta.url), "utf8");
const parserSource = await readFile(new URL("../supabase/functions/accounting-center/bank-parsers.ts", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../src/modules/accounting/AccountingCenterPage.tsx", import.meta.url), "utf8");

assert.match(edgeSource, /route === "facto\/sync"/);
assert.match(edgeSource, /accounting_facto_sync_runs/);
assert.match(edgeSource, /accounting_facto_sync_records/);
assert.match(edgeSource, /fromDate/);
assert.match(edgeSource, /selectAllRows/);
assert.match(edgeSource, /facto:.*purchase.*sale|facto:.*sale.*purchase/);
assert.match(edgeSource, /route === "foreign-trade\/sync"/);
assert.match(edgeSource, /route === "accounts\/create"/);
assert.match(edgeSource, /route === "imports\/preview"/);
assert.match(edgeSource, /route === "reconciliation\/confirm"/);
assert.match(edgeSource, /route === "checks\/create"/);
assert.match(edgeSource, /accounting_create_journal_entry/);
assert.match(edgeSource, /saldo_acumulado_clp/);
assert.match(parserSource, /banco_estado/);
assert.match(parserSource, /scotiabank/);
assert.match(parserSource, /mercado_pago/);
assert.match(parserSource, /fingerprint/);
assert.match(pageSource, /Balance de 8 columnas/);
assert.match(pageSource, /Estado de Resultados/);
assert.match(pageSource, /Flujo de Caja bancario/);
assert.match(pageSource, /Nueva cuenta/);
assert.match(pageSource, /Factura, pago, movimiento bancario, conciliación y asiento/);
assert.match(pageSource, /Carga histórica con respaldo/);
assert.match(pageSource, /2026-01-01/);

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
