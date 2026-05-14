-- Normalize Honduran phones and prevent new checkout customers from fragmenting by phone format.

create or replace function public.normalize_hn_phone(raw_phone text)
returns text
language sql
immutable
as $$
  select case
    when regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g') = '' then null
    when length(regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g')) = 8
      then '+504' || regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g')
    when length(regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g')) = 11
      and regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g') like '504%'
      then '+' || regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g')
    else '+' || regexp_replace(coalesce(raw_phone, ''), '\D', '', 'g')
  end;
$$;

create index if not exists customers_email_lower_idx on public.customers(lower(email)) where email is not null;
create index if not exists customers_phone_normalized_idx on public.customers(public.normalize_hn_phone(phone)) where phone is not null;

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
begin
  if normalized_country_code <> 'HN' or lower(normalized_country) not in ('honduras', 'hn') then
    raise exception 'Actualmente solo realizamos entregas dentro de Honduras.';
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
