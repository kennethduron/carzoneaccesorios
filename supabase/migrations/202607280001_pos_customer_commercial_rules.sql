-- POS Phase 1, Stage 3: customer selection and commercial context only.
-- Never creates orders, sales, payments, invoices, receivables, inventory
-- movements, financial events, or journal entries.

alter table public.customers
  add column if not exists commercial_notes text,
  add column if not exists commercial_version integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_commercial_version_nonnegative_check'
  ) then
    alter table public.customers
      add constraint customers_commercial_version_nonnegative_check
      check (commercial_version >= 0) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_commercial_notes_length_check'
  ) then
    alter table public.customers
      add constraint customers_commercial_notes_length_check
      check (commercial_notes is null or char_length(commercial_notes) <= 1000) not valid;
  end if;
end;
$$;

alter table public.customers validate constraint customers_commercial_version_nonnegative_check;
alter table public.customers validate constraint customers_commercial_notes_length_check;

comment on column public.customers.commercial_notes is
  'Non-sensitive operational notes editable only through the authorized POS customer contract.';
comment on column public.customers.commercial_version is
  'Optimistic concurrency version for identity, pricing, wholesale, portal, and credit context.';

create or replace function public.normalize_pos_customer_text_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select nullif(
    trim(regexp_replace(
      translate(lower(coalesce(raw_value, '')), 'áéíóúüñ', 'aeiouun'),
      '\s+', ' ', 'g'
    )),
    ''
  );
$$;

create or replace function public.normalize_pos_customer_email_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select nullif(lower(trim(coalesce(raw_value, ''))), '');
$$;

create or replace function public.normalize_pos_customer_phone_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select nullif(regexp_replace(coalesce(raw_value, ''), '[^0-9+]', '', 'g'), '');
$$;

create or replace function public.normalize_pos_customer_tax_id_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select nullif(regexp_replace(upper(coalesce(raw_value, '')), '[^A-Z0-9]', '', 'g'), '');
$$;

create or replace function public.mask_pos_customer_phone_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when nullif(trim(coalesce(raw_value, '')), '') is null then null
    when char_length(public.normalize_pos_customer_phone_v1(raw_value)) <= 4 then '••••'
    else '••••' || right(public.normalize_pos_customer_phone_v1(raw_value), 4)
  end;
$$;

create or replace function public.mask_pos_customer_email_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when public.normalize_pos_customer_email_v1(raw_value) is null then null
    when position('@' in public.normalize_pos_customer_email_v1(raw_value)) = 0 then '••••'
    else left(public.normalize_pos_customer_email_v1(raw_value), 1)
      || '•••@'
      || split_part(public.normalize_pos_customer_email_v1(raw_value), '@', 2)
  end;
$$;

revoke all on function public.normalize_pos_customer_text_v1(text) from public, anon;
revoke all on function public.normalize_pos_customer_email_v1(text) from public, anon;
revoke all on function public.normalize_pos_customer_phone_v1(text) from public, anon;
revoke all on function public.normalize_pos_customer_tax_id_v1(text) from public, anon;
revoke all on function public.mask_pos_customer_phone_v1(text) from public, anon;
revoke all on function public.mask_pos_customer_email_v1(text) from public, anon;
grant execute on function public.normalize_pos_customer_text_v1(text) to authenticated, service_role;
grant execute on function public.normalize_pos_customer_email_v1(text) to authenticated, service_role;
grant execute on function public.normalize_pos_customer_phone_v1(text) to authenticated, service_role;
grant execute on function public.normalize_pos_customer_tax_id_v1(text) to authenticated, service_role;
grant execute on function public.mask_pos_customer_phone_v1(text) to authenticated, service_role;
grant execute on function public.mask_pos_customer_email_v1(text) to authenticated, service_role;

create index if not exists customers_pos_contact_name_trgm_idx
  on public.customers using gin (public.normalize_pos_customer_text_v1(contact_name) extensions.gin_trgm_ops);
create index if not exists customers_pos_business_name_trgm_idx
  on public.customers using gin (public.normalize_pos_customer_text_v1(coalesce(company_name, business_name)) extensions.gin_trgm_ops);
create index if not exists customers_pos_email_normalized_idx
  on public.customers (public.normalize_pos_customer_email_v1(email))
  where email is not null;
create index if not exists customers_pos_phone_normalized_idx
  on public.customers (public.normalize_pos_customer_phone_v1(phone));
create index if not exists customers_pos_tax_id_normalized_idx
  on public.customers (public.normalize_pos_customer_tax_id_v1(tax_id))
  where tax_id is not null;
