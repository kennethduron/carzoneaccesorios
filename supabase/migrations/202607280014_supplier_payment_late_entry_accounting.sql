-- General accounting routing and controlled recovery for supplier payments
-- recorded after the V2 cutover with an earlier effective paid_at.
--
-- This migration installs contracts only. It does not scan historical rows,
-- change feature flags/cutovers, enqueue a named production payment, run the
-- worker, create a journal entry, or publish anything.

update public.roles
set permissions = coalesce(permissions, '[]'::jsonb)
    || '["accounting:repair_supplier_payment"]'::jsonb,
    updated_at = now()
where name = 'technical_owner'
  and not coalesce(permissions, '[]'::jsonb)
    ? 'accounting:repair_supplier_payment';

alter table public.accounting_outbox_v2
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.accounting_outbox_v2
  drop constraint if exists accounting_outbox_v2_metadata_object_check,
  add constraint accounting_outbox_v2_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  drop constraint if exists accounting_outbox_v2_supplier_metadata_safe_check,
  add constraint accounting_outbox_v2_supplier_metadata_safe_check
    check (
      source_type <> 'supplier_payment'
      or not (
        metadata ?| array[
          'email', 'phone', 'bank_reference', 'bank_account',
          'auth_user_id', 'tax_id', 'notes'
        ]
      )
    );

create table public.supplier_payment_accounting_repairs (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null
    references public.supplier_payments(id) on delete restrict,
  request_key text not null,
  expected_fingerprint text not null,
  reason text not null,
  classification text not null,
  status text not null default 'queued',
  routing_origin text not null,
  outbox_id uuid
    references public.accounting_outbox_v2(id) on delete restrict,
  financial_event_id uuid
    references public.financial_events(id) on delete restrict,
  covered_financial_event_v1_id uuid
    references public.financial_events(id) on delete restrict,
  journal_entry_id uuid
    references public.journal_entries(id) on delete restrict,
  created_by uuid not null references public.users(id) on delete restrict,
  result jsonb not null default '{}'::jsonb,
  sanitized_error jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_payment_accounting_repairs_payment_unique
    unique (payment_id),
  constraint supplier_payment_accounting_repairs_request_unique
    unique (request_key),
  constraint supplier_payment_accounting_repairs_status_check
    check (status in ('queued', 'processing', 'completed', 'review_required', 'failed')),
  constraint supplier_payment_accounting_repairs_classification_check
    check (
      classification in (
        'eligible_late_recorded',
        'already_accounted',
        'modern_missing_outbox',
        'historical_before_cutover',
        'mapping_missing',
        'chronology_conflict',
        'invalid_payment',
        'cancelled_or_reversed',
        'review_required'
      )
    ),
  constraint supplier_payment_accounting_repairs_lengths_check
    check (
      char_length(request_key) between 8 and 200
      and char_length(expected_fingerprint) = 64
      and char_length(reason) between 8 and 500
      and char_length(routing_origin) between 3 and 120
    ),
  constraint supplier_payment_accounting_repairs_json_check
    check (
      jsonb_typeof(result) = 'object'
      and jsonb_typeof(sanitized_error) = 'object'
    )
);

create index supplier_payment_accounting_repairs_status_idx
  on public.supplier_payment_accounting_repairs(status, updated_at desc);
create index supplier_payment_accounting_repairs_outbox_idx
  on public.supplier_payment_accounting_repairs(outbox_id)
  where outbox_id is not null;
create index supplier_payment_accounting_repairs_journal_idx
  on public.supplier_payment_accounting_repairs(journal_entry_id)
  where journal_entry_id is not null;

create trigger supplier_payment_accounting_repairs_set_updated_at
before update on public.supplier_payment_accounting_repairs
for each row execute function public.set_updated_at();

alter table public.supplier_payment_accounting_repairs enable row level security;

create policy supplier_payment_accounting_repairs_authorized_read
  on public.supplier_payment_accounting_repairs for select
  using (
    public.has_permission('accounting:read')
    and public.current_actor_role()
      in ('technical_owner', 'business_owner', 'admin', 'contadora')
  );

grant select on public.supplier_payment_accounting_repairs to authenticated;
revoke insert, update, delete
  on public.supplier_payment_accounting_repairs from authenticated;
grant select, insert, update, delete
  on public.supplier_payment_accounting_repairs to service_role;

comment on table public.supplier_payment_accounting_repairs is
  'One economic recovery maximum per supplier payment. Stores sanitized control state only; the canonical payment and payable remain unchanged.';

create or replace function public.supplier_payment_accounting_occurred_at(
  p_paid_at timestamptz,
  p_created_at timestamptz,
  p_cutover_at timestamptz
)
returns timestamptz
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_created_at is null or p_cutover_at is null then null
    when p_paid_at is null and p_created_at >= p_cutover_at
      then p_created_at
    when p_paid_at >= p_cutover_at
      then p_paid_at
    when p_paid_at < p_cutover_at and p_created_at >= p_cutover_at
      then p_created_at
    else null
  end
$$;

revoke all on function public.supplier_payment_accounting_occurred_at(
  timestamptz, timestamptz, timestamptz
) from public, anon;
grant execute on function public.supplier_payment_accounting_occurred_at(
  timestamptz, timestamptz, timestamptz
) to authenticated, service_role;

comment on function public.supplier_payment_accounting_occurred_at(
  timestamptz, timestamptz, timestamptz
) is
  'Canonical timestamp authority for supplier-payment accounting routing. Preserves paid_at and uses created_at only for a payment recorded after cutover with an earlier/null effective timestamp.';

