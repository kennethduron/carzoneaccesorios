-- Centralize product public-state automation around real available inventory and
-- make purchase creation/editing update inventory atomically.

alter table public.products
  add column if not exists auto_disabled_by_stock boolean not null default false;

comment on column public.products.auto_disabled_by_stock is
  'True only when inventory availability automatically disabled the product. Existing inactive products remain manual (false).';

with normalized_products as (
  update public.products
  set active = false,
      status = 'inactive',
      auto_disabled_by_stock = true,
      updated_at = now()
  where active = true
    and status = 'active'
    and greatest(stock - coalesce(reserved_stock, 0), 0) = 0
  returning id, stock, reserved_stock
)
insert into public.audit_logs (
  user_id,
  actor_role,
  table_name,
  record_id,
  action,
  old_data,
  new_data
)
select
  null,
  'system',
  'products',
  id,
  'product.auto_deactivated_by_stock',
  jsonb_build_object('active', true, 'auto_disabled_by_stock', false),
  jsonb_build_object(
    'active', false,
    'status', 'inactive',
    'auto_disabled_by_stock', true,
    'stock', stock,
    'reserved_stock', reserved_stock,
    'available_stock', 0,
    'origin', 'migration_backfill'
  )
from normalized_products;

create or replace function public.audit_automatic_product_stock_state(
  product_row_id uuid,
  action_name text,
  previous_state jsonb,
  next_state jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    auth.uid(),
    public.current_actor_role(),
    'products',
    product_row_id,
    action_name,
    previous_state,
    jsonb_build_object(
      'automatic', true,
      'origin', coalesce(nullif(current_setting('app.inventory_origin', true), ''), 'inventory_change'),
      'reference_id', nullif(current_setting('app.inventory_reference_id', true), '')
    ) || next_state
  );
end;
$$;

revoke all on function public.audit_automatic_product_stock_state(uuid, text, jsonb, jsonb) from public;

create or replace function public.sync_product_state_from_available_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_available integer;
  next_available integer;
  previous_state jsonb;
  next_state jsonb;
  automatic_action text;
begin
  previous_available := case
    when tg_op = 'INSERT' then null
    else greatest(coalesce(old.stock, 0) - coalesce(old.reserved_stock, 0), 0)
  end;
  next_available := greatest(coalesce(new.stock, 0) - coalesce(new.reserved_stock, 0), 0);

  previous_state := case
    when tg_op = 'INSERT' then null
    else jsonb_build_object(
      'stock', old.stock,
      'reserved_stock', old.reserved_stock,
      'available_stock', previous_available,
      'active', old.active,
      'status', old.status,
      'auto_disabled_by_stock', old.auto_disabled_by_stock
    )
  end;

  if next_available <= 0 then
    if coalesce(new.active, false) or coalesce(new.auto_disabled_by_stock, false) then
      new.active := false;
      new.status := 'inactive';
      new.auto_disabled_by_stock := true;

      if tg_op = 'INSERT'
        or old.active is distinct from new.active
        or old.auto_disabled_by_stock is distinct from new.auto_disabled_by_stock
      then
        automatic_action := 'product.auto_deactivated_by_stock';
      end if;
    end if;
  elsif tg_op = 'UPDATE' and coalesce(new.auto_disabled_by_stock, false) then
    new.active := true;
    new.status := 'active';
    new.auto_disabled_by_stock := false;
    automatic_action := 'product.auto_reactivated_by_stock';
  end if;

  if automatic_action is not null then
    next_state := jsonb_build_object(
      'stock', new.stock,
      'reserved_stock', new.reserved_stock,
      'available_stock', next_available,
      'active', new.active,
      'status', new.status,
      'auto_disabled_by_stock', new.auto_disabled_by_stock
    );
    perform public.audit_automatic_product_stock_state(
      new.id,
      automatic_action,
      previous_state,
      next_state
    );
  end if;

  return new;
end;
$$;

revoke all on function public.sync_product_state_from_available_stock() from public;

create or replace function public.mark_product_state_as_manual()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_available integer;
  previous_state jsonb;
  next_state jsonb;
  active_changed boolean;
  status_changed boolean;
