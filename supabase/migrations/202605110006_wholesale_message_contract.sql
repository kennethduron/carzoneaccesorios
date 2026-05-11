create or replace function public.validate_wholesale_code_public(raw_code text)
returns table (
  code text,
  is_valid boolean,
  status text,
  message text,
  requires_login boolean,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := upper(trim(coalesce($1, '')));
  matched_code public.wholesale_codes%rowtype;
  has_valid_customer boolean := false;
begin
  if normalized_code = '' then
    return query
    select normalized_code, false, 'empty'::text, 'Código mayorista inválido.'::text, false, null::timestamptz;
    return;
  end if;

  select *
  into matched_code
  from public.wholesale_codes wc
  where wc.code = normalized_code
  limit 1;

  if matched_code.id is null then
    return query
    select normalized_code, false, 'not_found'::text, 'Código mayorista inválido.'::text, false, null::timestamptz;
    return;
  end if;

  select exists (
    select 1
    from public.customers c
    where c.id = matched_code.customer_id
      and c.active = true
      and c.status = 'active'
      and c.is_wholesale = true
      and c.user_id is not null
  )
  into has_valid_customer;

  if not coalesce(matched_code.is_active, matched_code.active)
    or matched_code.status <> 'active'
    or (matched_code.starts_at is not null and matched_code.starts_at > now())
    or (matched_code.expires_at is not null and matched_code.expires_at < now())
    or (matched_code.max_uses is not null and matched_code.used_count >= matched_code.max_uses)
    or matched_code.customer_id is null
    or not has_valid_customer
  then
    return query
    select matched_code.code, false, matched_code.status::text, 'Código mayorista inválido.'::text, false, matched_code.expires_at;
    return;
  end if;

  return query
  select
    matched_code.code,
    true,
    'valid'::text,
    'Código válido. Inicia sesión con tu cuenta mayorista para activar precios.'::text,
    true,
    matched_code.expires_at;
end;
$$;

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
  transfer_receipt_url text default null
)
returns table (
  order_id uuid,
  order_number text
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
begin
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

  return query
  select legacy.order_id, legacy.order_number
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
  ) as legacy;
end;
$$;

grant execute on function public.validate_wholesale_code_public(text) to anon, authenticated, service_role;
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
  text
) to anon, authenticated, service_role;
