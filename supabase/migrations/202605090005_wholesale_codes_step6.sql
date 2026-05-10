create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'wholesale_code_status') then
    create type public.wholesale_code_status as enum ('active', 'inactive', 'expired', 'disabled');
  end if;
end;
$$;

alter table public.wholesale_codes
  add column if not exists code text,
  add column if not exists status public.wholesale_code_status not null default 'active',
  add column if not exists last_used_at timestamptz;

update public.wholesale_codes
set code = upper(coalesce(code, 'LEGACY-' || left(id::text, 8)))
where code is null;

alter table public.wholesale_codes
  alter column code set not null;

update public.wholesale_codes
set code_hash = encode(extensions.digest(upper(trim(code)), 'sha256'), 'hex')
where code_hash is null
   or code_hash = '';

create unique index if not exists wholesale_codes_code_idx on public.wholesale_codes(code);
create index if not exists wholesale_codes_status_idx on public.wholesale_codes(status);
create index if not exists wholesale_codes_expires_at_idx on public.wholesale_codes(expires_at);

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
  normalized_code text := upper(trim(raw_code));
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

  if not matched_code.active
    or matched_code.status <> 'active'
    or (matched_code.starts_at is not null and matched_code.starts_at > now())
    or (matched_code.expires_at is not null and matched_code.expires_at < now())
    or (matched_code.max_uses is not null and matched_code.used_count >= matched_code.max_uses)
  then
    return;
  end if;

  update public.wholesale_codes wc
  set
    used_count = wc.used_count + 1,
    last_used_at = now(),
    updated_at = now()
  where wc.id = matched_code.id
  returning * into matched_code;

  if matched_code.customer_id is not null then
    select *
    into matched_customer
    from public.customers c
    where c.id = matched_code.customer_id;
  end if;

  id := matched_code.id;
  code := matched_code.code;
  customer_id := matched_code.customer_id;
  customer_name := coalesce(matched_customer.contact_name, matched_code.label);
  business_name := coalesce(matched_customer.business_name, matched_code.label);
  label := matched_code.label;
  minimum_order := matched_code.minimum_order;
  expires_at := matched_code.expires_at;
  used_count := matched_code.used_count;
  status := matched_code.status;

  return next;
end;
$$;

grant execute on function public.validate_wholesale_code(text) to anon, authenticated;
