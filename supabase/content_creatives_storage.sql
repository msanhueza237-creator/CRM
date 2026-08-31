-- Centro de Contenido - almacenamiento de piezas visuales terminadas.
-- Ejecutar despues de content_center.sql. Es idempotente y no altera publicaciones historicas.

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'content-creatives',
  'content-creatives',
  true,
  12582912,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists content_creatives_read on storage.objects;
create policy content_creatives_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'content-creatives'
    and public.content_has_permission('content.view')
  );

drop policy if exists content_creatives_upload on storage.objects;
create policy content_creatives_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'content-creatives'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.content_has_permission('content.generate')
  );

drop policy if exists content_creatives_update on storage.objects;
create policy content_creatives_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'content-creatives'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.content_has_permission('content.edit')
  )
  with check (
    bucket_id = 'content-creatives'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.content_has_permission('content.edit')
  );

drop policy if exists content_creatives_delete on storage.objects;
create policy content_creatives_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'content-creatives'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.content_has_permission('content.edit')
  );
