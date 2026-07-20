create or replace function public.import_product_row_atomic(
  product_data jsonb,
  images_data jsonb,
  target_stock integer,
  import_mode text default 'create_and_update'
)
returns table (
  product_id uuid,
  row_status text,
  stock_applied boolean,
  stock_unchanged boolean,
  movement_id uuid,
  stock_before integer,
  stock_after integer,
  quantity integer,
  removed_asset_ids text[],
  consumed_asset_ids text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_sku text;
  existing_product_id uuid;
  category_is_official boolean := false;
  can_adjust_stock boolean := false;
  catalog_result record;
  stock_result record;
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('products:import')
    or public.has_permission('products:manage')
  ) then
    raise exception 'No tienes permiso para importar productos.';
  end if;

  if product_data is null or jsonb_typeof(product_data) <> 'object' then
    raise exception 'Los datos del producto no son validos.';
  end if;

  if import_mode not in ('create_and_update', 'create_only', 'update_only') then
    raise exception 'El modo de importacion no es valido.';
  end if;

  normalized_sku := upper(nullif(trim(product_data->>'sku'), ''));
  if normalized_sku is null then
    raise exception 'El SKU es obligatorio.';
  end if;
  product_data := product_data || jsonb_build_object('sku', normalized_sku);

  select exists (
    select 1
    from public.categories
    where id = nullif(product_data->>'category_id', '')::uuid
      and active = true
      and (slug, name) in (
        ('exterior', 'Exterior'),
        ('interior', 'Interior'),
        ('iluminacion', 'Iluminación'),
        ('polarizado-y-herramientas', 'Polarizado y Herramientas'),
        ('carroceria', 'Carrocería'),
        ('seguridad', 'Seguridad'),
        ('audio-y-sonido', 'Audio y Sonido')
      )
  ) into category_is_official;

  if not category_is_official then
    raise exception 'Selecciona una categoria oficial activa.';
  end if;

  can_adjust_stock :=
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('products:adjust_stock')
    or public.has_permission('products:manage')
    or public.has_permission('inventory:manage');

  if can_adjust_stock and target_stock is null then
    raise exception 'El stock es obligatorio para esta importacion.';
  end if;
  if not can_adjust_stock and target_stock is not null then
    raise exception 'No tienes permiso para ajustar stock.';
  end if;
  if target_stock is not null and (target_stock < 0 or target_stock > 2147483647) then
    raise exception 'El stock no es valido.';
  end if;

  select id
  into existing_product_id
  from public.products
  where sku = normalized_sku
  for update;

  if existing_product_id is not null and import_mode = 'create_only' then
    product_id := existing_product_id;
    row_status := 'skipped';
    stock_applied := false;
    stock_unchanged := false;
    removed_asset_ids := array[]::text[];
    consumed_asset_ids := array[]::text[];
    return next;
    return;
  end if;

  if existing_product_id is null and import_mode = 'update_only' then
    product_id := null;
    row_status := 'skipped';
    stock_applied := false;
    stock_unchanged := false;
    removed_asset_ids := array[]::text[];
    consumed_asset_ids := array[]::text[];
    return next;
    return;
  end if;

  select * into catalog_result
  from public.save_product_catalog_locked(existing_product_id, product_data, images_data);

  product_id := catalog_result.product_id;
  row_status := case when existing_product_id is null then 'created' else 'updated' end;
  removed_asset_ids := coalesce(catalog_result.removed_asset_ids, array[]::text[]);

  select coalesce(
    array_agg(distinct nullif(trim(coalesce(value->>'public_id', value->>'storage_path')), ''))
      filter (where nullif(trim(coalesce(value->>'public_id', value->>'storage_path')), '') is not null),
    array[]::text[]
  )
  into consumed_asset_ids
  from jsonb_array_elements(coalesce(images_data, '[]'::jsonb));

  if target_stock is not null then
    select * into stock_result
    from public.set_product_stock_locked(
      product_id,
      target_stock,
      'Ajuste de stock por importacion de productos'
    );
    movement_id := stock_result.movement_id;
    stock_before := stock_result.stock_before;
    stock_after := stock_result.stock_after;
    quantity := stock_result.quantity;
    stock_applied := true;
    stock_unchanged := stock_result.movement_id is null;
  else
    stock_applied := false;
    stock_unchanged := false;
  end if;

  return next;
end;
$$;

revoke all on function public.import_product_row_atomic(jsonb, jsonb, integer, text) from public;
grant execute on function public.import_product_row_atomic(jsonb, jsonb, integer, text) to authenticated, service_role;

comment on function public.import_product_row_atomic(jsonb, jsonb, integer, text) is
  'Atomically imports one product row, its optional images, and its absolute stock target.';
