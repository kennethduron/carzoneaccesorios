-- General supplier-payment accounting for payables recognized through a
-- protected aggregate opening-balance control entry.
--
-- This migration never changes supplier payments, payables, balances, paid_at,
-- cutover, mappings, commercial state, inventory, or existing journal entries.
-- It only registers immutable recognition evidence and routes validated
-- payments through the existing V2 outbox/manual-publication worker.

create table if not exists public.accounting_opening_balance_batches (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null
    references public.journal_entries(id) on delete restrict,
  control_line_id uuid not null
    references public.journal_entry_lines(id) on delete restrict,
  control_account_id uuid not null
    references public.accounting_accounts(id) on delete restrict,
  batch_key text not null,
  auxiliary_scope text not null
    default 'unlinked_payables_before_opening_entry_v1',
  payables_created_before timestamptz not null,
  protected_count integer not null check (protected_count > 0),
  protected_supplier_count integer not null
    check (protected_supplier_count > 0),
  protected_total numeric(14, 2) not null check (protected_total > 0),
  protected_hash text not null check (protected_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'disabled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (journal_entry_id),
  unique (control_line_id),
  unique (batch_key)
);

alter table public.accounting_opening_balance_batches enable row level security;

revoke all on table public.accounting_opening_balance_batches
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.accounting_opening_balance_batches to service_role;

comment on table public.accounting_opening_balance_batches is
  'Protected accounting evidence for aggregate opening-balance control entries. Read only through security-definer recognition contracts.';

-- Register the approved production batch only when its exact journal exists.
-- A mismatch aborts migration application instead of weakening the contract.
do $$
declare
  opening_entry public.journal_entries%rowtype;
  control_line public.journal_entry_lines%rowtype;
  control_account public.accounting_accounts%rowtype;
  entry_count integer;
  line_count integer;
  auxiliary_count integer;
  auxiliary_supplier_count integer;
  auxiliary_total numeric(14, 2);
  auxiliary_hash text;
  expected_count constant integer := 26;
  expected_supplier_count constant integer := 8;
  expected_total constant numeric(14, 2) := 1589972.61;
  expected_hash constant text :=
    '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd';
begin
  select count(*) into entry_count
  from public.journal_entries
  where entry_number = 'PC-20260714-621782';

  if entry_count = 0 then
    return;
  end if;
  if entry_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La partida protegida de saldo inicial no es inequivoca.';
  end if;

  select * into strict opening_entry
  from public.journal_entries
  where entry_number = 'PC-20260714-621782';

  if opening_entry.entry_date <> date '2026-07-11'
    or opening_entry.description <> 'BALANCE INICIAL DE ZAFRA'
    or opening_entry.status <> 'publicada'
    or opening_entry.posted_at is null
    or opening_entry.posted_by is null
    or opening_entry.reversed_entry_id is not null
    or exists (
      select 1
      from public.journal_entries reversal
      where reversal.source_type = 'journal_reversal'
        and reversal.source_id = opening_entry.id::text
    )
  then
    raise exception using
      errcode = '22023',
      message = 'La partida protegida de saldo inicial cambio o no esta publicada.';
  end if;

  select * into strict control_account
  from public.accounting_accounts
  where code = '2101001'
    and name = 'PROVEEDORES LOCALES';

  select count(*) into line_count
  from public.journal_entry_lines line
  where line.journal_entry_id = opening_entry.id
    and line.account_id = control_account.id;

  if line_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La partida protegida no tiene una unica linea control de CxP.';
  end if;

  select * into strict control_line
  from public.journal_entry_lines line
  where line.journal_entry_id = opening_entry.id
    and line.account_id = control_account.id;

  if control_account.type <> 'liability'
    or control_account.normal_balance <> 'credit'
    or not control_account.is_active
    or round(control_line.debit, 2) <> 0.00
    or round(control_line.credit, 2) <> expected_total
  then
    raise exception using
      errcode = '22023',
      message = 'La linea control protegida de CxP no coincide.';
  end if;

  select
    count(*),
    count(distinct payable.supplier_id),
    round(coalesce(sum(payable.total_amount), 0), 2),
    encode(
      extensions.digest(
        convert_to(
          string_agg(payable.id::text, ',' order by payable.id),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  into
    auxiliary_count,
    auxiliary_supplier_count,
    auxiliary_total,
    auxiliary_hash
  from public.accounts_payable payable
  where payable.purchase_id is null
    and payable.supplier_invoice_id is null
    and payable.imported_from_batch_id is null
    and payable.imported_from_row_id is null
    and payable.created_at < opening_entry.created_at;

  if auxiliary_count <> expected_count
    or auxiliary_supplier_count <> expected_supplier_count
    or auxiliary_total <> expected_total
    or auxiliary_hash <> expected_hash
    or round(control_line.credit - control_line.debit - auxiliary_total, 2)
      <> 0.00
  then
    raise exception using
      errcode = '22023',
      message = 'El lote auxiliar protegido no concilia con la partida inicial.';
  end if;

  insert into public.accounting_opening_balance_batches (
    journal_entry_id,
    control_line_id,
    control_account_id,
    batch_key,
    auxiliary_scope,
    payables_created_before,
    protected_count,
    protected_supplier_count,
    protected_total,
    protected_hash,
    status,
    metadata
  )
  values (
    opening_entry.id,
    control_line.id,
    control_account.id,
    'opening-balance:PC-20260714-621782:payables',
    'unlinked_payables_before_opening_entry_v1',
    opening_entry.created_at,
    expected_count,
    expected_supplier_count,
    expected_total,
    expected_hash,
    'active',
    jsonb_build_object(
      'entry_number', opening_entry.entry_number,
      'entry_date', opening_entry.entry_date,
      'control_account_code', control_account.code,
      'manual_publication_required', true
    )
  )
  on conflict (batch_key) do nothing;
end;
$$;

create or replace function public.resolve_accounts_payable_accounting_recognition_v1(
  p_accounts_payable_id uuid,
  p_proposed_journal_date date,
  p_payment_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  payable public.accounts_payable%rowtype;
  direct_event public.financial_events%rowtype;
  direct_entry public.journal_entries%rowtype;
  direct_count integer := 0;
  direct_candidate_count integer := 0;
  batch public.accounting_opening_balance_batches%rowtype;
  opening_entry public.journal_entries%rowtype;
  control_line public.journal_entry_lines%rowtype;
  control_account public.accounting_accounts%rowtype;
  batch_count integer := 0;
  entry_count integer := 0;
  control_line_count integer := 0;
  auxiliary_count integer := 0;
  auxiliary_supplier_count integer := 0;
  auxiliary_total numeric(14, 2) := 0;
  auxiliary_hash text;
  payment_journal_count integer := 0;
  reason_value text := 'accounts_payable_recognition_missing';
begin
  select * into payable
  from public.accounts_payable
  where id = p_accounts_payable_id;

  if payable.id is null then
    return jsonb_build_object(
      'recognized', false,
      'recognition_origin', null,
      'journal_entry_id', null,
      'journal_entry_number', null,
      'journal_date', null,
      'control_account_id', null,
      'opening_balance_batch_id', null,
      'protected_count', null,
      'protected_total', null,
      'protected_hash', null,
      'reason_code', 'accounts_payable_missing'
    );
  end if;

  if p_payment_id is not null then
    select count(*) into payment_journal_count
    from public.journal_entries entry
    where (
        entry.source_type = 'supplier_payment'
        and entry.source_id = p_payment_id::text
      )
      or entry.metadata->>'payment_id' = p_payment_id::text
      or exists (
        select 1
        from public.financial_events event
        where event.source_type = 'supplier_payment'
          and event.source_id = p_payment_id::text
          and entry.source_type = 'financial_event'
          and entry.source_id = event.id::text
      );
  end if;

  select count(*) into direct_candidate_count
  from public.financial_events event
  where event.source_type = 'accounts_payable'
    and event.source_id = payable.id::text
    and event.event_purpose = 'accounts_payable_created';

  select count(*) into direct_count
  from public.financial_events event
  join public.journal_entries entry
    on entry.id = event.journal_entry_id
  where event.source_type = 'accounts_payable'
    and event.source_id = payable.id::text
    and event.event_purpose = 'accounts_payable_created'
    and event.status = 'posted'
    and entry.status = 'publicada'
    and entry.reversed_entry_id is null
    and not exists (
      select 1
      from public.journal_entries reversal
      where reversal.source_type = 'journal_reversal'
        and reversal.source_id = entry.id::text
    );

  if direct_candidate_count <> direct_count then
    return jsonb_build_object(
      'recognized', false,
      'recognition_origin', 'direct_event',
      'journal_entry_id', null,
      'journal_entry_number', null,
      'journal_date', null,
      'control_account_id', null,
      'opening_balance_batch_id', null,
      'protected_count', null,
      'protected_total', null,
      'protected_hash', null,
      'reason_code',
        'accounts_payable_individual_recognition_incompatible'
    );
  end if;

  if direct_count > 1 then
    return jsonb_build_object(
      'recognized', false,
      'recognition_origin', 'direct_event',
      'journal_entry_id', null,
      'journal_entry_number', null,
      'journal_date', null,
      'control_account_id', null,
      'opening_balance_batch_id', null,
      'protected_count', null,
      'protected_total', null,
      'protected_hash', null,
      'reason_code', 'accounts_payable_recognition_ambiguous'
    );
  end if;

  if direct_count = 1 then
    select event.* into strict direct_event
    from public.financial_events event
    join public.journal_entries entry
      on entry.id = event.journal_entry_id
    where event.source_type = 'accounts_payable'
      and event.source_id = payable.id::text
      and event.event_purpose = 'accounts_payable_created'
      and event.status = 'posted'
      and entry.status = 'publicada'
      and entry.reversed_entry_id is null
      and not exists (
        select 1
        from public.journal_entries reversal
        where reversal.source_type = 'journal_reversal'
          and reversal.source_id = entry.id::text
      );

    select * into strict direct_entry
    from public.journal_entries
    where id = direct_event.journal_entry_id;

    reason_value := case
      when payment_journal_count > 0
        then 'supplier_payment_existing_journal'
      when p_proposed_journal_date is null
        then 'proposed_journal_date_missing'
      when direct_entry.entry_date > p_proposed_journal_date
        then 'payment_date_before_payable_recognition'
      else 'accounts_payable_recognized_direct_event'
    end;

    return jsonb_build_object(
      'recognized',
        reason_value = 'accounts_payable_recognized_direct_event',
      'recognition_origin', 'direct_event',
      'recognition_event_id', direct_event.id,
      'journal_entry_id', direct_entry.id,
      'journal_entry_number', direct_entry.entry_number,
      'journal_date', direct_entry.entry_date,
      'control_account_id', null,
      'opening_balance_batch_id', null,
      'protected_count', null,
      'protected_total', null,
      'protected_hash', null,
      'reason_code', reason_value
    );
  end if;

  select count(*) into batch_count
  from public.accounting_opening_balance_batches candidate
  where candidate.status = 'active'
    and candidate.auxiliary_scope =
      'unlinked_payables_before_opening_entry_v1'
    and payable.purchase_id is null
    and payable.supplier_invoice_id is null
    and payable.imported_from_batch_id is null
    and payable.imported_from_row_id is null
    and payable.created_at < candidate.payables_created_before;

  if batch_count = 0 then
    return jsonb_build_object(
      'recognized', false,
      'recognition_origin', null,
      'journal_entry_id', null,
      'journal_entry_number', null,
      'journal_date', null,
      'control_account_id', null,
      'opening_balance_batch_id', null,
      'protected_count', null,
      'protected_total', null,
      'protected_hash', null,
      'reason_code', 'accounts_payable_recognition_missing'
    );
  end if;

  if batch_count > 1 then
    return jsonb_build_object(
      'recognized', false,
      'recognition_origin', 'opening_balance_control',
      'journal_entry_id', null,
      'journal_entry_number', null,
      'journal_date', null,
      'control_account_id', null,
      'opening_balance_batch_id', null,
      'protected_count', null,
      'protected_total', null,
      'protected_hash', null,
      'reason_code', 'opening_balance_batch_ambiguous'
    );
  end if;

  select * into strict batch
  from public.accounting_opening_balance_batches candidate
  where candidate.status = 'active'
    and candidate.auxiliary_scope =
      'unlinked_payables_before_opening_entry_v1'
    and payable.purchase_id is null
    and payable.supplier_invoice_id is null
    and payable.imported_from_batch_id is null
    and payable.imported_from_row_id is null
    and payable.created_at < candidate.payables_created_before;

  select count(*) into entry_count
  from public.journal_entries entry
  where entry.id = batch.journal_entry_id;

  if entry_count = 1 then
    select * into opening_entry
    from public.journal_entries
    where id = batch.journal_entry_id;
  end if;

  select * into control_account
  from public.accounting_accounts
  where id = batch.control_account_id;

  select * into control_line
  from public.journal_entry_lines
  where id = batch.control_line_id;

  if opening_entry.id is not null then
    select count(*) into control_line_count
    from public.journal_entry_lines line
    where line.journal_entry_id = opening_entry.id
      and line.account_id = batch.control_account_id;
  end if;

  select
    count(*),
    count(distinct candidate.supplier_id),
    round(coalesce(sum(candidate.total_amount), 0), 2),
    encode(
      extensions.digest(
        convert_to(
          string_agg(candidate.id::text, ',' order by candidate.id),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
  into
    auxiliary_count,
    auxiliary_supplier_count,
    auxiliary_total,
    auxiliary_hash
  from public.accounts_payable candidate
  where candidate.purchase_id is null
    and candidate.supplier_invoice_id is null
    and candidate.imported_from_batch_id is null
    and candidate.imported_from_row_id is null
    and candidate.created_at < batch.payables_created_before;

  reason_value := case
    when entry_count <> 1
      then 'opening_balance_entry_missing'
    when opening_entry.status <> 'publicada'
      or opening_entry.posted_at is null
      or opening_entry.posted_by is null
      then 'opening_balance_entry_not_posted'
    when opening_entry.reversed_entry_id is not null
      or exists (
        select 1
        from public.journal_entries reversal
        where reversal.source_type = 'journal_reversal'
          and reversal.source_id = opening_entry.id::text
      )
      then 'opening_balance_entry_reversed'
    when p_proposed_journal_date is null
      then 'proposed_journal_date_missing'
    when opening_entry.entry_date > p_proposed_journal_date
      then 'payment_date_before_payable_recognition'
    when control_account.id is null
      or control_account.code <> '2101001'
      or control_account.name <> 'PROVEEDORES LOCALES'
      or control_account.type <> 'liability'
      or control_account.normal_balance <> 'credit'
      or not coalesce(control_account.is_active, false)
      then 'opening_balance_control_account_invalid'
    when control_line_count <> 1
      then 'opening_balance_control_line_ambiguous'
    when control_line.id is null
      or control_line.journal_entry_id <> opening_entry.id
      or control_line.account_id <> control_account.id
      or round(control_line.debit, 2) <> 0.00
      or round(control_line.credit, 2) <> batch.protected_total
      then 'opening_balance_control_total_mismatch'
    when auxiliary_count <> batch.protected_count
      then 'opening_balance_auxiliary_count_mismatch'
    when auxiliary_supplier_count <> batch.protected_supplier_count
      then 'opening_balance_supplier_count_mismatch'
    when auxiliary_total <> batch.protected_total
      or round(
        control_line.credit - control_line.debit - auxiliary_total,
        2
      ) <> 0.00
      then 'opening_balance_auxiliary_total_mismatch'
    when auxiliary_hash is distinct from batch.protected_hash
      then 'opening_balance_auxiliary_hash_mismatch'
    when payable.purchase_id is not null
      or payable.supplier_invoice_id is not null
      or payable.imported_from_batch_id is not null
      or payable.imported_from_row_id is not null
      or payable.created_at >= batch.payables_created_before
      then 'accounts_payable_not_in_opening_balance_batch'
    when payment_journal_count > 0
      then 'supplier_payment_existing_journal'
    else 'accounts_payable_recognized_opening_balance_control'
  end;

  return jsonb_build_object(
    'recognized',
      reason_value = 'accounts_payable_recognized_opening_balance_control',
    'recognition_origin', 'opening_balance_control',
    'recognition_event_id', null,
    'journal_entry_id', opening_entry.id,
    'journal_entry_number', opening_entry.entry_number,
    'journal_date', opening_entry.entry_date,
    'control_account_id', control_account.id,
    'opening_balance_batch_id', batch.id,
    'protected_count', batch.protected_count,
    'protected_total', batch.protected_total,
    'protected_hash', batch.protected_hash,
    'reason_code', reason_value
  );
end;
$$;

revoke all on function
  public.resolve_accounts_payable_accounting_recognition_v1(uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function
  public.resolve_accounts_payable_accounting_recognition_v1(uuid, date, uuid)
  to service_role;

comment on function
  public.resolve_accounts_payable_accounting_recognition_v1(uuid, date, uuid)
is
  'Read-only canonical recognition resolver. Accepts exactly one published direct event or one fully reconciled protected opening-balance control batch.';

alter function public.supplier_payment_accounting_assessment_v1(uuid)
  rename to supplier_payment_accounting_assessment_v014;

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
  legacy jsonb;
  recognition jsonb;
  result_value jsonb;
  proposed_date date;
  classification_value text;
  reason_value text;
  fingerprint_payload jsonb;
  fingerprint_value text;
begin
  legacy := public.supplier_payment_accounting_assessment_v014(p_payment_id);
  proposed_date := nullif(legacy->>'proposed_journal_date', '')::date;

  recognition :=
    public.resolve_accounts_payable_accounting_recognition_v1(
      nullif(legacy->>'accounts_payable_id', '')::uuid,
      proposed_date,
      p_payment_id
    );

  classification_value := legacy->>'classification';
  reason_value := legacy->>'classification_reason';

  if recognition->>'recognition_origin' = 'opening_balance_control'
    and coalesce((recognition->>'recognized')::boolean, false)
    and classification_value = 'review_required'
    and reason_value = 'accounts_payable_recognition_missing'
  then
    if public.is_date_in_closed_accounting_period(proposed_date) then
      classification_value := 'review_required';
      reason_value := 'proposed_accounting_period_closed';
    elsif legacy->>'routing_origin' = 'late_recorded_supplier_payment' then
      classification_value := 'eligible_late_recorded';
      reason_value := 'late_recorded_supplier_payment';
    else
      classification_value := 'modern_missing_outbox';
      reason_value := 'modern_supplier_payment_missing_outbox';
    end if;
  elsif recognition->>'recognition_origin'
      in ('opening_balance_control', 'direct_event')
    and not coalesce((recognition->>'recognized')::boolean, false)
    and classification_value = 'review_required'
    and reason_value = 'accounts_payable_recognition_missing'
  then
    reason_value := recognition->>'reason_code';
    if reason_value = 'payment_date_before_payable_recognition' then
      classification_value := 'chronology_conflict';
    end if;
  end if;

  result_value := legacy || jsonb_build_object(
    'classification', classification_value,
    'classification_reason', reason_value,
    'recognition_origin', recognition->>'recognition_origin',
    'recognition_validation', recognition,
    'opening_balance_recognition', case
      when recognition->>'recognition_origin' = 'opening_balance_control'
        then recognition
      else null
    end,
    'payable_recognition', case
      when coalesce((recognition->>'recognized')::boolean, false)
        then jsonb_build_object(
          'event_id', recognition->>'recognition_event_id',
          'journal_entry_id', recognition->>'journal_entry_id',
          'entry_number', recognition->>'journal_entry_number',
          'entry_date', recognition->>'journal_date',
          'status', 'publicada',
          'recognition_origin', recognition->>'recognition_origin'
        )
      else legacy->'payable_recognition'
    end
  );

  fingerprint_payload := (result_value - 'expected_fingerprint')
    || jsonb_build_object(
      'recognition_contract_version',
        'accounts_payable_recognition_v1'
    );
  fingerprint_value := encode(
    extensions.digest(
      convert_to(fingerprint_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  return result_value || jsonb_build_object(
    'expected_fingerprint', fingerprint_value
  );
end;
$$;

revoke all on function public.supplier_payment_accounting_assessment_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_accounting_assessment_v1(uuid)
  to service_role;

alter function public.route_supplier_payment_accounting_v2(uuid, uuid)
  rename to route_supplier_payment_accounting_v014;

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
  recognition jsonb;
  routing_at timestamptz;
  journal_date date;
  payable_account_id uuid;
  payment_account_id uuid;
  mapping_key text;
  existing_box_id uuid;
  result_id uuid;
  actor_id uuid;
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

  -- Preserve every 014 path that is not a late-recorded payment.
  if routing_at is null
    or not (
      payment.paid_at < flag.cutover_at
      and payment.created_at >= flag.cutover_at
    )
  then
    return public.route_supplier_payment_accounting_v014(
      p_payment_id,
      p_actor_id
    );
  end if;

  journal_date :=
    (routing_at at time zone 'America/Tegucigalpa')::date;
  recognition :=
    public.resolve_accounts_payable_accounting_recognition_v1(
      payment.accounts_payable_id,
      journal_date,
      payment.id
    );

  -- The direct-event contract remains byte-for-byte delegated to 014.
  if recognition->>'recognition_origin' is distinct from
    'opening_balance_control'
  then
    return public.route_supplier_payment_accounting_v014(
      p_payment_id,
      p_actor_id
    );
  end if;

  actor_id := coalesce(p_actor_id, payment.created_by, auth.uid());

  if not coalesce((recognition->>'recognized')::boolean, false) then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      'supplier_payment_opening_balance_validation_failed',
      'supplier_payments', payment.id,
      'supplier_payment', payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'recognition_origin', 'opening_balance_control',
        'reason', recognition->>'reason_code',
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'accounting_occurred_at', routing_at,
        'proposed_journal_date', journal_date,
        'manual_review_required', true
      ),
      actor_id
    );
    return null;
  end if;

  if public.is_date_in_closed_accounting_period(journal_date) then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      'supplier_payment_opening_balance_validation_failed',
      'supplier_payments', payment.id,
      'supplier_payment', payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'recognition_origin', 'opening_balance_control',
        'reason', 'proposed_accounting_period_closed',
        'proposed_journal_date', journal_date,
        'manual_review_required', true
      ),
      actor_id
    );
    return null;
  end if;

  mapping_key := case payment.payment_method_v2
    when 'cash' then 'supplier_payment_cash'
    when 'bank_transfer' then 'supplier_payment_bank'
    when 'card_credit' then 'supplier_payment_card'
    when 'card_debit' then 'supplier_payment_bank'
    else null
  end;
  payable_account_id := public.resolve_accounting_mapping_v2(
    'default_account',
    'accounts_payable',
    journal_date
  );
  payment_account_id := case when mapping_key is null then null else
    public.resolve_accounting_mapping_v2(
      'payment_method',
      mapping_key,
      journal_date
    )
  end;

  if payable_account_id is null or payment_account_id is null then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      'supplier_payment_opening_balance_validation_failed',
      'supplier_payments', payment.id,
      'supplier_payment', payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'recognition_origin', 'opening_balance_control',
        'reason', 'supplier_payment_mapping_missing',
        'missing_mapping_key', mapping_key,
        'proposed_journal_date', journal_date,
        'manual_review_required', true
      ),
      actor_id
    );
    return null;
  end if;

  select box.id into existing_box_id
  from public.accounting_outbox_v2 box
  where box.source_type = 'supplier_payment'
    and box.source_id = payment.id
    and box.event_purpose = 'supplier_payment'
    and box.posting_version = 'v2';

  if existing_box_id is null then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      'supplier_payment_opening_balance_recognized',
      'journal_entries',
      nullif(recognition->>'journal_entry_id', '')::uuid,
      'supplier_payment',
      payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'recognition_origin', 'opening_balance_control',
        'opening_balance_entry_id',
          nullif(recognition->>'journal_entry_id', '')::uuid,
        'opening_balance_batch_id',
          nullif(recognition->>'opening_balance_batch_id', '')::uuid,
        'protected_count', (recognition->>'protected_count')::integer,
        'protected_total', (recognition->>'protected_total')::numeric,
        'protected_hash', recognition->>'protected_hash',
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'accounting_occurred_at', routing_at,
        'routing_origin', 'late_recorded_supplier_payment',
        'manual_publication_required', true
      ),
      actor_id
    );
  end if;

  result_id := public.route_accounting_fact_v2(
    'supplier_payment_draft_v2',
    'payables.supplier_payment',
    'supplier_payment',
    payment.id,
    'supplier_payment',
    coalesce(payment.payment_method_v2, 'legacy_method_pending_data'),
    routing_at,
    actor_id
  );

  if result_id is null then
    return null;
  end if;

  update public.accounting_outbox_v2
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'source_type', 'supplier_payment',
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'accounting_occurred_at', routing_at,
        'journal_date', journal_date,
        'routing_origin', 'late_recorded_supplier_payment',
        'recognition_origin', 'opening_balance_control',
        'opening_balance_entry_id',
          nullif(recognition->>'journal_entry_id', '')::uuid,
        'opening_balance_batch_id',
          nullif(recognition->>'opening_balance_batch_id', '')::uuid,
        'protected_count', (recognition->>'protected_count')::integer,
        'protected_total', (recognition->>'protected_total')::numeric,
        'protected_hash', recognition->>'protected_hash',
        'cutover_applied', true,
        'manual_publication_required', true
      )
  where id = result_id;

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id,
    source_type, source_id, metadata, created_by
  )
  values (
    'supplier_payment_opening_balance_routed',
    'accounting_outbox_v2', result_id,
    'supplier_payment', payment.id::text,
    jsonb_build_object(
      'payment_id', payment.id,
      'accounts_payable_id', payment.accounts_payable_id,
      'outbox_id', result_id,
      'recognition_origin', 'opening_balance_control',
      'opening_balance_entry_id',
        nullif(recognition->>'journal_entry_id', '')::uuid,
      'opening_balance_batch_id',
        nullif(recognition->>'opening_balance_batch_id', '')::uuid,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_occurred_at', routing_at,
      'journal_date', journal_date,
      'routing_origin', 'late_recorded_supplier_payment',
      'duplicate_avoided', existing_box_id is not null,
      'manual_publication_required', true
    ),
    actor_id
  );

  return result_id;
end;
$$;

revoke all on function public.route_supplier_payment_accounting_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.route_supplier_payment_accounting_v2(uuid, uuid)
  to service_role;


-- Keep the canonical V2 worker unchanged. These narrow enrichers carry the
-- protected recognition evidence from the outbox into its event and draft.
create or replace function
  public.enrich_opening_balance_supplier_payment_event_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  box public.accounting_outbox_v2%rowtype;
begin
  if new.source_type <> 'supplier_payment'
    or new.event_purpose <> 'supplier_payment'
    or new.posting_version <> 'v2'
  then
    return new;
  end if;

  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id::text = new.source_id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';

  if box.id is null
    or box.metadata->>'recognition_origin'
      is distinct from 'opening_balance_control'
  then
    return new;
  end if;

  new.source_snapshot := coalesce(new.source_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'recognition_origin', 'opening_balance_control',
      'opening_balance_entry_id',
        box.metadata->>'opening_balance_entry_id',
      'opening_balance_batch_id',
        box.metadata->>'opening_balance_batch_id',
      'protected_count',
        (box.metadata->>'protected_count')::integer,
      'protected_total',
        (box.metadata->>'protected_total')::numeric,
      'protected_hash', box.metadata->>'protected_hash',
      'effective_paid_at', box.metadata->>'effective_paid_at',
      'recorded_at', box.metadata->>'recorded_at',
      'accounting_occurred_at',
        box.metadata->>'accounting_occurred_at',
      'payment_id', box.source_id,
      'accounts_payable_id',
        box.metadata->>'accounts_payable_id',
      'routing_origin', 'late_recorded_supplier_payment',
      'manual_publication_required', true
    );

  return new;
end;
$$;

revoke all on function
  public.enrich_opening_balance_supplier_payment_event_v2()
  from public, anon, authenticated;

drop trigger if exists
  financial_events_enrich_opening_balance_supplier_payment_v2
  on public.financial_events;
create trigger
  financial_events_enrich_opening_balance_supplier_payment_v2
before insert or update of source_snapshot on public.financial_events
for each row execute function
  public.enrich_opening_balance_supplier_payment_event_v2();

create or replace function
  public.enrich_opening_balance_supplier_payment_journal_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event public.financial_events%rowtype;
  box public.accounting_outbox_v2%rowtype;
begin
  if new.source_type <> 'financial_event' then
    return new;
  end if;

  select * into event
  from public.financial_events candidate
  where candidate.id = new.source_id::uuid
    and candidate.source_type = 'supplier_payment'
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';

  if event.id is null then
    return new;
  end if;

  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id::text = event.source_id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';

  if box.id is null
    or box.metadata->>'recognition_origin'
      is distinct from 'opening_balance_control'
  then
    return new;
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'recognition_origin', 'opening_balance_control',
      'opening_balance_entry_id',
        box.metadata->>'opening_balance_entry_id',
      'opening_balance_batch_id',
        box.metadata->>'opening_balance_batch_id',
      'protected_count',
        (box.metadata->>'protected_count')::integer,
      'protected_total',
        (box.metadata->>'protected_total')::numeric,
      'protected_hash', box.metadata->>'protected_hash',
      'effective_paid_at', box.metadata->>'effective_paid_at',
      'recorded_at', box.metadata->>'recorded_at',
      'accounting_occurred_at',
        box.metadata->>'accounting_occurred_at',
      'payment_id', box.source_id,
      'accounts_payable_id',
        box.metadata->>'accounts_payable_id',
      'routing_origin', 'late_recorded_supplier_payment',
      'manual_publication_required', true
    );

  return new;
end;
$$;

revoke all on function
  public.enrich_opening_balance_supplier_payment_journal_v2()
  from public, anon, authenticated;

drop trigger if exists
  journal_entries_enrich_opening_balance_supplier_payment_v2
  on public.journal_entries;
create trigger
  journal_entries_enrich_opening_balance_supplier_payment_v2
before insert on public.journal_entries
for each row execute function
  public.enrich_opening_balance_supplier_payment_journal_v2();

alter function
  public.repair_late_recorded_supplier_payment_draft_v1(
    text, uuid, text, text
  )
  rename to repair_late_recorded_supplier_payment_draft_v014;

create or replace function
  public.repair_late_recorded_supplier_payment_draft_v1(
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
  clean_request_key text := nullif(
    left(btrim(coalesce(p_request_key, '')), 200), ''
  );
  clean_fingerprint text :=
    lower(btrim(coalesce(p_expected_fingerprint, '')));
  clean_reason text := nullif(
    left(
      regexp_replace(
        btrim(coalesce(p_reason, '')),
        E'[\\n\\r\\t]+',
        ' ',
        'g'
      ),
      500
    ),
    ''
  );
  payment public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  supplier public.suppliers%rowtype;
  flag public.accounting_feature_flags%rowtype;
  batch public.accounting_opening_balance_batches%rowtype;
  existing_repair public.supplier_payment_accounting_repairs%rowtype;
  assessment jsonb;
  recognition jsonb;
  refreshed_recognition jsonb;
  classification_value text;
  routing_at timestamptz;
  journal_date date;
  payable_account_id uuid;
  payment_account_id uuid;
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
    or public.current_actor_role() <> 'technical_owner'
    or not public.has_permission(
      'accounting:repair_supplier_payment'
    )
  then
    raise exception using
      errcode = '42501',
      message =
        'Solo technical_owner puede reparar pagos a proveedores.';
  end if;

  if clean_request_key is null
    or char_length(clean_request_key) < 8
  then
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
  if clean_reason is null
    or char_length(clean_reason) < 8
    or clean_reason ~* '@|[0-9]{8,}'
  then
    raise exception using
      errcode = '22023',
      message =
        'Indica un motivo operativo sin datos sensibles.';
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
      or existing_repair.expected_fingerprint
        <> clean_fingerprint
    then
      raise exception using
        errcode = '23505',
        message =
          'La clave de solicitud ya pertenece a otro contenido.';
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

  assessment :=
    public.supplier_payment_accounting_assessment_v1(p_payment_id);
  recognition := assessment->'recognition_validation';

  -- Preserve the 014 implementation for individual direct-event recognition.
  if recognition->>'recognition_origin'
    is distinct from 'opening_balance_control'
  then
    return public.repair_late_recorded_supplier_payment_draft_v014(
      clean_request_key,
      p_payment_id,
      clean_fingerprint,
      clean_reason
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

  select * into batch
  from public.accounting_opening_balance_batches candidate
  where candidate.id =
    nullif(
      recognition->>'opening_balance_batch_id',
      ''
    )::uuid
  for share;

  perform 1
  from public.journal_entries entry
  where entry.id = batch.journal_entry_id
  for share;

  perform 1
  from public.journal_entry_lines line
  where line.journal_entry_id = batch.journal_entry_id
  for share;

  perform 1
  from public.accounts_payable candidate
  where candidate.purchase_id is null
    and candidate.supplier_invoice_id is null
    and candidate.imported_from_batch_id is null
    and candidate.imported_from_row_id is null
    and candidate.created_at < batch.payables_created_before
  for share;

  assessment :=
    public.supplier_payment_accounting_assessment_v1(payment.id);
  recognition := assessment->'recognition_validation';
  classification_value := assessment->>'classification';

  if assessment->>'expected_fingerprint'
    is distinct from clean_fingerprint
  then
    raise exception using
      errcode = '40001',
      message =
        'Los datos cambiaron desde la vista previa. Actualiza y revisa nuevamente.';
  end if;

  if classification_value <> 'eligible_late_recorded'
    or recognition->>'recognition_origin'
      is distinct from 'opening_balance_control'
    or not coalesce(
      (recognition->>'recognized')::boolean,
      false
    )
  then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      'supplier_payment_opening_balance_validation_failed',
      'supplier_payments', payment.id,
      'supplier_payment', payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'recognition_origin', 'opening_balance_control',
        'classification', classification_value,
        'reason', recognition->>'reason_code',
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'proposed_journal_date',
          assessment->>'proposed_journal_date',
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
  journal_date :=
    (routing_at at time zone 'America/Tegucigalpa')::date;
  payable_account_id := nullif(
    assessment->'mapping'->>'payable_account_id',
    ''
  )::uuid;
  payment_account_id := nullif(
    assessment->'mapping'->>'payment_account_id',
    ''
  )::uuid;
  refreshed_recognition :=
    public.resolve_accounts_payable_accounting_recognition_v1(
      payable.id,
      journal_date,
      payment.id
    );

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
    or lower(btrim(payment.payment_method))
      <> payment.payment_method_v2
    or flag.key is null
    or flag.state = 'disabled'
    or flag.cutover_at is null
    or payment.created_at < flag.cutover_at
    or payment.paid_at is null
    or payment.paid_at >= flag.cutover_at
    or routing_at is distinct from payment.created_at
    or journal_date is distinct from
      nullif(assessment->>'proposed_journal_date', '')::date
    or payable_account_id is null
    or payment_account_id is null
    or refreshed_recognition is distinct from recognition
  then
    raise exception using
      errcode = '22023',
      message =
        'Las precondiciones canonicas del pago cambiaron.';
  end if;

  if public.is_date_in_closed_accounting_period(journal_date) then
    raise exception using
      errcode = '22023',
      message =
        'La fecha contable propuesta pertenece a un periodo cerrado.';
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
      message =
        'Las cuentas contables resueltas ya no estan activas.';
  end if;

  if public.resolve_accounting_mapping_v2(
      'default_account',
      'accounts_payable',
      journal_date
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
      message =
        'Los mappings contables cambiaron desde la vista previa.';
  end if;

  select count(*) into v1_event_count
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
          or event.status <> 'pending'
        )
    )
  then
    raise exception using
      errcode = '23505',
      message =
        'Ya existe un efecto contable equivalente para este pago.';
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
    'recognition_origin', 'opening_balance_control',
    'opening_balance_entry_id',
      recognition->>'journal_entry_id',
    'opening_balance_batch_id',
      recognition->>'opening_balance_batch_id',
    'preview_lines', assessment->'preview_lines',
    'total_debit', round(payment.amount, 2),
    'total_credit', round(payment.amount, 2),
    'balanced', true,
    'manual_publication_required', true,
    'idempotent_replay', false
  );

  insert into public.supplier_payment_accounting_repairs (
    payment_id,
    request_key,
    expected_fingerprint,
    reason,
    classification,
    status,
    routing_origin,
    covered_financial_event_v1_id,
    created_by,
    result
  )
  values (
    payment.id,
    clean_request_key,
    clean_fingerprint,
    clean_reason,
    classification_value,
    'processing',
    'late_recorded_supplier_payment',
    v1_event_id,
    actor_id,
    safe_result
  )
  returning id into repair_id_value;

  outbox_id_value :=
    public.route_supplier_payment_accounting_v2(
      payment.id,
      actor_id
    );

  if outbox_id_value is null then
    raise exception using
      errcode = '22023',
      message =
        'El router no pudo crear la outbox contable validada.';
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

  return safe_result;
end;
$$;

revoke all on function
  public.repair_late_recorded_supplier_payment_draft_v1(
    text, uuid, text, text
  )
  from public, anon;
grant execute on function
  public.repair_late_recorded_supplier_payment_draft_v1(
    text, uuid, text, text
  )
  to authenticated;

comment on function
  public.repair_late_recorded_supplier_payment_draft_v1(
    text, uuid, text, text
  )
is
  'Canonical individual supplier-payment recovery. Uses one economic lock and routes only a validated V2 outbox; the unchanged worker creates a manual-review draft.';

create or replace function
  public.observe_opening_balance_supplier_payment_completion_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
    and new.source_type = 'supplier_payment'
    and new.event_purpose = 'supplier_payment'
    and new.posting_version = 'v2'
    and new.metadata->>'recognition_origin'
      = 'opening_balance_control'
    and new.status = 'completed'
    and new.status is distinct from old.status
    and new.journal_entry_id is not null
  then
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      'supplier_payment_opening_balance_repair_completed',
      'accounting_outbox_v2', new.id,
      'supplier_payment', new.source_id::text,
      jsonb_build_object(
        'payment_id', new.source_id,
        'accounts_payable_id',
          new.metadata->>'accounts_payable_id',
        'outbox_id', new.id,
        'financial_event_id', new.financial_event_id,
        'journal_entry_id', new.journal_entry_id,
        'recognition_origin', 'opening_balance_control',
        'opening_balance_entry_id',
          new.metadata->>'opening_balance_entry_id',
        'opening_balance_batch_id',
          new.metadata->>'opening_balance_batch_id',
        'effective_paid_at',
          new.metadata->>'effective_paid_at',
        'recorded_at', new.metadata->>'recorded_at',
        'accounting_occurred_at',
          new.metadata->>'accounting_occurred_at',
        'routing_origin',
          'late_recorded_supplier_payment',
        'manual_publication_required', true
      ),
      new.actor_id
    );
  end if;

  return new;
end;
$$;

revoke all on function
  public.observe_opening_balance_supplier_payment_completion_v1()
  from public, anon, authenticated;

drop trigger if exists
  accounting_outbox_v2_observe_opening_balance_supplier_payment
  on public.accounting_outbox_v2;
create trigger
  accounting_outbox_v2_observe_opening_balance_supplier_payment
after update on public.accounting_outbox_v2
for each row execute function
  public.observe_opening_balance_supplier_payment_completion_v1();