create index if not exists customers_pos_commercial_state_idx
  on public.customers (active, wholesale_status, commercial_version, updated_at desc);

update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || '["pos:access", "pos:customers:search", "pos:customers:create", "pos:customers:update", "customers:read_commercial", "customers:read_credit"]'::jsonb
    ) as expanded(permission)
  ) deduplicated
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = ((((((coalesce(permissions, '[]'::jsonb)
  - 'pos:access')
  - 'pos:customers:search')
  - 'pos:customers:create')
  - 'pos:customers:update')
  - 'customers:read_commercial')
  - 'customers:read_credit'),
updated_at = now()
where name in ('contadora', 'vendedor', 'bodega', 'soporte', 'cliente');

create or replace function public.pos_permission_allowed(permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and permission_key in (
      'pos:create_sale',
      'pos:apply_discount',
      'pos:access',
      'pos:customers:search',
      'pos:customers:create',
      'pos:customers:update',
      'customers:read_commercial',
      'customers:read_credit'
    )
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission(permission_key);
$$;

revoke all on function public.pos_permission_allowed(text) from public, anon;
grant execute on function public.pos_permission_allowed(text) to authenticated;

create or replace function public.bump_customer_commercial_version_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.commercial_version := old.commercial_version + 1;
  return new;
end;
$$;

drop trigger if exists bump_customer_commercial_version_trigger on public.customers;
create trigger bump_customer_commercial_version_trigger
before update of
  contact_name, business_name, company_name, email, phone, tax_id, address, city,
  commercial_notes, active, status, is_wholesale, wholesale_status,
  wholesale_customer_type, wholesale_first_purchase_completed, user_id
on public.customers
for each row
when (
  old.contact_name is distinct from new.contact_name
  or old.business_name is distinct from new.business_name
  or old.company_name is distinct from new.company_name
  or old.email is distinct from new.email
  or old.phone is distinct from new.phone
  or old.tax_id is distinct from new.tax_id
  or old.address is distinct from new.address
  or old.city is distinct from new.city
  or old.commercial_notes is distinct from new.commercial_notes
  or old.active is distinct from new.active
  or old.status is distinct from new.status
  or old.is_wholesale is distinct from new.is_wholesale
  or old.wholesale_status is distinct from new.wholesale_status
  or old.wholesale_customer_type is distinct from new.wholesale_customer_type
  or old.wholesale_first_purchase_completed is distinct from new.wholesale_first_purchase_completed
  or old.user_id is distinct from new.user_id
)
execute function public.bump_customer_commercial_version_v1();

create or replace function public.bump_customer_credit_commercial_version_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.customers
  set commercial_version = commercial_version + 1,
      updated_at = greatest(updated_at, now())
  where id = coalesce(new.customer_id, old.customer_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists bump_customer_credit_commercial_version_trigger on public.customer_credit_accounts;
create trigger bump_customer_credit_commercial_version_trigger
after insert or delete or update of is_credit_enabled, credit_limit, terms_days, status
on public.customer_credit_accounts
for each row
execute function public.bump_customer_credit_commercial_version_v1();

create or replace function public.protect_pos_customer_commercial_fields_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if public.pos_permission_allowed('pos:customers:update') then
    return new;
  end if;

  raise exception using errcode = '42501',
    message = 'Los campos comerciales del POS solo pueden cambiar mediante una operacion autorizada.';
end;
$$;

drop trigger if exists protect_pos_customer_commercial_fields_trigger on public.customers;
create trigger protect_pos_customer_commercial_fields_trigger
before update of commercial_notes, commercial_version on public.customers
for each row
execute function public.protect_pos_customer_commercial_fields_v1();

create or replace function public.resolve_customer_pricing_mode_v1(target_customer_id uuid)
returns table (
  pricing_mode text,
  customer_type text,
  wholesale_status text,
  pricing_reason text,
  commercial_version integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  customer_record public.customers%rowtype;
begin
  if not public.pos_permission_allowed('customers:read_commercial') then
    raise exception using errcode = '42501', message = 'Acceso denegado al contexto comercial del cliente.';
  end if;

  select * into customer_record from public.customers where id = target_customer_id;
  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el cliente.';
  end if;

  commercial_version := customer_record.commercial_version;
  wholesale_status := customer_record.wholesale_status;
  if not customer_record.active or customer_record.status <> 'active' then
    pricing_mode := 'retail';
    customer_type := case when customer_record.is_wholesale then 'wholesale' else 'retail' end;
    pricing_reason := 'El cliente esta inactivo; se mantiene precio minorista.';
  elsif customer_record.wholesale_status = 'suspended' then
    pricing_mode := 'retail'; customer_type := 'wholesale';
    pricing_reason := 'El beneficio mayorista esta suspendido; se aplica precio minorista.';
  elsif customer_record.is_wholesale and customer_record.wholesale_status = 'approved' then
    pricing_mode := 'wholesale'; customer_type := 'wholesale';
    pricing_reason := 'Cliente mayorista aprobado y activo.';
  else
    pricing_mode := 'retail'; customer_type := 'retail';
    pricing_reason := case customer_record.wholesale_status
      when 'pending' then 'La solicitud mayorista esta pendiente; se aplica precio minorista.'
      when 'rejected' then 'La solicitud mayorista fue rechazada; se aplica precio minorista.'
      else 'Cliente minorista.'
    end;
  end if;
  return next;
end;
$$;

create or replace function public.evaluate_wholesale_eligibility_v1(
  target_customer_id uuid,
  merchandise_final numeric
)
returns table (
  eligible boolean,
  threshold_amount numeric,
  evaluated_amount numeric,
  missing_amount numeric,
  current_status text,
  pricing_mode text,
  recommended_action text,
  commercial_version integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  customer_record public.customers%rowtype;
  configured_threshold numeric(12,2) := 10000;
begin
  if not public.pos_permission_allowed('customers:read_commercial') then
    raise exception using errcode = '42501', message = 'Acceso denegado a la elegibilidad mayorista.';
  end if;
  if merchandise_final is null or merchandise_final < 0 then
    raise exception using errcode = '22023', message = 'El monto de mercaderia no es valido.';
  end if;
  select * into customer_record from public.customers where id = target_customer_id;
  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el cliente.';
  end if;
  select coalesce(first_wholesale_minimum, 10000) into configured_threshold
  from public.company_settings order by created_at asc limit 1;
  configured_threshold := coalesce(configured_threshold, 10000);
  threshold_amount := configured_threshold;
  evaluated_amount := round(merchandise_final, 2);
  current_status := customer_record.wholesale_status;
  commercial_version := customer_record.commercial_version;
  if customer_record.is_wholesale and customer_record.wholesale_status = 'approved'
    and customer_record.active and customer_record.status = 'active' then
    eligible := true; missing_amount := 0; pricing_mode := 'wholesale';
    recommended_action := 'El cliente ya es mayorista aprobado; no necesita cumplir de nuevo el umbral.';
  elsif customer_record.wholesale_status = 'suspended' then
    eligible := false; missing_amount := greatest(configured_threshold - evaluated_amount, 0); pricing_mode := 'retail';
    recommended_action := 'El beneficio mayorista esta suspendido; requiere revision administrativa.';
  else
    eligible := evaluated_amount >= configured_threshold;
    missing_amount := greatest(configured_threshold - evaluated_amount, 0);
    pricing_mode := 'retail';
    recommended_action := case when eligible
      then 'Elegible para revision mayorista; no implica aprobacion automatica.'
      else 'Aun no alcanza el umbral de mercaderia para revision mayorista.' end;
  end if;
  return next;
end;
$$;

create or replace function public.search_pos_customers_v1(
  p_query text,
  p_limit integer default 25,
  p_offset integer default 0,
  p_include_inactive boolean default false
)
returns table (
  customer_id uuid,
  display_name text,
  business_name text,
  phone_masked text,
  email_masked text,
  customer_type text,
  wholesale_status text,
  has_portal_account boolean,
  is_blocked boolean,
  customer_status text,
  commercial_version integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_query text := public.normalize_pos_customer_text_v1(p_query);
  normalized_email text := public.normalize_pos_customer_email_v1(p_query);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_query);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_query);
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if not public.pos_permission_allowed('pos:customers:search') then
    raise exception using errcode = '42501', message = 'No tienes permiso para buscar clientes desde Punto de Venta.';
  end if;
  if p_include_inactive and not public.pos_permission_allowed('pos:customers:update') then
    raise exception using errcode = '42501', message = 'No tienes permiso para incluir clientes inactivos.';
  end if;
  if normalized_query is null then return; end if;

  return query
  with candidates as (
    select
      customer.*,
      public.normalize_pos_customer_text_v1(customer.contact_name) as normalized_name,
      public.normalize_pos_customer_text_v1(coalesce(customer.company_name, customer.business_name)) as normalized_business,
      public.normalize_pos_customer_email_v1(customer.email) as normalized_customer_email,
      public.normalize_pos_customer_phone_v1(customer.phone) as normalized_customer_phone,
      public.normalize_pos_customer_tax_id_v1(customer.tax_id) as normalized_customer_tax,
      exists (
        select 1 from public.customer_credit_accounts credit
        where credit.customer_id = customer.id and credit.status = 'suspended'
      ) or exists (
        select 1 from public.accounts_receivable receivable
        where receivable.customer_id = customer.id
          and receivable.status = 'overdue' and receivable.balance_due > 0
      ) as financial_block
    from public.customers customer
    where (p_include_inactive or (customer.active and customer.status = 'active'))
      and (
        customer.id::text = trim(p_query)
        or public.normalize_pos_customer_text_v1(customer.contact_name) like '%' || normalized_query || '%'
        or public.normalize_pos_customer_text_v1(coalesce(customer.company_name, customer.business_name)) like '%' || normalized_query || '%'
        or public.normalize_pos_customer_email_v1(customer.email) like '%' || normalized_email || '%'
        or public.normalize_pos_customer_phone_v1(customer.phone) like '%' || normalized_phone || '%'
        or public.normalize_pos_customer_tax_id_v1(customer.tax_id) like '%' || normalized_tax || '%'
      )
  ), ranked as (
    select candidates.*,
      case
        when candidates.id::text = trim(p_query) then 0
        when candidates.normalized_customer_email = normalized_email
          or candidates.normalized_customer_phone = normalized_phone
          or candidates.normalized_customer_tax = normalized_tax
          or candidates.normalized_name = normalized_query
          or candidates.normalized_business = normalized_query then 1
        when candidates.normalized_name like normalized_query || '%'
          or candidates.normalized_business like normalized_query || '%'
          or candidates.normalized_customer_email like normalized_email || '%'
          or candidates.normalized_customer_phone like normalized_phone || '%'
          or candidates.normalized_customer_tax like normalized_tax || '%' then 2
        else 3
      end as match_rank
    from candidates
  )
  select
    ranked.id,
    coalesce(nullif(trim(ranked.contact_name), ''), nullif(trim(coalesce(ranked.company_name, ranked.business_name)), ''), 'Cliente'),
    nullif(trim(coalesce(ranked.company_name, ranked.business_name)), ''),
    public.mask_pos_customer_phone_v1(ranked.phone),
    public.mask_pos_customer_email_v1(ranked.email),
    case when ranked.is_wholesale then 'wholesale' else 'retail' end,
    ranked.wholesale_status,
    ranked.user_id is not null,
    (not ranked.active or ranked.status <> 'active' or ranked.wholesale_status = 'suspended' or ranked.financial_block),
    case when ranked.active and ranked.status = 'active' then 'active' else 'inactive' end,
    ranked.commercial_version,
    count(*) over()
  from ranked
  order by ranked.match_rank, ranked.normalized_name nulls last, ranked.normalized_business nulls last, ranked.id
  limit safe_limit offset safe_offset;
end;
$$;

create or replace function public.get_pos_customer_context_v1(target_customer_id uuid)
returns table (
  customer_id uuid,
  display_name text,
  business_name text,
  phone text,
  email text,
  tax_id text,
  address text,
  city text,
  commercial_notes text,
  customer_type text,
  wholesale_status text,
  pricing_mode text,
  pricing_reason text,
  commercial_version integer,
  has_portal_account boolean,
  customer_status text,
  credit_status text,
  credit_enabled boolean,
  credit_limit numeric,
  open_balance numeric,
  available_credit numeric,
  overdue_balance numeric,
  receivable_count bigint,
  can_use_credit boolean,
  credit_reason text,
  order_count bigint,
  invoice_count bigint,
  total_billed numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.pos_permission_allowed('customers:read_commercial')
    or not public.pos_permission_allowed('customers:read_credit') then
    raise exception using errcode = '42501', message = 'No tienes permiso para consultar el contexto del cliente.';
  end if;

  return query
  with customer_context as (
    select customer.*,
      pricing.pricing_mode,
      pricing.customer_type,
      pricing.pricing_reason
    from public.customers customer
    cross join lateral public.resolve_customer_pricing_mode_v1(customer.id) pricing
    where customer.id = target_customer_id
  ), credit_summary as (
    select
      account.customer_id,
      account.is_credit_enabled,
      account.credit_limit,
      account.status,
      coalesce(sum(receivable.balance_due) filter (where receivable.status in ('open', 'partial', 'overdue')), 0) as open_balance,
      coalesce(sum(receivable.balance_due) filter (where receivable.status = 'overdue'), 0) as overdue_balance,
      count(receivable.id) filter (where receivable.status in ('open', 'partial', 'overdue')) as receivable_count
    from public.customer_credit_accounts account
    left join public.accounts_receivable receivable on receivable.customer_id = account.customer_id
    where account.customer_id = target_customer_id
    group by account.customer_id, account.is_credit_enabled, account.credit_limit, account.status
  ), order_summary as (
    select count(*) as order_count
    from public.orders order_record
    where order_record.customer_id = target_customer_id
      and order_record.status::text not in ('cancelado', 'cancelled')
  ), invoice_summary as (
    select count(*) as invoice_count, coalesce(sum(total), 0) as total_billed
    from public.invoices invoice_record
    where invoice_record.customer_id = target_customer_id
      and invoice_record.status::text not in ('anulada', 'cancelled')
  )
  select
    customer_context.id,
    coalesce(nullif(trim(customer_context.contact_name), ''), nullif(trim(coalesce(customer_context.company_name, customer_context.business_name)), ''), 'Cliente'),
    nullif(trim(coalesce(customer_context.company_name, customer_context.business_name)), ''),
    customer_context.phone,
    customer_context.email,
    customer_context.tax_id,
    customer_context.address,
    customer_context.city,
    customer_context.commercial_notes,
    customer_context.customer_type,
    customer_context.wholesale_status,
    customer_context.pricing_mode,
    customer_context.pricing_reason,
    customer_context.commercial_version,
    customer_context.user_id is not null,
    case when customer_context.active and customer_context.status = 'active' then 'active' else 'inactive' end,
    case
      when credit_summary.customer_id is null or not credit_summary.is_credit_enabled then 'not_enabled'
      when credit_summary.status = 'suspended' then 'suspended'
      when credit_summary.overdue_balance > 0 then 'on_hold'
      else 'active'
    end,
    coalesce(credit_summary.is_credit_enabled, false),
    coalesce(credit_summary.credit_limit, 0),
    coalesce(credit_summary.open_balance, 0),
    greatest(coalesce(credit_summary.credit_limit, 0) - coalesce(credit_summary.open_balance, 0), 0),
    coalesce(credit_summary.overdue_balance, 0),
    coalesce(credit_summary.receivable_count, 0),
    coalesce(credit_summary.is_credit_enabled, false)
      and coalesce(credit_summary.status, 'suspended') = 'active'
      and coalesce(credit_summary.overdue_balance, 0) = 0,
    case
      when credit_summary.customer_id is null or not credit_summary.is_credit_enabled then 'Credito no habilitado.'
      when credit_summary.status = 'suspended' then 'La cuenta de credito esta suspendida.'
      when credit_summary.overdue_balance > 0 then 'Existe saldo vencido; el credito esta en espera.'
      else 'Credito disponible solo para consulta en esta etapa.'
    end,
    order_summary.order_count,
    invoice_summary.invoice_count,
    invoice_summary.total_billed
  from customer_context
  cross join order_summary
  cross join invoice_summary
  left join credit_summary on credit_summary.customer_id = customer_context.id;

  if not found then
    raise exception using errcode = 'P0002', message = 'No se encontro el cliente.';
  end if;
end;
$$;

create or replace function public.find_pos_customer_duplicate_v1(
  normalized_email text,
  normalized_phone text,
  normalized_tax_id text,
  excluded_customer_id uuid default null
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select customer.id
  from public.customers customer
  where (excluded_customer_id is null or customer.id <> excluded_customer_id)
    and (
      (normalized_email is not null and public.normalize_pos_customer_email_v1(customer.email) = normalized_email)
      or (normalized_phone is not null and public.normalize_pos_customer_phone_v1(customer.phone) = normalized_phone)
      or (normalized_tax_id is not null and public.normalize_pos_customer_tax_id_v1(customer.tax_id) = normalized_tax_id)
    )
  order by customer.created_at, customer.id
  limit 1;
$$;

revoke all on function public.find_pos_customer_duplicate_v1(text, text, text, uuid) from public, anon, authenticated;

create or replace function public.create_pos_customer_v1(
  p_request_key uuid,
  p_contact_name text,
  p_phone text,
  p_email text default null,
  p_business_name text default null,
  p_tax_id text default null,
  p_address text default null,
  p_city text default null,
  p_commercial_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_name text := nullif(trim(regexp_replace(coalesce(p_contact_name, ''), '\s+', ' ', 'g')), '');
  normalized_business text := nullif(trim(regexp_replace(coalesce(p_business_name, ''), '\s+', ' ', 'g')), '');
  normalized_email text := public.normalize_pos_customer_email_v1(p_email);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_phone);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_tax_id);
  normalized_address text := nullif(trim(regexp_replace(coalesce(p_address, ''), '\s+', ' ', 'g')), '');
  normalized_city text := nullif(trim(regexp_replace(coalesce(p_city, ''), '\s+', ' ', 'g')), '');
  normalized_notes text := nullif(trim(regexp_replace(coalesce(p_commercial_notes, ''), '\s+', ' ', 'g')), '');
  payload jsonb;
  payload_hash text;
  claim_record record;
  duplicate_id uuid;
  created_customer public.customers%rowtype;
  safe_result jsonb;
  lock_key text;
begin
  if not public.pos_permission_allowed('pos:access')
    or not public.pos_permission_allowed('pos:customers:create') then
    raise exception using errcode = '42501', message = 'No tienes permiso para crear clientes desde Punto de Venta.';
  end if;
  if p_request_key is null or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'La clave de idempotencia no es valida.';
  end if;
  if normalized_name is null or char_length(normalized_name) > 160 then
    raise exception using errcode = '22023', message = 'El nombre del cliente es obligatorio y debe tener hasta 160 caracteres.';
  end if;
  if normalized_phone is null or char_length(normalized_phone) not between 8 and 20 then
    raise exception using errcode = '22023', message = 'El telefono debe contener entre 8 y 20 digitos o un prefijo internacional valido.';
  end if;
  if normalized_email is not null and (char_length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception using errcode = '22023', message = 'El correo electronico no es valido.';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 1000 then
    raise exception using errcode = '22023', message = 'Las notas comerciales deben tener hasta 1000 caracteres.';
  end if;

  payload := jsonb_build_object(
    'contact_name', normalized_name, 'phone', normalized_phone, 'email', normalized_email,
    'business_name', normalized_business, 'tax_id', normalized_tax, 'address', normalized_address,
    'city', normalized_city, 'commercial_notes', normalized_notes
  );
  payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim_record
  from public.claim_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash);
  if claim_record.request_status = 'succeeded' then
    return claim_record.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim_record.acquired then
    raise exception using errcode = '55000', message = 'La creacion del cliente todavia esta en proceso.';
  end if;

  for lock_key in
    select value from unnest(array_remove(array[
      case when normalized_email is not null then 'email:' || normalized_email end,
      case when normalized_phone is not null then 'phone:' || normalized_phone end,
      case when normalized_tax is not null then 'tax:' || normalized_tax end
    ], null)) value order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended('pos-customer:' || lock_key, 0));
  end loop;

  duplicate_id := public.find_pos_customer_duplicate_v1(normalized_email, normalized_phone, normalized_tax, null);
  if duplicate_id is not null then
    safe_result := jsonb_build_object(
      'ok', false, 'status', 'duplicate',
      'message', 'Ya existe un cliente con el mismo correo, telefono o RTN.',
      'customerId', duplicate_id,
      'commercialVersion', (select commercial_version from public.customers where id = duplicate_id),
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', duplicate_id, 'pos.customer.duplicate_blocked', null,
      jsonb_build_object(
        'request_key', p_request_key,
        'email_hash', case when normalized_email is null then null else encode(extensions.digest(convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex') end,
        'phone_last4', case when normalized_phone is null then null else right(normalized_phone, 4) end,
        'tax_hash', case when normalized_tax is null then null else encode(extensions.digest(convert_to(normalized_tax, 'UTF8'), 'sha256'), 'hex') end
      )
    );
    perform public.complete_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash, safe_result);
    return safe_result;
  end if;

  insert into public.customers (
    contact_name, phone, email, business_name, company_name, tax_id, address, city,
    commercial_notes, is_wholesale, wholesale_status, active, status, lead_status, source
  ) values (
    normalized_name, trim(p_phone), normalized_email, normalized_business, normalized_business,
    nullif(trim(p_tax_id), ''), normalized_address, normalized_city, normalized_notes,
    false, 'none', true, 'active', 'cliente', 'pos'
  ) returning * into created_customer;

  safe_result := jsonb_build_object(
    'ok', true, 'status', 'created', 'message', 'Cliente creado correctamente.',
    'customerId', created_customer.id, 'commercialVersion', created_customer.commercial_version,
    'idempotentReplay', false
  );
  perform public.write_audit_log(
    'customers', created_customer.id, 'pos.customer.created', null,
    jsonb_build_object(
      'customer_id', created_customer.id, 'request_key', p_request_key,
      'has_email', normalized_email is not null, 'phone_last4', right(normalized_phone, 4),
      'has_tax_id', normalized_tax is not null, 'wholesale_status', created_customer.wholesale_status,
      'credit_enabled', false, 'portal_linked', false
    )
  );
  perform public.complete_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash, safe_result);
  return safe_result;
end;
$$;

create or replace function public.update_pos_customer_v1(
  p_request_key uuid,
  p_customer_id uuid,
  p_expected_commercial_version integer,
  p_contact_name text,
  p_phone text,
  p_email text default null,
  p_business_name text default null,
  p_tax_id text default null,
  p_address text default null,
  p_city text default null,
  p_commercial_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_name text := nullif(trim(regexp_replace(coalesce(p_contact_name, ''), '\s+', ' ', 'g')), '');
  normalized_business text := nullif(trim(regexp_replace(coalesce(p_business_name, ''), '\s+', ' ', 'g')), '');
  normalized_email text := public.normalize_pos_customer_email_v1(p_email);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_phone);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_tax_id);
  normalized_address text := nullif(trim(regexp_replace(coalesce(p_address, ''), '\s+', ' ', 'g')), '');
  normalized_city text := nullif(trim(regexp_replace(coalesce(p_city, ''), '\s+', ' ', 'g')), '');
  normalized_notes text := nullif(trim(regexp_replace(coalesce(p_commercial_notes, ''), '\s+', ' ', 'g')), '');
  payload jsonb;
  payload_hash text;
  claim_record record;
  duplicate_id uuid;
  current_customer public.customers%rowtype;
  saved_customer public.customers%rowtype;
  safe_result jsonb;
  lock_key text;
begin
  if not public.pos_permission_allowed('pos:access')
    or not public.pos_permission_allowed('pos:customers:update') then
    raise exception using errcode = '42501', message = 'No tienes permiso para editar clientes desde Punto de Venta.';
  end if;
  if p_request_key is null or p_customer_id is null or p_expected_commercial_version is null then
    raise exception using errcode = '22023', message = 'La solicitud de edicion no esta completa.';
  end if;
  if normalized_name is null or char_length(normalized_name) > 160 then
    raise exception using errcode = '22023', message = 'El nombre del cliente es obligatorio y debe tener hasta 160 caracteres.';
  end if;
  if normalized_phone is null or char_length(normalized_phone) not between 8 and 20 then
    raise exception using errcode = '22023', message = 'El telefono debe contener entre 8 y 20 digitos o un prefijo internacional valido.';
  end if;
  if normalized_email is not null and (char_length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception using errcode = '22023', message = 'El correo electronico no es valido.';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 1000 then
    raise exception using errcode = '22023', message = 'Las notas comerciales deben tener hasta 1000 caracteres.';
  end if;

  payload := jsonb_build_object(
    'customer_id', p_customer_id, 'expected_version', p_expected_commercial_version,
    'contact_name', normalized_name, 'phone', normalized_phone, 'email', normalized_email,
    'business_name', normalized_business, 'tax_id', normalized_tax, 'address', normalized_address,
    'city', normalized_city, 'commercial_notes', normalized_notes
  );
  payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim_record
  from public.claim_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash);
  if claim_record.request_status = 'succeeded' then
    return claim_record.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim_record.acquired then
    raise exception using errcode = '55000', message = 'La edicion del cliente todavia esta en proceso.';
  end if;

  for lock_key in
    select value from unnest(array_remove(array[
      case when normalized_email is not null then 'email:' || normalized_email end,
      case when normalized_phone is not null then 'phone:' || normalized_phone end,
      case when normalized_tax is not null then 'tax:' || normalized_tax end
    ], null)) value order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended('pos-customer:' || lock_key, 0));
  end loop;

  select * into current_customer from public.customers where id = p_customer_id for update;
  if current_customer.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el cliente.';
  end if;
  if current_customer.commercial_version <> p_expected_commercial_version then
    safe_result := jsonb_build_object(
      'ok', false, 'status', 'version_conflict',
      'message', 'El cliente cambio desde que lo abriste. Recarga sus datos antes de guardar.',
      'customerId', current_customer.id, 'commercialVersion', current_customer.commercial_version,
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', current_customer.id, 'pos.customer.version_conflict', null,
      jsonb_build_object('request_key', p_request_key, 'expected_version', p_expected_commercial_version, 'actual_version', current_customer.commercial_version)
    );
    perform public.complete_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash, safe_result);
    return safe_result;
  end if;

  duplicate_id := public.find_pos_customer_duplicate_v1(normalized_email, normalized_phone, normalized_tax, p_customer_id);
  if duplicate_id is not null then
    safe_result := jsonb_build_object(
      'ok', false, 'status', 'duplicate',
      'message', 'Otro cliente ya utiliza el mismo correo, telefono o RTN.',
      'customerId', duplicate_id, 'commercialVersion', current_customer.commercial_version,
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', current_customer.id, 'pos.customer.duplicate_update_blocked', null,
      jsonb_build_object(
        'request_key', p_request_key, 'matched_customer_id', duplicate_id,
        'email_hash', case when normalized_email is null then null else encode(extensions.digest(convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex') end,
        'phone_last4', case when normalized_phone is null then null else right(normalized_phone, 4) end,
        'tax_hash', case when normalized_tax is null then null else encode(extensions.digest(convert_to(normalized_tax, 'UTF8'), 'sha256'), 'hex') end
      )
    );
    perform public.complete_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash, safe_result);
    return safe_result;
  end if;

  update public.customers
  set contact_name = normalized_name, phone = trim(p_phone), email = normalized_email,
      business_name = normalized_business, company_name = normalized_business,
      tax_id = nullif(trim(p_tax_id), ''), address = normalized_address, city = normalized_city,
      commercial_notes = normalized_notes, updated_at = now()
  where id = p_customer_id
  returning * into saved_customer;

  safe_result := jsonb_build_object(
    'ok', true, 'status', 'updated', 'message', 'Cliente actualizado correctamente.',
    'customerId', saved_customer.id, 'commercialVersion', saved_customer.commercial_version,
    'idempotentReplay', false
  );
  perform public.write_audit_log(
    'customers', saved_customer.id, 'pos.customer.updated',
    jsonb_build_object(
      'commercial_version', current_customer.commercial_version,
      'has_email', current_customer.email is not null,
      'phone_last4', right(public.normalize_pos_customer_phone_v1(current_customer.phone), 4),
      'has_tax_id', current_customer.tax_id is not null
    ),
    jsonb_build_object(
      'commercial_version', saved_customer.commercial_version, 'request_key', p_request_key,
      'has_email', saved_customer.email is not null,
      'phone_last4', right(public.normalize_pos_customer_phone_v1(saved_customer.phone), 4),
      'has_tax_id', saved_customer.tax_id is not null
    )
  );
  perform public.complete_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash, safe_result);
  return safe_result;
