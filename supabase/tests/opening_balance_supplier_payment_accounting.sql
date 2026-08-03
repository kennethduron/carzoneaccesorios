\set ON_ERROR_STOP on

begin;
select plan(1);
\ir fixtures/supplier_payment_opening_balance_repair_fixture.sql.inc

-- This transaction reconstructs the protected 26-payable opening batch.
insert into public.accounting_opening_balance_batches (
  id, journal_entry_id, control_line_id, control_account_id, batch_key,
  payables_created_before, protected_count, protected_supplier_count,
  protected_total, protected_hash, status
) values (
  '93000000-0000-4000-8000-000000000001',
  '5843045f-db47-429c-ad19-f75dc61cdd3e',
  'f7389203-9ac0-40b8-9822-edfceb0e38fb',
  '05847d56-7097-492b-b153-2db33a00b9cd',
  'test:opening-balance:payables',
  '2026-07-14 20:23:42.016954+00',
  26, 8, 1589972.61,
  '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd',
  'active'
);

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, is_active, created_by
) values (
  '93000000-0000-4000-8000-000000000002',
  '1101005', 'BAC CHEQUES LPS', 'asset', 'debit', true,
  '91000000-0000-4000-8000-000000000001'
);

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active,
  effective_from, created_by
) values (
  'payment_method', 'supplier_payment_bank',
  '93000000-0000-4000-8000-000000000002',
  1, true, '2026-01-01',
  '91000000-0000-4000-8000-000000000001'
);

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = '2026-07-28 20:30:00+00',
    updated_by = '91000000-0000-4000-8000-000000000001'
where key = 'supplier_payment_draft_v2';

-- direct-event recognition remains valid and takes precedence.
savepoint direct_event_recognition;
insert into public.journal_entries (
  id, entry_number, entry_date, description, status,
  source_type, source_id, created_by, updated_by, posted_by, posted_at
) values (
  '93000000-0000-4000-8000-000000000003',
  'TEST-DIRECT-AP', '2026-07-15', 'Direct payable recognition',
  'publicada', 'financial_event',
  '93000000-0000-4000-8000-000000000004',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001', now()
);
insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, journal_entry_id, created_by
) values (
  '93000000-0000-4000-8000-000000000004',
  'accounts_payable', '3decb1cc-fa18-49e2-ac9a-c97e84916f5b',
  'accounts_payable_created', 'v1', 'posted', '2026-07-15 12:00:00+00',
  '{}'::jsonb, '[]'::jsonb,
  '93000000-0000-4000-8000-000000000003',
  '91000000-0000-4000-8000-000000000001'
);
do $$
declare result jsonb;
begin
  result := public.resolve_accounts_payable_accounting_recognition_v1(
    '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
  );
  if result->>'recognized' <> 'true'
    or result->>'recognition_origin' <> 'direct_event'
  then raise exception 'direct-event recognition remains valid'; end if;
end;
$$;
rollback to savepoint direct_event_recognition;

-- A pending manual-scan event without a journal does not block opening evidence.
savepoint pending_manual_scan_event;
insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values (
  '93000000-0000-4000-8000-000000000008',
  'accounts_payable', '3decb1cc-fa18-49e2-ac9a-c97e84916f5b',
  'accounts_payable_created', 'v1', 'pending',
  '2026-07-15 12:00:00+00', '{}'::jsonb, '[]'::jsonb,
  '91000000-0000-4000-8000-000000000001'
);
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'accounts_payable_recognized_opening_balance_control'
  then raise exception 'pending manual scan event compatibility'; end if;
end;
$$;
rollback to savepoint pending_manual_scan_event;

-- A non-pending individual event without a valid journal remains blocking.
savepoint incompatible_individual_recognition;
insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values (
  '93000000-0000-4000-8000-000000000010',
  'accounts_payable', '3decb1cc-fa18-49e2-ac9a-c97e84916f5b',
  'accounts_payable_created', 'v2', 'ready',
  '2026-07-15 12:00:00+00', '{}'::jsonb, '[]'::jsonb,
  '91000000-0000-4000-8000-000000000001'
);
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'accounts_payable_individual_recognition_incompatible'
  then raise exception 'incompatible individual recognition'; end if;
