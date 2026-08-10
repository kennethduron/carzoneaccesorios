begin;

-- Prospective operational feature flag. It is intentionally independent from
-- accounting_automation_settings and is installed disabled.
create table public.purchase_feature_flags (
  key text primary key,
  enabled boolean not null default false,
  version integer not null default 1 check (version > 0),
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null,
  constraint purchase_feature_flags_known_key check (
    key = 'purchase_ap_automation_v1'
  ),
  constraint purchase_feature_flags_enabled_shape check (
    (enabled and enabled_at is not null)
    or (not enabled and enabled_at is null)
  )
);

insert into public.purchase_feature_flags (key, enabled, reason)
values (
  'purchase_ap_automation_v1',
  false,
  'Purchase accounts-payable automation V1 installed disabled for controlled rollout.'
);

alter table public.purchase_feature_flags enable row level security;
revoke all on public.purchase_feature_flags from public, anon, authenticated;
grant select, insert, update on public.purchase_feature_flags to service_role;

alter table public.purchases
  add column payment_condition text,
  add column confirmed_due_date date,
  add column confirmation_request_key uuid,
  add column confirmation_fingerprint text,
  add column initial_supplier_payment_id uuid
    references public.supplier_payments(id) on delete restrict,
  add column cancellation_request_key uuid;

alter table public.purchases
  add constraint purchases_payment_condition_v1_check check (
    payment_condition is null or payment_condition in ('cash', 'credit', 'partial')
  ),
  add constraint purchases_confirmation_fingerprint_v1_check check (
    confirmation_fingerprint is null
    or confirmation_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  add constraint purchases_confirmation_snapshot_v1_check check (
    (
      confirmation_request_key is null
      and confirmation_fingerprint is null
      and payment_condition is null
      and initial_supplier_payment_id is null
    )
    or (
      confirmation_request_key is not null
      and confirmation_fingerprint is not null
      and payment_condition is not null
    )
  );

create unique index purchases_confirmation_request_key_v1_uidx
  on public.purchases (confirmation_request_key)
  where confirmation_request_key is not null;

create unique index purchases_cancellation_request_key_v1_uidx
  on public.purchases (cancellation_request_key)
  where cancellation_request_key is not null;

alter table public.accounts_payable
  add column automation_source text;

alter table public.accounts_payable
  add constraint accounts_payable_automation_source_v1_check check (
    automation_source is null
    or automation_source = 'purchase_confirmation_v1'
  );

do $$
begin
  if exists (
    select 1
    from public.accounts_payable payable
    where payable.purchase_id is not null
      and payable.status <> 'cancelled'
    group by payable.purchase_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'PURCHASE_AP_ACTIVE_DUPLICATES_FOUND';
  end if;
end;
$$;

create unique index accounts_payable_active_purchase_v1_uidx
  on public.accounts_payable (purchase_id)
  where purchase_id is not null and status <> 'cancelled';

create index accounts_payable_automation_source_v1_idx
  on public.accounts_payable (automation_source, created_at desc)
  where automation_source is not null;

create or replace function public.purchase_ap_automation_enabled_v1()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select flag.enabled
    from public.purchase_feature_flags flag
    where flag.key = 'purchase_ap_automation_v1'
  ), false);
$$;

revoke all on function public.purchase_ap_automation_enabled_v1()
  from public, anon;
grant execute on function public.purchase_ap_automation_enabled_v1()
  to authenticated, service_role;

