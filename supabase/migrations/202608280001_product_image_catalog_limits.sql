begin;

-- Keep the preflight result valid until both enforcement triggers are installed.
lock table public.products in share row exclusive mode;
lock table public.product_images in share row exclusive mode;

-- Safety gate only: this migration never reconciles or deletes production data.
do $$
begin
  if exists (
    select 1
    from public.product_images
    group by product_id
    having count(*) > 4
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRODUCT_IMAGE_PREEXISTING_LIMIT_VIOLATION';
  end if;

  if (select count(*) from public.products) > 3000 then
    raise exception using
      errcode = 'P0001',
      message = 'PRODUCT_CATALOG_PREEXISTING_LIMIT_VIOLATION';
  end if;
end;
$$;

create or replace function public.enforce_product_catalog_capacity_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Every physical row-count change uses the same transaction-scoped lock.
  perform pg_advisory_xact_lock(hashtextextended('car-zone:product-catalog-capacity:v1', 0));

  if tg_op = 'INSERT' and (select count(*) from public.products) >= 3000 then
    raise exception using
      errcode = 'P0001',
      message = 'PRODUCT_CATALOG_LIMIT_REACHED';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_product_catalog_capacity_v1() from public;

drop trigger if exists products_enforce_catalog_capacity_v1 on public.products;
create trigger products_enforce_catalog_capacity_v1
before insert or delete on public.products
for each row execute function public.enforce_product_catalog_capacity_v1();

create or replace function public.enforce_product_image_capacity_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_product_id uuid := case when tg_op in ('DELETE', 'UPDATE') then old.product_id else null end;
  target_product_id uuid := case when tg_op in ('INSERT', 'UPDATE') then new.product_id else null end;
  source_lock bigint;
  target_lock bigint;
begin
  source_lock := case when source_product_id is null then null
    else hashtextextended('car-zone:product-images:' || source_product_id::text, 0) end;
  target_lock := case when target_product_id is null then null
    else hashtextextended('car-zone:product-images:' || target_product_id::text, 0) end;

  if source_lock is not null and target_lock is not null and source_lock <> target_lock then
    perform pg_advisory_xact_lock(least(source_lock, target_lock));
    perform pg_advisory_xact_lock(greatest(source_lock, target_lock));
  elsif coalesce(target_lock, source_lock) is not null then
    perform pg_advisory_xact_lock(coalesce(target_lock, source_lock));
  end if;

  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.product_id is distinct from old.product_id) then
    if (select count(*) from public.product_images where product_id = target_product_id) >= 4 then
      raise exception using
        errcode = 'P0001',
        message = 'PRODUCT_IMAGE_LIMIT_EXCEEDED';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_product_image_capacity_v1() from public;

drop trigger if exists product_images_enforce_capacity_insert_delete_v1 on public.product_images;
create trigger product_images_enforce_capacity_insert_delete_v1
before insert or delete on public.product_images
for each row execute function public.enforce_product_image_capacity_v1();

drop trigger if exists product_images_enforce_capacity_move_v1 on public.product_images;
create trigger product_images_enforce_capacity_move_v1
before update of product_id on public.product_images
for each row execute function public.enforce_product_image_capacity_v1();

-- The canonical V3 save delegates to V2. Validate the complete payload before
-- the V1 mutation function deletes/reinserts image rows.
create or replace function public.save_product_catalog_v2_locked(
  target_product_id uuid,
  product_data jsonb,
  images_data jsonb default null
)
returns table (
  product_id uuid,
  removed_asset_ids text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved record;
  normalized_tax_category text := lower(trim(coalesce(product_data->>'tax_category', '')));
  normalized_tracks_inventory boolean;
begin
  if images_data is not null then
    if jsonb_typeof(images_data) <> 'array' then
      raise exception using errcode = '22023', message = 'Las imagenes del producto no son validas.';
    end if;
    if jsonb_array_length(images_data) > 4 then
      raise exception using errcode = 'P0001', message = 'PRODUCT_IMAGE_LIMIT_EXCEEDED';
    end if;
  end if;

  if normalized_tax_category not in ('standard', 'exempt') then
    raise exception using errcode = '22023',
      message = 'La clasificacion fiscal debe ser standard o exempt.';
  end if;
  begin
    normalized_tracks_inventory := coalesce(
      (product_data->>'tracks_inventory')::boolean, true
    );
  exception when others then
    raise exception using errcode = '22023',
      message = 'El modo de inventario del producto no es valido.';
  end;

  select * into saved
  from public.save_product_catalog_locked(target_product_id, product_data, images_data);

  update public.products
  set tax_category = normalized_tax_category,
      tracks_inventory = normalized_tracks_inventory
  where id = saved.product_id
    and row(tax_category, tracks_inventory)
      is distinct from row(normalized_tax_category, normalized_tracks_inventory);

  product_id := saved.product_id;
  removed_asset_ids := saved.removed_asset_ids;
  return next;
end;
$$;

revoke all on function public.save_product_catalog_v2_locked(uuid, jsonb, jsonb)
  from public, anon;
grant execute on function public.save_product_catalog_v2_locked(uuid, jsonb, jsonb)
  to authenticated, service_role;

comment on function public.enforce_product_catalog_capacity_v1() is
  'Serializes physical product row-count changes and rejects product 3001 without affecting updates.';
comment on function public.enforce_product_image_capacity_v1() is
  'Serializes product image row-count changes per product and rejects image 5.';

commit;
