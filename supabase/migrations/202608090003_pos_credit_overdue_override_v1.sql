begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- The integrity guard below is always on. This flag controls only the
-- exceptional per-sale authorization path.
create table public.pos_feature_flags (
  key text primary key,
  enabled boolean not null default false,
  version integer not null default 1 check (version > 0),
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null,
  constraint pos_feature_flags_known_key check (key = 'pos_credit_overdue_override_v1'),
  constraint pos_feature_flags_enabled_shape check (
    (enabled and enabled_at is not null) or (not enabled and enabled_at is null)
  )
);

insert into public.pos_feature_flags (key, enabled, reason)
values ('pos_credit_overdue_override_v1', false,
  'POS overdue credit override V1 installed disabled for controlled rollout.');

alter table public.pos_feature_flags enable row level security;
revoke all on public.pos_feature_flags from public, anon, authenticated;
grant select, insert, update on public.pos_feature_flags to service_role;

create or replace function public.pos_credit_overdue_override_enabled_v1()
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce((select enabled from public.pos_feature_flags
    where key = 'pos_credit_overdue_override_v1'), false);
$$;
revoke all on function public.pos_credit_overdue_override_enabled_v1() from public, anon;
grant execute on function public.pos_credit_overdue_override_enabled_v1() to authenticated, service_role;

