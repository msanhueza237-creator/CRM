import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  findSimilarDraft,
  nextScheduleAt,
  selectRotatedProduct,
  textSimilarity,
} from "../supabase/functions/content-center/content-logic.ts";
import {
  classifyInstagramContainerStatus,
  isFacebookPublishPermissionMissing,
  isInstagramMediaNotReady,
} from "../supabase/functions/content-center/social-publishing-logic.ts";

const db = new PGlite();
await db.exec(`
  create role authenticated;
  create role service_role;
  create role anon;
  create schema if not exists auth;
  create type public.app_role as enum ('administrador','vendedor','visualizador');
  create table public.profiles (
    id uuid primary key default gen_random_uuid(),
    full_name text not null default '',
    role public.app_role not null default 'visualizador',
    active boolean not null default true
  );
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function public.current_role() returns public.app_role language sql stable as $$ select 'administrador'::public.app_role $$;
  create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create table public.integration_connections (
    provider text primary key check (provider in ('facto','tiendanube','gmail','brave','meta_whatsapp')),
    enabled boolean not null default false,
    read_only boolean not null default true,
    status text not null default 'pending_configuration',
    message text not null default '',
    last_checked_at timestamptz,
    last_success_at timestamptz
  );
  create table public.integration_records (
    id uuid primary key default gen_random_uuid(),
    provider text not null references public.integration_connections(provider),
    resource text not null,
    external_id text not null,
    payload jsonb not null,
    payload_hash text not null,
    updated_at timestamptz not null default now(),
    unique(provider, resource, external_id)
  );
  insert into public.integration_connections(provider, enabled, read_only, status, message)
  values ('tiendanube', true, true, 'connected', 'Catálogo conectado');
`);

const migration = (await readFile(new URL("../supabase/content_center.sql", import.meta.url), "utf8"))
  .replace(/create extension if not exists pgcrypto;/i, "");
await db.exec(migration);
await db.exec(migration);

const seeded = await db.query("select count(*)::integer as count from public.content_templates");
assert.equal(seeded.rows[0].count, 15, "debe sembrar exactamente 15 plantillas sin duplicarlas");

const productPayload = {
  name: { es: "Bomba de vacío ST-4BMC" },
  description: { es: "Bomba inalámbrica para trabajos de climatización." },
  handle: { es: "bomba-de-vacio-st-4bmc" },
  categories: [{ name: { es: "Herramientas" } }],
  brand: "Super Stars",
  images: [{ src: "https://cdn.example.test/st-4bmc.jpg" }],
  variants: [{ sku: "ST-4BMC", price: "299990.00", promotional_price: "279990.00", stock: "7" }],
  published: true,
  updated_at: "2026-08-20T12:00:00Z",
};
const infiniteStockPayload = {
  name: { es: "Bomba de vacío sin control de inventario" },
  description: { es: "Producto disponible con stock ilimitado confirmado por Tiendanube." },
  handle: { es: "bomba-vacio-stock-ilimitado" },
  categories: [{ name: { es: "Herramientas" } }],
  images: [{ src: "https://cdn.example.test/infinite.jpg" }],
  variants: [{ sku: "INF-102", price: "99990.00", promotional_price: null, stock_management: false, stock: null }],
  published: true,
  updated_at: "2026-08-20T12:00:00Z",
};
await db.query(
  "insert into public.integration_records(provider,resource,external_id,payload,payload_hash) values ('tiendanube','products','101',$1::jsonb,'hash-1')",
  [JSON.stringify(productPayload)],
);
await db.query(
  "insert into public.integration_records(provider,resource,external_id,payload,payload_hash) values ('tiendanube','products','102',$1::jsonb,'hash-2')",
  [JSON.stringify(infiniteStockPayload)],
);

const firstSync = await db.query("select * from public.sync_content_products_from_tiendanube()");
assert.deepEqual(firstSync.rows[0], { synchronized: 2, incomplete: 0 });
const normalized = await db.query("select external_id,sku,name,category,price,promotional_price,stock,has_stock,product_url,sync_status from public.content_products where external_id='101'");
assert.equal(normalized.rows.length, 1);
assert.equal(normalized.rows[0].sku, "ST-4BMC");
assert.equal(normalized.rows[0].stock, 7);
assert.equal(normalized.rows[0].has_stock, true);
assert.equal(normalized.rows[0].product_url, "https://climactiva.cl/productos/bomba-de-vacio-st-4bmc");
const infiniteStock = await db.query("select stock,has_stock from public.content_products where external_id='102'");
assert.deepEqual(infiniteStock.rows[0], { stock: 0, has_stock: true }, "el stock ilimitado debe seguir disponible");

