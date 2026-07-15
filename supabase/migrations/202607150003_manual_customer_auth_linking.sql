-- Portal identity remains separate from operational customer records.
-- This migration does not link or unlink any existing customer.

alter table public.users
  alter column phone drop not null;

update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || jsonb_build_array('customers:link_portal_account')
    ) as permission
  ) distinct_permissions
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin', 'contadora');

create unique index if not exists customers_user_id_unique_idx
  on public.customers(user_id)
  where user_id is not null;

create or replace function public.link_customer_portal_account_manual(
  p_customer_id uuid,
  p_user_id uuid,
  p_reason text,
  p_confirmed boolean default false
)
returns table (
  ok boolean,
  status text,
  message text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  customer_row public.customers%rowtype;
  user_row public.users%rowtype;
  conflicting_customer_id uuid;
begin
  if actor_id is null or not public.has_permission('customers:link_portal_account') then
    if actor_id is not null then
      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
      values (
        actor_id,
        actor_role_name,
        'customers',
        p_customer_id,
        'customer_portal_link.permission_denied',
        jsonb_build_object(
          'confirmed', coalesce(p_confirmed, false),
          'portal_user_id', p_user_id
        )
      );
    end if;

    return query select false, 'permission_denied'::text, 'No tienes permiso para vincular cuentas del portal.'::text;
    return;
  end if;

  if not coalesce(p_confirmed, false) then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id,
      actor_role_name,
      'customers',
      p_customer_id,
      'customer_portal_link.confirmation_required',
      jsonb_build_object('confirmed', false, 'portal_user_id', p_user_id)
    );

    return query select false, 'confirmation_required'::text, 'Debes confirmar explícitamente la vinculación.'::text;
    return;
  end if;

  if normalized_reason is null or char_length(normalized_reason) < 10 then
    return query select false, 'reason_required'::text, 'Escribe un motivo de al menos 10 caracteres.'::text;
    return;
  end if;

  if char_length(normalized_reason) > 500 then
    return query select false, 'reason_too_long'::text, 'El motivo no puede exceder 500 caracteres.'::text;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('customer-portal-link-user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('customer-portal-link-customer:' || p_customer_id::text, 0));

  select *
  into customer_row
  from public.customers
  where id = p_customer_id
  for update;

  if customer_row.id is null then
    return query select false, 'customer_not_found'::text, 'El cliente operativo no existe.'::text;
    return;
  end if;

  if not coalesce(customer_row.active, false) or customer_row.status in ('inactive', 'disabled') then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id,
      actor_role_name,
      'customers',
      p_customer_id,
      'customer_portal_link.inactive_customer',
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );

    return query select false, 'inactive_customer'::text, 'El cliente operativo no está activo.'::text;
    return;
  end if;

  select *
  into user_row
  from public.users
  where id = p_user_id
  for update;

  if user_row.id is null or not coalesce(user_row.active, false)
    or not exists (select 1 from auth.users where id = p_user_id)
  then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id,
      actor_role_name,
      'customers',
      p_customer_id,
      'customer_portal_link.invalid_portal_account',
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );

    return query select false, 'invalid_portal_account'::text, 'La cuenta del portal no existe o no está activa.'::text;
    return;
  end if;

  if customer_row.user_id = p_user_id then
    return query select true, 'already_linked'::text, 'El cliente ya está vinculado a esa cuenta del portal.'::text;
    return;
  end if;

  if customer_row.user_id is not null then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
    values (
      actor_id,
      actor_role_name,
      'customers',
      p_customer_id,
      'customer_portal_link.customer_conflict',
      jsonb_build_object('linked', true),
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );

    return query select false, 'customer_conflict'::text, 'El cliente ya está vinculado a otra cuenta del portal.'::text;
    return;
  end if;

  select id
  into conflicting_customer_id
  from public.customers
  where user_id = p_user_id
    and id <> p_customer_id
  limit 1
  for update;

  if conflicting_customer_id is not null then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id,
      actor_role_name,
      'customers',
      p_customer_id,
      'customer_portal_link.portal_account_conflict',
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );

    return query select false, 'portal_account_conflict'::text, 'La cuenta del portal ya está vinculada a otro cliente.'::text;
    return;
  end if;

  update public.customers
  set user_id = p_user_id
  where id = p_customer_id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role_name,
    'customers',
    p_customer_id,
    'customer_portal_link.linked_manual',
    jsonb_build_object('linked', false),
    jsonb_build_object(
      'linked', true,
      'portal_user_id', p_user_id,
      'reason', normalized_reason,
      'source', 'manual_admin_action'
    )
  );

  return query select true, 'linked'::text, 'Cuenta del portal vinculada correctamente.'::text;
