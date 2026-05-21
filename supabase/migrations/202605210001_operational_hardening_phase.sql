-- Operational hardening phase:
-- - real inventory reservations for pending checkout orders
-- - private transfer receipt metadata
-- - database-backed rate limiting for public actions
-- - backup review register for technical-owner verification

alter table public.products
  add column if not exists reserved_stock integer not null default 0 check (reserved_stock >= 0);

alter table public.products
  add column if not exists available_stock integer generated always as (greatest(stock - reserved_stock, 0)) stored;

create index if not exists products_available_stock_idx on public.products(available_stock);
create index if not exists products_reserved_stock_idx on public.products(reserved_stock) where reserved_stock > 0;

alter table public.orders
  add column if not exists order_reservation_status text not null default 'not_required'
    check (order_reservation_status in ('not_required', 'reserved', 'confirmed', 'released', 'expired', 'canceled')),
  add column if not exists reservation_expires_at timestamptz;

create index if not exists orders_reservation_status_idx
  on public.orders(order_reservation_status, reservation_expires_at)
  where order_reservation_status in ('reserved', 'expired');

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'confirmed', 'released', 'expired', 'canceled')),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_reservations_order_idx on public.inventory_reservations(order_id);
create index if not exists inventory_reservations_product_idx on public.inventory_reservations(product_id);
create index if not exists inventory_reservations_status_expires_idx
  on public.inventory_reservations(status, expires_at)
  where status = 'reserved';

create unique index if not exists inventory_reservations_active_order_product_idx
  on public.inventory_reservations(order_id, product_id)
  where status = 'reserved';

alter table public.inventory_reservations enable row level security;

drop policy if exists "Staff can read inventory reservations" on public.inventory_reservations;
create policy "Staff can read inventory reservations"
  on public.inventory_reservations for select
  using (
    public.has_permission('inventory:manage')
    or public.has_permission('orders:read')
    or public.has_permission('orders:manage')
    or public.has_permission('system:monitoring')
  );

grant select on public.inventory_reservations to authenticated, service_role;

alter table public.payments
  add column if not exists transfer_receipt_public_id text,
  add column if not exists transfer_receipt_resource_type text,
  add column if not exists transfer_receipt_delivery_type text,
  add column if not exists transfer_receipt_format text,
  add column if not exists transfer_receipt_original_filename text,
  add column if not exists transfer_receipt_uploaded_at timestamptz,
  add column if not exists transfer_receipt_accessed_at timestamptz;

create index if not exists payments_transfer_receipt_public_id_idx
  on public.payments(transfer_receipt_public_id)
  where transfer_receipt_public_id is not null;

create table if not exists public.rate_limits (
  id uuid primary key default gen_random_uuid(),
  identifier_hash text not null,
  route_key text not null,
  window_start timestamptz not null,
  attempts integer not null default 1,
  blocked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_limits_attempts_positive check (attempts > 0)
);

create unique index if not exists rate_limits_identifier_route_window_key
  on public.rate_limits(identifier_hash, route_key, window_start);
create index if not exists rate_limits_cleanup_idx on public.rate_limits(updated_at);

alter table public.rate_limits enable row level security;

grant execute on function public.has_permission(text) to authenticated;

