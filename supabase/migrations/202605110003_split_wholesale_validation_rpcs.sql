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
    select
      normalized_code,
      false,
      'empty'::text,
      'Ingresa un codigo mayorista.'::text,
      false,
      null::timestamptz;
    return;
  end if;

  select *
  into matched_code
  from public.wholesale_codes wc
  where wc.code = normalized_code
  limit 1;

  if matched_code.id is null then
    return query
    select
      normalized_code,
      false,
      'not_found'::text,
      'Codigo mayorista invalido, inactivo, vencido o sin usos disponibles.'::text,
      false,
      null::timestamptz;
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
    select
      matched_code.code,
      false,
      matched_code.status::text,
      'Codigo mayorista invalido, inactivo, vencido o sin usos disponibles.'::text,
      false,
      matched_code.expires_at;
    return;
  end if;

  return query
  select
    matched_code.code,
    true,
    'valid'::text,
    'Codigo mayorista valido. Para activar precios de mayoreo, inicia sesion con tu cuenta mayorista.'::text,
    true,
    matched_code.expires_at;
end;
$$;

create or replace function public.activate_wholesale_account(raw_code text)
returns table (
  id uuid,
  code text,
  customer_id uuid,
  customer_name text,
  business_name text,
  label text,
  minimum_order numeric,
  expires_at timestamptz,
  used_count integer,
  status public.wholesale_code_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := upper(trim(coalesce($1, '')));
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null or normalized_code = '' then
    return;
  end if;

  return query
  select
    wc.id,
    wc.code,
    wc.customer_id,
    coalesce(c.contact_name, wc.label) as customer_name,
    coalesce(c.company_name, c.business_name, wc.label) as business_name,
    wc.label,
    wc.minimum_order,
    wc.expires_at,
    wc.used_count,
    wc.status
  from public.wholesale_codes wc
  join public.customers c on c.id = wc.customer_id
  join public.users u on u.id = c.user_id
  where wc.code = normalized_code
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
end;
$$;

grant execute on function public.validate_wholesale_code_public(text) to anon, authenticated, service_role;
grant execute on function public.activate_wholesale_account(text) to authenticated, service_role;
