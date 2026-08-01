-- Ejecutar una vez en Supabase SQL Editor.
-- Guarda de forma privada la compra real acordada con el proveedor y conserva
-- el snapshot de la sugerencia que estaba visible al momento de subirla.

begin;

create table if not exists public.foreign_trade_actual_orders (
  id uuid primary key default gen_random_uuid(),
  supplier text not null default 'Chinafore',
  suggested_task_id text,
  suggested_generated_at date,
  suggested_snapshot jsonb not null default '{}'::jsonb,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'under_review', 'confirmed', 'rejected')),
  notes text,
  actual_summary jsonb not null default '{}'::jsonb,
  comparison_summary jsonb not null default '{}'::jsonb,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(suggested_snapshot) = 'object'),
  check (jsonb_typeof(actual_summary) = 'object'),
  check (jsonb_typeof(comparison_summary) = 'object'),
  check (file_size is null or (file_size > 0 and file_size <= 26214400))
);

create index if not exists foreign_trade_actual_orders_created_idx
  on public.foreign_trade_actual_orders (created_at desc);
create index if not exists foreign_trade_actual_orders_task_idx
  on public.foreign_trade_actual_orders (suggested_task_id);

drop trigger if exists set_foreign_trade_actual_orders_updated_at
  on public.foreign_trade_actual_orders;
create trigger set_foreign_trade_actual_orders_updated_at
before update on public.foreign_trade_actual_orders
for each row execute function public.set_updated_at();

alter table public.foreign_trade_actual_orders enable row level security;

drop policy if exists "authenticated read foreign trade orders" on public.foreign_trade_actual_orders;
drop policy if exists "admins read foreign trade orders" on public.foreign_trade_actual_orders;
create policy "admins read foreign trade orders"
on public.foreign_trade_actual_orders for select to authenticated
using (public.current_role() = 'administrador');

drop policy if exists "admins insert foreign trade orders" on public.foreign_trade_actual_orders;
create policy "admins insert foreign trade orders"
on public.foreign_trade_actual_orders for insert to authenticated
with check (public.current_role() = 'administrador' and uploaded_by = auth.uid());

drop policy if exists "admins update foreign trade orders" on public.foreign_trade_actual_orders;
create policy "admins update foreign trade orders"
on public.foreign_trade_actual_orders for update to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "admins delete foreign trade orders" on public.foreign_trade_actual_orders;
create policy "admins delete foreign trade orders"
on public.foreign_trade_actual_orders for delete to authenticated
using (public.current_role() = 'administrador');

revoke all on public.foreign_trade_actual_orders from anon;
grant select, insert, update, delete on public.foreign_trade_actual_orders to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'foreign-trade-orders',
  'foreign-trade-orders',
  false,
  26214400,
  array[
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read private foreign trade files" on storage.objects;
drop policy if exists "admins read private foreign trade files" on storage.objects;
create policy "admins read private foreign trade files"
on storage.objects for select to authenticated
using (bucket_id = 'foreign-trade-orders' and public.current_role() = 'administrador');

drop policy if exists "admins upload private foreign trade files" on storage.objects;
create policy "admins upload private foreign trade files"
on storage.objects for insert to authenticated
with check (bucket_id = 'foreign-trade-orders' and public.current_role() = 'administrador');

drop policy if exists "admins update private foreign trade files" on storage.objects;
create policy "admins update private foreign trade files"
on storage.objects for update to authenticated
using (bucket_id = 'foreign-trade-orders' and public.current_role() = 'administrador')
with check (bucket_id = 'foreign-trade-orders' and public.current_role() = 'administrador');

drop policy if exists "admins delete private foreign trade files" on storage.objects;
create policy "admins delete private foreign trade files"
on storage.objects for delete to authenticated
using (bucket_id = 'foreign-trade-orders' and public.current_role() = 'administrador');

comment on table public.foreign_trade_actual_orders is
  'Ordenes/proformas reales acordadas. Conservan el snapshot de la sugerencia para conciliacion humana posterior.';

commit;

select
  to_regclass('public.foreign_trade_actual_orders') as actual_orders_table,
  (select public from storage.buckets where id = 'foreign-trade-orders') as bucket_public,
  (select file_size_limit from storage.buckets where id = 'foreign-trade-orders') as max_file_size;
