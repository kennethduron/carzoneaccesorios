-- Granular product capabilities for operational accountant access.
-- This migration grants no stock, inventory, deletion, security, or technical capability to contadora.

update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || '[
        "products:read",
        "products:create",
        "products:update",
        "products:import",
        "products:images_manage",
        "products:export"
      ]'::jsonb
    ) as expanded(permission)
  ) deduplicated
),
updated_at = now()
where name = 'contadora';

drop policy if exists "Admins can manage products" on public.products;
drop policy if exists "Product staff can read all products" on public.products;
drop policy if exists "Product creators can create products" on public.products;
drop policy if exists "Product editors can update products" on public.products;
drop policy if exists "Product deleters can delete products" on public.products;

create policy "Product staff can read all products"
  on public.products for select
  using (
    public.has_permission('products:read')
    or public.has_permission('products:manage')
  );

create policy "Product creators can create products"
  on public.products for insert
  with check (
    public.has_permission('products:create')
    or public.has_permission('products:manage')
  );

create policy "Product editors can update products"
  on public.products for update
  using (
    public.has_permission('products:update')
    or public.has_permission('products:manage')
  )
  with check (
    public.has_permission('products:update')
    or public.has_permission('products:manage')
  );

create policy "Product deleters can delete products"
  on public.products for delete
  using (
    public.has_permission('products:delete')
    or public.has_permission('products:manage')
  );

drop policy if exists "Admins can manage product images" on public.product_images;
drop policy if exists "Product staff can read all product images" on public.product_images;
drop policy if exists "Product image managers can insert product images" on public.product_images;
drop policy if exists "Product image managers can update product images" on public.product_images;
drop policy if exists "Product image managers can delete product images" on public.product_images;

create policy "Product staff can read all product images"
  on public.product_images for select
  using (
    public.has_permission('products:read')
    or public.has_permission('products:images_manage')
    or public.has_permission('products:delete')
    or public.has_permission('products:manage')
  );

create policy "Product image managers can insert product images"
  on public.product_images for insert
  with check (
    public.has_permission('products:images_manage')
    or public.has_permission('products:manage')
  );

create policy "Product image managers can update product images"
  on public.product_images for update
  using (
    public.has_permission('products:images_manage')
    or public.has_permission('products:manage')
  )
  with check (
    public.has_permission('products:images_manage')
    or public.has_permission('products:manage')
  );

create policy "Product image managers can delete product images"
  on public.product_images for delete
  using (
    public.has_permission('products:images_manage')
    or public.has_permission('products:manage')
  );

-- Authenticated table writes intentionally omit stock and reservation columns.
-- Inventory changes must continue through the locked inventory RPCs.
revoke insert, update on public.products from authenticated;

grant insert (
  category_id,
  sku,
  internal_code,
  slug,
  name,
  brand,
  vehicle_brand,
  vehicle_model,
  vehicle_year_start,
  vehicle_year_end,
  short_description,
  description,
  features,
  specifications,
  compatibility_notes,
  low_stock_threshold,
  min_stock,
  cost_price,
  retail_price,
  wholesale_price,
  wholesale_min_quantity,
  is_new,
  status,
  active
) on public.products to authenticated;

grant update (
  category_id,
  sku,
  internal_code,
  slug,
  name,
  brand,
  vehicle_brand,
  vehicle_model,
  vehicle_year_start,
  vehicle_year_end,
  short_description,
  description,
  features,
  specifications,
  compatibility_notes,
  low_stock_threshold,
  min_stock,
  cost_price,
  retail_price,
  wholesale_price,
  wholesale_min_quantity,
  is_new,
  status,
  active
) on public.products to authenticated;