create or replace function public.set_purchase_ap_automation_v1(
  p_enabled boolean,
  p_reason text
)
returns table (
  feature_key text,
  enabled boolean,
  version integer,
  enabled_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  clean_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  saved public.purchase_feature_flags%rowtype;
begin
  if not coalesce(auth.role() = 'service_role', false)
    and (
      actor_id is null
      or public.current_actor_role() not in ('technical_owner', 'business_owner')
    )
  then
    raise exception using errcode = '42501', message = 'PURCHASE_AP_FLAG_FORBIDDEN';
  end if;

  if clean_reason is null or char_length(clean_reason) < 10 then
    raise exception using errcode = '22023', message = 'PURCHASE_AP_FLAG_REASON_REQUIRED';
  end if;

  update public.purchase_feature_flags flag
  set enabled = p_enabled,
      version = flag.version + 1,
      reason = clean_reason,
      enabled_at = case when p_enabled then now() else null end,
      updated_at = now(),
      updated_by = actor_id
  where flag.key = 'purchase_ap_automation_v1'
  returning * into saved;

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'purchase_feature_flags',
    null,
    'purchases.feature_flag_changed',
    null,
    jsonb_build_object(
      'key', saved.key,
      'enabled', saved.enabled,
      'version', saved.version,
      'reason', saved.reason
    )
  );

  feature_key := saved.key;
  enabled := saved.enabled;
  version := saved.version;
  enabled_at := saved.enabled_at;
  updated_at := saved.updated_at;
  return next;
end;
$$;

revoke all on function public.set_purchase_ap_automation_v1(boolean, text)
  from public, anon;
grant execute on function public.set_purchase_ap_automation_v1(boolean, text)
  to authenticated, service_role;

-- Internal canonical state transition shared by legacy and V1 confirmation.
create or replace function public._confirm_purchase_state_v1(
  target_purchase_id uuid,
  target_actor_id uuid
)
returns table (
  purchase_id uuid,
  purchase_number text,
  purchase_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  purchase_row public.purchases%rowtype;
begin
  select * into purchase_row
  from public.purchases
  where id = target_purchase_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PURCHASE_NOT_FOUND';
  end if;
  if purchase_row.status <> 'draft' then
    raise exception using errcode = 'PT409', message = 'PURCHASE_NOT_DRAFT';
  end if;
  if not exists (
    select 1 from public.purchase_items item
    where item.purchase_id = purchase_row.id
  ) then
    raise exception using errcode = '22023', message = 'PURCHASE_ITEMS_REQUIRED';
  end if;

  update public.purchases
  set status = 'confirmed',
      confirmed_by = target_actor_id,
      confirmed_at = now(),
      updated_at = now()
  where id = purchase_row.id
  returning * into purchase_row;

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  )
  values (
    target_actor_id,
    public.current_actor_role(),
    'purchases',
    purchase_row.id,
    'purchases.confirm',
    jsonb_build_object('status', 'draft'),
    jsonb_build_object(
      'purchase_number', purchase_row.purchase_number,
      'status', purchase_row.status,
      'confirmed_at', purchase_row.confirmed_at
    )
  );

  purchase_id := purchase_row.id;
  purchase_number := purchase_row.purchase_number;
  purchase_status := purchase_row.status;
  return next;
end;
$$;