end;
$$;
rollback to savepoint incompatible_individual_recognition;

-- valid aggregate opening balance and valid chronology.
do $$
declare result jsonb;
begin
  result := public.resolve_accounts_payable_accounting_recognition_v1(
    '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
  );
  if result->>'recognized' <> 'true'
    or result->>'recognition_origin' <> 'opening_balance_control'
    or result->>'reason_code'
      <> 'accounts_payable_recognized_opening_balance_control'
    or (result->>'protected_count')::integer <> 26
    or (result->>'protected_total')::numeric <> 1589972.61
  then raise exception 'valid aggregate opening balance'; end if;
end;
$$;

-- incorrect protected hash.
savepoint incorrect_protected_hash;
update public.accounting_opening_balance_batches
set protected_hash = repeat('f', 64);
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_auxiliary_hash_mismatch'
  then raise exception 'incorrect protected hash'; end if;
end;
$$;
rollback to savepoint incorrect_protected_hash;

-- incorrect auxiliary count.
savepoint incorrect_auxiliary_count;
update public.accounting_opening_balance_batches set protected_count = 25;
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_auxiliary_count_mismatch'
  then raise exception 'incorrect auxiliary count'; end if;
end;
$$;
rollback to savepoint incorrect_auxiliary_count;

-- incorrect control total.
savepoint incorrect_control_total;
set local session_replication_role = replica;
update public.journal_entry_lines
set credit = credit - 0.01
where id = 'f7389203-9ac0-40b8-9822-edfceb0e38fb';
set local session_replication_role = origin;
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_control_total_mismatch'
  then raise exception 'incorrect control total'; end if;
end;
$$;
rollback to savepoint incorrect_control_total;

-- unpublished opening entry.
savepoint unpublished_opening_entry;
set local session_replication_role = replica;
update public.journal_entries
set status = 'borrador', posted_at = null, posted_by = null
where id = '5843045f-db47-429c-ad19-f75dc61cdd3e';
set local session_replication_role = origin;
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_entry_not_posted'
  then raise exception 'unpublished opening entry'; end if;
end;
$$;
rollback to savepoint unpublished_opening_entry;

-- reversed opening entry.
savepoint reversed_opening_entry;
insert into public.journal_entries (
  entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by
) values (
  'TEST-OPENING-REVERSAL', '2026-07-30', 'Reversal marker', 'borrador',
  'journal_reversal', '5843045f-db47-429c-ad19-f75dc61cdd3e',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001'
);
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_entry_reversed'
  then raise exception 'reversed opening entry'; end if;
end;
$$;
rollback to savepoint reversed_opening_entry;

-- different control account.
savepoint different_control_account;
update public.accounting_opening_balance_batches
set control_account_id = '92000000-0000-4000-8000-000000000003',
    control_line_id = '92000000-0000-4000-8000-000000000004';
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_control_account_invalid'
  then raise exception 'different control account'; end if;
end;
$$;
rollback to savepoint different_control_account;

-- multiple control lines.
savepoint multiple_control_lines;
set local session_replication_role = replica;
insert into public.journal_entry_lines (
  journal_entry_id, account_id, debit, credit, description
) values (
  '5843045f-db47-429c-ad19-f75dc61cdd3e',
  '05847d56-7097-492b-b153-2db33a00b9cd',
  0, 1, 'Second control line'
);
set local session_replication_role = origin;
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'reason_code'
  ) <> 'opening_balance_control_line_ambiguous'
  then raise exception 'multiple control lines'; end if;
end;
$$;
rollback to savepoint multiple_control_lines;

