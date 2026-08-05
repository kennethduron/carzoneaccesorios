-- Authorized accounting mapping for cash-on-delivery revenue.
-- Accounting approval: revenue:sale_cod_fee -> 4101002 VENTAS POR CONTRAENTREGA.

begin;

select pg_advisory_xact_lock(hashtextextended('carzone:accounting:mapping:revenue:sale_cod_fee', 0));

create table if not exists public.accounting_mapping_authorization_audit (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid not null references public.accounting_mappings(id) on delete restrict,
  action text not null check (action = 'ACCOUNTING_MAPPING_CREATED'),
  mapping_key text not null check (mapping_key = 'revenue:sale_cod_fee'),
  account_code text not null check (account_code = '4101002'),
  account_name text not null check (account_name = 'VENTAS POR CONTRAENTREGA'),
  reason text not null check (reason = 'APPROVED_ACCOUNT_FOR_CASH_ON_DELIVERY_REVENUE'),
  approved_by text not null check (approved_by = 'area_contable'),
  effective_from date not null,
  before_hash text not null check (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash text not null check (after_hash ~ '^[0-9a-f]{64}$'),
  before_state jsonb not null,
  after_state jsonb not null,
  executed_by name not null default current_user,
  executed_at timestamptz not null default clock_timestamp(),
  unique (mapping_id, action)
);

alter table public.accounting_mapping_authorization_audit enable row level security;
revoke all on public.accounting_mapping_authorization_audit from public, anon, authenticated, service_role;
grant select on public.accounting_mapping_authorization_audit to service_role;

create or replace function public.guard_accounting_mapping_authorization_audit_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception 'ACCOUNTING_MAPPING_AUTHORIZATION_AUDIT_IMMUTABLE' using errcode = '55000';
end;
$function$;

revoke all on function public.guard_accounting_mapping_authorization_audit_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists accounting_mapping_authorization_audit_append_only
  on public.accounting_mapping_authorization_audit;
create trigger accounting_mapping_authorization_audit_append_only
before update or delete on public.accounting_mapping_authorization_audit
for each row execute function public.guard_accounting_mapping_authorization_audit_v1();

create unique index if not exists accounting_mappings_active_sale_cod_fee_unique_idx
  on public.accounting_mappings ((1))
  where mapping_type = 'revenue'
    and source_key = 'sale_cod_fee'
    and is_active;

create or replace function public.configure_sale_cod_fee_mapping_v1()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target_account public.accounting_accounts%rowtype;
  existing_mapping public.accounting_mappings%rowtype;
  mapping_id uuid;
  account_count integer;
  mapping_count integer;
  before_state jsonb;
  after_state jsonb;
  before_hash text;
  after_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('carzone:accounting:mapping:revenue:sale_cod_fee', 0));

  select count(*) into account_count
  from public.accounting_accounts
  where code = '4101002';
  if account_count <> 1 then
    raise exception 'SALE_COD_FEE_ACCOUNT_COUNT_MISMATCH' using errcode = '23514';
  end if;

  select * into target_account
  from public.accounting_accounts
  where code = '4101002'
  for update;

  if target_account.name <> 'VENTAS POR CONTRAENTREGA'
    or target_account.type <> 'revenue'
    or target_account.normal_balance <> 'credit'
    or not target_account.is_active
    or exists (
      select 1 from public.accounting_accounts child
      where child.parent_id = target_account.id
    )
  then
    raise exception 'SALE_COD_FEE_ACCOUNT_NOT_POSTABLE_REVENUE' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(to_jsonb(mapping) order by mapping.created_at, mapping.id), '[]'::jsonb), count(*)
  into before_state, mapping_count
  from public.accounting_mappings mapping
  where mapping.mapping_type = 'revenue'
    and mapping.source_key = 'sale_cod_fee';

  if mapping_count > 0 then
    if mapping_count <> 1 then
      raise exception 'SALE_COD_FEE_MAPPING_OVERLAP' using errcode = '23505';
    end if;
    select * into existing_mapping
    from public.accounting_mappings
    where mapping_type = 'revenue' and source_key = 'sale_cod_fee'
    for update;
    if existing_mapping.account_id <> target_account.id
      or not existing_mapping.is_active
      or coalesce(existing_mapping.effective_from, '-infinity'::date) > date '2026-07-16'
      or existing_mapping.effective_to is not null
    then
      raise exception 'SALE_COD_FEE_MAPPING_CONFLICT' using errcode = '23514';
    end if;
    return existing_mapping.id;
  end if;

  before_hash := encode(extensions.digest(convert_to(before_state::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.accounting_mappings (
    mapping_type, source_key, account_id, priority, is_active,
    effective_from, effective_to, metadata, created_by
  ) values (
    'revenue', 'sale_cod_fee', target_account.id, 100, true,
    date '2026-07-16', null,
    jsonb_build_object(
      'canonical_key', 'revenue:sale_cod_fee',
      'approved_by', 'area_contable',
      'reason', 'APPROVED_ACCOUNT_FOR_CASH_ON_DELIVERY_REVENUE',
      'manual_publication_required', true
    ),
    null
  ) returning id into mapping_id;

  select to_jsonb(mapping) into after_state
  from public.accounting_mappings mapping
  where mapping.id = mapping_id;
  after_hash := encode(extensions.digest(convert_to(after_state::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.accounting_mapping_authorization_audit (
    mapping_id, action, mapping_key, account_code, account_name,
    reason, approved_by, effective_from, before_hash, after_hash,
    before_state, after_state
  ) values (
    mapping_id, 'ACCOUNTING_MAPPING_CREATED', 'revenue:sale_cod_fee',
    target_account.code, target_account.name,
    'APPROVED_ACCOUNT_FOR_CASH_ON_DELIVERY_REVENUE', 'area_contable',
    date '2026-07-16', before_hash, after_hash, before_state, after_state
  );

  perform public.write_audit_log(
    'accounting_mappings', mapping_id, 'ACCOUNTING_MAPPING_CREATED',
    before_state,
    jsonb_build_object(
      'mapping', 'revenue:sale_cod_fee',
      'account_code', target_account.code,
      'account_name', target_account.name,
      'reason', 'APPROVED_ACCOUNT_FOR_CASH_ON_DELIVERY_REVENUE',
      'approved_by', 'area_contable',
      'effective_from', date '2026-07-16',
      'before_hash', before_hash,
      'after_hash', after_hash,
      'technical_actor', current_user
    )
  );

  return mapping_id;
end;
$function$;

revoke all on function public.configure_sale_cod_fee_mapping_v1()
  from public, anon, authenticated;
grant execute on function public.configure_sale_cod_fee_mapping_v1()
  to service_role;

do $migration$
begin
  -- A pristine local database has no production chart of accounts. Tests invoke
  -- the guarded function after creating their local-only account fixture.
  if not exists (select 1 from public.accounting_accounts) then
    return;
  end if;
  perform public.configure_sale_cod_fee_mapping_v1();
end;
$migration$;

comment on function public.configure_sale_cod_fee_mapping_v1() is
  'Idempotently configures the accounting-approved COD revenue mapping after validating account 4101002.';

commit;