create or replace function public.save_product_catalog_locked(
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
set search_path = public
as $$
declare
  is_service_role boolean := coalesce(auth.role() = 'service_role', false);
  saved_product_id uuid;
  old_asset_ids text[] := array[]::text[];
  image_record record;
  image_count integer := 0;
begin
  if product_data is null or jsonb_typeof(product_data) <> 'object' then
    raise exception 'Los datos del producto no son validos.';
  end if;

  if target_product_id is null then
    if not (
      is_service_role
      or public.has_permission('products:create')
      or public.has_permission('products:manage')
    ) then
      raise exception 'No tienes permiso para crear productos.';
    end if;
  elsif not (
    is_service_role
    or public.has_permission('products:update')
    or public.has_permission('products:manage')
  ) then
    raise exception 'No tienes permiso para actualizar productos.';
  end if;

  if images_data is not null and not (
    is_service_role
    or public.has_permission('products:images_manage')
    or public.has_permission('products:manage')
  ) then
    raise exception 'No tienes permiso para administrar imagenes de productos.';
  end if;

  if nullif(trim(product_data->>'sku'), '') is null
    or nullif(trim(product_data->>'name'), '') is null
    or nullif(trim(product_data->>'brand'), '') is null then
    raise exception 'SKU, nombre y marca son obligatorios.';
  end if;

  if target_product_id is null then
    insert into public.products (
      category_id,
      sku,
      internal_code,
      slug,
      name,
      brand,
      vehicle_brand,
      vehicle_model,
      vehicle_year_start,
      vehicle_year_end,
      short_description,
      description,
      features,
      specifications,
      compatibility_notes,
      low_stock_threshold,
      min_stock,
      cost_price,
      retail_price,
      wholesale_price,
      wholesale_min_quantity,
      is_new,
      status,
      active
    )
    values (
      nullif(product_data->>'category_id', '')::uuid,
      trim(product_data->>'sku'),
      nullif(trim(product_data->>'internal_code'), ''),
      trim(product_data->>'slug'),
      trim(product_data->>'name'),
      trim(product_data->>'brand'),
      nullif(trim(product_data->>'vehicle_brand'), ''),
      nullif(trim(product_data->>'vehicle_model'), ''),
      nullif(product_data->>'vehicle_year_start', '')::integer,
      nullif(product_data->>'vehicle_year_end', '')::integer,
      nullif(trim(product_data->>'short_description'), ''),
      coalesce(product_data->>'description', ''),
      nullif(trim(product_data->>'features'), ''),
      nullif(trim(product_data->>'specifications'), ''),
      nullif(trim(product_data->>'compatibility_notes'), ''),
      greatest(coalesce((product_data->>'low_stock_threshold')::integer, 0), 0),
      greatest(coalesce((product_data->>'min_stock')::integer, 0), 0),
      greatest(coalesce((product_data->>'cost_price')::numeric, 0), 0),
      greatest(coalesce((product_data->>'retail_price')::numeric, 0), 0),
      greatest(coalesce((product_data->>'wholesale_price')::numeric, 0), 0),
      greatest(coalesce((product_data->>'wholesale_min_quantity')::integer, 1), 1),
      coalesce((product_data->>'is_new')::boolean, false),
      coalesce(nullif(product_data->>'status', '')::public.product_status, 'active'::public.product_status),
      coalesce((product_data->>'active')::boolean, true)
    )
    returning id into saved_product_id;
  else
    perform 1
    from public.products
    where id = target_product_id
    for update;

    if not found then
      raise exception 'Producto no encontrado.';
    end if;

    update public.products
    set category_id = nullif(product_data->>'category_id', '')::uuid,
        sku = trim(product_data->>'sku'),
        internal_code = nullif(trim(product_data->>'internal_code'), ''),
        slug = trim(product_data->>'slug'),
        name = trim(product_data->>'name'),
        brand = trim(product_data->>'brand'),
        vehicle_brand = nullif(trim(product_data->>'vehicle_brand'), ''),
        vehicle_model = nullif(trim(product_data->>'vehicle_model'), ''),
        vehicle_year_start = nullif(product_data->>'vehicle_year_start', '')::integer,
        vehicle_year_end = nullif(product_data->>'vehicle_year_end', '')::integer,
        short_description = nullif(trim(product_data->>'short_description'), ''),
        description = coalesce(product_data->>'description', ''),
        features = nullif(trim(product_data->>'features'), ''),
        specifications = nullif(trim(product_data->>'specifications'), ''),
        compatibility_notes = nullif(trim(product_data->>'compatibility_notes'), ''),
        low_stock_threshold = greatest(coalesce((product_data->>'low_stock_threshold')::integer, 0), 0),
        min_stock = greatest(coalesce((product_data->>'min_stock')::integer, 0), 0),
        cost_price = greatest(coalesce((product_data->>'cost_price')::numeric, 0), 0),
        retail_price = greatest(coalesce((product_data->>'retail_price')::numeric, 0), 0),
        wholesale_price = greatest(coalesce((product_data->>'wholesale_price')::numeric, 0), 0),
        wholesale_min_quantity = greatest(coalesce((product_data->>'wholesale_min_quantity')::integer, 1), 1),
        is_new = coalesce((product_data->>'is_new')::boolean, false),
        status = coalesce(nullif(product_data->>'status', '')::public.product_status, status),
        active = coalesce((product_data->>'active')::boolean, active),
        updated_at = now()
    where id = target_product_id;

    saved_product_id := target_product_id;
  end if;

  if images_data is not null then
    if jsonb_typeof(images_data) <> 'array' then
      raise exception 'Las imagenes del producto no son validas.';
    end if;

    image_count := jsonb_array_length(images_data);
    if image_count > 5 then
      raise exception 'Solo puedes guardar hasta 5 imagenes por producto.';
    end if;

    select coalesce(
      array_agg(distinct coalesce(product_images.public_id, product_images.storage_path))
        filter (where coalesce(product_images.public_id, product_images.storage_path) is not null),
      array[]::text[]
    )
    into old_asset_ids
    from public.product_images
    where public.product_images.product_id = saved_product_id;

    delete from public.product_images
    where public.product_images.product_id = saved_product_id;

    for image_record in
      select value as image, ordinality - 1 as fallback_order
      from jsonb_array_elements(images_data) with ordinality
    loop
      if nullif(trim(image_record.image->>'public_url'), '') is null
        or nullif(trim(coalesce(image_record.image->>'storage_path', image_record.image->>'public_id')), '') is null then
        raise exception 'Cada imagen necesita una URL y una identidad de almacenamiento validas.';
      end if;

      insert into public.product_images (
        product_id,
        storage_bucket,
        storage_path,
        public_id,
        public_url,
        angle,
        alt_text,
        sort_order,
        is_primary
      )
      values (
        saved_product_id,
        'product-images',
        trim(coalesce(image_record.image->>'storage_path', image_record.image->>'public_id')),
        nullif(trim(image_record.image->>'public_id'), ''),
        trim(image_record.image->>'public_url'),
        coalesce(nullif(trim(image_record.image->>'angle'), ''), 'principal'),
        nullif(trim(image_record.image->>'alt_text'), ''),
        greatest(coalesce((image_record.image->>'sort_order')::integer, image_record.fallback_order::integer), 0),
        coalesce((image_record.image->>'is_primary')::boolean, image_record.fallback_order = 0)
      );
    end loop;
  end if;

  product_id := saved_product_id;
  removed_asset_ids := old_asset_ids;
  return next;
end;
$$;

revoke all on function public.save_product_catalog_locked(uuid, jsonb, jsonb) from public;
grant execute on function public.save_product_catalog_locked(uuid, jsonb, jsonb) to authenticated, service_role;

create or replace function public.set_product_stock_locked(
  target_product_id uuid,
  target_stock integer,
  movement_notes text default null
)
returns table (
  movement_id uuid,
  stock_before integer,
  stock_after integer,
  quantity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  locked_product record;
  delta integer;
  new_movement_id uuid;
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('products:adjust_stock')
    or public.has_permission('products:manage')
    or public.has_permission('inventory:manage')
  ) then
    raise exception 'No tienes permiso para ajustar stock.';
  end if;

  if target_product_id is null then
    raise exception 'Selecciona un producto.';
  end if;

  if target_stock is null or target_stock < 0 then
    raise exception 'El stock no puede ser negativo.';
  end if;

  select id, stock, coalesce(reserved_stock, 0) as reserved_stock
  into locked_product
  from public.products
  where id = target_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.';
  end if;

  if target_stock < locked_product.reserved_stock then
    raise exception 'No puedes dejar el stock total por debajo de las unidades reservadas (%).', locked_product.reserved_stock;
  end if;

  stock_before := locked_product.stock;
  stock_after := target_stock;
  delta := stock_after - stock_before;

  if delta = 0 then
    movement_id := null;
    quantity := 0;
    return next;
    return;
  end if;

  update public.products
  set stock = stock_after,
      updated_at = now()
  where id = target_product_id;

  insert into public.inventory_movements (
    product_id,
    user_id,
    movement_type,
    quantity,
    stock_before,
    stock_after,
    reference_type,
    reference_id,
    notes
  )
  values (
    target_product_id,
    actor_id,
    'adjustment',
    delta,
    stock_before,
    stock_after,
    'products',
    target_product_id,
    left(nullif(trim(coalesce(movement_notes, '')), ''), 500)
  )
  returning id into new_movement_id;

  movement_id := new_movement_id;
  quantity := delta;
  return next;
end;
$$;

revoke all on function public.set_product_stock_locked(uuid, integer, text) from public;
grant execute on function public.set_product_stock_locked(uuid, integer, text) to authenticated, service_role;

comment on function public.save_product_catalog_locked(uuid, jsonb, jsonb) is
  'Atomically creates or updates commercial product data and optional image references. Stock and reservations are never accepted.';
comment on function public.set_product_stock_locked(uuid, integer, text) is
  'Adjusts stock with row locking and inventory history; requires explicit stock, inventory, or legacy product management permission.';
