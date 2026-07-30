-- Compatibility correction for manual-scan AP events.
-- A pending accounts_payable_created V1 event without a journal is evidence
-- of a read-only scan, not an incompatible individual accounting entry.
-- Real individual artifacts remain blocking unless they are uniquely posted.

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
  direct_artifact_count integer := 0;
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

  select count(*) into direct_artifact_count
  from public.financial_events event
  where event.source_type = 'accounts_payable'
    and event.source_id = payable.id::text
    and event.event_purpose = 'accounts_payable_created'
    and (
      event.journal_entry_id is not null
      or event.status <> 'pending'
    );

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

  if direct_artifact_count <> direct_count then
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
