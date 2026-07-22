-- Ejecutar en Supabase SQL Editor.
-- Habilita adjuntos persistentes para el modulo Campanas.

alter table public.campaigns
  add column if not exists product text,
  add column if not exists coupon text,
  add column if not exists attachments jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campaigns_attachments_is_array'
      and conrelid = 'public.campaigns'::regclass
  ) then
    alter table public.campaigns
      add constraint campaigns_attachments_is_array
      check (jsonb_typeof(attachments) = 'array')
      not valid;
  end if;
end $$;

alter table public.campaigns validate constraint campaigns_attachments_is_array;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'campaign-attachments',
  'campaign-attachments',
  true,
  20971520,
  array[
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated can read campaign attachments" on storage.objects;
create policy "authenticated can read campaign attachments"
on storage.objects for select to authenticated
using (bucket_id = 'campaign-attachments');

drop policy if exists "admins can upload campaign attachments" on storage.objects;
create policy "admins can upload campaign attachments"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'campaign-attachments'
  and public.current_role() = 'administrador'
);

drop policy if exists "admins can update campaign attachments" on storage.objects;
create policy "admins can update campaign attachments"
on storage.objects for update to authenticated
using (
  bucket_id = 'campaign-attachments'
  and public.current_role() = 'administrador'
)
with check (
  bucket_id = 'campaign-attachments'
  and public.current_role() = 'administrador'
);

drop policy if exists "admins can delete campaign attachments" on storage.objects;
create policy "admins can delete campaign attachments"
on storage.objects for delete to authenticated
using (
  bucket_id = 'campaign-attachments'
  and public.current_role() = 'administrador'
);

comment on column public.campaigns.attachments is
  'Lista JSON de adjuntos de campanas: [{ "name": "...", "url": "..." }].';