end;
$$;

comment on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) is
  'Explicit, audited and idempotent portal-account link. It never matches identity automatically and only changes customers.user_id.';

revoke all on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) from public;
revoke all on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) from anon;
grant execute on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_full_name text := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), '');
  raw_username text := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  profile_username text := null;
  profile_phone text := nullif(regexp_replace(coalesce(new.raw_user_meta_data->>'phone', ''), '[^0-9]', '', 'g'), '');
  profile_email text := lower(trim(coalesce(new.email, '')));
begin
  if raw_username ~ '^[a-z0-9._-]{3,30}$'
    and raw_username not in ('admin', 'soporte', 'root', 'carzone', 'mayorista', 'facturas', 'pedidos')
  then
    profile_username := raw_username;
  end if;

  if profile_full_name is null then
    profile_full_name := profile_email;
  end if;

  insert into public.users (id, role_id, full_name, username, email, phone, active)
  values (
    new.id,
    (select roles.id from public.roles where roles.name = 'cliente' limit 1),
    profile_full_name,
    profile_username,
    profile_email,
    profile_phone,
    true
  )
  on conflict (id) do update
  set
    full_name = excluded.full_name,
    username = coalesce(public.users.username, excluded.username),
    email = excluded.email,
    phone = excluded.phone,
    updated_at = now();

  -- Creating or synchronizing an Auth profile never creates, finds or links a customer.
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
grant execute on function public.handle_new_user() to service_role;

-- Authenticated checkout may create or reuse an operational customer, but it never links portal ownership.
-- Checkout must trust the authenticated account email, not submitted form email.
-- The first wholesale minimum is calculated from product subtotal only:
-- shipping and cash-on-delivery fees do not count toward the minimum.

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
  account_email text;
  account_customer_id uuid;
  authorized_wholesale_customer_id uuid;
  original_jwt_sub text := current_setting('request.jwt.claim.sub', true);
  original_jwt_claims text := current_setting('request.jwt.claims', true);
  normalized_country text := coalesce(nullif(trim(delivery_country), ''), 'Honduras');
  normalized_country_code text := coalesce(nullif(upper(trim(country_code)), ''), 'HN');
  normalized_customer_name text := trim(coalesce(customer_name, ''));
  normalized_customer_email text := lower(nullif(trim(coalesce(customer_email, '')), ''));
  normalized_customer_phone text := public.normalize_hn_phone(customer_phone);
  normalized_customer_rtn text := nullif(trim(coalesce(customer_rtn, '')), '');
  normalized_delivery_address text := trim(coalesce(delivery_address, ''));
  legacy_customer_email text := customer_email;
  legacy_customer_phone text := coalesce(public.normalize_hn_phone(customer_phone), customer_phone);
  legacy_customer_rtn text := customer_rtn;
  legacy_row record;
  legacy_customer_id uuid;
  created_order record;
  item_record record;
  product_record record;
  expected_item_count integer := 0;
  restored_stock integer;
  reservation_id uuid;
  reservation_deadline timestamptz := now() + interval '48 hours';
  wholesale_subtotal numeric(12, 2) := 0;
  wholesale_tax numeric(12, 2) := 0;
  tax_rate numeric(5, 4) := 0.1500;
  free_shipping_threshold numeric(12, 2) := 3000;
  standard_shipping_fee numeric(12, 2) := 120;
  cash_on_delivery_percentage numeric(6, 2) := 5;
  enable_cash_on_delivery_fee boolean := true;
  first_wholesale_minimum numeric(12, 2) := 10000;
  missing_wholesale_minimum numeric(12, 2) := 0;
  shipping_amount numeric(12, 2) := 0;
  cod_amount numeric(12, 2) := 0;
  final_total numeric(12, 2) := 0;
  has_previous_wholesale boolean := false;