-- payable excluded from batch.
savepoint payable_excluded_from_batch;
update public.accounts_payable
set created_at = '2026-07-14 21:00:00+00'
where id = '3decb1cc-fa18-49e2-ac9a-c97e84916f5b';
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-30', null
    )->>'recognized'
  ) <> 'false'
  then raise exception 'payable excluded from batch'; end if;
end;
$$;
rollback to savepoint payable_excluded_from_batch;

-- invalid chronology.
do $$
begin
  if (
    public.resolve_accounts_payable_accounting_recognition_v1(
      '3decb1cc-fa18-49e2-ac9a-c97e84916f5b', '2026-07-10', null
    )->>'reason_code'
  ) <> 'payment_date_before_payable_recognition'
  then raise exception 'invalid chronology'; end if;
end;
$$;

update public.accounts_payable
set paid_amount = 11746.50, status = 'paid'
where id = '3decb1cc-fa18-49e2-ac9a-c97e84916f5b';
update public.accounts_payable
set paid_amount = 10000, status = 'partial'
where id = 'a2250e0c-7718-4203-92a1-178429a86018';

alter table public.supplier_payments disable trigger user;
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_at, created_by
) values
  (
    '5911527b-53ed-49bf-b6cc-ead2951adf60',
    '3decb1cc-fa18-49e2-ac9a-c97e84916f5b',
    'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe',
    11746.50, 'bank_transfer', 'bank_transfer', 'paid',
    '2026-07-17 06:00:00+00', '2026-07-30 14:06:38.384895+00',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6',
    'a2250e0c-7718-4203-92a1-178429a86018',
    '97226fc4-4e67-48d1-8108-33a511e5f2e2',
    7500, 'bank_transfer', 'bank_transfer', 'paid',
    '2026-07-16 06:00:00+00', '2026-07-30 14:02:37.125139+00',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '3b88e1ac-0000-4000-8000-000000000001',
    'a2250e0c-7718-4203-92a1-178429a86018',
    '97226fc4-4e67-48d1-8108-33a511e5f2e2',
    2500, 'bank_transfer', 'bank_transfer', 'paid',
    '2026-07-15 06:00:00+00', '2026-07-29 14:00:00+00',
    '91000000-0000-4000-8000-000000000001'
  );
alter table public.supplier_payments enable trigger user;

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values
  (
    '93000000-0000-4000-8000-000000000005',
    'supplier_payment', '5911527b-53ed-49bf-b6cc-ead2951adf60',
    'supplier_payment', 'v1', 'pending', '2026-07-17 06:00:00+00',
    '{}'::jsonb, '[]'::jsonb,
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '93000000-0000-4000-8000-000000000006',
    'supplier_payment', 'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6',
    'supplier_payment', 'v1', 'pending', '2026-07-16 06:00:00+00',
    '{}'::jsonb, '[]'::jsonb,
    '91000000-0000-4000-8000-000000000001'
  );

-- The older Edgar payment is an independent, already published artifact.
insert into public.journal_entries (
  id, entry_number, entry_date, description, status,
  source_type, source_id, created_by, updated_by, posted_by, posted_at,
  metadata
) values (
  '93000000-0000-4000-8000-000000000007',
  'PC-TEST-EDGAR-2500', '2026-07-29', 'Older Edgar payment',
  'publicada', 'supplier_payment',
  '3b88e1ac-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001', now(),
  '{"payment_id":"3b88e1ac-0000-4000-8000-000000000001"}'::jsonb
);