create or replace function public.supplier_payment_accounting_assessment_v1(
  p_payment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  payment public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  supplier public.suppliers%rowtype;
  flag public.accounting_feature_flags%rowtype;
  routing_at timestamptz;
  proposed_date date;
  mapping_key text;
  payable_account public.accounting_accounts%rowtype;
  payment_account public.accounting_accounts%rowtype;
  recognition_event public.financial_events%rowtype;
  recognition_entry public.journal_entries%rowtype;
  v1_event public.financial_events%rowtype;
  v2_event public.financial_events%rowtype;
  v2_box public.accounting_outbox_v2%rowtype;
  existing_entry public.journal_entries%rowtype;
  recognition_count integer := 0;
  v1_outbox_count integer := 0;
  paid_payments_total numeric(14, 2) := 0;
  classification_value text := 'review_required';
  reason_code text := 'review_required';
  routing_origin_value text;
  fingerprint_payload jsonb;
  fingerprint_value text;
  payment_ref text;
  supplier_ref text;
  payable_ref text;
begin
  select * into payment
  from public.supplier_payments
  where id = p_payment_id;

  select * into flag
  from public.accounting_feature_flags
  where key = 'supplier_payment_draft_v2';

  if payment.id is not null then
    select * into payable
    from public.accounts_payable
    where id = payment.accounts_payable_id;

    select * into supplier
    from public.suppliers
    where id = payment.supplier_id;

    select round(coalesce(sum(candidate.amount), 0), 2)
    into paid_payments_total
    from public.supplier_payments candidate
    where candidate.accounts_payable_id = payment.accounts_payable_id
      and candidate.status = 'paid'
      and candidate.voided_at is null;
  end if;

  routing_at := public.supplier_payment_accounting_occurred_at(
    payment.paid_at,
    payment.created_at,
    flag.cutover_at
  );
  proposed_date := case
    when routing_at is null then null
    else (routing_at at time zone 'America/Tegucigalpa')::date
  end;
  routing_origin_value := case
    when payment.paid_at < flag.cutover_at
      and payment.created_at >= flag.cutover_at
      then 'late_recorded_supplier_payment'
    else 'supplier_payment'
  end;

  mapping_key := case payment.payment_method_v2
    when 'cash' then 'supplier_payment_cash'
    when 'bank_transfer' then 'supplier_payment_bank'
    when 'card_credit' then 'supplier_payment_card'
    when 'card_debit' then 'supplier_payment_bank'
    else null
  end;

  if proposed_date is not null then
    select account.* into payable_account
    from public.accounting_accounts account
    where account.id = public.resolve_accounting_mapping_v2(
      'default_account', 'accounts_payable', proposed_date
    );

    if mapping_key is not null then
      select account.* into payment_account
      from public.accounting_accounts account
      where account.id = public.resolve_accounting_mapping_v2(
        'payment_method', mapping_key, proposed_date
      );
    end if;
  end if;

  if payable.id is not null then
    select count(*) into recognition_count
    from public.financial_events event
    join public.journal_entries entry
      on entry.id = event.journal_entry_id
    where event.source_type = 'accounts_payable'
      and event.source_id = payable.id::text
      and event.event_purpose = 'accounts_payable_created'
      and event.status = 'posted'
      and entry.status = 'publicada';

    select event.*
    into recognition_event
    from public.financial_events event
    join public.journal_entries entry
      on entry.id = event.journal_entry_id
    where event.source_type = 'accounts_payable'
      and event.source_id = payable.id::text
      and event.event_purpose = 'accounts_payable_created'
      and event.status = 'posted'
      and entry.status = 'publicada'
    order by entry.entry_date, entry.created_at, entry.id
    limit 1;

    select * into recognition_entry
    from public.journal_entries
    where id = recognition_event.journal_entry_id;
  end if;

  if payment.id is not null then
    select * into v1_event
    from public.financial_events event
    where event.source_type = 'supplier_payment'
      and event.source_id = payment.id::text
      and event.event_purpose = 'supplier_payment'
      and event.posting_version = 'v1'
    order by event.created_at, event.id
    limit 1;

    select * into v2_event
    from public.financial_events event
    where event.source_type = 'supplier_payment'
      and event.source_id = payment.id::text
      and event.event_purpose = 'supplier_payment'
      and event.posting_version = 'v2'
    order by event.created_at, event.id
    limit 1;

    select * into v2_box
    from public.accounting_outbox_v2 box
    where box.source_type = 'supplier_payment'
      and box.source_id = payment.id
      and box.event_purpose = 'supplier_payment'
      and box.posting_version = 'v2'
    order by box.created_at, box.id
    limit 1;

    select * into existing_entry
    from public.journal_entries entry
    where (
        v1_event.id is not null
        and entry.source_type = 'financial_event'
        and entry.source_id = v1_event.id::text
      )
      or (
        v2_event.id is not null
        and entry.source_type = 'financial_event'
        and entry.source_id = v2_event.id::text
      )
      or (
        entry.source_type = 'supplier_payment'
        and entry.source_id = payment.id::text
      )
      or entry.metadata->>'payment_id' = payment.id::text
    order by entry.created_at, entry.id
    limit 1;

    select count(*) into v1_outbox_count
    from public.accounting_outbox box
    where box.source_type = 'supplier_payment'
      and box.source_id = payment.id;
  end if;

  if payment.id is null
    or payable.id is null
    or supplier.id is null
    or payable.supplier_id is distinct from payment.supplier_id
    or round(coalesce(payment.amount, 0), 2) <= 0
    or round(coalesce(payable.total_amount, 0), 2) <= 0
    or round(coalesce(payable.paid_amount, 0), 2)
      < round(coalesce(payment.amount, 0), 2)
    or round(coalesce(payable.paid_amount, 0), 2)
      < round(coalesce(paid_payments_total, 0), 2)
    or round(coalesce(payable.balance, 0), 2)
      <> round(coalesce(payable.total_amount, 0)
        - coalesce(payable.paid_amount, 0), 2)
  then
    classification_value := 'invalid_payment';
    reason_code := 'canonical_payment_or_payable_invalid';
  elsif payment.status = 'voided'
    or payment.voided_at is not null
    or v1_event.status = 'reversed'
    or v2_event.status = 'reversed'
  then
    classification_value := 'cancelled_or_reversed';
    reason_code := 'payment_cancelled_or_reversed';
  elsif v2_box.id is not null
    or v2_event.id is not null
    or existing_entry.id is not null
    or v1_event.journal_entry_id is not null
    or v1_outbox_count > 0
    or exists (
      select 1
      from public.supplier_payment_accounting_repairs repair
      where repair.payment_id = payment.id
        and repair.status in ('queued', 'processing', 'completed')
    )
  then
    classification_value := 'already_accounted';
    reason_code := 'existing_economic_artifact';
  elsif flag.key is null
    or flag.cutover_at is null
    or flag.state <> 'enabled'
  then
    classification_value := 'review_required';
    reason_code := 'supplier_payment_v2_not_enabled';
  elsif routing_at is null
    and payment.created_at < flag.cutover_at
    and (payment.paid_at is null or payment.paid_at < flag.cutover_at)
  then
    classification_value := 'historical_before_cutover';
    reason_code := 'payment_recorded_before_cutover';
  elsif payment.status <> 'paid'
    or payment.payment_method_v2
      not in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
    or routing_at is null
  then
    classification_value := 'invalid_payment';
    reason_code := 'payment_not_eligible_for_accounting';
  elsif payable_account.id is null or payment_account.id is null
    or not coalesce(payable_account.is_active, false)
    or not coalesce(payment_account.is_active, false)
  then
    classification_value := 'mapping_missing';
    reason_code := 'supplier_payment_mapping_missing';
  elsif recognition_count = 0 then
    classification_value := 'review_required';
    reason_code := 'accounts_payable_recognition_missing';
  elsif recognition_count <> 1 then
    classification_value := 'review_required';
    reason_code := 'accounts_payable_recognition_ambiguous';
  elsif recognition_entry.entry_date > proposed_date then
    classification_value := 'chronology_conflict';
    reason_code := 'payment_date_before_payable_recognition';
  elsif public.is_date_in_closed_accounting_period(proposed_date) then
    classification_value := 'review_required';
    reason_code := 'proposed_accounting_period_closed';
  elsif payment.paid_at < flag.cutover_at
    and payment.created_at >= flag.cutover_at
  then
    classification_value := 'eligible_late_recorded';
    reason_code := 'late_recorded_supplier_payment';
  else
    classification_value := 'modern_missing_outbox';
    reason_code := 'modern_supplier_payment_missing_outbox';
  end if;

  payment_ref := case when payment.id is null then null else
    'payment#' || left(encode(
      extensions.digest(convert_to(payment.id::text, 'UTF8'), 'sha256'),
      'hex'
    ), 12) end;
  supplier_ref := case when supplier.id is null then null else
    'supplier#' || left(encode(
      extensions.digest(convert_to(supplier.id::text, 'UTF8'), 'sha256'),
      'hex'
    ), 12) end;
  payable_ref := case when payable.id is null then null else
    'payable#' || left(encode(
      extensions.digest(convert_to(payable.id::text, 'UTF8'), 'sha256'),
      'hex'
    ), 12) end;

  fingerprint_payload := jsonb_build_object(
    'payment_id', payment.id,
    'accounts_payable_id', payable.id,
    'supplier_id', supplier.id,
    'amount', round(coalesce(payment.amount, 0), 2),
    'payment_method', payment.payment_method_v2,
    'payment_status', payment.status,
    'paid_at', payment.paid_at,
    'recorded_at', payment.created_at,
    'voided_at', payment.voided_at,
    'payable_total', payable.total_amount,
    'payable_paid', payable.paid_amount,
    'payable_balance', payable.balance,
    'payable_status', payable.status,
    'cutover_at', flag.cutover_at,
    'accounting_occurred_at', routing_at,
    'proposed_journal_date', proposed_date,
    'payable_account_id', payable_account.id,
    'payment_account_id', payment_account.id,
    'recognition_event_id', recognition_event.id,
    'recognition_journal_id', recognition_entry.id,
    'recognition_date', recognition_entry.entry_date,
    'classification', classification_value
  );
  fingerprint_value := encode(
    extensions.digest(
      convert_to(fingerprint_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  return jsonb_build_object(
    'payment_id', payment.id,
    'payment_reference', payment_ref,
    'supplier_reference', supplier_ref,
    'supplier_name', left(coalesce(supplier.name, 'Proveedor no disponible'), 160),
    'amount', round(coalesce(payment.amount, 0), 2),
    'currency', coalesce(payable.currency, 'HNL'),
    'effective_paid_at', payment.paid_at,
    'recorded_at', payment.created_at,
    'accounting_occurred_at', routing_at,
    'proposed_journal_date', proposed_date,
    'accounts_payable_id', payable.id,
    'accounts_payable_reference', payable_ref,
    'accounts_payable_status', payable.status,
    'payment_status', payment.status,
    'payment_method', payment.payment_method_v2,
    'classification', classification_value,
    'classification_reason', reason_code,
    'routing_origin', routing_origin_value,
    'cutover_at', flag.cutover_at,
    'cutover_applied', routing_origin_value = 'late_recorded_supplier_payment',
    'mapping', jsonb_build_object(
      'payable_account_id', payable_account.id,
      'payable_account_code', payable_account.code,
      'payable_account_name', payable_account.name,
      'payment_account_id', payment_account.id,
      'payment_account_code', payment_account.code,
      'payment_account_name', payment_account.name,
      'payment_mapping_key', mapping_key
    ),
    'existing_event', case
      when v2_event.id is not null then jsonb_build_object(
        'id', v2_event.id, 'version', 'v2', 'status', v2_event.status,
        'journal_entry_id', v2_event.journal_entry_id
      )
      when v1_event.id is not null then jsonb_build_object(
        'id', v1_event.id, 'version', 'v1', 'status', v1_event.status,
        'journal_entry_id', v1_event.journal_entry_id
      )
      else null
    end,
    'existing_outbox', case when v2_box.id is null then null else
      jsonb_build_object(
        'id', v2_box.id, 'status', v2_box.status,
        'financial_event_id', v2_box.financial_event_id,
        'journal_entry_id', v2_box.journal_entry_id
      )
    end,
    'existing_journal', case when existing_entry.id is null then null else
      jsonb_build_object(
        'id', existing_entry.id,
        'entry_number', existing_entry.entry_number,
        'entry_date', existing_entry.entry_date,
        'status', existing_entry.status
      )
    end,
    'payable_recognition', case when recognition_entry.id is null then null else
      jsonb_build_object(
        'event_id', recognition_event.id,
        'journal_entry_id', recognition_entry.id,
        'entry_number', recognition_entry.entry_number,
        'entry_date', recognition_entry.entry_date,
        'status', recognition_entry.status
      )
    end,
    'preview_lines', jsonb_build_array(
      jsonb_build_object(
        'side', 'debit',
        'account_id', payable_account.id,
        'account_code', payable_account.code,
        'account_name', payable_account.name,
        'amount', round(coalesce(payment.amount, 0), 2)
      ),
      jsonb_build_object(
        'side', 'credit',
        'account_id', payment_account.id,
        'account_code', payment_account.code,
        'account_name', payment_account.name,
        'amount', round(coalesce(payment.amount, 0), 2)
      )
    ),
    'total_debit', round(coalesce(payment.amount, 0), 2),
    'total_credit', round(coalesce(payment.amount, 0), 2),
    'balanced', round(coalesce(payment.amount, 0), 2) > 0
      and payable_account.id is not null
      and payment_account.id is not null,
    'manual_publication_required', true,
    'expected_fingerprint', fingerprint_value
  );
end;
$$;

revoke all on function public.supplier_payment_accounting_assessment_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_accounting_assessment_v1(uuid)
  to service_role;

create or replace function public.preview_supplier_payment_accounting_repairs_v1(
  p_payment_id uuid default null
)
returns table (preview jsonb)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
begin
  if actor_id is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:read')
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para consultar reparaciones contables.';
  end if;

  if p_payment_id is not null then
    return query
    select public.supplier_payment_accounting_assessment_v1(p_payment_id);
    return;
  end if;

  return query
  select public.supplier_payment_accounting_assessment_v1(payment.id)
  from public.supplier_payments payment
  cross join public.accounting_feature_flags flag
  where flag.key = 'supplier_payment_draft_v2'
    and payment.status in ('paid', 'voided')
    and (
      payment.created_at >= flag.cutover_at
      or exists (
        select 1
        from public.supplier_payment_accounting_repairs repair
        where repair.payment_id = payment.id
      )
    )
  order by payment.created_at desc, payment.id
  limit 500;
end;
$$;

revoke all on function public.preview_supplier_payment_accounting_repairs_v1(uuid)
  from public, anon;
grant execute on function public.preview_supplier_payment_accounting_repairs_v1(uuid)
  to authenticated;

comment on function public.preview_supplier_payment_accounting_repairs_v1(uuid)
  is 'Read-only supplier-payment accounting assessment. It never inserts events/logs/outboxes, changes state, or calls the legacy dry-run scanner.';

create or replace function public.route_supplier_payment_accounting_v2(
  p_payment_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment public.supplier_payments%rowtype;
  flag public.accounting_feature_flags%rowtype;
  routing_at timestamptz;
  journal_date date;
  routing_origin_value text;
  recognition_date date;
  recognition_count integer := 0;
  existing_box_id uuid;
  result_id uuid;
begin
  if p_payment_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'supplier_payment_accounting:' || p_payment_id::text,
      0
    )
  );

  select * into payment
  from public.supplier_payments
  where id = p_payment_id;

  select * into flag
  from public.accounting_feature_flags
  where key = 'supplier_payment_draft_v2';

  if payment.id is null
    or payment.status <> 'paid'
    or flag.key is null
    or flag.state = 'disabled'
    or flag.cutover_at is null
  then
    return null;
  end if;

  routing_at := public.supplier_payment_accounting_occurred_at(
    payment.paid_at,
    payment.created_at,
    flag.cutover_at
  );

  if routing_at is null then
    if payment.created_at < flag.cutover_at
      and (payment.paid_at is null or payment.paid_at < flag.cutover_at)
    then
      insert into public.accounting_event_log (
        event_type, entity_type, entity_id,
        source_type, source_id, metadata, created_by
      )
      values (
        'supplier_payment_historical_before_cutover_skipped',
        'supplier_payments', payment.id,
        'supplier_payment', payment.id::text,
        jsonb_build_object(
          'payment_id', payment.id,
          'effective_paid_at', payment.paid_at,
          'recorded_at', payment.created_at,
          'cutover_at', flag.cutover_at,
          'manual_review_required', true
        ),
        coalesce(p_actor_id, payment.created_by, auth.uid())
      );
    end if;
    return null;
  end if;

  journal_date := (routing_at at time zone 'America/Tegucigalpa')::date;
  routing_origin_value := case
    when payment.paid_at < flag.cutover_at
      and payment.created_at >= flag.cutover_at
      then 'late_recorded_supplier_payment'
    else 'supplier_payment'
  end;

  if routing_origin_value = 'late_recorded_supplier_payment' then
    select count(*), min(entry.entry_date)
    into recognition_count, recognition_date
    from public.financial_events event
    join public.journal_entries entry
      on entry.id = event.journal_entry_id
    where event.source_type = 'accounts_payable'
      and event.source_id = payment.accounts_payable_id::text
      and event.event_purpose = 'accounts_payable_created'
      and event.status = 'posted'
      and entry.status = 'publicada';

    if recognition_count <> 1
      or recognition_date is null
      or recognition_date > journal_date
    then
      insert into public.accounting_event_log (
        event_type, entity_type, entity_id,
        source_type, source_id, metadata, created_by
      )
      values (
        'supplier_payment_chronology_review_required',
        'supplier_payments', payment.id,
        'supplier_payment', payment.id::text,
        jsonb_build_object(
          'payment_id', payment.id,
          'effective_paid_at', payment.paid_at,
          'recorded_at', payment.created_at,
          'proposed_journal_date', journal_date,
          'recognition_date', recognition_date,
          'recognition_count', recognition_count,
          'reason', case
            when recognition_count = 0
              then 'accounts_payable_recognition_missing'
            when recognition_count <> 1
              then 'accounts_payable_recognition_ambiguous'
            else 'payment_date_before_payable_recognition'
          end,
          'manual_review_required', true
        ),
        coalesce(p_actor_id, payment.created_by, auth.uid())
      );
      return null;
    end if;
  end if;

  select box.id into existing_box_id
  from public.accounting_outbox_v2 box
  where box.source_type = 'supplier_payment'
    and box.source_id = payment.id
    and box.event_purpose = 'supplier_payment'
    and box.posting_version = 'v2';

  result_id := public.route_accounting_fact_v2(
    'supplier_payment_draft_v2',
    'payables.supplier_payment',
    'supplier_payment',
    payment.id,
    'supplier_payment',
    coalesce(payment.payment_method_v2, 'legacy_method_pending_data'),
    routing_at,
    coalesce(p_actor_id, payment.created_by, auth.uid())
  );

  if result_id is null then
    return null;
  end if;

  update public.accounting_outbox_v2
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'source_type', 'supplier_payment',
        'payment_id', payment.id,
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'accounting_occurred_at', routing_at,
        'journal_date', journal_date,
        'routing_origin', routing_origin_value,
        'cutover_applied',
          routing_origin_value = 'late_recorded_supplier_payment',
        'manual_publication_required', true
      )
  where id = result_id;

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id,
    source_type, source_id, metadata, created_by
  )
  values (
    case
      when existing_box_id is not null
        then 'supplier_payment_already_accounted'
      when routing_origin_value = 'late_recorded_supplier_payment'
        then 'supplier_payment_late_recorded_routed'
      else 'supplier_payment_v2_routed'
    end,
    'accounting_outbox_v2', result_id,
    'supplier_payment', payment.id::text,
    jsonb_build_object(
      'payment_id', payment.id,
      'outbox_id', result_id,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_occurred_at', routing_at,
      'journal_date', journal_date,
      'routing_origin', routing_origin_value,
      'duplicate_avoided', existing_box_id is not null,
      'manual_publication_required', true
    ),
    coalesce(p_actor_id, payment.created_by, auth.uid())
  );

  return result_id;
end;
$$;

revoke all on function public.route_supplier_payment_accounting_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.route_supplier_payment_accounting_v2(uuid, uuid)
  to service_role;

create or replace function public.enqueue_supplier_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'paid' then
    perform public.route_supplier_payment_accounting_v2(
      new.id,
      coalesce(new.created_by, auth.uid())
    );
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_supplier_payment_v2()
  from public, anon, authenticated;

drop trigger if exists supplier_payments_enqueue_accounting_v2
  on public.supplier_payments;
create trigger supplier_payments_enqueue_accounting_v2
after insert on public.supplier_payments
for each row
execute function public.enqueue_supplier_payment_v2();

create or replace function public.enrich_supplier_payment_event_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment public.supplier_payments%rowtype;
  box public.accounting_outbox_v2%rowtype;
begin
  if new.source_type <> 'supplier_payment'
    or new.event_purpose <> 'supplier_payment'
    or new.posting_version <> 'v2'
  then
    return new;
  end if;

  select * into payment
  from public.supplier_payments
  where id = new.source_id::uuid;

  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = payment.id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';

  if payment.id is null or box.id is null then
    return new;
  end if;

  new.occurred_at := box.occurred_at;
  new.source_snapshot := coalesce(new.source_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'source_type', 'supplier_payment',
      'supplier_payment_id', payment.id,
      'accounts_payable_id', payment.accounts_payable_id,
      'supplier_id', payment.supplier_id,
      'amount', round(payment.amount, 2),
      'payment_method', payment.payment_method_v2,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_occurred_at', box.occurred_at,
      'journal_date',
        (box.occurred_at at time zone 'America/Tegucigalpa')::date,
      'routing_origin', coalesce(
        box.metadata->>'routing_origin',
        'supplier_payment'
      ),
      'cutover_applied', coalesce(
        (box.metadata->>'cutover_applied')::boolean,
        false
      ),
      'manual_publication_required', true
    );
  return new;
end;
$$;

revoke all on function public.enrich_supplier_payment_event_v2()
  from public, anon, authenticated;

drop trigger if exists financial_events_enrich_supplier_payment_v2
  on public.financial_events;
create trigger financial_events_enrich_supplier_payment_v2
before insert or update of source_snapshot on public.financial_events
for each row execute function public.enrich_supplier_payment_event_v2();

create or replace function public.enrich_supplier_payment_journal_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event public.financial_events%rowtype;
  payment public.supplier_payments%rowtype;
  box public.accounting_outbox_v2%rowtype;
begin
  if new.source_type <> 'financial_event' then
    return new;
  end if;

  select * into event
  from public.financial_events
  where id = new.source_id::uuid
    and source_type = 'supplier_payment'
    and event_purpose = 'supplier_payment'
    and posting_version = 'v2';

  if event.id is null then
    return new;
  end if;

  select * into payment
  from public.supplier_payments
  where id = event.source_id::uuid;

  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = payment.id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';

  if payment.id is null or box.id is null then
    return new;
  end if;

  new.entry_date :=
    (box.occurred_at at time zone 'America/Tegucigalpa')::date;
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'source_type', 'supplier_payment',
      'payment_id', payment.id,
      'accounts_payable_id', payment.accounts_payable_id,
      'supplier_id', payment.supplier_id,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_occurred_at', box.occurred_at,
      'routing_origin', coalesce(
        box.metadata->>'routing_origin',
        'supplier_payment'
      ),
      'cutover_applied', coalesce(
        (box.metadata->>'cutover_applied')::boolean,
        false
      ),
      'manual_publication_required', true
    );
  return new;