begin
  active_changed := new.active is distinct from old.active;
  status_changed := new.status is distinct from old.status;

  if not active_changed and not status_changed then
    return new;
  end if;

  if active_changed and status_changed then
    if coalesce(new.active, false) is distinct from (new.status = 'active') then
      raise exception 'El estado activo y el estado de catalogo del producto deben coincidir.';
    end if;
  elsif active_changed then
    new.status := case
      when coalesce(new.active, false) then 'active'::public.product_status
      else 'inactive'::public.product_status
    end;
  else
    new.active := new.status = 'active';
  end if;

  next_available := greatest(coalesce(new.stock, 0) - coalesce(new.reserved_stock, 0), 0);
  new.auto_disabled_by_stock := false;

  -- Manual activation remains an available control, but a zero-availability
  -- product cannot remain publicly active.
  if coalesce(new.active, false) and next_available <= 0 then
    previous_state := jsonb_build_object(
      'stock', old.stock,
      'reserved_stock', old.reserved_stock,
      'available_stock', greatest(coalesce(old.stock, 0) - coalesce(old.reserved_stock, 0), 0),
      'active', old.active,
      'status', old.status,
      'auto_disabled_by_stock', old.auto_disabled_by_stock
    );

    new.active := false;
    new.status := 'inactive';
    new.auto_disabled_by_stock := true;

    next_state := jsonb_build_object(
      'stock', new.stock,
      'reserved_stock', new.reserved_stock,
      'available_stock', next_available,
      'active', new.active,
      'status', new.status,
      'auto_disabled_by_stock', new.auto_disabled_by_stock
    );

    perform public.audit_automatic_product_stock_state(
      new.id,
      'product.auto_deactivated_by_stock',
      previous_state,
      next_state || jsonb_build_object('origin', 'manual_activation_without_stock')
    );
  end if;

  return new;
end;
$$;

revoke all on function public.mark_product_state_as_manual() from public;

drop trigger if exists products_mark_manual_state on public.products;
create trigger products_mark_manual_state
before update of active, status on public.products
for each row
execute function public.mark_product_state_as_manual();

drop trigger if exists products_sync_state_from_stock on public.products;
create trigger products_sync_state_from_stock
before insert or update of stock, reserved_stock on public.products
for each row
execute function public.sync_product_state_from_available_stock();

alter table public.products
  drop constraint if exists products_active_status_consistency;
alter table public.products
  add constraint products_active_status_consistency
  check (
    (active = true and status = 'active')
    or (active = false and status <> 'active')
  );