const secondSync = await db.query("select * from public.sync_content_products_from_tiendanube()");
assert.equal(secondSync.rows[0].synchronized, 2, "la sincronización repetida conserva el total oficial");
const noDuplicates = await db.query("select count(*)::integer as count from public.content_products");
assert.equal(noDuplicates.rows[0].count, 2, "no debe duplicar productos");

await db.exec("delete from public.integration_records where provider='tiendanube' and resource='products' and external_id='101'");
await db.query("select * from public.sync_content_products_from_tiendanube()");
const removed = await db.query("select source_status from public.content_products where external_id='101'");
assert.equal(removed.rows[0].source_status, "deleted", "un producto ausente debe quedar retirado");

const channel = await db.query("select id from public.content_channels where code='instagram'");
const product = await db.query("select id from public.content_products where external_id='101'");
await db.query(`
  insert into public.content_publications(product_id,channel_id,body,content_fingerprint,status,scheduled_at)
  values ($1,$2,'Contenido verificado de prueba','fingerprint-1','scheduled',now() - interval '1 minute')
`, [product.rows[0].id, channel.rows[0].id]);
const enqueued = await db.query("select public.enqueue_due_content_publications() as count");
const enqueuedAgain = await db.query("select public.enqueue_due_content_publications() as count");
assert.equal(enqueued.rows[0].count, 1);
assert.equal(enqueuedAgain.rows[0].count, 0, "la cola debe ignorar una clave idempotente repetida");

const claimed = await db.query("select * from public.claim_content_job('test-worker', 120)");
assert.equal(claimed.rows.length, 1);
const job = claimed.rows[0];
await db.query("select public.complete_content_job($1,'test-worker',$2,$3::jsonb)", [job.job.id, job.lease_token, JSON.stringify({ ok: true })]);
const completed = await db.query("select status,attempts from public.content_jobs where id=$1", [job.job.id]);
assert.deepEqual(completed.rows[0], { status: "completed", attempts: 1 });

const now = Date.parse("2026-08-20T12:00:00Z");
const products = [
  { id: "recent", name: "Reciente", category: "Bombas", stock: 10 },
  { id: "never", name: "Nunca publicado", category: "Herramientas", stock: 3 },
];
const publications = [{ product_id: "recent", status: "published", published_at: "2026-08-19T12:00:00Z" }];
const channels = [{ id: "instagram" }];
const rules = new Map([["instagram", { min_product_gap_days: 14 }]]);
assert.equal(selectRotatedProduct(products, publications, channels, rules, now)?.id, "never");

const schedule = {
  recurrence_type: "interval_days",
  recurrence_rule: { interval_days: 4, times: ["19:30"] },
  timezone: "America/Santiago",
  starts_at: "2026-08-20T23:30:00Z",
  ends_at: null,
};
assert.equal(nextScheduleAt(schedule, new Date("2026-08-20T23:31:00Z"))?.toISOString(), "2026-08-24T23:30:00.000Z");
assert.ok(textSimilarity("Conoce esta bomba de vacío profesional", "Conoce esta bomba de vacio profesional") > 0.95);
assert.equal(findSimilarDraft([{ body: "Conoce esta bomba de vacío profesional" }], [{ body: "Conoce esta bomba de vacio profesional" }], 0.8)?.similarity, 1);
assert.deepEqual(classifyInstagramContainerStatus({ status_code: "IN_PROGRESS" }), {
  state: "pending",
  statusCode: "IN_PROGRESS",
  message: "",
});
assert.deepEqual(classifyInstagramContainerStatus({ status_code: "FINISHED", status: "Ready" }), {
  state: "ready",
  statusCode: "FINISHED",
  message: "Ready",
});
assert.equal(classifyInstagramContainerStatus({ status_code: "ERROR" }).state, "failed");
assert.equal(isInstagramMediaNotReady(new Error("Media ID is not available")), true);
assert.equal(
  isFacebookPublishPermissionMissing(new Error("(#200) The permission(s) pages_manage_posts are not available.")),
  true,
);
assert.equal(isFacebookPublishPermissionMissing(new Error("Meta rechazo la operacion.")), false);

await db.close();
console.log("Centro de Contenido: esquema, catálogo, cola y rotación verificados.");