end;
$$;

revoke all on function public.enrich_supplier_payment_journal_v2()
  from public, anon, authenticated;

drop trigger if exists journal_entries_enrich_supplier_payment_v2
  on public.journal_entries;
create trigger journal_entries_enrich_supplier_payment_v2
before insert on public.journal_entries
for each row execute function public.enrich_supplier_payment_journal_v2();

create or replace function public.observe_supplier_payment_outbox_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_name text;
begin
  if new.source_type <> 'supplier_payment'
    or new.event_purpose <> 'supplier_payment'
    or new.posting_version <> 'v2'
  then
    return new;
  end if;

  update public.supplier_payment_accounting_repairs repair
  set status = case
        when new.status = 'completed' and new.journal_entry_id is not null
          then 'completed'
        when new.status in ('failed', 'cancelled') then 'failed'
        when new.status in ('pending_mapping', 'pending_data')
          then 'review_required'
        else repair.status
      end,
      financial_event_id = coalesce(
        new.financial_event_id,
        repair.financial_event_id
      ),
      journal_entry_id = coalesce(
        new.journal_entry_id,
        repair.journal_entry_id
      ),
      result = repair.result || jsonb_build_object(
        'outbox_id', new.id,
        'outbox_status', new.status,
        'financial_event_id', new.financial_event_id,
        'journal_entry_id', new.journal_entry_id,
        'manual_publication_required', true
      ),
      sanitized_error = case
        when new.status in ('pending_mapping', 'pending_data', 'failed')
          then jsonb_build_object(
            'code', new.last_error_code,
            'missing_key', new.missing_key
          )
        else '{}'::jsonb
      end
  where repair.payment_id = new.source_id
    and repair.outbox_id = new.id;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    event_name := case
      when new.status = 'pending_mapping'
        then 'supplier_payment_mapping_missing'
      when new.status = 'completed' and new.journal_entry_id is not null
        then 'supplier_payment_draft_created'
      when new.status = 'completed'
        then 'supplier_payment_already_accounted'
      else null
    end;

    if event_name is not null then
      insert into public.accounting_event_log (
        event_type, entity_type, entity_id,
        source_type, source_id, metadata, created_by
      )
      values (
        event_name,
        'accounting_outbox_v2', new.id,
        'supplier_payment', new.source_id::text,
        jsonb_build_object(
          'payment_id', new.source_id,
          'outbox_id', new.id,
          'outbox_status', new.status,
          'financial_event_id', new.financial_event_id,
          'journal_entry_id', new.journal_entry_id,
          'routing_origin', new.metadata->>'routing_origin',
          'manual_publication_required', true
        ),
        new.actor_id
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.observe_supplier_payment_outbox_v2()
  from public, anon, authenticated;

drop trigger if exists accounting_outbox_v2_observe_supplier_payment
  on public.accounting_outbox_v2;
create trigger accounting_outbox_v2_observe_supplier_payment
after insert or update on public.accounting_outbox_v2
for each row execute function public.observe_supplier_payment_outbox_v2();

create or replace function public.repair_late_recorded_supplier_payment_draft_v1(
  p_request_key text,
  p_payment_id uuid,
  p_expected_fingerprint text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  clean_request_key text := nullif(
    left(btrim(coalesce(p_request_key, '')), 200),
    ''
  );
  clean_fingerprint text := lower(btrim(coalesce(p_expected_fingerprint, '')));
  clean_reason text := nullif(
    left(regexp_replace(btrim(coalesce(p_reason, '')), E'[\\n\\r\\t]+', ' ', 'g'), 500),
    ''
  );
  payment public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  supplier public.suppliers%rowtype;
  flag public.accounting_feature_flags%rowtype;
  existing_repair public.supplier_payment_accounting_repairs%rowtype;
  assessment jsonb;
  classification_value text;
  reason_code text;
  routing_at timestamptz;
  journal_date date;
  payable_account_id uuid;
  payment_account_id uuid;
  recognition_event_id uuid;
  recognition_entry_id uuid;
  recognition_date date;
  v1_event_id uuid;
  v1_event_count integer := 0;
  v2_event_count integer := 0;
  v1_outbox_count integer := 0;
  v2_outbox_count integer := 0;
  conflicting_journal_count integer := 0;
  paid_payments_total numeric(14, 2) := 0;
  outbox_id_value uuid;
  repair_id_value uuid;
  safe_result jsonb;
begin
  if actor_id is null
    or actor_role <> 'technical_owner'
    or not public.has_permission('accounting:repair_supplier_payment')
  then
    raise exception using
      errcode = '42501',
      message = 'Solo technical_owner puede reparar pagos a proveedores.';
  end if;

  if clean_request_key is null or char_length(clean_request_key) < 8 then
    raise exception using
      errcode = '22023',
      message = 'La clave de solicitud no es valida.';
  end if;
  if clean_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'La huella esperada no es valida.';
  end if;
  if p_payment_id is null then
    raise exception using
      errcode = '22023',
      message = 'El pago es obligatorio.';
  end if;
  if clean_reason is null or char_length(clean_reason) < 8
    or clean_reason ~* '@|[0-9]{8,}'
  then
    raise exception using
      errcode = '22023',
      message = 'Indica un motivo operativo sin datos sensibles.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'supplier_payment_accounting:' || p_payment_id::text,
      0
    )
  );

  select * into existing_repair
  from public.supplier_payment_accounting_repairs repair
  where repair.request_key = clean_request_key
     or repair.payment_id = p_payment_id
  order by (repair.request_key = clean_request_key) desc
  limit 1
  for update;

  if existing_repair.id is not null then
    if existing_repair.payment_id <> p_payment_id
      or existing_repair.expected_fingerprint <> clean_fingerprint
    then
      raise exception using
        errcode = '23505',
        message = 'La clave de solicitud ya pertenece a otro contenido.';
    end if;

    return existing_repair.result || jsonb_build_object(
      'ok', true,
      'repair_id', existing_repair.id,
      'status', existing_repair.status,
      'outbox_id', existing_repair.outbox_id,
      'financial_event_id', existing_repair.financial_event_id,
      'journal_entry_id', existing_repair.journal_entry_id,
      'idempotent_replay', true,
      'manual_publication_required', true
    );
  end if;

  select * into payment
  from public.supplier_payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'El pago a proveedor no existe.';
  end if;

  select * into payable
  from public.accounts_payable
  where id = payment.accounts_payable_id
  for update;

  select * into supplier
  from public.suppliers
  where id = payment.supplier_id
  for share;

  select * into flag
  from public.accounting_feature_flags
  where key = 'supplier_payment_draft_v2'
  for share;

  assessment := public.supplier_payment_accounting_assessment_v1(payment.id);
  classification_value := assessment->>'classification';
  reason_code := assessment->>'classification_reason';

  if assessment->>'expected_fingerprint' is distinct from clean_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'Los datos cambiaron desde la vista previa. Actualiza y revisa nuevamente.';
  end if;

  if classification_value <> 'eligible_late_recorded' then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      case classification_value
        when 'already_accounted' then 'supplier_payment_already_accounted'
        when 'mapping_missing' then 'supplier_payment_mapping_missing'
        when 'chronology_conflict'
          then 'supplier_payment_chronology_review_required'
        when 'historical_before_cutover'
          then 'supplier_payment_historical_before_cutover_skipped'
        else 'supplier_payment_chronology_review_required'
      end,
      'supplier_payments', payment.id,
      'supplier_payment', payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'classification', classification_value,
        'reason', reason_code,
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'proposed_journal_date', assessment->>'proposed_journal_date',
        'manual_review_required', true
      ),
      actor_id
    );

    return assessment || jsonb_build_object(
      'ok', false,
      'status', 'review_required',
      'idempotent_replay', false,
      'outbox_created', false,
      'manual_publication_required', true
    );
  end if;

  routing_at := public.supplier_payment_accounting_occurred_at(
    payment.paid_at,
    payment.created_at,
    flag.cutover_at
  );
  journal_date := (routing_at at time zone 'America/Tegucigalpa')::date;
  payable_account_id := nullif(
    assessment->'mapping'->>'payable_account_id',
    ''
  )::uuid;
  payment_account_id := nullif(
    assessment->'mapping'->>'payment_account_id',
    ''
  )::uuid;
  recognition_event_id := nullif(
    assessment->'payable_recognition'->>'event_id',
    ''
  )::uuid;
  recognition_entry_id := nullif(
    assessment->'payable_recognition'->>'journal_entry_id',
    ''
  )::uuid;
  recognition_date := nullif(
    assessment->'payable_recognition'->>'entry_date',
    ''
  )::date;

  select round(coalesce(sum(candidate.amount), 0), 2)
  into paid_payments_total
  from public.supplier_payments candidate
  where candidate.accounts_payable_id = payable.id
    and candidate.status = 'paid'
    and candidate.voided_at is null;

  if payable.id is null
    or supplier.id is null
    or payable.supplier_id <> payment.supplier_id
    or payment.status <> 'paid'
    or payment.voided_at is not null
    or round(payment.amount, 2) <= 0
    or round(payable.paid_amount, 2) < round(payment.amount, 2)
    or round(payable.paid_amount, 2) < paid_payments_total
    or payment.payment_method_v2
      not in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
    or lower(btrim(payment.payment_method)) <> payment.payment_method_v2
    or payment.created_at < flag.cutover_at
    or payment.paid_at is null
    or payment.paid_at >= flag.cutover_at
    or routing_at is distinct from payment.created_at
    or payable_account_id is null
    or payment_account_id is null
    or recognition_event_id is null
    or recognition_entry_id is null
    or recognition_date is null
    or recognition_date > journal_date
  then
    raise exception using
      errcode = '22023',
      message = 'Las precondiciones canonicas del pago cambiaron.';
  end if;

  if public.is_date_in_closed_accounting_period(journal_date) then
    raise exception using
      errcode = '22023',
      message = 'La fecha contable propuesta pertenece a un periodo cerrado.';
  end if;

  if not exists (
    select 1
    from public.accounting_accounts account
    where account.id = payable_account_id
      and account.is_active
  ) or not exists (
    select 1
    from public.accounting_accounts account
    where account.id = payment_account_id
      and account.is_active
  ) then
    raise exception using
      errcode = '22023',
      message = 'Las cuentas contables resueltas ya no estan activas.';
  end if;

  if public.resolve_accounting_mapping_v2(
      'default_account', 'accounts_payable', journal_date
    ) is distinct from payable_account_id
    or public.resolve_accounting_mapping_v2(
      'payment_method',
      case payment.payment_method_v2
        when 'cash' then 'supplier_payment_cash'
        when 'bank_transfer' then 'supplier_payment_bank'
        when 'card_credit' then 'supplier_payment_card'
        when 'card_debit' then 'supplier_payment_bank'
      end,
      journal_date
    ) is distinct from payment_account_id
  then
    raise exception using
      errcode = '22023',
      message = 'Los mappings contables cambiaron desde la vista previa.';
  end if;

  if not exists (
    select 1
    from public.financial_events event
    join public.journal_entries entry
      on entry.id = event.journal_entry_id
    where event.id = recognition_event_id
      and event.source_type = 'accounts_payable'
      and event.source_id = payable.id::text
      and event.event_purpose = 'accounts_payable_created'
      and event.status = 'posted'
      and entry.id = recognition_entry_id
      and entry.status = 'publicada'
      and entry.entry_date = recognition_date
  ) then
    raise exception using
      errcode = '22023',
      message = 'La obligacion ya no esta reconocida de forma valida.';
  end if;

  select count(*)
  into v1_event_count
  from public.financial_events event
  where event.source_type = 'supplier_payment'
    and event.source_id = payment.id::text
    and event.event_purpose = 'supplier_payment'
    and event.posting_version = 'v1';

  select event.id into v1_event_id
  from public.financial_events event
  where event.source_type = 'supplier_payment'
    and event.source_id = payment.id::text
    and event.event_purpose = 'supplier_payment'
    and event.posting_version = 'v1'
  order by event.created_at, event.id
  limit 1;

  select count(*) into v2_event_count
  from public.financial_events event
  where event.source_type = 'supplier_payment'
    and event.source_id = payment.id::text
    and event.event_purpose = 'supplier_payment'
    and event.posting_version = 'v2';

  select count(*) into v1_outbox_count
  from public.accounting_outbox box
  where box.source_type = 'supplier_payment'
    and box.source_id = payment.id;

  select count(*) into v2_outbox_count
  from public.accounting_outbox_v2 box
  where box.source_type = 'supplier_payment'
    and box.source_id = payment.id
    and box.event_purpose = 'supplier_payment';

  select count(*) into conflicting_journal_count
  from public.journal_entries entry
  where (
      entry.source_type = 'supplier_payment'
      and entry.source_id = payment.id::text
    )
    or entry.metadata->>'payment_id' = payment.id::text
    or exists (
      select 1
      from public.financial_events event
      where event.source_type = 'supplier_payment'
        and event.source_id = payment.id::text
        and entry.source_type = 'financial_event'
        and entry.source_id = event.id::text
    );

  if v1_event_count > 1
    or v2_event_count <> 0
    or v1_outbox_count <> 0
    or v2_outbox_count <> 0
    or conflicting_journal_count <> 0
    or exists (
      select 1
      from public.financial_events event
      where event.id = v1_event_id
        and (
          event.journal_entry_id is not null
          or event.status in ('draft_created', 'posted', 'reversed')
        )
    )
  then
    raise exception using
      errcode = '23505',
      message = 'Ya existe un efecto contable equivalente para este pago.';
  end if;

  safe_result := jsonb_build_object(
    'ok', true,
    'payment_id', payment.id,
    'payment_reference', assessment->>'payment_reference',
    'supplier_reference', assessment->>'supplier_reference',
    'amount', round(payment.amount, 2),
    'effective_paid_at', payment.paid_at,
    'recorded_at', payment.created_at,
    'accounting_occurred_at', routing_at,
    'proposed_journal_date', journal_date,
    'classification', classification_value,
    'routing_origin', 'late_recorded_supplier_payment',
    'preview_lines', assessment->'preview_lines',
    'total_debit', round(payment.amount, 2),
    'total_credit', round(payment.amount, 2),
    'balanced', true,
    'manual_publication_required', true,
    'idempotent_replay', false
  );

  insert into public.supplier_payment_accounting_repairs (
    payment_id, request_key, expected_fingerprint, reason,
    classification, status, routing_origin,
    covered_financial_event_v1_id, created_by, result
  )
  values (
    payment.id, clean_request_key, clean_fingerprint, clean_reason,
    classification_value, 'processing', 'late_recorded_supplier_payment',
    v1_event_id, actor_id, safe_result
  )
  returning id into repair_id_value;

  outbox_id_value := public.route_supplier_payment_accounting_v2(
    payment.id,
    actor_id
  );

  if outbox_id_value is null then
    raise exception using
      errcode = '22023',
      message = 'El router no pudo crear la outbox contable validada.';
  end if;

  safe_result := safe_result || jsonb_build_object(
    'repair_id', repair_id_value,
    'status', 'queued',
    'outbox_id', outbox_id_value,
    'outbox_created', true,
    'covered_financial_event_v1_id', v1_event_id
  );

  update public.supplier_payment_accounting_repairs
  set status = 'queued',
      outbox_id = outbox_id_value,
      result = safe_result
  where id = repair_id_value;

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id,
    source_type, source_id, metadata, created_by
  )
  values (
    'supplier_payment_late_recorded_repair_queued',
    'supplier_payment_accounting_repairs', repair_id_value,
    'supplier_payment', payment.id::text,
    jsonb_build_object(
      'payment_id', payment.id,
      'repair_id', repair_id_value,
      'outbox_id', outbox_id_value,
      'covered_financial_event_v1_id', v1_event_id,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_occurred_at', routing_at,
      'proposed_journal_date', journal_date,
      'routing_origin', 'late_recorded_supplier_payment',
      'manual_publication_required', true
    ),
    actor_id
  );

  return safe_result;
end;
$$;

revoke all on function public.repair_late_recorded_supplier_payment_draft_v1(
  text, uuid, text, text
) from public, anon;
grant execute on function public.repair_late_recorded_supplier_payment_draft_v1(
  text, uuid, text, text
) to authenticated;

comment on function public.repair_late_recorded_supplier_payment_draft_v1(
  text, uuid, text, text
) is
  'Technical-owner-only, row-locked and idempotent recovery. Derives every economic value from canonical records and creates only the missing V2 outbox; the canonical worker creates a manual-review draft.';