create or replace function public.save_purchase_with_inventory(
  target_purchase_id uuid,
  purchase_data jsonb,
  items_data jsonb
)
returns table (
  purchase_id uuid,
  purchase_number text,
  purchase_status text,
  purchase_total numeric,
  was_created boolean,
  affected_products jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  supplier_row public.suppliers%rowtype;
  purchase_row public.purchases%rowtype;
  locked_product record;
  item_record record;
  delta_record record;
  movement_row_id uuid;
  old_items_data jsonb := '[]'::jsonb;
  normalized_items jsonb := '[]'::jsonb;
  next_purchase_id uuid;
  next_supplier_id uuid;
  next_purchase_number text;
  next_purchase_date date;
  next_subtotal numeric(12, 2);
  next_tax_amount numeric(12, 2);
  next_discount_amount numeric(12, 2);
  next_shipping_amount numeric(12, 2);
  next_total numeric(12, 2);
  next_currency text;
  next_notes text;
  stock_after_value integer;
  movement_type_value public.inventory_movement_type;
  affected jsonb := '[]'::jsonb;
  created_value boolean := false;
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('purchases:manage')
  ) then
    raise exception 'No tienes permiso para registrar compras.';
  end if;

  if purchase_data is null or jsonb_typeof(purchase_data) <> 'object' then
    raise exception 'Los datos de la compra no son validos.';
  end if;

  if items_data is null or jsonb_typeof(items_data) <> 'array' or jsonb_array_length(items_data) = 0 then
    raise exception 'Agrega al menos una linea a la compra.';
  end if;

  begin
    next_supplier_id := nullif(trim(purchase_data->>'supplier_id'), '')::uuid;
    next_purchase_date := nullif(trim(purchase_data->>'purchase_date'), '')::date;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'Proveedor o fecha de compra no validos.';
  end;

  next_purchase_number := nullif(trim(purchase_data->>'purchase_number'), '');
  next_shipping_amount := round(coalesce((purchase_data->>'shipping_amount')::numeric, 0), 2);
  next_currency := coalesce(nullif(trim(purchase_data->>'currency'), ''), 'HNL');
  next_notes := nullif(trim(coalesce(purchase_data->>'notes', '')), '');

  if next_supplier_id is null or next_purchase_number is null or next_purchase_date is null then
    raise exception 'Proveedor, numero y fecha de compra son obligatorios.';
  end if;

  if next_shipping_amount < 0 then
    raise exception 'El importe de envio de la compra no puede ser negativo.';
  end if;

  select *
  into supplier_row
  from public.suppliers
  where id = next_supplier_id
  for share;

  if not found then
    raise exception 'El proveedor seleccionado no existe.';
  end if;

  if not supplier_row.is_active then
    raise exception 'El proveedor seleccionado esta inactivo.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', parsed.item_id,
        'provided_id', parsed.provided_id,
        'product_id', parsed.product_id,
        'description', parsed.description,
        'quantity', parsed.quantity,
        'unit_cost', parsed.unit_cost,
        'tax_amount', parsed.tax_amount,
        'discount_amount', parsed.discount_amount,
        'total_cost', parsed.total_cost
      )
      order by parsed.ordinality
    ),
    '[]'::jsonb
  )
  into normalized_items
  from (
    select
      case
        when target_purchase_id is null or nullif(trim(item->>'id'), '') is null then gen_random_uuid()
        else (item->>'id')::uuid
      end as item_id,
      target_purchase_id is not null and nullif(trim(item->>'id'), '') is not null as provided_id,
      nullif(trim(item->>'product_id'), '')::uuid as product_id,
      nullif(trim(item->>'description'), '') as description,
      round(coalesce((item->>'quantity')::numeric, 0), 2) as quantity,
      round(coalesce((item->>'unit_cost')::numeric, 0), 2) as unit_cost,
      round(coalesce((item->>'tax_amount')::numeric, 0), 2) as tax_amount,
      round(coalesce((item->>'discount_amount')::numeric, 0), 2) as discount_amount,
      greatest(
        round(
          coalesce((item->>'quantity')::numeric, 0) * coalesce((item->>'unit_cost')::numeric, 0)
          + coalesce((item->>'tax_amount')::numeric, 0)
          - coalesce((item->>'discount_amount')::numeric, 0),
          2
        ),
        0
      ) as total_cost,
      ordinality
    from jsonb_array_elements(items_data) with ordinality as source(item, ordinality)
  ) parsed;

  if exists (
    select 1
    from jsonb_array_elements(normalized_items) as source(item)
    group by item->>'id'
    having count(*) > 1
  ) then
    raise exception 'La solicitud contiene IDs de lineas duplicados.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(normalized_items) as source(item)
    where nullif(trim(item->>'description'), '') is null
      or (item->>'quantity')::numeric <= 0
      or (item->>'unit_cost')::numeric < 0
      or (item->>'tax_amount')::numeric < 0
      or (item->>'discount_amount')::numeric < 0
      or (item->>'total_cost')::numeric < 0
  ) then
    raise exception 'Revisa las cantidades y costos de las lineas de compra.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(normalized_items) as source(item)
    where nullif(item->>'product_id', '') is not null
      and (item->>'quantity')::numeric <> trunc((item->>'quantity')::numeric)
  ) then
    raise exception 'La cantidad de un producto de inventario debe ser un numero entero.';
  end if;

  select
    round(coalesce(sum((item->>'quantity')::numeric * (item->>'unit_cost')::numeric), 0), 2),
    round(coalesce(sum((item->>'tax_amount')::numeric), 0), 2),
    round(coalesce(sum((item->>'discount_amount')::numeric), 0), 2)
  into next_subtotal, next_tax_amount, next_discount_amount
  from jsonb_array_elements(normalized_items) as source(item);

  next_total := greatest(
    round(next_subtotal + next_tax_amount + next_shipping_amount - next_discount_amount, 2),
    0
  );

  if target_purchase_id is null then
    insert into public.purchases (
      supplier_id,
      purchase_number,
      purchase_date,
      status,
      subtotal,
      tax_amount,
      discount_amount,
      shipping_amount,
      total,
      currency,
      notes,
      created_by
    )
    values (
      next_supplier_id,
      next_purchase_number,
      next_purchase_date,
      'draft',
      next_subtotal,
      next_tax_amount,
      next_discount_amount,
      next_shipping_amount,
      next_total,
      next_currency,
      next_notes,
      actor_id
    )
    returning * into purchase_row;

    next_purchase_id := purchase_row.id;
    created_value := true;
  else
    select *
    into purchase_row
    from public.purchases
    where id = target_purchase_id
    for update;

    if not found then
      raise exception 'La compra no existe.';
    end if;

    if purchase_row.status <> 'draft' then
      raise exception 'Solo se pueden editar compras en borrador.';
    end if;

    next_purchase_id := purchase_row.id;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', purchase_items.id,
          'product_id', purchase_items.product_id,
          'description', purchase_items.description,
          'quantity', purchase_items.quantity,
          'unit_cost', purchase_items.unit_cost,
          'tax_amount', purchase_items.tax_amount,
          'discount_amount', purchase_items.discount_amount,
          'total_cost', purchase_items.total_cost
        )
      ),
      '[]'::jsonb
    )
    into old_items_data
    from public.purchase_items
    where purchase_items.purchase_id = next_purchase_id;

    update public.purchases
    set supplier_id = next_supplier_id,
        purchase_number = next_purchase_number,
        purchase_date = next_purchase_date,
        subtotal = next_subtotal,
        tax_amount = next_tax_amount,
        discount_amount = next_discount_amount,
        shipping_amount = next_shipping_amount,
        total = next_total,
        currency = next_currency,
        notes = next_notes,
        updated_at = now()
    where id = next_purchase_id
    returning * into purchase_row;
  end if;

  if target_purchase_id is not null and exists (
    select 1
    from jsonb_array_elements(normalized_items) as source(item)
    where coalesce((item->>'provided_id')::boolean, false)
      and not exists (
      select 1
      from public.purchase_items
      where purchase_items.id = (item->>'id')::uuid
        and purchase_items.purchase_id = next_purchase_id
    )
  ) then
    raise exception 'Una linea editada no pertenece a la compra.';
  end if;

  delete from public.purchase_items
  where purchase_items.purchase_id = next_purchase_id
    and not exists (
      select 1
      from jsonb_array_elements(normalized_items) as source(item)
      where (item->>'id')::uuid = purchase_items.id
    );

  for item_record in
    select
      (item->>'id')::uuid as id,
      nullif(item->>'product_id', '')::uuid as product_id,
      item->>'description' as description,
      (item->>'quantity')::numeric as quantity,
      (item->>'unit_cost')::numeric as unit_cost,
      (item->>'tax_amount')::numeric as tax_amount,
      (item->>'discount_amount')::numeric as discount_amount,
      (item->>'total_cost')::numeric as total_cost
    from jsonb_array_elements(normalized_items) as source(item)
  loop
    insert into public.purchase_items (
      id,
      purchase_id,
      product_id,
      description,
      quantity,
      unit_cost,
      tax_amount,
      discount_amount,
      total_cost
    )
    values (
      item_record.id,
      next_purchase_id,
      item_record.product_id,
      item_record.description,
      item_record.quantity,
      item_record.unit_cost,
      item_record.tax_amount,
      item_record.discount_amount,
      item_record.total_cost
    )
    on conflict (id) do update
    set product_id = excluded.product_id,
        description = excluded.description,
        quantity = excluded.quantity,
        unit_cost = excluded.unit_cost,
        tax_amount = excluded.tax_amount,
        discount_amount = excluded.discount_amount,
        total_cost = excluded.total_cost;
  end loop;

  perform set_config('app.inventory_origin', 'purchase', true);
  perform set_config('app.inventory_reference_id', next_purchase_id::text, true);

  for delta_record in
    with old_quantities as (
      select
        nullif(item->>'product_id', '')::uuid as product_id,
        sum((item->>'quantity')::numeric)::integer as quantity,
        case
          when sum((item->>'quantity')::numeric) > 0
          then sum((item->>'quantity')::numeric * (item->>'unit_cost')::numeric)
            / sum((item->>'quantity')::numeric)
          else null
        end as unit_cost
      from jsonb_array_elements(old_items_data) as source(item)
      where nullif(item->>'product_id', '') is not null
      group by nullif(item->>'product_id', '')::uuid
    ),
    new_quantities as (
      select
        nullif(item->>'product_id', '')::uuid as product_id,
        sum((item->>'quantity')::numeric)::integer as quantity,
        case
          when sum((item->>'quantity')::numeric) > 0
          then sum((item->>'quantity')::numeric * (item->>'unit_cost')::numeric)
            / sum((item->>'quantity')::numeric)
          else null
        end as unit_cost
      from jsonb_array_elements(normalized_items) as source(item)
      where nullif(item->>'product_id', '') is not null
      group by nullif(item->>'product_id', '')::uuid
    )
    select
      coalesce(new_quantities.product_id, old_quantities.product_id) as product_id,
      coalesce(new_quantities.quantity, 0) - coalesce(old_quantities.quantity, 0) as quantity_delta,
      coalesce(new_quantities.unit_cost, old_quantities.unit_cost) as unit_cost
    from old_quantities
    full join new_quantities using (product_id)
    where coalesce(new_quantities.quantity, 0) <> coalesce(old_quantities.quantity, 0)
    order by coalesce(new_quantities.product_id, old_quantities.product_id)
  loop
    select
      id,
      slug,
      category_id,
      name,
      stock,
      coalesce(reserved_stock, 0) as reserved_stock,
      active,
      auto_disabled_by_stock,
      cost_price
    into locked_product
    from public.products
    where id = delta_record.product_id
    for update;

    if not found then
      raise exception 'Uno de los productos de la compra ya no existe.';
    end if;

    stock_after_value := locked_product.stock + delta_record.quantity_delta;

    if stock_after_value < locked_product.reserved_stock then
      raise exception 'La edicion dejaria el stock de % por debajo de sus unidades reservadas (%).',
        locked_product.name,
        locked_product.reserved_stock;
    end if;

    movement_type_value := case
      when created_value and delta_record.quantity_delta > 0 then 'purchase'::public.inventory_movement_type
      else 'adjustment'::public.inventory_movement_type
    end;

    update public.products
    set stock = stock_after_value,
        updated_at = now()
    where id = locked_product.id;

    insert into public.inventory_movements (
      product_id,
      user_id,
      movement_type,
      quantity,
      stock_before,
      stock_after,
      reference_type,
      reference_id,
      unit_cost_snapshot,
      total_cost_snapshot,
      cost_source,
      cost_captured_at,
      notes
    )
    values (
      locked_product.id,
      actor_id,
      movement_type_value,
      delta_record.quantity_delta,
      locked_product.stock,
      stock_after_value,
      'purchase',
      next_purchase_id,
      round(coalesce(delta_record.unit_cost, locked_product.cost_price, 0), 2),
      round(abs(delta_record.quantity_delta) * coalesce(delta_record.unit_cost, locked_product.cost_price, 0), 2),
      case when created_value then 'purchase_item' else 'purchase_item_edit_delta' end,
      now(),
      left(
        case
          when created_value then 'Entrada por compra ' || next_purchase_number
          else 'Ajuste por edicion de compra ' || next_purchase_number
        end,
        500
      )
    )
    returning id into movement_row_id;

    update public.purchase_items
    set inventory_movement_id = movement_row_id
    where purchase_items.purchase_id = next_purchase_id
      and purchase_items.product_id = locked_product.id;

    insert into public.audit_logs (
      user_id,
      actor_role,
      table_name,
      record_id,
      action,
      old_data,
      new_data
    )
    values (
      actor_id,
      public.current_actor_role(),
      'inventory_movements',
      movement_row_id,
      'inventory.purchase_movement_created',
      jsonb_build_object('stock', locked_product.stock),
      jsonb_build_object(
        'purchase_id', next_purchase_id,
        'purchase_number', next_purchase_number,
        'product_id', locked_product.id,
        'quantity', delta_record.quantity_delta,
        'stock', stock_after_value,
        'origin', case when created_value then 'purchase_create' else 'purchase_edit' end
      )
    );

    affected := affected || jsonb_build_array(
      jsonb_build_object(
        'id', locked_product.id,
        'slug', locked_product.slug,
        'category_id', locked_product.category_id,
        'stock_before', locked_product.stock,
        'stock_after', stock_after_value
      )
    );
  end loop;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'purchases',
    next_purchase_id,
    case when created_value then 'purchase.registered_with_inventory' else 'purchase.updated_with_inventory' end,
    case
      when created_value then null
      else jsonb_build_object('items', old_items_data)
    end,
    jsonb_build_object(
      'purchase_number', next_purchase_number,
      'status', purchase_row.status,
      'total', next_total,
      'items', normalized_items,
      'affected_products', affected
    )
  );

  purchase_id := next_purchase_id;
  purchase_number := next_purchase_number;
  purchase_status := purchase_row.status;
  purchase_total := next_total;
  was_created := created_value;
  affected_products := affected;
  return next;
