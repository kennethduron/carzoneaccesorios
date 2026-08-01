-- Canonical customer identity and merge foundation.
-- Additive and disabled by default. Historical fiscal/accounting rows are untouched.

alter table public.customers
  add column if not exists merged_into_customer_id uuid references public.customers(id) on delete restrict,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_by uuid references public.users(id) on delete set null,
  add column if not exists merge_operation_id uuid,
  add column if not exists merge_reason text;

alter table public.customers drop constraint if exists customers_status_check;
alter table public.customers add constraint customers_status_check
  check (status in ('active', 'inactive', 'disabled', 'pending_account', 'merged'));

alter table public.customers add constraint customers_not_merged_into_self_check
  check (merged_into_customer_id is null or merged_into_customer_id <> id);
alter table public.customers add constraint customers_merged_shape_check
  check (
    (merged_into_customer_id is null and status <> 'merged')
    or (merged_into_customer_id is not null and status = 'merged' and active = false and merged_at is not null and merge_operation_id is not null)
  );
alter table public.customers add constraint customers_merge_reason_length_check
  check (merge_reason is null or char_length(trim(merge_reason)) between 10 and 1000);

create index if not exists customers_merged_into_idx on public.customers(merged_into_customer_id);
create index if not exists customers_canonical_active_idx
  on public.customers(active, updated_at desc) where merged_into_customer_id is null;
create index if not exists customers_merge_operation_idx
  on public.customers(merge_operation_id) where merge_operation_id is not null;

create table public.customer_feature_flags (
  key text primary key check (key in ('customer_merge_execution_v1', 'customer_duplicate_prevention_v1')),
  enabled boolean not null default false,
  version integer not null default 1 check (version > 0),
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  enabled_at timestamptz,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((enabled and enabled_at is not null) or (not enabled and enabled_at is null))
);

insert into public.customer_feature_flags(key, enabled, reason) values
  ('customer_merge_execution_v1', false, 'Installed disabled pending local, RLS, concurrency and visual validation.'),
  ('customer_duplicate_prevention_v1', false, 'Installed disabled pending local and visual validation across customer creation channels.');

create table public.customer_merge_operations (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique check (char_length(trim(request_key)) between 12 and 200),
  primary_customer_id uuid not null references public.customers(id) on delete restrict,
  secondary_customer_id uuid not null references public.customers(id) on delete restrict,
  primary_root_customer_id uuid not null references public.customers(id) on delete restrict,
  secondary_root_customer_id uuid not null references public.customers(id) on delete restrict,
  expected_primary_commercial_version integer not null check (expected_primary_commercial_version >= 0),
  expected_secondary_commercial_version integer not null check (expected_secondary_commercial_version >= 0),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('crm', 'customers', 'receivables', 'pos', 'support', 'controlled_production')),
  reason text not null check (char_length(trim(reason)) between 10 and 1000),
  identity_decisions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_decisions) = 'object'),
  credit_decision jsonb not null default '{}'::jsonb check (jsonb_typeof(credit_decision) = 'object'),
  commercial_decision jsonb not null default '{}'::jsonb check (jsonb_typeof(commercial_decision) = 'object'),
  relation_plan jsonb not null default '{}'::jsonb check (jsonb_typeof(relation_plan) = 'object'),
  counts_before jsonb not null default '{}'::jsonb,
  counts_after jsonb not null default '{}'::jsonb,
  financial_totals_before jsonb not null default '{}'::jsonb,
  financial_totals_after jsonb not null default '{}'::jsonb,
  fiscal_hashes_before jsonb not null default '{}'::jsonb,
  fiscal_hashes_after jsonb not null default '{}'::jsonb,
  accounting_hashes_before jsonb not null default '{}'::jsonb,
  accounting_hashes_after jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'reversed')),
  error_code text,
  error_detail_sanitized text check (error_detail_sanitized is null or char_length(error_detail_sanitized) <= 1000),
  result jsonb,
  merge_snapshot jsonb not null default '{}'::jsonb,
  requested_by uuid not null references public.users(id) on delete restrict,
  executed_by uuid references public.users(id) on delete restrict,
  executed_role text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  check (primary_customer_id <> secondary_customer_id),
  check (primary_root_customer_id <> secondary_root_customer_id)
);

alter table public.customers
  add constraint customers_merge_operation_fk
  foreign key (merge_operation_id) references public.customer_merge_operations(id) on delete restrict;

