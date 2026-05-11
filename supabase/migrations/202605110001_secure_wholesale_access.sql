alter table public.customers
  add column if not exists company_name text,
  add column if not exists status text not null default 'active';

alter table public.wholesale_codes
  add column if not exists is_active boolean;

update public.customers
set
  company_name = coalesce(company_name, business_name),
  status = case when active then 'active' else 'inactive' end
where company_name is null
   or status is null
   or status not in ('active', 'inactive', 'disabled');

update public.wholesale_codes
set is_active = coalesce(is_active, active)
where is_active is null;

alter table public.wholesale_codes
  alter column is_active set default true,
  alter column is_active set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_status_check'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_status_check check (status in ('active', 'inactive', 'disabled'));
  end if;
end;
$$;

create index if not exists customers_status_idx on public.customers(status);
create index if not exists customers_company_name_idx on public.customers(company_name);
create index if not exists wholesale_codes_is_active_idx on public.wholesale_codes(is_active);

create or replace function public.sync_customer_security_aliases()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.company_name := nullif(coalesce(new.company_name, new.business_name), '');
    new.business_name := nullif(coalesce(new.business_name, new.company_name), '');
    new.status := coalesce(new.status, case when new.active then 'active' else 'inactive' end);
    new.active := new.status = 'active';
    return new;
  end if;

  if new.company_name is distinct from old.company_name
     and new.business_name is not distinct from old.business_name then
    new.business_name := nullif(new.company_name, '');
  elsif new.business_name is distinct from old.business_name
        and new.company_name is not distinct from old.company_name then
    new.company_name := nullif(new.business_name, '');
  elsif new.company_name is null and new.business_name is not null then
    new.company_name := new.business_name;
  elsif new.business_name is null and new.company_name is not null then
    new.business_name := new.company_name;
  end if;

  if new.status is distinct from old.status
     and new.active is not distinct from old.active then
    new.active := new.status = 'active';
  elsif new.active is distinct from old.active
        and new.status is not distinct from old.status then
    new.status := case when new.active then 'active' else 'inactive' end;
  elsif new.status is null then
    new.status := case when new.active then 'active' else 'inactive' end;
  end if;

  return new;
end;
$$;

drop trigger if exists customers_sync_security_aliases on public.customers;
create trigger customers_sync_security_aliases
  before insert or update on public.customers
  for each row execute function public.sync_customer_security_aliases();

create or replace function public.sync_wholesale_code_active_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.is_active := coalesce(new.is_active, new.active, true);
    new.active := coalesce(new.active, new.is_active, true);
    return new;
  end if;

  if new.is_active is distinct from old.is_active
     and new.active is not distinct from old.active then
    new.active := new.is_active;
  elsif new.active is distinct from old.active
        and new.is_active is not distinct from old.is_active then
    new.is_active := new.active;
  elsif new.is_active is null then
    new.is_active := new.active;
  end if;

  return new;
end;
$$;

drop trigger if exists wholesale_codes_sync_active_fields on public.wholesale_codes;
create trigger wholesale_codes_sync_active_fields
  before insert or update on public.wholesale_codes
  for each row execute function public.sync_wholesale_code_active_fields();

create or replace function public.validate_wholesale_code(raw_code text)
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
  normalized_code text := upper(trim(coalesce(raw_code, '')));
  matched_code public.wholesale_codes%rowtype;
  matched_customer public.customers%rowtype;
begin
  if normalized_code = '' then
    return;
  end if;

  select *
  into matched_code
  from public.wholesale_codes wc
  where wc.code = normalized_code
  limit 1;

  if matched_code.id is null then
    return;
  end if;

  if not coalesce(matched_code.is_active, matched_code.active)
    or matched_code.status <> 'active'
    or (matched_code.starts_at is not null and matched_code.starts_at > now())
    or (matched_code.expires_at is not null and matched_code.expires_at < now())
    or (matched_code.max_uses is not null and matched_code.used_count >= matched_code.max_uses)
    or matched_code.customer_id is null
  then
    return;
  end if;

  select *
  into matched_customer
  from public.customers c
  where c.id = matched_code.customer_id
    and c.active = true
    and c.status = 'active'
    and c.is_wholesale = true;

  if matched_customer.id is null then
    return;
  end if;

  id := matched_code.id;
  code := matched_code.code;
  customer_id := matched_code.customer_id;
  customer_name := coalesce(matched_customer.contact_name, matched_code.label);
  business_name := coalesce(matched_customer.company_name, matched_customer.business_name, matched_code.label);
  label := matched_code.label;
  minimum_order := matched_code.minimum_order;
  expires_at := matched_code.expires_at;
  used_count := matched_code.used_count;
  status := matched_code.status;

  return next;
end;
$$;

create or replace function public.activate_wholesale_code(raw_code text)
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
  normalized_code text := upper(trim(coalesce(raw_code, '')));
  current_user_id uuid := auth.uid();
  matched_code public.wholesale_codes%rowtype;
  matched_customer public.customers%rowtype;
begin
  if current_user_id is null or normalized_code = '' then
    return;
  end if;

  select wc.*
  into matched_code
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

  if matched_code.id is null then
    return;
  end if;

  select *
  into matched_customer
  from public.customers c
  where c.id = matched_code.customer_id;

  id := matched_code.id;
  code := matched_code.code;
  customer_id := matched_code.customer_id;
  customer_name := coalesce(matched_customer.contact_name, matched_code.label);
  business_name := coalesce(matched_customer.company_name, matched_customer.business_name, matched_code.label);
  label := matched_code.label;
  minimum_order := matched_code.minimum_order;
  expires_at := matched_code.expires_at;
  used_count := matched_code.used_count;
  status := matched_code.status;

  return next;
end;
$$;

do $$
begin
  if to_regprocedure('public.create_checkout_order_legacy_20260511(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text)') is null
     and to_regprocedure('public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text)') is not null then
    execute 'alter function public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text) rename to create_checkout_order_legacy_20260511';
  end if;
end;
$$;

revoke all on function public.create_checkout_order_legacy_20260511(
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
) from public, anon, authenticated;

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
begin
  if requested_price_mode = 'wholesale' then
    if current_user_id is null then
      raise exception 'Para activar precios de mayoreo debes iniciar sesion con tu cuenta mayorista.';
    end if;

    if nullif(trim(coalesce(wholesale_code, '')), '') is null or wholesale_code_id is null then
      raise exception 'Debes validar un codigo mayorista antes de comprar con precio mayorista.';
    end if;

    select wc.id
    into wholesale_allowed_id
    from public.wholesale_codes wc
    join public.customers c on c.id = wc.customer_id
    join public.users u on u.id = c.user_id
    where wc.code = upper(trim(wholesale_code))
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

grant execute on function public.validate_wholesale_code(text) to anon, authenticated, service_role;
grant execute on function public.activate_wholesale_code(text) to authenticated, service_role;
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