revoke all on function public._confirm_purchase_state_v1(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.confirm_purchase_locked(target_purchase_id uuid)
returns table (
  purchase_id uuid,
  purchase_number text,
  purchase_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('purchases:manage')
  ) then
    raise exception using errcode = '42501', message = 'PURCHASE_CONFIRM_FORBIDDEN';
  end if;

  if public.purchase_ap_automation_enabled_v1() then
    raise exception using errcode = 'PT409', message = 'PURCHASE_AP_AUTOMATION_REQUIRED';
  end if;

  return query
  select transition.purchase_id, transition.purchase_number, transition.purchase_status
  from public._confirm_purchase_state_v1(target_purchase_id, actor_id) transition;
end;
$$;

revoke all on function public.confirm_purchase_locked(uuid) from public, anon;
grant execute on function public.confirm_purchase_locked(uuid)
  to authenticated, service_role;

create or replace function public.confirm_purchase_with_payable_v1(
  target_purchase_id uuid,
  p_payment_condition text,
  p_due_date date,
  p_initial_payment_amount numeric,
  p_payment_method text,
  p_payment_date date,
  p_payment_notes text,
  p_request_key uuid
)
returns table (
  purchase_id uuid,
  purchase_status text,
  accounts_payable_id uuid,
  accounts_payable_status text,
  total_amount numeric,
  paid_amount numeric,
  balance numeric,
  due_date date,
  supplier_payment_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  clean_condition text := lower(trim(coalesce(p_payment_condition, '')));
  clean_method text := nullif(lower(trim(coalesce(p_payment_method, ''))), '');
  clean_notes text := nullif(left(trim(coalesce(p_payment_notes, '')), 2000), '');
  purchase_row public.purchases%rowtype;
  payable_row public.accounts_payable%rowtype;
  invoice_row public.supplier_invoices%rowtype;
  transition_row record;
  payment_row record;
  active_invoice_count integer := 0;
  resolved_due_date date;
  resolved_payment_date date;
  resolved_payment_amount numeric(12, 2) := 0;
  request_fingerprint text;
  initial_payment_id uuid;
  payable_created boolean := false;
  supplier_name text;
begin
  if actor_id is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('purchases:manage')
  then
    raise exception using errcode = '42501', message = 'PURCHASE_CONFIRM_FORBIDDEN';
  end if;
  if not public.purchase_ap_automation_enabled_v1() then
    raise exception using errcode = 'PT409', message = 'PURCHASE_AP_AUTOMATION_DISABLED';
  end if;
  if p_request_key is null
    or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid
  then
    raise exception using errcode = '22023', message = 'PURCHASE_REQUEST_KEY_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('purchase_ap_confirmation:' || p_request_key::text, 0)
  );

  if exists (
    select 1 from public.purchases existing
    where existing.confirmation_request_key = p_request_key
      and existing.id <> target_purchase_id
  ) then
    raise exception using errcode = 'PT409', message = 'PURCHASE_REQUEST_KEY_CONFLICT';
  end if;

  select * into purchase_row
  from public.purchases
  where id = target_purchase_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PURCHASE_NOT_FOUND';
  end if;
  if clean_condition not in ('cash', 'credit', 'partial') then
    raise exception using errcode = '22023', message = 'PURCHASE_PAYMENT_CONDITION_INVALID';
  end if;
  if round(purchase_row.total, 2) <= 0 then
    raise exception using errcode = '22023', message = 'PURCHASE_TOTAL_INVALID';
  end if;

  if clean_condition = 'cash' then
    resolved_payment_amount := round(purchase_row.total, 2);
    resolved_payment_date := coalesce(p_payment_date, purchase_row.purchase_date);
  elsif clean_condition = 'credit' then
    if coalesce(round(p_initial_payment_amount, 2), 0) <> 0 then
      raise exception using errcode = '22023', message = 'PURCHASE_CREDIT_PAYMENT_MUST_BE_ZERO';
    end if;
    resolved_payment_amount := 0;
    resolved_payment_date := null;
    clean_method := null;
    clean_notes := null;
  else
    if p_initial_payment_amount is null
      or round(p_initial_payment_amount, 2) <> p_initial_payment_amount
      or p_initial_payment_amount <= 0
      or round(p_initial_payment_amount, 2) >= round(purchase_row.total, 2)
    then
      raise exception using errcode = '22023', message = 'PURCHASE_PARTIAL_AMOUNT_INVALID';
    end if;
    resolved_payment_amount := round(p_initial_payment_amount, 2);
    resolved_payment_date := coalesce(p_payment_date, purchase_row.purchase_date);
  end if;

  if clean_condition in ('cash', 'partial')
    and clean_method not in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
  then
    raise exception using errcode = '22023', message = 'PURCHASE_PAYMENT_METHOD_INVALID';
  end if;

  if purchase_row.status <> 'draft' then
    resolved_due_date := purchase_row.confirmed_due_date;
    request_fingerprint := encode(extensions.digest(convert_to(
      jsonb_build_object(
        'purchase_id', purchase_row.id,
        'payment_condition', clean_condition,
        'requested_due_date', p_due_date,
        'resolved_due_date', resolved_due_date,
        'initial_payment_amount', resolved_payment_amount,
        'payment_date', resolved_payment_date,
        'payment_method', clean_method,
        'payment_notes', clean_notes,
        'canonical_total', round(purchase_row.total, 2)
      )::text,
      'UTF8'
    ), 'sha256'), 'hex');

    if purchase_row.status = 'confirmed'
      and purchase_row.confirmation_request_key = p_request_key
      and purchase_row.confirmation_fingerprint = request_fingerprint
    then
      select * into payable_row
      from public.accounts_payable payable
      where payable.purchase_id = purchase_row.id
        and payable.status <> 'cancelled'
      limit 1;

      if not found then
        raise exception using errcode = 'PT409', message = 'PURCHASE_REPLAY_PAYABLE_MISSING';
      end if;

      purchase_id := purchase_row.id;
      purchase_status := purchase_row.status;
      accounts_payable_id := payable_row.id;
      accounts_payable_status := payable_row.status;
      total_amount := payable_row.total_amount;
      paid_amount := payable_row.paid_amount;
      balance := payable_row.balance;
      due_date := payable_row.due_date;
      supplier_payment_id := purchase_row.initial_supplier_payment_id;
      replayed := true;
      return next;
      return;
    end if;

    if purchase_row.confirmation_request_key = p_request_key then
      raise exception using errcode = 'PT409', message = 'PURCHASE_CONFIRMATION_FINGERPRINT_CONFLICT';
    end if;
    raise exception using errcode = 'PT409', message = 'PURCHASE_ALREADY_CONFIRMED';
  end if;

  if not exists (
    select 1 from public.suppliers supplier
    where supplier.id = purchase_row.supplier_id and supplier.is_active
  ) then
    raise exception using errcode = '22023', message = 'PURCHASE_SUPPLIER_INVALID';
  end if;

  select count(*) into active_invoice_count
  from public.supplier_invoices invoice
  where invoice.purchase_id = purchase_row.id
    and invoice.status <> 'cancelled';

  if active_invoice_count > 1 then
    raise exception using errcode = 'PT409', message = 'PURCHASE_MULTIPLE_ACTIVE_SUPPLIER_INVOICES';
  elsif active_invoice_count = 1 then
    select * into invoice_row
    from public.supplier_invoices invoice
    where invoice.purchase_id = purchase_row.id
      and invoice.status <> 'cancelled'
    for update;

    if invoice_row.supplier_id <> purchase_row.supplier_id
      or round(invoice_row.total, 2) <> round(purchase_row.total, 2)
      or upper(trim(invoice_row.currency)) <> upper(trim(purchase_row.currency))
    then
      raise exception using errcode = 'PT409', message = 'PURCHASE_SUPPLIER_INVOICE_INCONSISTENT';
    end if;
  end if;

  resolved_due_date := coalesce(invoice_row.due_date, p_due_date);
  if clean_condition in ('credit', 'partial') and resolved_due_date is null then
    raise exception using errcode = '22023', message = 'PURCHASE_DUE_DATE_REQUIRED';
  end if;
  if clean_condition = 'cash' and resolved_due_date is null then
    resolved_due_date := resolved_payment_date;
  end if;

  request_fingerprint := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'purchase_id', purchase_row.id,
      'payment_condition', clean_condition,
      'requested_due_date', p_due_date,
      'resolved_due_date', resolved_due_date,
      'initial_payment_amount', resolved_payment_amount,
      'payment_date', resolved_payment_date,
      'payment_method', clean_method,
      'payment_notes', clean_notes,
      'canonical_total', round(purchase_row.total, 2)
    )::text,
    'UTF8'
  ), 'sha256'), 'hex');

  select * into payable_row
  from public.accounts_payable payable
  where payable.purchase_id = purchase_row.id
    and payable.status <> 'cancelled'
  for update;

  if found then
    if payable_row.supplier_id <> purchase_row.supplier_id
      or round(payable_row.total_amount, 2) <> round(purchase_row.total, 2)
      or upper(trim(payable_row.currency)) <> upper(trim(purchase_row.currency))
      or payable_row.paid_amount <> 0
      or payable_row.status not in ('pending', 'overdue')
      or (payable_row.supplier_invoice_id is not null and payable_row.supplier_invoice_id is distinct from invoice_row.id)
      or (payable_row.due_date is not null and payable_row.due_date is distinct from resolved_due_date)
      or exists (
        select 1 from public.supplier_payments payment
        where payment.accounts_payable_id = payable_row.id
          and payment.status <> 'voided'
      )
    then
      raise exception using errcode = 'PT409', message = 'PURCHASE_ACTIVE_PAYABLE_INCONSISTENT';
    end if;

    update public.accounts_payable
    set supplier_invoice_id = coalesce(payable_row.supplier_invoice_id, invoice_row.id),
        due_date = coalesce(payable_row.due_date, resolved_due_date),
        automation_source = 'purchase_confirmation_v1',
        notes = coalesce(payable_row.notes, 'Cuenta por pagar creada al confirmar compra ' || purchase_row.purchase_number),
        updated_at = now()
    where id = payable_row.id
    returning * into payable_row;
  else
    insert into public.accounts_payable (
      supplier_id, purchase_id, supplier_invoice_id, total_amount, paid_amount,
      due_date, status, currency, notes, created_by, automation_source
    )
    values (
      purchase_row.supplier_id,
      purchase_row.id,
      invoice_row.id,
      round(purchase_row.total, 2),
      0,
      resolved_due_date,
      'pending',
      upper(trim(purchase_row.currency)),
      'Cuenta por pagar creada al confirmar compra ' || purchase_row.purchase_number,
      actor_id,
      'purchase_confirmation_v1'
    )
    returning * into payable_row;
    payable_created := true;
  end if;

  if clean_condition in ('cash', 'partial') then
    select * into payment_row
    from public.register_supplier_payment_v2(
      payable_row.id,
      resolved_payment_amount,
      clean_method,
      resolved_payment_date,
      clean_notes,
      'purchase-confirmation:' || p_request_key::text
    );
    initial_payment_id := payment_row.payment_id;
  end if;

  select * into transition_row
  from public._confirm_purchase_state_v1(purchase_row.id, actor_id);

  update public.purchases
  set payment_condition = clean_condition,
      confirmed_due_date = resolved_due_date,
      confirmation_request_key = p_request_key,
      confirmation_fingerprint = request_fingerprint,
      initial_supplier_payment_id = initial_payment_id,
      updated_at = now()
  where id = purchase_row.id
  returning * into purchase_row;

  select supplier.name into supplier_name
  from public.suppliers supplier
  where supplier.id = purchase_row.supplier_id;

  select * into payable_row
  from public.accounts_payable payable
  where payable.id = payable_row.id;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  )
  values (
    'accounts_payable',
    payable_row.id::text,
    'accounts_payable_created',
    'v1',
    'pending',
    purchase_row.confirmed_at,
    jsonb_build_object(
      'accounts_payable_id', payable_row.id,
      'purchase_id', purchase_row.id,
      'supplier_invoice_id', payable_row.supplier_invoice_id,
      'vendor_id', purchase_row.supplier_id,
      'supplier_id', purchase_row.supplier_id,
      'supplier_name', coalesce(supplier_name, 'Proveedor no identificado'),
      'subtotal', purchase_row.subtotal,
      'tax_amount', purchase_row.tax_amount,
      'discount_amount', purchase_row.discount_amount,
      'shipping_amount', purchase_row.shipping_amount,
      'total_amount', payable_row.total_amount,
      'paid_amount', payable_row.paid_amount,
      'balance', payable_row.balance,
      'currency', payable_row.currency,
      'document_number', purchase_row.purchase_number,
      'document_date', purchase_row.purchase_date,
      'purchase_number', purchase_row.purchase_number,
      'invoice_number', invoice_row.invoice_number,
      'due_date', payable_row.due_date,
      'source_type', 'accounts_payable',
      'source_id', payable_row.id,
      'payment_status', payable_row.status,
      'status', payable_row.status,
      'fiscal_breakdown_status', 'complete',
      'fiscal_source', 'purchase',
      'automation_source', 'purchase_confirmation_v1',
      'manual_publication_required', true
    ),
    jsonb_build_array('Modo de automatizacion contable desactivado; publicacion manual requerida.'),
    actor_id
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do nothing;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  )
  values (
    'purchase',
    purchase_row.id::text,
    'purchase_confirmed',
    'v1',
    'pending',
    purchase_row.confirmed_at,
    jsonb_build_object(
      'purchase_id', purchase_row.id,
      'purchase_number', purchase_row.purchase_number,
      'accounts_payable_id', payable_row.id,
      'event_role', 'operational_control',
      'recognition_source', 'accounts_payable',
      'manual_publication_required', true
    ),
    jsonb_build_array('La obligacion se reconoce desde accounts_payable_created para evitar doble contabilizacion.'),
    actor_id
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do nothing;

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'accounts_payable',
    payable_row.id,
    case when payable_created
      then 'accounts_payable.created_from_purchase'
      else 'accounts_payable.adopted_for_purchase_confirmation'
    end,
    null,
    jsonb_build_object(
      'purchase_id', purchase_row.id,
      'supplier_id', purchase_row.supplier_id,
      'total_amount', payable_row.total_amount,
      'paid_amount', payable_row.paid_amount,
      'balance', payable_row.balance,
      'status', payable_row.status,
      'due_date', payable_row.due_date,
      'supplier_payment_id', initial_payment_id,
      'request_key', p_request_key
    )
  );

  purchase_id := purchase_row.id;
  purchase_status := purchase_row.status;
  accounts_payable_id := payable_row.id;
  accounts_payable_status := payable_row.status;
  total_amount := payable_row.total_amount;
  paid_amount := payable_row.paid_amount;
  balance := payable_row.balance;
  due_date := payable_row.due_date;
  supplier_payment_id := initial_payment_id;
  replayed := false;
  return next;