-- Future automatic trigger flow creates one V2 outbox for an opening payable.
update public.accounts_payable
set paid_amount = 1000, status = 'partial'
where id = 'a1dd3335-b682-4bac-9924-579b9a812c76';
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_at, created_by
) values (
  '93000000-0000-4000-8000-000000000009',
  'a1dd3335-b682-4bac-9924-579b9a812c76',
  'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe',
  1000, 'bank_transfer', 'bank_transfer', 'paid',
  '2026-07-15 06:00:00+00', '2026-07-30 15:00:00+00',
  '91000000-0000-4000-8000-000000000001'
);
do $$
declare box_id uuid;
begin
  select id into box_id
  from public.accounting_outbox_v2
  where source_id = '93000000-0000-4000-8000-000000000009'
    and metadata->>'recognition_origin' = 'opening_balance_control';
  if box_id is null then
    raise exception 'future automatic trigger flow';
  end if;
  perform public.process_accounting_outbox_v2(
    box_id, 'opening-trigger-sql-test', false
  );
  if not exists (
    select 1
    from public.accounting_outbox_v2 box
    join public.journal_entries entry
      on entry.id = box.journal_entry_id
    where box.id = box_id
      and box.status = 'completed'
      and entry.status = 'borrador'
      and entry.metadata->>'recognition_origin'
        = 'opening_balance_control'
      and entry.metadata->>'manual_publication_required' = 'true'
  ) then raise exception 'future trigger draft flow'; end if;
end;
$$;

-- full opening-balance payment, partial opening-balance payment,
-- multiple payments on one payable, and separate Edgar payments.
do $$
declare kool jsonb; edgar jsonb; old_edgar jsonb;
begin
  kool := public.supplier_payment_accounting_assessment_v1(
    '5911527b-53ed-49bf-b6cc-ead2951adf60'
  );
  edgar := public.supplier_payment_accounting_assessment_v1(
    'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
  );
  old_edgar := public.supplier_payment_accounting_assessment_v1(
    '3b88e1ac-0000-4000-8000-000000000001'
  );
  if kool->>'classification' <> 'eligible_late_recorded'
    or edgar->>'classification' <> 'eligible_late_recorded'
    or kool->>'recognition_origin' <> 'opening_balance_control'
    or edgar->>'recognition_origin' <> 'opening_balance_control'
    or kool->>'proposed_journal_date' <> '2026-07-17'
    or edgar->>'proposed_journal_date' <> '2026-07-16'
    or old_edgar->>'classification' <> 'already_accounted'
    or (kool->>'total_debit')::numeric <> 11746.50
    or (edgar->>'total_credit')::numeric <> 7500
  then raise exception 'opening payment eligibility regression'; end if;
end;
$$;

-- inactive mapping.
savepoint inactive_mapping;
update public.accounting_mappings
set is_active = false
where mapping_type = 'payment_method'
  and source_key = 'supplier_payment_bank';
do $$
begin
  if (
    public.supplier_payment_accounting_assessment_v1(
      '5911527b-53ed-49bf-b6cc-ead2951adf60'
    )->>'classification'
  ) <> 'mapping_missing'
  then raise exception 'inactive mapping'; end if;
end;
$$;
rollback to savepoint inactive_mapping;

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);

create temporary table repair_results (
  payment_id uuid primary key,
  result jsonb not null
) on commit drop;

insert into repair_results
select
  '5911527b-53ed-49bf-b6cc-ead2951adf60'::uuid,
  public.repair_late_recorded_supplier_payment_draft_v1(
    'opening-koolaudio-request',
    '5911527b-53ed-49bf-b6cc-ead2951adf60',
    public.supplier_payment_accounting_assessment_v1(
      '5911527b-53ed-49bf-b6cc-ead2951adf60'
    )->>'expected_fingerprint',
    'Validacion contable saldo inicial'
  )
union all
select
  'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'::uuid,
  public.repair_late_recorded_supplier_payment_draft_v1(
    'opening-edgar-request',
    'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6',
    public.supplier_payment_accounting_assessment_v1(
      'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
    )->>'expected_fingerprint',
    'Validacion contable saldo inicial'
  );