create or replace function public.check_rate_limit(
  identifier_hash text,
  route_key text,
  max_attempts integer,
  window_seconds integer
)
returns table (
  allowed boolean,
  attempts integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_identifier text := left(nullif(trim(coalesce(identifier_hash, '')), ''), 128);
  safe_route text := left(nullif(trim(coalesce(route_key, '')), ''), 160);
  safe_max integer := greatest(coalesce(max_attempts, 10), 1);
  safe_window integer := greatest(coalesce(window_seconds, 60), 10);
  current_window timestamptz;
  current_attempts integer;
begin
  if safe_identifier is null or safe_route is null then
    allowed := true;
    attempts := 0;
    retry_after_seconds := 0;
    return next;
    return;
  end if;

  current_window := to_timestamp(floor(extract(epoch from now()) / safe_window) * safe_window);

  insert into public.rate_limits(identifier_hash, route_key, window_start, attempts, updated_at)
  values (safe_identifier, safe_route, current_window, 1, now())
  on conflict (identifier_hash, route_key, window_start)
  do update set
    attempts = public.rate_limits.attempts + 1,
    updated_at = now()
  returning public.rate_limits.attempts into current_attempts;

  if current_attempts > safe_max then
    update public.rate_limits
    set blocked_until = current_window + make_interval(secs => safe_window),
        updated_at = now()
    where public.rate_limits.identifier_hash = safe_identifier
      and public.rate_limits.route_key = safe_route
      and public.rate_limits.window_start = current_window;

    allowed := false;
    attempts := current_attempts;
    retry_after_seconds := greatest(1, ceil(extract(epoch from (current_window + make_interval(secs => safe_window) - now())))::integer);
  else
    allowed := true;
    attempts := current_attempts;
    retry_after_seconds := 0;
  end if;

  return next;
end;
$$;

grant execute on function public.check_rate_limit(text, text, integer, integer) to anon, authenticated, service_role;

create or replace function public.cleanup_old_rate_limits(retention_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.rate_limits
  where updated_at < now() - make_interval(hours => greatest(coalesce(retention_hours, 24), 1));

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

grant execute on function public.cleanup_old_rate_limits(integer) to service_role;

create table if not exists public.operational_backup_checks (
  id uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default now(),
  checked_by uuid references auth.users(id) on delete set null,
  plan_name text not null default 'free_or_unverified',
  status text not null default 'manual_review'
    check (status in ('ok', 'manual_review', 'risk', 'failed')),
  database_backup_checked boolean not null default false,
  cloudinary_manifest_checked boolean not null default false,
  vercel_env_checked boolean not null default false,
  restore_drill_checked boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists operational_backup_checks_checked_at_idx
  on public.operational_backup_checks(checked_at desc);

alter table public.operational_backup_checks enable row level security;

drop policy if exists "Technical staff can read backup checks" on public.operational_backup_checks;
create policy "Technical staff can read backup checks"
  on public.operational_backup_checks for select
  using (public.has_permission('system:monitoring'));

grant select, insert on public.operational_backup_checks to authenticated, service_role;

create or replace function public.record_operational_backup_check(
  plan_name text,
  check_status text,
  database_backup_checked boolean,
  cloudinary_manifest_checked boolean,
  vercel_env_checked boolean,
  restore_drill_checked boolean,
  notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  check_id uuid;
begin
  if not public.has_permission('system:monitoring') then
    raise exception 'No tienes permiso para registrar revisiones de respaldo.';
  end if;

  insert into public.operational_backup_checks (
    checked_by,
    plan_name,
    status,
    database_backup_checked,
    cloudinary_manifest_checked,
    vercel_env_checked,
    restore_drill_checked,
    notes
  )
  values (
    auth.uid(),
    left(coalesce(nullif(trim(plan_name), ''), 'free_or_unverified'), 80),
    case when check_status in ('ok', 'manual_review', 'risk', 'failed') then check_status else 'manual_review' end,
    coalesce(database_backup_checked, false),
    coalesce(cloudinary_manifest_checked, false),
    coalesce(vercel_env_checked, false),
    coalesce(restore_drill_checked, false),
    left(nullif(trim(coalesce(notes, '')), ''), 1200)
  )
  returning id into check_id;

  return check_id;
end;
$$;

grant execute on function public.record_operational_backup_check(text, text, boolean, boolean, boolean, boolean, text)
  to authenticated, service_role;

create or replace function public.release_order_reservation(
  target_order_id uuid,
  release_status text default 'released',
  reason text default null,
  actor_user_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_status text := case
    when release_status in ('released', 'expired', 'canceled') then release_status
    else 'released'
  end;
  reservation_record record;
  product_record record;
  released_count integer := 0;
begin
  if target_order_id is null then
    raise exception 'El pedido es obligatorio para liberar inventario.';
  end if;

  perform 1 from public.orders where id = target_order_id for update;

  for reservation_record in
    select *
    from public.inventory_reservations
    where order_id = target_order_id
      and status = 'reserved'
    order by product_id
    for update
  loop
    select id, stock, reserved_stock
    into product_record
    from public.products
    where id = reservation_record.product_id
    for update;

    if found then
      update public.products
      set reserved_stock = greatest(coalesce(reserved_stock, 0) - reservation_record.quantity, 0),
          updated_at = now()
      where id = reservation_record.product_id;

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
        reservation_record.product_id,
        actor_user_id,
        'adjustment',
        reservation_record.quantity,
        product_record.stock,
        product_record.stock,
        'inventory_reservations',
        reservation_record.id,
        left(coalesce(reason, 'Liberacion de reserva de inventario'), 500)
      );
    end if;

    update public.inventory_reservations
    set status = safe_status,
        released_at = now(),
        release_reason = left(nullif(trim(coalesce(reason, '')), ''), 500),
        updated_at = now()
    where id = reservation_record.id;

    released_count := released_count + 1;
  end loop;

  if released_count > 0 then
    update public.orders
    set order_reservation_status = safe_status,
        updated_at = now()
    where id = target_order_id;
  end if;

  return released_count;
end;
$$;

create or replace function public.confirm_order_reservation(
  target_order_id uuid,
  actor_user_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation_record record;
  product_record record;
  confirmed_count integer := 0;
begin
  if target_order_id is null then
    raise exception 'El pedido es obligatorio para confirmar inventario.';
  end if;

  perform 1 from public.orders where id = target_order_id for update;

  if not exists (
    select 1
    from public.inventory_reservations
    where order_id = target_order_id
  ) then
    return 0;
  end if;

  if not exists (
    select 1
    from public.inventory_reservations
    where order_id = target_order_id
      and status = 'reserved'
  ) then
    return 0;
  end if;

  for reservation_record in
    select *
    from public.inventory_reservations
    where order_id = target_order_id
      and status = 'reserved'
    order by product_id
    for update
  loop
    select id, name, stock, reserved_stock
    into product_record
    from public.products
    where id = reservation_record.product_id
    for update;

    if not found then
      raise exception 'No se encontro el producto reservado.';
    end if;

    if product_record.stock < reservation_record.quantity then
      raise exception 'El producto % ya no tiene stock total suficiente para confirmar la venta.', product_record.name;
    end if;

    update public.products
    set stock = product_record.stock - reservation_record.quantity,
        reserved_stock = greatest(coalesce(product_record.reserved_stock, 0) - reservation_record.quantity, 0),
        updated_at = now()
    where id = reservation_record.product_id;

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
      reservation_record.product_id,
      actor_user_id,
      'sale',
      -reservation_record.quantity,
      product_record.stock,
      product_record.stock - reservation_record.quantity,
      'orders',
      target_order_id,
      'Venta confirmada desde reserva de inventario'
    );

    update public.inventory_reservations
    set status = 'confirmed',
        confirmed_at = now(),
        updated_at = now()
    where id = reservation_record.id;

    confirmed_count := confirmed_count + 1;
  end loop;

  update public.orders
  set order_reservation_status = 'confirmed',
      updated_at = now()
  where id = target_order_id;

  return confirmed_count;
end;
$$;

grant execute on function public.release_order_reservation(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.confirm_order_reservation(uuid, uuid) to authenticated, service_role;

create or replace function public.apply_order_sale_inventory(target_order_id uuid, actor_user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_order public.orders%rowtype;
  item_record record;
  product_record public.products%rowtype;
  existing_sale_movements integer := 0;
  order_item_count integer := 0;
  missing_product_count integer := 0;
  stock_update_count integer := 0;
  reservation_count integer := 0;
begin
  if target_order_id is null then
    raise exception 'El pedido es obligatorio para descontar inventario.';
  end if;

  select *
  into target_order
  from public.orders
  where orders.id = target_order_id
  for update;

  if target_order.id is null then
    raise exception 'No se encontro el pedido para descontar inventario.';
  end if;

  select count(*)
  into reservation_count
  from public.inventory_reservations
  where order_id = target_order_id;

  if reservation_count > 0 then
    if not exists (
      select 1
      from public.inventory_reservations
      where order_id = target_order_id
        and status = 'reserved'
    ) then
      if exists (
        select 1
        from public.inventory_reservations
        where order_id = target_order_id
          and status = 'confirmed'
      ) then
        return;
      end if;

      raise exception 'La reserva de inventario ya no esta activa. Revisa el pedido antes de confirmar el pago.';
    end if;

    perform public.confirm_order_reservation(target_order_id, actor_user_id);
    return;
  end if;

  select count(*)
  into existing_sale_movements
  from public.inventory_movements
  where inventory_movements.reference_type = 'orders'
    and inventory_movements.reference_id = target_order_id
    and inventory_movements.movement_type = 'sale';

  if existing_sale_movements > 0 then
    return;
  end if;

  select count(*)
  into order_item_count
  from public.order_items
  where order_items.order_id = target_order_id;

  if order_item_count = 0 then
    raise exception 'El pedido no tiene productos para descontar inventario.';
  end if;

  select count(*)
  into missing_product_count
  from public.order_items
  where order_items.order_id = target_order_id
    and order_items.product_id is null;

  if missing_product_count > 0 then
    raise exception 'El pedido tiene productos sin referencia de inventario.';
  end if;

  for item_record in
    select
      order_items.product_id,
      sum(order_items.quantity)::integer as quantity
    from public.order_items
    where order_items.order_id = target_order_id
    group by order_items.product_id
    order by order_items.product_id
  loop
    select *
    into product_record
    from public.products
    where products.id = item_record.product_id
    for update;

    if product_record.id is null then
      raise exception 'No se encontro el producto del pedido para descontar inventario.';
    end if;

    if item_record.quantity <= 0 then
      raise exception 'El producto % tiene una cantidad invalida.', product_record.name;
    end if;

    if item_record.quantity > (product_record.stock - coalesce(product_record.reserved_stock, 0)) then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    update public.products
    set
      stock = product_record.stock - item_record.quantity,
      updated_at = now()
    where products.id = product_record.id
      and (products.stock - coalesce(products.reserved_stock, 0)) >= item_record.quantity;

    get diagnostics stock_update_count = row_count;

    if stock_update_count <> 1 then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

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
      product_record.id,
      actor_user_id,
      'sale',
      -item_record.quantity,
      product_record.stock,
      product_record.stock - item_record.quantity,
      'orders',
      target_order_id,
      'Salida automatica por pedido confirmado'
    );
  end loop;
end;
$$;

grant execute on function public.apply_order_sale_inventory(uuid, uuid) to authenticated, service_role;

create or replace function public.release_order_reservation_from_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status::text in ('cancelado', 'cancelled') then
    perform public.release_order_reservation(new.id, 'canceled', 'Pedido cancelado: reserva liberada', new.user_id);
  end if;

  return new;
end;
$$;

drop trigger if exists release_order_reservation_on_order_cancel on public.orders;
create trigger release_order_reservation_on_order_cancel
after update of status on public.orders
for each row
when (old.status is distinct from new.status and new.status::text in ('cancelado', 'cancelled'))
execute function public.release_order_reservation_from_order_status();

create or replace function public.expire_inventory_reservations(max_orders integer default 100)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  order_record record;
  expired_orders integer := 0;
begin
  for order_record in
    select orders.id
    from public.orders
    where exists (
      select 1
      from public.inventory_reservations ir
      where ir.order_id = orders.id
        and ir.status = 'reserved'
        and ir.expires_at <= now()
    )
    order by orders.id
    limit greatest(coalesce(max_orders, 100), 1)
    for update skip locked
  loop
    perform public.release_order_reservation(order_record.id, 'expired', 'Reserva vencida liberada automaticamente', null);
    expired_orders := expired_orders + 1;
  end loop;

  perform public.cleanup_old_rate_limits(24);

  return expired_orders;
end;
$$;

grant execute on function public.expire_inventory_reservations(integer) to service_role;

drop function if exists public.create_checkout_order(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text
);

create or replace function public.create_checkout_order(
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_rtn text,
  delivery_address text,
  requested_price_mode public.order_price_mode,
  requested_payment_method public.payment_method,
  bank_reference_number text,
  order_items jsonb,
  wholesale_code text default null,
  wholesale_code_id uuid default null,
  transfer_receipt_url text default null,
  delivery_country text default 'Honduras',
  country_code text default 'HN',
  delivery_department text default null,
  delivery_city text default null
)
returns table (
  order_id uuid,
  order_number text,
  tracking_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  wholesale_allowed_id uuid;
  user_has_authorized_wholesale_account boolean := false;
  normalized_wholesale_code text := upper(trim(coalesce(wholesale_code, '')));
  normalized_country text := coalesce(nullif(trim(delivery_country), ''), 'Honduras');
  normalized_country_code text := coalesce(nullif(upper(trim(country_code)), ''), 'HN');
  normalized_customer_email text := lower(nullif(trim(coalesce(customer_email, '')), ''));
  normalized_customer_phone text := public.normalize_hn_phone(customer_phone);
  canonical_customer_id uuid;
  duplicate_customer_id uuid;
  legacy_row record;
  created_order record;
  free_shipping_threshold numeric(12, 2) := 3000;
  standard_shipping_fee numeric(12, 2) := 120;
  cash_on_delivery_percentage numeric(6, 2) := 5;
  enable_cash_on_delivery_fee boolean := true;
  first_wholesale_minimum numeric(12, 2) := 10000;
  shipping_amount numeric(12, 2) := 0;
  cod_amount numeric(12, 2) := 0;
  final_total numeric(12, 2) := 0;
  has_previous_wholesale boolean := false;
  expected_item_count integer := 0;
  item_record record;
  product_record record;
  restored_stock integer;
  reservation_id uuid;
  reservation_deadline timestamptz := now() + interval '48 hours';
begin
  if normalized_country_code <> 'HN' or lower(normalized_country) not in ('honduras', 'hn') then
    raise exception 'Actualmente solo realizamos entregas dentro de Honduras.';
  end if;

  if order_items is null or jsonb_typeof(order_items) <> 'array' or jsonb_array_length(order_items) = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  create temporary table if not exists checkout_reservation_items_temp (
    product_id uuid primary key,
    quantity integer not null check (quantity > 0)
  ) on commit drop;

  truncate table checkout_reservation_items_temp;

  insert into checkout_reservation_items_temp (product_id, quantity)
  select
    raw_items.product_id::uuid,
    sum(raw_items.quantity)::integer
  from jsonb_to_recordset(order_items) as raw_items(product_id text, quantity numeric)
  where raw_items.product_id is not null
    and raw_items.quantity is not null
    and raw_items.quantity > 0
  group by raw_items.product_id::uuid;

  select count(*) into expected_item_count from checkout_reservation_items_temp;

  if expected_item_count = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  for item_record in
    select
      products.id,
      products.name,
      products.stock,
      coalesce(products.reserved_stock, 0) as reserved_stock,
      checkout_items.quantity
    from checkout_reservation_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    where products.active = true
      and products.status = 'active'
    order by products.id
    for update of products
  loop
    if item_record.quantity > (item_record.stock - item_record.reserved_stock) then
      raise exception 'Solo hay % unidades disponibles de %.', greatest(item_record.stock - item_record.reserved_stock, 0), item_record.name;
    end if;
  end loop;

  if (
    select count(*)
    from checkout_reservation_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    where products.active = true
      and products.status = 'active'
  ) <> expected_item_count then
    raise exception 'Uno de los productos ya no esta disponible.';
  end if;

  if requested_price_mode = 'wholesale' then
    if current_user_id is null then
      raise exception 'Codigo valido. Inicia sesion con tu cuenta mayorista para activar precios.';
    end if;

    if normalized_wholesale_code = '' or wholesale_code_id is null then
      raise exception 'Codigo mayorista invalido.';
    end if;

    if not exists (
      select 1
      from public.wholesale_codes wc
      where wc.code = normalized_wholesale_code
        and wc.id = wholesale_code_id
        and coalesce(wc.is_active, wc.active) = true
        and wc.status = 'active'
        and (wc.starts_at is null or wc.starts_at <= now())
        and (wc.expires_at is null or wc.expires_at >= now())
        and (wc.max_uses is null or wc.used_count < wc.max_uses)
    ) then
      raise exception 'Codigo mayorista invalido.';
    end if;

    select exists (
      select 1
      from public.customers c
      join public.users u on u.id = c.user_id
      where c.user_id = current_user_id
        and c.active = true
        and c.status = 'active'
        and c.is_wholesale = true
        and u.active = true
    )
    into user_has_authorized_wholesale_account;

    if not user_has_authorized_wholesale_account then
      raise exception 'Tu cuenta no esta autorizada para compras mayoristas.';
    end if;

    select wc.id
    into wholesale_allowed_id
    from public.wholesale_codes wc
    join public.customers c on c.id = wc.customer_id
    join public.users u on u.id = c.user_id
    where wc.code = normalized_wholesale_code
      and wc.id = wholesale_code_id
      and coalesce(wc.is_active, wc.active) = true
      and wc.status = 'active'
      and (wc.starts_at is null or wc.starts_at <= now())
      and (wc.expires_at is null or wc.expires_at >= now())
      and (wc.max_uses is null or wc.used_count < wc.max_uses)
      and c.user_id = current_user_id
      and c.active = true
      and c.status = 'active'
      and c.is_wholesale = true
      and u.active = true
    limit 1;

    if wholesale_allowed_id is null then
      raise exception 'Este codigo mayorista no pertenece a tu cuenta.';
    end if;
  end if;

  select *
  into legacy_row
  from public.create_checkout_order_legacy_20260511(
    customer_name,
    customer_email,
    coalesce(normalized_customer_phone, customer_phone),
    customer_rtn,
    delivery_address,
    requested_price_mode,
    requested_payment_method,
    bank_reference_number,
    order_items,
    wholesale_code,
    wholesale_code_id,
    transfer_receipt_url
  )
  limit 1;

  select *
  into created_order
  from public.orders
  where orders.id = legacy_row.order_id
  for update;

  delete from public.inventory_movements
  where reference_type = 'orders'
    and reference_id = legacy_row.order_id
    and movement_type = 'sale';

  for item_record in
    select
      order_items.product_id,
      sum(order_items.quantity)::integer as quantity
    from public.order_items
    where order_items.order_id = legacy_row.order_id
      and order_items.product_id is not null
    group by order_items.product_id
    order by order_items.product_id
  loop
    select id, stock, reserved_stock
    into product_record
    from public.products
    where id = item_record.product_id
    for update;

    restored_stock := product_record.stock + item_record.quantity;

    insert into public.inventory_reservations (
      order_id,
      product_id,
      quantity,
      status,
      expires_at
    )
    values (
      legacy_row.order_id,
      item_record.product_id,
      item_record.quantity,
      'reserved',
      reservation_deadline
    )
    returning id into reservation_id;

    update public.products
    set stock = restored_stock,
        reserved_stock = coalesce(reserved_stock, 0) + item_record.quantity,
        updated_at = now()
    where id = item_record.product_id;

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
      item_record.product_id,
      current_user_id,
      'adjustment',
      -item_record.quantity,
      restored_stock,
      restored_stock,
      'inventory_reservations',
      reservation_id,
      'Reserva temporal por checkout pendiente; stock fisico no descontado'
    );
  end loop;

  update public.orders
  set order_reservation_status = 'reserved',
      reservation_expires_at = reservation_deadline,
      updated_at = now()
  where id = legacy_row.order_id;

  select customers.id
  into canonical_customer_id
  from public.customers
  where (
      current_user_id is not null
      and customers.user_id = current_user_id
    )
    or (
      normalized_customer_email is not null
      and lower(customers.email) = normalized_customer_email
    )
    or (
      normalized_customer_phone is not null
      and public.normalize_hn_phone(customers.phone) = normalized_customer_phone
    )
  order by
    case
      when current_user_id is not null and customers.user_id = current_user_id then 0
      when normalized_customer_email is not null and lower(customers.email) = normalized_customer_email then 1
      when normalized_customer_phone is not null and public.normalize_hn_phone(customers.phone) = normalized_customer_phone then 2
      else 3
    end,
    customers.created_at asc
  limit 1
  for update;

  if canonical_customer_id is not null and canonical_customer_id <> created_order.customer_id then
    duplicate_customer_id := created_order.customer_id;

    update public.orders
    set customer_id = canonical_customer_id,
        updated_at = now()
    where orders.id = legacy_row.order_id;

    update public.payments
    set customer_id = canonical_customer_id,
        updated_at = now()
    where payments.order_id = legacy_row.order_id;

    update public.crm_followups
    set customer_id = canonical_customer_id,
        updated_at = now()
    where crm_followups.order_id = legacy_row.order_id;

    update public.crm_notes
    set customer_id = canonical_customer_id
    where crm_notes.order_id = legacy_row.order_id;

    update public.customers
    set
      contact_name = coalesce(nullif(trim(customer_name), ''), customers.contact_name),
      email = coalesce(normalized_customer_email, customers.email),
      phone = coalesce(normalized_customer_phone, customers.phone),
      tax_id = coalesce(nullif(trim(coalesce(customer_rtn, '')), ''), customers.tax_id),
      active = true,
      updated_at = now()
    where customers.id = canonical_customer_id;

    update public.customers
    set
      active = false,
      status = 'inactive',
      notes = coalesce(notes, '') || chr(10) || '[DUPLICADO_AUTO] Pedido reasignado al cliente ' || canonical_customer_id::text,
      updated_at = now()
    where customers.id = duplicate_customer_id
      and not exists (select 1 from public.orders where orders.customer_id = duplicate_customer_id)
      and not exists (select 1 from public.invoices where invoices.customer_id = duplicate_customer_id);

    created_order.customer_id := canonical_customer_id;
  end if;

  select
    coalesce(company_settings.free_shipping_threshold, 3000),
    coalesce(company_settings.standard_shipping_fee, 120),
    coalesce(company_settings.cash_on_delivery_percentage, 5),
    coalesce(company_settings.enable_cash_on_delivery_fee, true),
    coalesce(company_settings.first_wholesale_minimum, 10000)
  into
    free_shipping_threshold,
    standard_shipping_fee,
    cash_on_delivery_percentage,
    enable_cash_on_delivery_fee,
    first_wholesale_minimum
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  select *
  into created_order
  from public.orders
  where orders.id = legacy_row.order_id
  for update;

  if requested_price_mode = 'wholesale' then
    select exists (
      select 1
      from public.orders previous_orders
      where previous_orders.customer_id = created_order.customer_id
        and previous_orders.price_mode = 'wholesale'
        and previous_orders.status::text not in ('cancelado', 'cancelled')
        and previous_orders.id <> created_order.id
    )
    into has_previous_wholesale;

    if not has_previous_wholesale and created_order.subtotal < first_wholesale_minimum then
      raise exception 'Para tu primera compra mayorista, el minimo requerido es de L %.', first_wholesale_minimum;
    end if;
  end if;

  shipping_amount := case
    when created_order.subtotal >= free_shipping_threshold then 0
    else standard_shipping_fee
  end;

  cod_amount := case
    when requested_payment_method = 'cash' and enable_cash_on_delivery_fee
      then round(created_order.subtotal * (cash_on_delivery_percentage / 100), 2)
    else 0
  end;

  final_total := round(created_order.subtotal + shipping_amount + cod_amount, 2);

  update public.orders
  set
    shipping_fee = shipping_amount,
    shipping_total = shipping_amount,
    cash_on_delivery_fee = cod_amount,
    total = final_total,
    delivery_country = normalized_country,
    delivery_country_code = normalized_country_code,
    delivery_department = nullif(trim(coalesce(create_checkout_order.delivery_department, '')), ''),
    delivery_city = nullif(trim(coalesce(create_checkout_order.delivery_city, '')), ''),
    tracking_status = coalesce(nullif(tracking_status, ''), status::text),
    public_tracking_enabled = true,
    updated_at = now()
  where orders.id = legacy_row.order_id
  returning orders.tracking_code into tracking_code;

  update public.payments
  set amount = final_total,
      updated_at = now()
  where payments.order_id = legacy_row.order_id;

  update public.crm_followups
  set estimated_value = final_total,
      notes = notes || chr(10) ||
        'Envio: ' || shipping_amount::text || chr(10) ||
        'Comision pago al recibir: ' || cod_amount::text || chr(10) ||
        'Total final: ' || final_total::text,
      updated_at = now()
  where crm_followups.order_id = legacy_row.order_id;

  order_id := legacy_row.order_id;
  order_number := legacy_row.order_number;
  return next;
end;
$$;

grant execute on function public.create_checkout_order(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text
) to anon, authenticated, service_role;

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

  select id, stock, coalesce(reserved_stock, 0) as reserved_stock
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

  if movement_kind = 'sale' and abs(delta) > (locked_product.stock - locked_product.reserved_stock) then
    raise exception 'Solo hay % unidades disponibles; % estan reservadas.', greatest(locked_product.stock - locked_product.reserved_stock, 0), locked_product.reserved_stock;
  end if;

  if stock_after < locked_product.reserved_stock then
    raise exception 'No puedes dejar el stock total por debajo de las unidades reservadas (%).', locked_product.reserved_stock;
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

grant execute on function public.create_inventory_movement_locked(uuid, public.inventory_movement_type, integer, text) to authenticated, service_role;
grant execute on function public.set_product_stock_locked(uuid, integer, text) to authenticated, service_role;