end;
$$;

revoke all on function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) from public, anon;
grant execute on function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) to authenticated;

create or replace function public.cancel_purchase_with_payable_v1(
  target_purchase_id uuid,
  p_request_key uuid
)
returns table (
  purchase_id uuid,
  purchase_status text,
  accounts_payable_id uuid,
  accounts_payable_status text,
  affected_products jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  purchase_row public.purchases%rowtype;
  payable_row public.accounts_payable%rowtype;
  cancellation_row record;
  affected jsonb := '[]'::jsonb;
begin
  if actor_id is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('purchases:manage')
  then
    raise exception using errcode = '42501', message = 'PURCHASE_CANCEL_FORBIDDEN';
  end if;
  if p_request_key is null
    or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid
  then
    raise exception using errcode = '22023', message = 'PURCHASE_CANCEL_REQUEST_KEY_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('purchase_ap_cancellation:' || p_request_key::text, 0)
  );

  if exists (
    select 1 from public.purchases existing
    where existing.cancellation_request_key = p_request_key
      and existing.id <> target_purchase_id
  ) then
    raise exception using errcode = 'PT409', message = 'PURCHASE_CANCEL_REQUEST_KEY_CONFLICT';
  end if;

  select * into purchase_row
  from public.purchases
  where id = target_purchase_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'PURCHASE_NOT_FOUND';
  end if;

  if purchase_row.status = 'cancelled' then
    if purchase_row.cancellation_request_key is distinct from p_request_key then
      raise exception using errcode = 'PT409', message = 'PURCHASE_ALREADY_CANCELLED';
    end if;

    select * into payable_row
    from public.accounts_payable payable
    where payable.purchase_id = purchase_row.id
      and payable.automation_source = 'purchase_confirmation_v1'
    order by payable.created_at desc
    limit 1;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', product.id,
      'slug', product.slug,
      'category_id', product.category_id
    )), '[]'::jsonb)
    into affected
    from (
      select distinct movement.product_id
      from public.inventory_movements movement
      where movement.reference_type = 'purchase_cancellation'
        and movement.reference_id = purchase_row.id
    ) reversed
    join public.products product on product.id = reversed.product_id;

    purchase_id := purchase_row.id;
    purchase_status := purchase_row.status;
    accounts_payable_id := payable_row.id;
    accounts_payable_status := payable_row.status;
    affected_products := affected;
    replayed := true;
    return next;
    return;
  end if;

  if purchase_row.confirmation_request_key is null
    or purchase_row.payment_condition is null
  then
    raise exception using errcode = 'PT409', message = 'PURCHASE_NOT_AUTOMATED';
  end if;

  select * into payable_row
  from public.accounts_payable payable
  where payable.purchase_id = purchase_row.id
    and payable.status <> 'cancelled'
  for update;

  if found then
    if payable_row.automation_source is distinct from 'purchase_confirmation_v1' then
      raise exception using errcode = 'PT409', message = 'PURCHASE_MANUAL_PAYABLE_REVIEW_REQUIRED';
    end if;
    if payable_row.paid_amount > 0
      or exists (
        select 1 from public.supplier_payments payment
        where payment.accounts_payable_id = payable_row.id
          and payment.status = 'paid'
      )
      or exists (
        select 1 from public.supplier_payment_applications application
        where application.accounts_payable_id = payable_row.id
          and application.status = 'applied'
      )
    then
      raise exception using errcode = 'PT409', message = 'PURCHASE_PAYMENTS_MUST_BE_VOIDED_FIRST';
    end if;
    if exists (
      select 1 from public.supplier_invoices invoice
      where invoice.purchase_id = purchase_row.id
        and invoice.status <> 'cancelled'
    ) then
      raise exception using errcode = 'PT409', message = 'PURCHASE_ACTIVE_SUPPLIER_INVOICE_BLOCKS_CANCEL';
    end if;
    if exists (
      select 1 from public.financial_events event
      where event.source_type = 'accounts_payable'
        and event.source_id = payable_row.id::text
        and event.event_purpose = 'accounts_payable_created'
        and event.journal_entry_id is not null
    ) then
      raise exception using errcode = 'PT409', message = 'PURCHASE_ACCOUNTING_REVERSAL_REQUIRED';
    end if;

    update public.accounts_payable
    set status = 'cancelled',
        cancelled_by = actor_id,
        cancelled_at = now(),
        updated_at = now()
    where id = payable_row.id
    returning * into payable_row;

    update public.financial_events event
    set status = 'skipped',
        validation_errors = event.validation_errors
          || jsonb_build_array('Cuenta por pagar cancelada junto con la compra antes de publicacion contable.'),
        updated_at = now()
    where event.source_type = 'accounts_payable'
      and event.source_id = payable_row.id::text
      and event.event_purpose = 'accounts_payable_created'
      and event.posting_version = 'v1'
      and event.journal_entry_id is null
      and event.status not in ('posted', 'reversed');

    insert into public.audit_logs (
      user_id, actor_role, table_name, record_id, action, old_data, new_data
    )
    values (
      actor_id,
      public.current_actor_role(),
      'accounts_payable',
      payable_row.id,
      'accounts_payable.cancelled_with_purchase',
      jsonb_build_object('status', 'pending', 'paid_amount', 0),
      jsonb_build_object('status', 'cancelled', 'purchase_id', purchase_row.id)
    );
  end if;

  select * into cancellation_row
  from public.cancel_purchase_with_inventory(purchase_row.id);

  affected := coalesce(cancellation_row.affected_products, '[]'::jsonb);

  update public.purchases
  set cancellation_request_key = p_request_key,
      updated_at = now()
  where id = purchase_row.id
  returning * into purchase_row;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  )
  values (
    'purchase',
    purchase_row.id::text,
    'purchase_cancelled',
    'v1',
    'pending',
    purchase_row.cancelled_at,
    jsonb_build_object(
      'purchase_id', purchase_row.id,
      'purchase_number', purchase_row.purchase_number,
      'accounts_payable_id', payable_row.id,
      'event_role', 'operational_control',
      'manual_publication_required', true
    ),
    jsonb_build_array('Cancelacion operativa registrada; cualquier reverso contable requiere publicacion manual.'),
    actor_id
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do nothing;

  purchase_id := purchase_row.id;
  purchase_status := purchase_row.status;
  accounts_payable_id := payable_row.id;
  accounts_payable_status := payable_row.status;
  affected_products := affected;
  replayed := false;
  return next;
end;
$$;

revoke all on function public.cancel_purchase_with_payable_v1(uuid, uuid)
  from public, anon;
grant execute on function public.cancel_purchase_with_payable_v1(uuid, uuid)
  to authenticated;

comment on function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) is 'Atomically confirms a draft purchase, creates or safely adopts one payable, applies an optional canonical supplier payment, and records durable accounting intents with replay-safe idempotency.';

comment on function public.cancel_purchase_with_payable_v1(uuid, uuid)
  is 'Idempotently cancels a purchase and its V1 automated unpaid payable while reusing the canonical inventory reversal and blocking paid or accounted obligations.';

commit;