create unique index customer_merge_active_pair_idx on public.customer_merge_operations(
  least(primary_root_customer_id, secondary_root_customer_id),
  greatest(primary_root_customer_id, secondary_root_customer_id)
) where status in ('pending', 'processing');
create index customer_merge_primary_idx on public.customer_merge_operations(primary_root_customer_id, created_at desc);
create index customer_merge_secondary_idx on public.customer_merge_operations(secondary_root_customer_id, created_at desc);
create index customer_merge_status_idx on public.customer_merge_operations(status, created_at desc);

create table public.customer_identity_values (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  identity_type text not null check (identity_type in ('business_name', 'company_name', 'contact_name', 'email', 'phone', 'tax_id', 'address', 'city')),
  raw_value text not null check (char_length(trim(raw_value)) between 1 and 1000),
  normalized_value text,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active', 'historical', 'conflict', 'rejected')),
  source_customer_id uuid references public.customers(id) on delete restrict,
  source_type text not null check (source_type in ('customer_record', 'merge', 'manual', 'crm', 'receivables', 'pos', 'portal')),
  verified_at timestamptz,
  verified_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create unique index customer_identity_value_unique_idx
  on public.customer_identity_values(customer_id, identity_type, normalized_value)
  where normalized_value is not null and status <> 'rejected';
create unique index customer_identity_primary_unique_idx
  on public.customer_identity_values(customer_id, identity_type)
  where is_primary and status = 'active';
create index customer_identity_normalized_lookup_idx
  on public.customer_identity_values(identity_type, normalized_value, status);
create index customer_identity_source_idx on public.customer_identity_values(source_customer_id);

alter table public.crm_notes add column if not exists original_customer_id uuid references public.customers(id) on delete restrict;
alter table public.crm_followups add column if not exists original_customer_id uuid references public.customers(id) on delete restrict;
create index if not exists crm_notes_original_customer_idx on public.crm_notes(original_customer_id) where original_customer_id is not null;
create index if not exists crm_followups_original_customer_idx on public.crm_followups(original_customer_id) where original_customer_id is not null;

create or replace function public.normalize_customer_email_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$
  select case when candidate ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(candidate) <= 320 then candidate end
  from (select nullif(lower(regexp_replace(trim(coalesce(raw_value, '')), '\s+', '', 'g')), '') candidate) normalized;
$$;

create or replace function public.normalize_customer_phone_hn_v1(raw_value text)
returns text language plpgsql immutable parallel safe set search_path = public as $$
declare compact text := regexp_replace(trim(coalesce(raw_value, '')), '[^0-9+]', '', 'g'); digits text;
begin
  if compact = '' then return null; end if;
  if compact like '+%' and compact not like '+504%' then
    digits := substring(compact from 2);
    if digits ~ '^[1-9][0-9]{7,14}$' then return '+' || digits; end if;
    return null;
  end if;
  digits := regexp_replace(compact, '[^0-9]', '', 'g');
  if digits ~ '^504[2389][0-9]{7}$' then return '+' || digits; end if;
  if digits ~ '^[2389][0-9]{7}$' then return '+504' || digits; end if;
  return null;
end;
$$;

create or replace function public.normalize_customer_tax_id_hn_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$
  select case when digits ~ '^[0-9]{14}$' then digits end
  from (select nullif(regexp_replace(coalesce(raw_value, ''), '[^0-9]', '', 'g'), '') digits) normalized;
$$;

create or replace function public.normalize_customer_name_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$
  select nullif(trim(regexp_replace(translate(lower(coalesce(raw_value, '')), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'), '\s+', ' ', 'g')), '');
$$;

create or replace function public.normalize_customer_address_v1(raw_value text)
returns text language sql immutable parallel safe set search_path = public as $$
  select nullif(trim(regexp_replace(translate(lower(coalesce(raw_value, '')), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'), '\s+', ' ', 'g')), '');
$$;

create or replace function public.resolve_customer_root_v1(p_customer_id uuid)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare current_id uuid := p_customer_id; next_id uuid; visited uuid[] := array[]::uuid[]; depth integer := 0;
begin
  if current_id is null then return null; end if;
  loop
    if current_id = any(visited) then raise exception using errcode = '23514', message = 'CUSTOMER_ALIAS_CYCLE'; end if;
    if depth >= 32 then raise exception using errcode = '54001', message = 'CUSTOMER_ALIAS_DEPTH_EXCEEDED'; end if;
    visited := array_append(visited, current_id);
    select merged_into_customer_id into next_id from public.customers where id = current_id;
    if not found then raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND'; end if;
    if next_id is null then return current_id; end if;
    current_id := next_id; depth := depth + 1;
  end loop;
end;
$$;

create or replace function public.get_customer_family_ids_v1(p_customer_id uuid)
returns table(customer_id uuid, is_root boolean) language sql stable security definer set search_path = public, pg_temp as $$
  with recursive family as (
    select public.resolve_customer_root_v1(p_customer_id) id, true is_root
    union all
    select child.id, false from public.customers child join family parent on child.merged_into_customer_id = parent.id
  ) select distinct id, bool_or(is_root) from family group by id;
$$;

create or replace function public.customer_identity_normalized_value_v1(p_type text, p_value text)
returns text language sql immutable parallel safe set search_path = public as $$
  select case p_type
    when 'email' then public.normalize_customer_email_v1(p_value)
    when 'phone' then public.normalize_customer_phone_hn_v1(p_value)
    when 'tax_id' then public.normalize_customer_tax_id_hn_v1(p_value)
    when 'address' then public.normalize_customer_address_v1(p_value)
    else public.normalize_customer_name_v1(p_value)
  end;
$$;

create or replace function public.protect_customer_merge_fields_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.merged_into_customer_id, new.merged_at, new.merged_by, new.merge_operation_id, new.merge_reason)
     is distinct from
     (old.merged_into_customer_id, old.merged_at, old.merged_by, old.merge_operation_id, old.merge_reason)
     and nullif(current_setting('app.customer_merge_operation', true), '') is null then
    raise exception using errcode = '42501', message = 'CUSTOMER_MERGE_FIELDS_RPC_ONLY';
  end if;
  return new;
end;
$$;

create trigger customers_protect_merge_fields
before update on public.customers for each row execute function public.protect_customer_merge_fields_v1();

alter table public.customer_feature_flags enable row level security;
alter table public.customer_merge_operations enable row level security;
alter table public.customer_identity_values enable row level security;

create policy customer_feature_flags_internal_read on public.customer_feature_flags for select
  using (auth.uid() is not null and (public.has_permission('customers:manage') or public.has_permission('customers:merge')));
create policy customer_merge_operations_authorized_read on public.customer_merge_operations for select
  using (auth.uid() is not null and public.has_permission('customers:merge'));
create policy customer_identity_values_authorized_read on public.customer_identity_values for select
  using (auth.uid() is not null and (public.has_permission('customers:manage') or public.has_permission('customers:merge')));

revoke all on public.customer_feature_flags, public.customer_merge_operations, public.customer_identity_values from public, anon, authenticated;
grant select on public.customer_feature_flags, public.customer_merge_operations, public.customer_identity_values to authenticated;
grant select, insert, update, delete on public.customer_feature_flags, public.customer_merge_operations, public.customer_identity_values to service_role;

update public.roles set permissions = (
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  from (select distinct value from jsonb_array_elements_text(coalesce(permissions, '[]'::jsonb) || '["customers:merge"]'::jsonb)) p
), updated_at = now()
where name in ('technical_owner', 'business_owner');

update public.roles set permissions = coalesce(permissions, '[]'::jsonb) - 'customers:merge', updated_at = now()
where name in ('admin', 'vendedor', 'contadora', 'bodega', 'soporte', 'cliente');

revoke all on function public.resolve_customer_root_v1(uuid) from public, anon;
revoke all on function public.get_customer_family_ids_v1(uuid) from public, anon;
grant execute on function public.resolve_customer_root_v1(uuid), public.get_customer_family_ids_v1(uuid) to authenticated, service_role;
grant execute on function public.normalize_customer_email_v1(text), public.normalize_customer_phone_hn_v1(text), public.normalize_customer_tax_id_hn_v1(text), public.normalize_customer_name_v1(text), public.normalize_customer_address_v1(text) to authenticated, service_role;

comment on table public.customer_merge_operations is 'Immutable audit ledger for idempotent canonical customer merges.';
comment on table public.customer_identity_values is 'Canonical and alternate identity values with provenance; fiscal alternates never become primary implicitly.';
