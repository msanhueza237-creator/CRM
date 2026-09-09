-- A failed detail request falls back to a products-list row in the hub worker.
-- Keep the previous detail and its original dates, atomically for every writer.
create or replace function public.preserve_facto_product_details()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.provider = 'facto' and new.provider = old.provider
     and old.resource = 'product_details' and new.resource = old.resource
     and old.external_id = new.external_id
     and coalesce(old.payload->>'product_id', '') = old.external_id
     and coalesce(new.payload->>'product_id', '') = new.external_id
     and nullif(upper(trim(old.payload->>'sku')), '') = upper(trim(new.payload->>'sku'))
     and jsonb_typeof(old.payload->'inventories'->'details') = 'array'
     and (case when jsonb_typeof(old.payload->'inventories'->'details') = 'array'
              then jsonb_array_length(old.payload->'inventories'->'details') > 0
              else false end)
     and not (new.payload ? 'inventories') and not (new.payload ? 'price')
  then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_facto_product_details on public.integration_records;
create trigger preserve_facto_product_details
before update on public.integration_records
for each row execute function public.preserve_facto_product_details();