end;
$$;

revoke all on function public.save_purchase_with_inventory(uuid, jsonb, jsonb) from public;
grant execute on function public.save_purchase_with_inventory(uuid, jsonb, jsonb) to authenticated, service_role;

comment on function public.save_purchase_with_inventory(uuid, jsonb, jsonb) is
  'Atomically creates or edits a draft purchase, applies only inventory deltas, records movements, and relies on centralized stock-state triggers.';

-- Purchase mutations are only valid through the transactional domain RPCs.
revoke insert, update, delete on public.purchases from authenticated, service_role;
revoke insert, update, delete on public.purchase_items from authenticated, service_role;

drop policy if exists purchases_insert on public.purchases;
drop policy if exists purchases_update on public.purchases;
drop policy if exists purchase_items_insert on public.purchase_items;
drop policy if exists purchase_items_update on public.purchase_items;

create or replace function public.confirm_purchase_locked(target_purchase_id uuid)
returns table (
  purchase_id uuid,
  purchase_number text,
  purchase_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  purchase_row public.purchases%rowtype;
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('purchases:manage')
  ) then
    raise exception 'No tienes permiso para confirmar compras.';
  end if;

  select *
  into purchase_row
  from public.purchases
  where id = target_purchase_id
  for update;

  if not found then
    raise exception 'La compra no existe.';
  end if;

  if purchase_row.status <> 'draft' then
    raise exception 'Solo se pueden confirmar compras en borrador.';
  end if;

  if not exists (
    select 1
    from public.purchase_items
    where purchase_items.purchase_id = purchase_row.id
  ) then
    raise exception 'Agrega al menos una linea antes de confirmar.';
  end if;

  update public.purchases
  set status = 'confirmed',
      confirmed_by = actor_id,
      confirmed_at = now(),
      updated_at = now()
  where id = purchase_row.id
  returning * into purchase_row;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'purchases',
    purchase_row.id,
    'purchases.confirm',
    jsonb_build_object('status', 'draft'),
    jsonb_build_object(
      'purchase_number', purchase_row.purchase_number,
      'status', purchase_row.status,
      'confirmed_at', purchase_row.confirmed_at
    )
  );

  purchase_id := purchase_row.id;
  purchase_number := purchase_row.purchase_number;
  purchase_status := purchase_row.status;
  return next;