end;
$$;

revoke all on function public.resolve_customer_pricing_mode_v1(uuid) from public, anon;
revoke all on function public.evaluate_wholesale_eligibility_v1(uuid, numeric) from public, anon;
revoke all on function public.search_pos_customers_v1(text, integer, integer, boolean) from public, anon;
revoke all on function public.get_pos_customer_context_v1(uuid) from public, anon;
revoke all on function public.create_pos_customer_v1(uuid, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.update_pos_customer_v1(uuid, uuid, integer, text, text, text, text, text, text, text, text) from public, anon;

grant execute on function public.resolve_customer_pricing_mode_v1(uuid) to authenticated;
grant execute on function public.evaluate_wholesale_eligibility_v1(uuid, numeric) to authenticated;
grant execute on function public.search_pos_customers_v1(text, integer, integer, boolean) to authenticated;
grant execute on function public.get_pos_customer_context_v1(uuid) to authenticated;
grant execute on function public.create_pos_customer_v1(uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.update_pos_customer_v1(uuid, uuid, integer, text, text, text, text, text, text, text, text) to authenticated;

comment on function public.search_pos_customers_v1(text, integer, integer, boolean) is
  'Paginated POS-only customer search. Returns masked list data and no Auth identifier, address, notes, or full tax id.';
comment on function public.get_pos_customer_context_v1(uuid) is
  'Selected-customer POS context. Credit is read-only and wholesale/pricing are resolved by the database.';
comment on function public.create_pos_customer_v1(uuid, text, text, text, text, text, text, text, text) is
  'Idempotent POS customer creation with deterministic duplicate locks. Never creates Auth, credit, orders, sales, or inventory effects.';
comment on function public.update_pos_customer_v1(uuid, uuid, integer, text, text, text, text, text, text, text, text) is
  'Idempotent POS customer update with optimistic commercial_version and masked audit data.';
