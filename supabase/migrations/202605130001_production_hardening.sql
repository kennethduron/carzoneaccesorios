drop policy if exists "Public can read company settings" on public.company_settings;
drop policy if exists "Staff can read company settings" on public.company_settings;

revoke select on public.company_settings from anon;

create policy "Staff can read company settings"
  on public.company_settings for select
  using (
    public.has_permission('settings:manage')
    or public.has_permission('reports:read')
    or public.has_permission('orders:read')
    or public.has_permission('orders:manage')
    or public.has_permission('fiscal:read')
    or public.has_permission('invoices:read')
    or public.has_permission('invoices:manage')
  );

create or replace view public.public_company_settings as
select
  company_name,
  currency,
  tax_rate,
  logo_url
from public.company_settings
order by created_at asc
limit 1;

grant select on public.public_company_settings to anon, authenticated;

create index if not exists error_logs_anon_created_at_idx
  on public.error_logs(created_at desc)
  where user_id is null;

create or replace function public.write_error_log(
  affected_route text,
  action_name text,
  error_message text,
  error_stack text default null,
  error_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
  actor_id uuid := auth.uid();
  actor_email text := auth.jwt() ->> 'email';
  safe_route text := left(nullif(trim(coalesce(affected_route, '')), ''), 180);
  safe_action text := left(nullif(trim(coalesce(action_name, '')), ''), 120);
  safe_message text := left(nullif(trim(coalesce(error_message, '')), ''), 700);
  safe_stack text := left(nullif(trim(coalesce(error_stack, '')), ''), 2000);
  safe_metadata jsonb := coalesce(error_metadata, '{}'::jsonb);
begin
  if safe_action is null then
    raise exception 'La accion del error es obligatoria.';
  end if;

  if safe_message is null then
    raise exception 'El mensaje del error es obligatorio.';
  end if;

  if actor_id is null then
    if (
      select count(*)
      from public.error_logs
      where user_id is null
        and created_at > now() - interval '1 minute'
    ) >= 60 then
      return null;
    end if;

    if (
      select count(*)
      from public.error_logs
      where user_id is null
        and action = safe_action
        and coalesce(route, '') = coalesce(safe_route, '')
        and created_at > now() - interval '1 minute'
    ) >= 10 then
      return null;
    end if;

    safe_stack := null;
    safe_metadata := jsonb_strip_nulls(jsonb_build_object(
      'source', safe_metadata ->> 'source',
      'environment', safe_metadata ->> 'environment',
      'digest', safe_metadata ->> 'digest'
    ));
  elsif length(safe_metadata::text) > 4000 then
    safe_metadata := jsonb_build_object('truncated', true);
  end if;

  insert into public.error_logs (
    route,
    user_id,
    user_email,
    action,
    error_message,
    error_stack,
    metadata
  )
  values (
    safe_route,
    actor_id,
    left(nullif(trim(coalesce(actor_email, '')), ''), 180),
    safe_action,
    safe_message,
    safe_stack,
    safe_metadata
  )
  returning id into log_id;

  return log_id;
end;
$$;

grant execute on function public.write_error_log(text, text, text, text, jsonb) to anon, authenticated, service_role;

create or replace function public.create_inventory_movement_locked(
  target_product_id uuid,
  movement_kind public.inventory_movement_type,
  raw_quantity integer,
  movement_notes text default null
)
returns table (
  movement_id uuid,
  product_id uuid,
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
  if not public.has_permission('inventory:manage') then
    raise exception 'No tienes permiso para administrar inventario.';
  end if;

  if target_product_id is null then
    raise exception 'Selecciona un producto.';
  end if;

  if coalesce(raw_quantity, 0) = 0 then
    raise exception 'La cantidad debe ser diferente de cero.';
  end if;

  delta := case
    when movement_kind in ('purchase', 'return') then abs(raw_quantity)
    when movement_kind = 'sale' then -abs(raw_quantity)
    else raw_quantity
  end;

  select id, stock
  into locked_product
  from public.products
  where id = target_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.';
  end if;

  stock_before := locked_product.stock;
  stock_after := stock_before + delta;

  if stock_after < 0 then
    raise exception 'Solo hay % unidades disponibles.', stock_before;
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
    notes
  )
  values (
    target_product_id,
    actor_id,
    movement_kind,
    delta,
    stock_before,
    stock_after,
    'inventory',
    left(nullif(trim(coalesce(movement_notes, '')), ''), 500)
  )
  returning id into new_movement_id;

  movement_id := new_movement_id;
  product_id := target_product_id;
  quantity := delta;
  return next;
end;
$$;

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
  if not (public.has_permission('products:manage') or public.has_permission('inventory:manage')) then
    raise exception 'No tienes permiso para ajustar stock.';
  end if;

  if target_product_id is null then
    raise exception 'Selecciona un producto.';
  end if;

  if target_stock is null or target_stock < 0 then
    raise exception 'El stock no puede ser negativo.';
  end if;

  select id, stock
  into locked_product
  from public.products
  where id = target_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado.';
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

revoke all on function public.create_inventory_movement_locked(uuid, public.inventory_movement_type, integer, text) from public;
revoke all on function public.set_product_stock_locked(uuid, integer, text) from public;
grant execute on function public.create_inventory_movement_locked(uuid, public.inventory_movement_type, integer, text) to authenticated, service_role;
grant execute on function public.set_product_stock_locked(uuid, integer, text) to authenticated, service_role;

revoke insert, update, delete on public.inventory_movements from authenticated;