-- existing outbox and V1 event covered.
do $$
begin
  if (select count(*) from public.accounting_outbox_v2
      where source_id in (
        '5911527b-53ed-49bf-b6cc-ead2951adf60',
        'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
      )) <> 2
    or (select count(*) from public.supplier_payment_accounting_repairs
        where covered_financial_event_v1_id in (
          '93000000-0000-4000-8000-000000000005',
          '93000000-0000-4000-8000-000000000006'
        )) <> 2
  then raise exception 'existing outbox or V1 event covered'; end if;
end;
$$;

-- idempotent replay returns the same economic repair.
do $$
declare replay jsonb; original jsonb;
begin
  select result into original from repair_results
  where payment_id = '5911527b-53ed-49bf-b6cc-ead2951adf60';
  replay := public.repair_late_recorded_supplier_payment_draft_v1(
    'opening-koolaudio-request',
    '5911527b-53ed-49bf-b6cc-ead2951adf60',
    (select repair.expected_fingerprint
     from public.supplier_payment_accounting_repairs repair
     where repair.payment_id =
       '5911527b-53ed-49bf-b6cc-ead2951adf60'),
    'Validacion contable saldo inicial'
  );
  if replay->>'outbox_id' <> original->>'outbox_id'
    or replay->>'idempotent_replay' <> 'true'
  then raise exception 'idempotent replay'; end if;
end;
$$;

select public.process_accounting_outbox_v2(
  (result->>'outbox_id')::uuid, 'opening-balance-sql-test', false
)
from repair_results;

-- existing draft, balanced draft, and manual publication.
do $$
begin
  if (select count(*) from public.accounting_outbox_v2
      where source_id in (
        '5911527b-53ed-49bf-b6cc-ead2951adf60',
        'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
      )
      and status = 'completed'
      and journal_entry_id is not null) <> 2
    or (select count(*) from public.journal_entries
        where metadata->>'payment_id' in (
          '5911527b-53ed-49bf-b6cc-ead2951adf60',
          'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
        )
        and status = 'borrador'
        and metadata->>'manual_publication_required' = 'true') <> 2
    or exists (
      select 1
      from public.journal_entries entry
      join lateral (
        select round(sum(line.debit), 2) debit,
               round(sum(line.credit), 2) credit
        from public.journal_entry_lines line
        where line.journal_entry_id = entry.id
      ) totals on true
      where entry.metadata->>'payment_id' in (
        '5911527b-53ed-49bf-b6cc-ead2951adf60',
        'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
      )
        and totals.debit is distinct from totals.credit
    )
  then raise exception 'existing draft, balanced draft, manual publication'; end if;
end;
$$;

-- Worker replay and timeout/retry safety cannot create another draft.
select public.process_accounting_outbox_v2(
  (result->>'outbox_id')::uuid, 'opening-balance-replay', true
)
from repair_results;
do $$
begin
  if (select count(*) from public.accounting_outbox_v2
      where source_id in (
        '5911527b-53ed-49bf-b6cc-ead2951adf60',
        'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
      )) <> 2
    or (select count(*) from public.financial_events
        where source_type = 'supplier_payment'
          and posting_version = 'v2'
          and source_id in (
            '5911527b-53ed-49bf-b6cc-ead2951adf60',
            'cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6'
          )) <> 2
  then raise exception 'timeout or replay duplicate'; end if;
end;
$$;

-- RLS and grants keep protected evidence service-only.
do $$
begin
  if has_table_privilege(
      'authenticated',
      'public.accounting_opening_balance_batches',
      'select'
    )
    or has_table_privilege(
      'authenticated',
      'public.accounting_opening_balance_batches',
      'insert'
    )
    or not has_table_privilege(
      'service_role',
      'public.accounting_opening_balance_batches',
      'select'
    )
    or has_function_privilege(
      'authenticated',
      'public.resolve_accounts_payable_accounting_recognition_v1(uuid,date,uuid)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.resolve_accounts_payable_accounting_recognition_v1(uuid,date,uuid)',
      'execute'
    )
  then raise exception 'RLS and grants regression'; end if;
end;
$$;

select pass('opening balance supplier payment accounting');
select * from finish();
rollback;
