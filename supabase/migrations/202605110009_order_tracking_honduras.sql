alter table public.orders
  add column if not exists tracking_code text,
  add column if not exists tracking_token uuid not null default gen_random_uuid(),
  add column if not exists tracking_status text not null default 'recibido',
  add column if not exists public_tracking_enabled boolean not null default true,
  add column if not exists delivery_country text not null default 'Honduras',
  add column if not exists delivery_country_code text not null default 'HN',
  add column if not exists delivery_department text,
  add column if not exists delivery_city text;

create unique index if not exists orders_tracking_code_key
  on public.orders(tracking_code)
  where tracking_code is not null;

create index if not exists orders_tracking_status_idx on public.orders(tracking_status);
create index if not exists orders_public_tracking_enabled_idx on public.orders(public_tracking_enabled);

create or replace function public.generate_order_tracking_code(source_order_number text default null)
returns text
language plpgsql
set search_path = public
as $$
declare
  generated_code text;
  suffix text;
begin
  for attempt in 1..20 loop
    suffix := upper(substr(encode(gen_random_bytes(3), 'hex'), 1, 4));
    generated_code := 'TRK-CZ-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || suffix;

    if not exists (
      select 1
      from public.orders
      where orders.tracking_code = generated_code
    ) then
      return generated_code;
    end if;
  end loop;

  return 'TRK-CZ-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS') || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
end;
$$;

update public.orders
set
  tracking_code = coalesce(
    tracking_code,
    'TRK-CZ-' || to_char(created_at, 'YYYYMMDD') || '-' || upper(substr(replace(id::text, '-', ''), 1, 4))
  ),
  tracking_status = coalesce(tracking_status, status::text, 'recibido'),
  public_tracking_enabled = coalesce(public_tracking_enabled, true),
  delivery_country = coalesce(nullif(trim(delivery_country), ''), 'Honduras'),
  delivery_country_code = coalesce(nullif(upper(trim(delivery_country_code)), ''), 'HN')
where tracking_code is null
   or tracking_status is null
   or delivery_country is null
   or delivery_country_code is null;

create or replace function public.prepare_order_tracking_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.delivery_country := coalesce(nullif(trim(new.delivery_country), ''), 'Honduras');
  new.delivery_country_code := coalesce(nullif(upper(trim(new.delivery_country_code)), ''), 'HN');

  if upper(new.delivery_country_code) <> 'HN' or lower(new.delivery_country) not in ('honduras', 'hn') then
    raise exception 'Actualmente solo realizamos entregas dentro de Honduras.';
  end if;

  if new.tracking_code is null or trim(new.tracking_code) = '' then
    new.tracking_code := public.generate_order_tracking_code(new.order_number);
  end if;

  if new.tracking_token is null then
    new.tracking_token := gen_random_uuid();
  end if;

  new.tracking_status := coalesce(nullif(trim(new.tracking_status), ''), new.status::text, 'recibido');
  new.public_tracking_enabled := coalesce(new.public_tracking_enabled, true);

  if tg_op = 'UPDATE' and old.status is distinct from new.status then
    new.tracking_status := new.status::text;
  end if;

  return new;
end;
$$;

drop trigger if exists prepare_order_tracking_fields_on_orders on public.orders;
create trigger prepare_order_tracking_fields_on_orders
before insert or update on public.orders
for each row
execute function public.prepare_order_tracking_fields();

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
  legacy_row record;
begin
  if normalized_country_code <> 'HN' or lower(normalized_country) not in ('honduras', 'hn') then
    raise exception 'Actualmente solo realizamos entregas dentro de Honduras.';
  end if;

  if requested_price_mode = 'wholesale' then
    if current_user_id is null then
      raise exception 'Código válido. Inicia sesión con tu cuenta mayorista para activar precios.';
    end if;

    if normalized_wholesale_code = '' or wholesale_code_id is null then
      raise exception 'Código mayorista inválido.';
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
      raise exception 'Código mayorista inválido.';
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
      raise exception 'Tu cuenta no está autorizada para compras mayoristas.';
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
      raise exception 'Este código mayorista no pertenece a tu cuenta.';
    end if;
  end if;

  select *
  into legacy_row
  from public.create_checkout_order_legacy_20260511(
    customer_name,
    customer_email,
    customer_phone,
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

  update public.orders
  set
    delivery_country = normalized_country,
    delivery_country_code = normalized_country_code,
    delivery_department = nullif(trim(coalesce(create_checkout_order.delivery_department, '')), ''),
    delivery_city = nullif(trim(coalesce(create_checkout_order.delivery_city, '')), ''),
    tracking_status = coalesce(nullif(tracking_status, ''), status::text),
    public_tracking_enabled = true,
    updated_at = now()
  where orders.id = legacy_row.order_id
  returning orders.tracking_code into tracking_code;

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

create or replace function public.get_public_order_tracking(raw_tracking_code text)
returns table (
  order_number text,
  tracking_code text,
  tracking_status text,
  order_status text,
  payment_status text,
  created_at timestamptz,
  payment_method text,
  total numeric,
  customer_name_masked text,
  phone_last4 text,
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_tracking_code text := upper(trim(coalesce(raw_tracking_code, '')));
begin
  if normalized_tracking_code = '' then
    return;
  end if;

  return query
  select
    o.order_number,
    o.tracking_code,
    coalesce(o.tracking_status, o.status::text),
    o.status::text,
    coalesce(p.payment_status::text, p.status::text, 'pending'),
    o.created_at,
    o.payment_method::text,
    o.total,
    trim(split_part(o.customer_name, ' ', 1)) || case when strpos(o.customer_name, ' ') > 0 then ' ' || left(split_part(o.customer_name, ' ', 2), 1) || '.' else '' end,
    right(regexp_replace(o.phone, '\D', '', 'g'), 4),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'sku', oi.sku,
          'product_name', oi.product_name,
          'quantity', oi.quantity,
          'unit_price', oi.unit_price,
          'line_total', oi.line_total
        )
        order by oi.created_at asc
      ) filter (where oi.id is not null),
      '[]'::jsonb
    )
  from public.orders o
  left join lateral (
    select payments.payment_status, payments.status
    from public.payments
    where payments.order_id = o.id
    order by payments.created_at desc
    limit 1
  ) p on true
  left join public.order_items oi on oi.order_id = o.id
  where upper(o.tracking_code) = normalized_tracking_code
    and o.public_tracking_enabled = true
  group by
    o.id,
    o.order_number,
    o.tracking_code,
    o.tracking_status,
    o.status,
    p.payment_status,
    p.status,
    o.created_at,
    o.payment_method,
    o.total,
    o.customer_name,
    o.phone;
end;
$$;

grant execute on function public.get_public_order_tracking(text) to anon, authenticated, service_role;