begin
  if normalized_country_code <> 'HN' or lower(normalized_country) not in ('honduras', 'hn') then
    raise exception 'Actualmente solo realizamos entregas dentro de Honduras.';
  end if;

  if order_items is null or jsonb_typeof(order_items) <> 'array' or jsonb_array_length(order_items) = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  if current_user_id is not null then
    select lower(nullif(trim(coalesce(auth_users.email, app_users.email)), ''))
    into account_email
    from auth.users auth_users
    left join public.users app_users on app_users.id = auth_users.id
    where auth_users.id = current_user_id
    limit 1;

    if account_email is null then
      select lower(nullif(trim(users.email), ''))
      into account_email
      from public.users
      where users.id = current_user_id
      limit 1;
    end if;

    if account_email is null then
      raise exception 'No pudimos validar el correo de tu cuenta. Cierra sesion e inicia sesion nuevamente.';
    end if;

    normalized_customer_email := account_email;

    -- The legacy checkout receives isolated identifiers so it cannot select an
    -- operational customer by email, phone or RTN. The final order remains
    -- owned by orders.user_id, while customer portal ownership stays manual.
    legacy_customer_email := null;
    legacy_customer_phone := 'account-checkout-' || gen_random_uuid()::text;
    legacy_customer_rtn := null;

    select customers.id
    into account_customer_id
    from public.customers
    where customers.user_id = current_user_id
      and customers.active = true
    order by customers.updated_at desc
    limit 1;

    if account_customer_id is null then
      select customers.id
      into account_customer_id
      from public.orders
      join public.customers on customers.id = orders.customer_id
      where orders.user_id = current_user_id
        and customers.user_id is null
        and customers.active = true
      order by orders.created_at desc
      limit 1;
    end if;
  else
    if normalized_customer_email is null or normalized_customer_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Ingresa un correo valido para el pedido.';
    end if;

    legacy_customer_email := null;
    legacy_customer_phone := 'guest-checkout-' || gen_random_uuid()::text;
    legacy_customer_rtn := null;
  end if;

  if requested_price_mode = 'wholesale' then
    if current_user_id is null then
      raise exception 'Inicia sesion con tu cuenta mayorista aprobada para activar precios.';
    end if;

    select c.id
    into authorized_wholesale_customer_id
    from public.customers c
    join public.users u on u.id = c.user_id
    where c.user_id = current_user_id
      and c.active = true
      and c.wholesale_status = 'approved'
      and u.active = true
    order by c.updated_at desc
    limit 1;

    if authorized_wholesale_customer_id is null then
      raise exception 'Tu cuenta no esta autorizada para compras mayoristas.';
    end if;

    account_customer_id := authorized_wholesale_customer_id;
  end if;

  create temporary table if not exists checkout_reservation_items_temp (
    product_id uuid primary key,
    quantity integer not null check (quantity > 0)
  ) on commit drop;

  truncate table checkout_reservation_items_temp;

  insert into checkout_reservation_items_temp (product_id, quantity)
  select raw_items.product_id::uuid, sum(raw_items.quantity)::integer
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
    select products.id, products.name, products.stock, coalesce(products.reserved_stock, 0) as reserved_stock, checkout_items.quantity
    from checkout_reservation_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    where products.active = true and products.status = 'active'
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
    where products.active = true and products.status = 'active'
  ) <> expected_item_count then
    raise exception 'Uno de los productos ya no esta disponible.';
  end if;

  -- The legacy function reads auth.uid() and would otherwise write it into the
  -- staging customer before this wrapper can apply the manual-link boundary.
  -- Mask the subject only for that nested call, then restore the request state.
  if current_user_id is not null then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);
  end if;

  select *
  into legacy_row
  from public.create_checkout_order_legacy_20260511(
    customer_name,
    legacy_customer_email,
    legacy_customer_phone,
    legacy_customer_rtn,
    delivery_address,
    case when requested_price_mode = 'wholesale' then 'retail'::public.order_price_mode else requested_price_mode end,
    requested_payment_method,
    bank_reference_number,
    order_items,
    null,
    null,
    transfer_receipt_url
  )
  limit 1;

  if current_user_id is not null then
    perform set_config('request.jwt.claim.sub', coalesce(original_jwt_sub, ''), true);
    perform set_config('request.jwt.claims', coalesce(original_jwt_claims, ''), true);
  end if;

  select orders.customer_id
  into legacy_customer_id
  from public.orders
  where orders.id = legacy_row.order_id;

  if requested_price_mode = 'wholesale' then
    select coalesce(company_settings.tax_rate, 0.1500)
    into tax_rate
    from public.company_settings
    order by company_settings.created_at asc
    limit 1;

    update public.order_items oi
    set
      applied_price_mode = 'wholesale',
      unit_price = round(products.wholesale_price, 2),
      line_total = round(products.wholesale_price * oi.quantity, 2),
      retail_price_snapshot = round(products.retail_price, 2),
      wholesale_price_snapshot = round(products.wholesale_price, 2)
    from public.products
    where oi.order_id = legacy_row.order_id
      and products.id = oi.product_id;

    select coalesce(sum(line_total), 0)
    into wholesale_subtotal
    from public.order_items
    where order_items.order_id = legacy_row.order_id;

    wholesale_tax := round(wholesale_subtotal * coalesce(tax_rate, 0.1500), 2);

    update public.orders
    set
      user_id = current_user_id,
      customer_id = authorized_wholesale_customer_id,
      email = account_email,
      price_mode = 'wholesale',
      wholesale_code_id = null,
      subtotal = wholesale_subtotal,
      tax = wholesale_tax,
      total = wholesale_subtotal + wholesale_tax,
      updated_at = now()
    where orders.id = legacy_row.order_id;

    update public.payments
    set customer_id = authorized_wholesale_customer_id,
        amount = wholesale_subtotal + wholesale_tax,
        updated_at = now()
    where payments.order_id = legacy_row.order_id;
  end if;

  select *
  into created_order
  from public.orders
  where orders.id = legacy_row.order_id
  for update;

  if current_user_id is null then
    update public.customers
    set
      user_id = null,
      contact_name = normalized_customer_name,
      email = normalized_customer_email,
      phone = coalesce(normalized_customer_phone, create_checkout_order.customer_phone),
      tax_id = normalized_customer_rtn,
      address = normalized_delivery_address,
      is_wholesale = false,
      active = true,
      status = 'active',
      lead_status = 'cliente',
      notes = case
        when coalesce(notes, '') like '%[CHECKOUT_INVITADO]%' then notes
        else coalesce(notes, '') || case when coalesce(notes, '') = '' then '' else chr(10) end || '[CHECKOUT_INVITADO] Compra sin cuenta'
      end,
      updated_at = now()
    where customers.id = created_order.customer_id
      and customers.user_id is null;

    update public.orders
    set
      user_id = null,
      customer_name = normalized_customer_name,
      email = normalized_customer_email,
      phone = coalesce(normalized_customer_phone, create_checkout_order.customer_phone),
      customer_phone = coalesce(normalized_customer_phone, create_checkout_order.customer_phone),
      delivery_address = normalized_delivery_address,
      updated_at = now()
    where orders.id = legacy_row.order_id;
  else
    if account_customer_id is null then
      account_customer_id := created_order.customer_id;

      update public.customers
      set
        user_id = null,
        contact_name = coalesce(nullif(normalized_customer_name, ''), account_email),
        email = account_email,
        phone = normalized_customer_phone,
        tax_id = normalized_customer_rtn,
        address = nullif(normalized_delivery_address, ''),
        city = nullif(trim(coalesce(delivery_city, '')), ''),
        active = true,
        status = 'active',
        lead_status = 'cliente',
        notes = case
          when coalesce(notes, '') like '%[CHECKOUT_CUENTA_SIN_VINCULO]%'
            then notes
          else coalesce(notes, '') || case when coalesce(notes, '') = '' then '' else chr(10) end
            || '[CHECKOUT_CUENTA_SIN_VINCULO] Customer operativo; cuenta web no vinculada'
        end,
        updated_at = now()
      where customers.id = account_customer_id
        and customers.user_id is null;

      if not found then
        raise exception 'No pudimos preparar el cliente operativo del pedido.';
      end if;
    else
      update public.customers
      set
        contact_name = coalesce(nullif(normalized_customer_name, ''), customers.contact_name),
        email = account_email,
        phone = coalesce(normalized_customer_phone, customers.phone),
        tax_id = coalesce(normalized_customer_rtn, customers.tax_id),
        address = coalesce(nullif(normalized_delivery_address, ''), customers.address),
        city = coalesce(nullif(trim(coalesce(delivery_city, '')), ''), customers.city),
        active = true,
        updated_at = now()
      where customers.id = account_customer_id;
    end if;

    update public.orders
    set
      user_id = current_user_id,
      customer_id = account_customer_id,
      customer_name = normalized_customer_name,
      email = account_email,
      phone = coalesce(normalized_customer_phone, create_checkout_order.customer_phone),
      customer_phone = coalesce(normalized_customer_phone, create_checkout_order.customer_phone),
      delivery_address = normalized_delivery_address,
      updated_at = now()
    where orders.id = legacy_row.order_id;

    update public.payments
    set customer_id = account_customer_id,
        updated_at = now()
    where payments.order_id = legacy_row.order_id;

    update public.invoices
    set customer_id = account_customer_id,
        customer_email = account_email,
        updated_at = now()
    where invoices.order_id = legacy_row.order_id;

    update public.crm_followups
    set customer_id = account_customer_id
    where crm_followups.order_id = legacy_row.order_id;

    update public.crm_notes
    set customer_id = account_customer_id
    where crm_notes.order_id = legacy_row.order_id;

    if legacy_customer_id <> account_customer_id then
      delete from public.customers
      where customers.id = legacy_customer_id
        and customers.user_id is null
        and customers.phone = legacy_customer_phone;

      if not found then
        raise exception 'No pudimos limpiar el cliente temporal del pedido.';
      end if;
    end if;
  end if;

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
    select order_items.product_id, sum(order_items.quantity)::integer as quantity
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

    insert into public.inventory_reservations (order_id, product_id, quantity, status, expires_at)
    values (legacy_row.order_id, item_record.product_id, item_record.quantity, 'reserved', reservation_deadline)
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
  where orders.id = legacy_row.order_id;

  select
    coalesce(company_settings.free_shipping_threshold, 3000),
    coalesce(company_settings.standard_shipping_fee, 120),
    coalesce(company_settings.cash_on_delivery_percentage, 5),
    coalesce(company_settings.enable_cash_on_delivery_fee, true),
    coalesce(company_settings.first_wholesale_minimum, 10000)
  into free_shipping_threshold, standard_shipping_fee, cash_on_delivery_percentage, enable_cash_on_delivery_fee, first_wholesale_minimum
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  select *
  into created_order
  from public.orders
  where orders.id = legacy_row.order_id
  for update;

  if requested_price_mode = 'wholesale' and first_wholesale_minimum > 0 then
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
      missing_wholesale_minimum := first_wholesale_minimum - created_order.subtotal;
      raise exception 'Tu primera compra como mayorista debe ser de L % o mas. Agrega mas productos para completar el minimo. Te faltan L % para completar el minimo mayorista.',
        to_char(first_wholesale_minimum, 'FM999G999G990D00'),
        to_char(missing_wholesale_minimum, 'FM999G999G990D00');
    end if;
  end if;

  shipping_amount := case when created_order.subtotal >= free_shipping_threshold then 0 else standard_shipping_fee end;
  cod_amount := case
    when requested_payment_method = 'cash' and enable_cash_on_delivery_fee then round(created_order.subtotal * (cash_on_delivery_percentage / 100), 2)
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