create or replace function public.get_pos_credit_overdue_override_capability_v1()
returns table (feature_enabled boolean, override_allowed boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare actor_id uuid := auth.uid(); actor_role text;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  actor_role := public.current_actor_role();
  feature_enabled := public.pos_credit_overdue_override_enabled_v1();
  override_allowed := actor_role in ('technical_owner', 'business_owner', 'admin')
    and public.pos_permission_allowed('pos:confirm_sale');
  return next;
end;
$$;
revoke all on function public.get_pos_credit_overdue_override_capability_v1() from public, anon;
grant execute on function public.get_pos_credit_overdue_override_capability_v1() to authenticated, service_role;

create or replace function public.set_pos_credit_overdue_override_v1(p_enabled boolean, p_reason text)
returns table (feature_key text, enabled boolean, version integer, enabled_at timestamptz, updated_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := case when auth.uid() is null then 'service_role' else public.current_actor_role() end;
  clean_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  saved public.pos_feature_flags%rowtype;
begin
  if not coalesce(auth.role() = 'service_role', false)
    and (actor_id is null or actor_role not in ('technical_owner', 'business_owner', 'admin')) then
    raise exception using errcode = '42501', message = 'POS_CREDIT_OVERRIDE_FORBIDDEN';
  end if;
  if clean_reason is null or char_length(clean_reason) < 10 then
    raise exception using errcode = '22023', message = 'POS_CREDIT_OVERRIDE_REASON_REQUIRED';
  end if;
  update public.pos_feature_flags flag
  set enabled = p_enabled, version = flag.version + 1, reason = clean_reason,
      enabled_at = case when p_enabled then now() else null end,
      updated_at = now(), updated_by = actor_id
  where flag.key = 'pos_credit_overdue_override_v1' returning * into saved;
  insert into public.audit_logs(user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (actor_id, actor_role, 'pos_feature_flags', null,
    'pos.credit_overdue_override.feature_flag_changed', null,
    jsonb_build_object('key', saved.key, 'enabled', saved.enabled,
      'version', saved.version, 'reason', saved.reason));
  feature_key := saved.key; enabled := saved.enabled; version := saved.version;
  enabled_at := saved.enabled_at; updated_at := saved.updated_at; return next;
end;
$$;
revoke all on function public.set_pos_credit_overdue_override_v1(boolean, text) from public, anon;
grant execute on function public.set_pos_credit_overdue_override_v1(boolean, text) to authenticated, service_role;

-- Canonical exposure and effective-overdue definition using Honduras civil date.
create or replace function public._get_customer_commercial_credit_state_v2(p_customer_id uuid)
returns table (
  customer_id uuid, credit_account_id uuid, enabled boolean, account_status text,
  credit_limit numeric, open_balance numeric, effective_overdue_balance numeric,
  available_credit numeric, open_receivable_count bigint, effective_overdue_count bigint,
  has_effective_overdue boolean, can_use_credit_without_override boolean,
  block_reason text, current_honduras_date date
)
language sql stable security definer set search_path = public, pg_temp as $$
  with operating_date as (
    select (now() at time zone 'America/Tegucigalpa')::date as value
  ), balances as (
    select
      coalesce(sum(r.balance_due) filter (where r.status in ('open','partial','overdue') and r.balance_due > 0), 0)::numeric as open_balance,
      coalesce(sum(r.balance_due) filter (where r.status in ('open','partial','overdue') and r.balance_due > 0 and r.due_date < d.value), 0)::numeric as overdue_balance,
      count(r.id) filter (where r.status in ('open','partial','overdue') and r.balance_due > 0)::bigint as open_count,
      count(r.id) filter (where r.status in ('open','partial','overdue') and r.balance_due > 0 and r.due_date < d.value)::bigint as overdue_count,
      d.value as hn_date
    from operating_date d left join public.accounts_receivable r on r.customer_id = p_customer_id
    group by d.value
  )
  select p_customer_id, a.id, coalesce(a.is_credit_enabled, false), coalesce(a.status::text, 'missing'),
    coalesce(a.credit_limit, 0)::numeric, b.open_balance, b.overdue_balance,
    greatest(coalesce(a.credit_limit, 0) - b.open_balance, 0)::numeric,
    b.open_count, b.overdue_count, b.overdue_balance > 0,
    a.id is not null and a.is_credit_enabled and a.status = 'active' and b.overdue_balance = 0,
    case when a.id is null then 'NO_CREDIT_ACCOUNT'
      when not a.is_credit_enabled then 'CREDIT_DISABLED'
      when a.status <> 'active' then 'CREDIT_ACCOUNT_INACTIVE'
      when b.overdue_balance > 0 then 'OVERDUE_BALANCE' else null end,
    b.hn_date
  from balances b left join public.customer_credit_accounts a on a.customer_id = p_customer_id;
$$;
revoke all on function public._get_customer_commercial_credit_state_v2(uuid) from public, anon, authenticated;
grant execute on function public._get_customer_commercial_credit_state_v2(uuid) to service_role;

-- Preserve the existing result shape while replacing status-only overdue.
create or replace function public.get_pos_customer_context_v1(target_customer_id uuid)
returns table (
  customer_id uuid, display_name text, business_name text, phone text, email text,
  tax_id text, address text, city text, commercial_notes text, customer_type text,
  wholesale_status text, pricing_mode text, pricing_reason text, commercial_version integer,
  has_portal_account boolean, customer_status text, credit_status text,
  credit_enabled boolean, credit_limit numeric, open_balance numeric,
  available_credit numeric, overdue_balance numeric, receivable_count bigint,
  can_use_credit boolean, credit_reason text, order_count bigint,
  invoice_count bigint, total_billed numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.pos_permission_allowed('customers:read_commercial')
    or not public.pos_permission_allowed('customers:read_credit') then
    raise exception using errcode = '42501', message = 'No tienes permiso para consultar el contexto del cliente.';
  end if;
  return query
  with customer_context as (
    select customer.*, pricing.pricing_mode, pricing.customer_type, pricing.pricing_reason
    from public.customers customer
    cross join lateral public.resolve_customer_pricing_mode_v1(customer.id) pricing
    where customer.id = target_customer_id
  ), credit_summary as (
    select * from public._get_customer_commercial_credit_state_v2(target_customer_id)
  ), order_summary as (
    select count(*) as order_count from public.orders o
    where o.customer_id = target_customer_id and o.status::text not in ('cancelado','cancelled')
  ), invoice_summary as (
    select count(*) as invoice_count, coalesce(sum(total), 0) as total_billed
    from public.invoices i where i.customer_id = target_customer_id
      and i.status::text not in ('anulada','cancelled')
  )
  select c.id,
    coalesce(nullif(trim(c.contact_name), ''), nullif(trim(coalesce(c.company_name, c.business_name)), ''), 'Cliente'),
    nullif(trim(coalesce(c.company_name, c.business_name)), ''), c.phone, c.email, c.tax_id,
    c.address, c.city, c.commercial_notes, c.customer_type, c.wholesale_status,
    c.pricing_mode, c.pricing_reason, c.commercial_version, c.user_id is not null,
    case when c.active and c.status = 'active' then 'active' else 'inactive' end,
    case when cs.credit_account_id is null or not cs.enabled then 'not_enabled'
      when cs.account_status <> 'active' then 'suspended'
      when cs.has_effective_overdue then 'on_hold' else 'active' end,
    cs.enabled, cs.credit_limit, cs.open_balance, cs.available_credit,
    cs.effective_overdue_balance, cs.open_receivable_count,
    cs.can_use_credit_without_override,
    case cs.block_reason when 'NO_CREDIT_ACCOUNT' then 'Credito no habilitado.'
      when 'CREDIT_DISABLED' then 'Credito no habilitado.'
      when 'CREDIT_ACCOUNT_INACTIVE' then 'La cuenta de credito esta suspendida.'
      when 'OVERDUE_BALANCE' then 'Existe saldo vencido: el credito esta en espera.'
      else 'Credito comercial activo. El disponible se verificara nuevamente al confirmar.' end,
    os.order_count, ins.invoice_count, ins.total_billed
  from customer_context c cross join credit_summary cs
  cross join order_summary os cross join invoice_summary ins;
  if not found then raise exception using errcode = 'P0002', message = 'No se encontro el cliente.'; end if;
end;
$$;

-- Transaction-local envelope: never durable and never directly writable by app roles.
create table public.pos_credit_overdue_override_context (
  backend_pid integer not null, transaction_id bigint not null,
  actor_id uuid not null references public.users(id) on delete restrict,
  actor_role text not null check (actor_role in ('technical_owner','business_owner','admin')),
  draft_id uuid not null references public.pos_sale_drafts(id) on delete cascade,
  public_request_key uuid not null, confirmation_request_key uuid not null,
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  created_at timestamptz not null default now(),
  primary key (backend_pid, transaction_id, draft_id)
);
alter table public.pos_credit_overdue_override_context enable row level security;
revoke all on public.pos_credit_overdue_override_context from public, anon, authenticated;
grant select, insert, delete on public.pos_credit_overdue_override_context to service_role;

create or replace function public._prepare_pos_credit_overdue_override_v1(
  p_draft_id uuid, p_public_request_key uuid, p_confirmation_request_key uuid, p_payment_payload jsonb
)
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  actor_id uuid := auth.uid(); actor_role text;
  payment_method_value text := nullif(trim(coalesce(p_payment_payload->>'method', '')), '');
  clean_reason text := nullif(left(trim(coalesce(p_payment_payload->>'overdue_override_reason', '')), 500), '');
begin
  if clean_reason is null then return; end if;
  actor_role := public.current_actor_role();
  if actor_id is null or actor_role not in ('technical_owner','business_owner','admin')
    or not public.pos_permission_allowed('pos:confirm_sale') then
    raise exception using errcode = '42501', message = 'POS_CREDIT_OVERRIDE_FORBIDDEN';
  end if;
  if payment_method_value <> 'commercial_credit' then
    raise exception using errcode = '22023', message = 'POS_CREDIT_OVERRIDE_INVALID';
  end if;
  if char_length(clean_reason) < 10 then
    raise exception using errcode = '22023', message = 'POS_CREDIT_OVERRIDE_REASON_REQUIRED';
  end if;
  if not public.pos_credit_overdue_override_enabled_v1() then
    raise exception using errcode = '42501', message = 'POS_CREDIT_OVERRIDE_DISABLED';
  end if;
  insert into public.pos_credit_overdue_override_context(
    backend_pid, transaction_id, actor_id, actor_role, draft_id,
    public_request_key, confirmation_request_key, reason
  ) values (pg_backend_pid(), txid_current(), actor_id, actor_role, p_draft_id,
    p_public_request_key, p_confirmation_request_key, clean_reason);
end;
$$;
revoke all on function public._prepare_pos_credit_overdue_override_v1(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public._prepare_pos_credit_overdue_override_v1(uuid, uuid, uuid, jsonb) to service_role;

-- Last authoritative gate before the POS transaction creates its receivable.
create or replace function public.enforce_pos_credit_before_receivable_v1()
returns trigger language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  order_record public.orders%rowtype;
  confirmation_context public.pos_sale_confirmation_context%rowtype;
  override_context public.pos_credit_overdue_override_context%rowtype;
  credit_state record; authorization_fingerprint text;
begin
  if new.order_id is null then return new; end if;
  select * into order_record from public.orders where id = new.order_id;
  if order_record.id is null or order_record.source <> 'pos'
    or order_record.payment_method::text <> 'commercial_credit'
    or order_record.pos_draft_id is null then return new; end if;
  select * into confirmation_context from public.pos_sale_confirmation_context context
  where context.backend_pid = pg_backend_pid() and context.transaction_id = txid_current()
    and context.actor_id = auth.uid() and context.draft_id = order_record.pos_draft_id;
  if confirmation_context.draft_id is null then
    raise exception using errcode = '42501', message = 'POS_CONFIRMATION_CONTEXT_REQUIRED';
  end if;
  select * into credit_state from public._get_customer_commercial_credit_state_v2(new.customer_id);
  if credit_state.credit_account_id is null or not credit_state.enabled then
    raise exception using errcode = '22023', message = 'POS_CREDIT_DISABLED';
  end if;
  if credit_state.account_status <> 'active' then
    raise exception using errcode = '22023', message = 'POS_CREDIT_SUSPENDED';
  end if;
  if round(credit_state.open_balance + new.original_amount, 2) > credit_state.credit_limit then
    raise exception using errcode = 'PT409', message = 'POS_CREDIT_INSUFFICIENT';
  end if;
  if credit_state.has_effective_overdue then
    select * into override_context from public.pos_credit_overdue_override_context context
    where context.backend_pid = pg_backend_pid() and context.transaction_id = txid_current()
      and context.actor_id = auth.uid() and context.draft_id = order_record.pos_draft_id
      and context.confirmation_request_key = confirmation_context.request_key;
    if override_context.draft_id is null then
      raise exception using errcode = 'PT409', message = 'POS_CREDIT_OVERDUE';
    end if;
    if override_context.actor_role not in ('technical_owner','business_owner','admin')
      or public.current_actor_role() is distinct from override_context.actor_role
      or not public.pos_permission_allowed('pos:confirm_sale') then
      raise exception using errcode = '42501', message = 'POS_CREDIT_OVERRIDE_FORBIDDEN';
    end if;
    if not public.pos_credit_overdue_override_enabled_v1() then
      raise exception using errcode = '42501', message = 'POS_CREDIT_OVERRIDE_DISABLED';
    end if;
    authorization_fingerprint := encode(digest(convert_to(jsonb_build_object(
      'actor_id', override_context.actor_id, 'actor_role', override_context.actor_role,
      'customer_id', new.customer_id, 'draft_id', order_record.pos_draft_id,
      'order_id', order_record.id, 'sale_total', new.original_amount,
      'credit_limit', credit_state.credit_limit, 'open_balance', credit_state.open_balance,
      'available_credit', credit_state.available_credit,
      'effective_overdue_balance', credit_state.effective_overdue_balance,
      'reason', override_context.reason, 'request_key', override_context.public_request_key
    )::text, 'UTF8'), 'sha256'), 'hex');
    perform public.write_audit_log('pos_sale_drafts', order_record.pos_draft_id,
      'pos.credit_overdue_override_authorized', null, jsonb_build_object(
        'actor_id', override_context.actor_id, 'actor_role', override_context.actor_role,
        'customer_id', new.customer_id, 'draft_id', order_record.pos_draft_id,
        'order_id', order_record.id, 'receivable_id', new.id,
        'sale_total', new.original_amount, 'credit_limit', credit_state.credit_limit,
        'open_balance', credit_state.open_balance, 'available_credit', credit_state.available_credit,
        'effective_overdue_balance', credit_state.effective_overdue_balance,
        'effective_overdue_count', credit_state.effective_overdue_count,
        'reason', override_context.reason, 'authorized_at_utc', now(),
        'current_honduras_date', credit_state.current_honduras_date,
        'request_key', override_context.public_request_key,
        'confirmation_request_key', override_context.confirmation_request_key,
        'authorization_fingerprint', authorization_fingerprint, 'scope', 'single_sale'));
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_pos_credit_before_receivable_v1() from public, anon, authenticated;
drop trigger if exists accounts_receivable_pos_credit_guard_v1 on public.accounts_receivable;
create trigger accounts_receivable_pos_credit_guard_v1 before insert on public.accounts_receivable
for each row execute function public.enforce_pos_credit_before_receivable_v1();

-- Existing endpoint; override data is part of the current payment fingerprint.
create or replace function public.confirm_pos_sale_with_charge_descriptions_v1(
  p_draft_id uuid, p_request_key uuid, p_expected_draft_version bigint,
  p_invoice_date date, p_payment_payload jsonb
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp set timezone = 'America/Tegucigalpa' as $$
declare
  result jsonb; draft_record public.pos_sale_drafts%rowtype;
  confirmation_request_key uuid := public.pos_child_request_key_v1(p_request_key, 'charge-descriptions-confirmation-v1');
begin
  perform public._prepare_pos_credit_overdue_override_v1(
    p_draft_id, p_request_key, confirmation_request_key, p_payment_payload);
  result := public.confirm_selectable_pos_sale_v1(
    p_draft_id, confirmation_request_key, p_expected_draft_version, p_invoice_date, p_payment_payload);
  select * into strict draft_record from public.pos_sale_drafts where id = p_draft_id;
  if coalesce((result->>'replayed')::boolean, false) = false
    and (draft_record.additional_charge > 0 or draft_record.other_charge > 0) then
    perform public.write_audit_log('pos_sale_drafts', p_draft_id,
      'pos.sale.charge_descriptions_attached', null, jsonb_build_object(
        'order_id', result->>'order_id', 'invoice_id', result->>'invoice_id',
        'additional_charge_description', draft_record.additional_charge_description,
        'other_charge_description', draft_record.other_charge_description,
        'accounting_mapping_changed', false));
  end if;
  delete from public.pos_credit_overdue_override_context context
  where context.backend_pid = pg_backend_pid() and context.transaction_id = txid_current()
    and context.draft_id = p_draft_id;
  return result;
end;
$$;
revoke all on function public.confirm_pos_sale_with_charge_descriptions_v1(uuid, uuid, bigint, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.confirm_pos_sale_with_charge_descriptions_v1(uuid, uuid, bigint, date, jsonb)
  to authenticated;

comment on table public.pos_feature_flags is
  'Domain-scoped POS kill switches. The overdue integrity guard is independent from this table.';
comment on function public._get_customer_commercial_credit_state_v2(uuid) is
  'Canonical commercial-credit exposure using the explicit Honduras civil date and active receivable states.';
comment on function public.enforce_pos_credit_before_receivable_v1() is
  'Authoritative final guard for POS commercial-credit receivables.';

commit;