end;
$$;

revoke all on function public.confirm_purchase_locked(uuid) from public;
grant execute on function public.confirm_purchase_locked(uuid) to authenticated, service_role;

create or replace function public.cancel_purchase_with_inventory(target_purchase_id uuid)
returns table (
  purchase_id uuid,
  purchase_number text,
  purchase_status text,
  affected_products jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  purchase_row public.purchases%rowtype;
  effect_record record;
  reversal_movement_id uuid;
  stock_after_value integer;
  affected jsonb := '[]'::jsonb;
  previous_purchase_status text;
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('purchases:manage')
  ) then
    raise exception 'No tienes permiso para cancelar compras.';
  end if;

  select *
  into purchase_row
  from public.purchases
  where id = target_purchase_id
  for update;

  if not found then
    raise exception 'La compra no existe.';
  end if;

  if purchase_row.status = 'cancelled' then
    raise exception 'La compra ya fue cancelada.';
  end if;

  if purchase_row.status not in ('draft', 'confirmed') then
    raise exception 'Esta compra ya no se puede cancelar.';
  end if;

  previous_purchase_status := purchase_row.status;

  if exists (
    select 1
    from public.supplier_invoices
    where supplier_invoices.purchase_id = purchase_row.id
      and supplier_invoices.status <> 'cancelled'
  ) or exists (
    select 1
    from public.accounts_payable
    where accounts_payable.purchase_id = purchase_row.id
      and accounts_payable.status <> 'cancelled'
  ) then
    raise exception 'No se puede cancelar una compra con factura o cuenta por pagar activa.';
  end if;

  perform set_config('app.inventory_origin', 'purchase_cancellation', true);
  perform set_config('app.inventory_reference_id', purchase_row.id::text, true);

  for effect_record in
    with purchase_effects as (
      select
        inventory_movements.product_id,
        sum(inventory_movements.quantity)::integer as applied_quantity,
        sum(
          case
            when inventory_movements.quantity > 0 then coalesce(
              inventory_movements.total_cost_snapshot,
              abs(inventory_movements.quantity) * inventory_movements.unit_cost_snapshot,
              0
            )
            else -coalesce(
              inventory_movements.total_cost_snapshot,
              abs(inventory_movements.quantity) * inventory_movements.unit_cost_snapshot,
              0
            )
          end
        ) as applied_total_cost
      from public.inventory_movements
      where inventory_movements.reference_type = 'purchase'
        and inventory_movements.reference_id = purchase_row.id
      group by inventory_movements.product_id
      having sum(inventory_movements.quantity) <> 0
    )
    select
      products.id,
      products.slug,
      products.category_id,
      products.name,
      products.stock,
      coalesce(products.reserved_stock, 0) as reserved_stock,
      products.cost_price,
      purchase_effects.applied_quantity,
      purchase_effects.applied_total_cost
    from public.products
    join purchase_effects on purchase_effects.product_id = products.id
    order by products.id
    for update of products
  loop
    stock_after_value := effect_record.stock - effect_record.applied_quantity;

    if stock_after_value < 0 then
      raise exception 'No se puede cancelar la compra porque el inventario de % ya fue consumido.', effect_record.name;
    end if;

    if stock_after_value < effect_record.reserved_stock then
      raise exception 'No se puede cancelar la compra porque el inventario de % tiene % unidades reservadas.',
        effect_record.name,
        effect_record.reserved_stock;
    end if;

    update public.products
    set stock = stock_after_value,
        updated_at = now()
    where id = effect_record.id;

    insert into public.inventory_movements (
      product_id,
      user_id,
      movement_type,
      quantity,
      stock_before,
      stock_after,
      reference_type,
      reference_id,
      unit_cost_snapshot,
      total_cost_snapshot,
      cost_source,
      cost_captured_at,
      notes
    )
    values (
      effect_record.id,
      actor_id,
      'adjustment'::public.inventory_movement_type,
      -effect_record.applied_quantity,
      effect_record.stock,
      stock_after_value,
      'purchase_cancellation',
      purchase_row.id,
      round(
        coalesce(abs(effect_record.applied_total_cost / nullif(effect_record.applied_quantity, 0)), effect_record.cost_price, 0),
        2
      ),
      round(abs(coalesce(effect_record.applied_total_cost, 0)), 2),
      'purchase_cancellation_exact_reversal',
      now(),
      left('Reversion por cancelacion de compra ' || purchase_row.purchase_number, 500)
    )
    returning id into reversal_movement_id;

    insert into public.audit_logs (
      user_id,
      actor_role,
      table_name,
      record_id,
      action,
      old_data,
      new_data
    )
    values (
      actor_id,
      public.current_actor_role(),
      'inventory_movements',
      reversal_movement_id,
      'inventory.purchase_cancellation_movement_created',
      jsonb_build_object('stock', effect_record.stock),
      jsonb_build_object(
        'purchase_id', purchase_row.id,
        'purchase_number', purchase_row.purchase_number,
        'product_id', effect_record.id,
        'reversed_quantity', effect_record.applied_quantity,
        'movement_quantity', -effect_record.applied_quantity,
        'stock', stock_after_value,
        'origin', 'purchase_cancellation'
      )
    );

    affected := affected || jsonb_build_array(
      jsonb_build_object(
        'id', effect_record.id,
        'slug', effect_record.slug,
        'category_id', effect_record.category_id,
        'stock_before', effect_record.stock,
        'stock_after', stock_after_value,
        'reversed_quantity', effect_record.applied_quantity
      )
    );
  end loop;

  update public.purchases
  set status = 'cancelled',
      cancelled_by = actor_id,
      cancelled_at = now(),
      updated_at = now()
  where id = purchase_row.id
  returning * into purchase_row;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'purchases',
    purchase_row.id,
    'purchases.cancel',
    jsonb_build_object('status', previous_purchase_status),
    jsonb_build_object(
      'purchase_number', purchase_row.purchase_number,
      'status', purchase_row.status,
      'cancelled_at', purchase_row.cancelled_at,
      'affected_products', affected
    )
  );

  purchase_id := purchase_row.id;
  purchase_number := purchase_row.purchase_number;
  purchase_status := purchase_row.status;
  affected_products := affected;
  return next;
end;
$$;

revoke all on function public.cancel_purchase_with_inventory(uuid) from public;
grant execute on function public.cancel_purchase_with_inventory(uuid) to authenticated, service_role;
