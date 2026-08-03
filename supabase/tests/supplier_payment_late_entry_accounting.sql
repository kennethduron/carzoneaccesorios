\set ON_ERROR_STOP on

begin;

select plan(1);

do $$
begin
  if public.supplier_payment_accounting_occurred_at(
      '2026-07-29 06:00:00+00',
      '2026-07-29 14:00:00+00',
      '2026-07-28 20:30:00+00'
    ) <> '2026-07-29 06:00:00+00'::timestamptz
  then raise exception 'A normal modern payment did not retain paid_at.'; end if;

  if public.supplier_payment_accounting_occurred_at(
      '2026-07-13 06:00:00+00',
      '2026-07-29 14:08:18+00',
      '2026-07-28 20:30:00+00'
    ) <> '2026-07-29 14:08:18+00'::timestamptz
  then raise exception 'A late-recorded payment did not retain technical routing eligibility.'; end if;

  if public.supplier_payment_accounting_occurred_at(
      '2026-07-13 06:00:00+00',
      '2026-07-14 14:08:18+00',
      '2026-07-28 20:30:00+00'
    ) is not null
  then raise exception 'A truly historical payment became V2 eligible.'; end if;

  if public.supplier_payment_accounting_occurred_at(
      null,
      '2026-07-29 14:08:18+00',
      '2026-07-28 20:30:00+00'
    ) <> '2026-07-29 14:08:18+00'::timestamptz
  then raise exception 'A null paid_at did not retain technical routing eligibility.'; end if;
end;
$$;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'late-payment-owner@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    full_name = 'Late payment technical owner',
    email = 'late-payment-owner@example.test',
    active = true
where id = 'a1000000-0000-4000-8000-000000000001';

insert into public.roles (name, description, permissions)
values (
  'contadora',
  'Contadora fixture',
  '["admin:access","accounting:read"]'::jsonb
)
on conflict (name) do update
set permissions = public.roles.permissions || '["accounting:read"]'::jsonb;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'late-payment-accountant@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'contadora'),
    full_name = 'Late payment accountant',
    email = 'late-payment-accountant@example.test',
    active = true
where id = 'a1000000-0000-4000-8000-000000000002';

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = '2026-07-28 20:30:00+00',
    updated_by = 'a1000000-0000-4000-8000-000000000001'
where key = 'supplier_payment_draft_v2';

update public.accounting_mappings
set is_active = false
where (mapping_type, source_key) in (
  ('default_account', 'accounts_payable'),
  ('payment_method', 'supplier_payment_bank'),
  ('payment_method', 'supplier_payment_cash')
);

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, is_active, created_by
) values
  (
    'a2000000-0000-4000-8000-000000000001',
    'LATE-2101', 'Proveedores Locales fixture', 'liability', 'credit', true,
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'a2000000-0000-4000-8000-000000000002',
    'LATE-1101', 'Banco fixture', 'asset', 'debit', true,
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'a2000000-0000-4000-8000-000000000003',
    'LATE-1102', 'Caja fixture', 'asset', 'debit', true,
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'a2000000-0000-4000-8000-000000000004',
    'LATE-5101', 'Compra fixture', 'expense', 'debit', true,
    'a1000000-0000-4000-8000-000000000001'
  );

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active, created_by
) values
  (
    'default_account', 'accounts_payable',
    'a2000000-0000-4000-8000-000000000001', 1, true,
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'payment_method', 'supplier_payment_bank',
    'a2000000-0000-4000-8000-000000000002', 1, true,
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'payment_method', 'supplier_payment_cash',
    'a2000000-0000-4000-8000-000000000003', 1, true,
    'a1000000-0000-4000-8000-000000000001'
  );

insert into public.suppliers (id, name, is_active, created_by)
values (
  'a3000000-0000-4000-8000-000000000001',
  'Proveedor pago tardio fixture',
  true,
  'a1000000-0000-4000-8000-000000000001'
);

-- The payable recognition is already posted on 28 July.
insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency, created_by,
  created_at
) values (
  'a4000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  3200, 3200, 'paid', 'HNL',
  'a1000000-0000-4000-8000-000000000001',
  '2026-07-28 22:06:21+00'
);

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, posted_by, posted_at
) values (
  'a5000000-0000-4000-8000-000000000001',
  'LATE-AP-RECOGNITION', date '2026-07-12',
  'Reconocimiento CxP fixture', 'borrador', 'financial_event',
  'a6000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  null, null
);

insert into public.journal_entry_lines (
  journal_entry_id, account_id, debit, credit, description, vendor_id
) values
  (
    'a5000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000004',
    3200, 0, 'Compra fixture', 'a3000000-0000-4000-8000-000000000001'
  ),
  (
    'a5000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    0, 3200, 'CxP fixture', 'a3000000-0000-4000-8000-000000000001'
  );

update public.journal_entries
set status = 'publicada',
    posted_by = 'a1000000-0000-4000-8000-000000000001',
    posted_at = '2026-07-28 22:21:50+00'
where id = 'a5000000-0000-4000-8000-000000000001';

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, journal_entry_id, created_by
) values (
  'a6000000-0000-4000-8000-000000000001',
  'accounts_payable', 'a4000000-0000-4000-8000-000000000001',
  'accounts_payable_created', 'v1', 'posted',
  '2026-07-28 22:06:21+00', '{}'::jsonb, '[]'::jsonb,
  'a5000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001'
);

-- Simulate a payment that was recorded before this general router existed.
alter table public.supplier_payments
  disable trigger supplier_payments_enqueue_accounting_v2;

insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_at, created_by,
  idempotency_key, request_fingerprint
) values (
  'a7000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  3200, 'bank_transfer', 'bank_transfer', 'paid',
  '2026-07-13 06:00:00+00', '2026-07-29 14:08:18+00',
  'a1000000-0000-4000-8000-000000000001',
  'a8000000-0000-4000-8000-000000000001',
  repeat('a', 32)
);

alter table public.supplier_payments
  enable trigger supplier_payments_enqueue_accounting_v2;

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values (
  'a6000000-0000-4000-8000-000000000002',
  'supplier_payment', 'a7000000-0000-4000-8000-000000000001',
  'supplier_payment', 'v1', 'pending',
  '2026-07-13 06:00:00+00', '{}'::jsonb,
  '["legacy pending event"]'::jsonb,
  'a1000000-0000-4000-8000-000000000001'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

do $$
declare
  before_events bigint;
  before_outboxes bigint;
  before_logs bigint;
  before_entries bigint;
  before_payments bigint;
  preview_row jsonb;
begin
  select count(*) into before_events from public.financial_events;
  select count(*) into before_outboxes from public.accounting_outbox_v2;
  select count(*) into before_logs from public.accounting_event_log;
  select count(*) into before_entries from public.journal_entries;
  select count(*) into before_payments from public.supplier_payments;

  select preview into strict preview_row
  from public.preview_supplier_payment_accounting_repairs_v1(
    'a7000000-0000-4000-8000-000000000001'
  );

  if preview_row->>'classification' <> 'eligible_late_recorded'
    or preview_row->>'proposed_journal_date' <> '2026-07-13'
    or preview_row->>'routing_origin' <> 'late_recorded_supplier_payment'
    or (preview_row->>'amount')::numeric <> 3200
    or (preview_row->>'balanced')::boolean is not true
    or preview_row->'preview_lines'->0->>'side' <> 'debit'
    or preview_row->'preview_lines'->1->>'side' <> 'credit'
    or preview_row->'payable_recognition'->>'entry_date' <> '2026-07-12'
    or char_length(preview_row->>'expected_fingerprint') <> 64
  then raise exception 'Late payment preview is not canonical: %', preview_row; end if;

  if (select count(*) from public.financial_events) <> before_events
    or (select count(*) from public.accounting_outbox_v2) <> before_outboxes
    or (select count(*) from public.accounting_event_log) <> before_logs
    or (select count(*) from public.journal_entries) <> before_entries
    or (select count(*) from public.supplier_payments) <> before_payments
  then raise exception 'The preview wrote economic or audit state.'; end if;
end;
$$;

-- Accounting read roles can preview but cannot execute the repair.
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

do $$
declare preview_row jsonb;
begin
  select preview into strict preview_row
  from public.preview_supplier_payment_accounting_repairs_v1(
    'a7000000-0000-4000-8000-000000000001'
  );
  if preview_row->>'classification' <> 'eligible_late_recorded'
  then raise exception 'Contadora could not read the preview.'; end if;

  begin
    perform public.repair_late_recorded_supplier_payment_draft_v1(
      'a9000000-0000-4000-8000-000000000001',
      'a7000000-0000-4000-8000-000000000001',
      preview_row->>'expected_fingerprint',
      'Revision contable autorizada'
    );
    raise exception 'Contadora executed a technical-owner repair.';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

do $$
declare
  preview_row jsonb;
  repaired jsonb;
  replay jsonb;
begin
  select preview into strict preview_row
  from public.preview_supplier_payment_accounting_repairs_v1(
    'a7000000-0000-4000-8000-000000000001'
  );

  repaired := public.repair_late_recorded_supplier_payment_draft_v1(
    'a9000000-0000-4000-8000-000000000001',
    'a7000000-0000-4000-8000-000000000001',
    preview_row->>'expected_fingerprint',
    'Revision contable autorizada'
  );

  if repaired->>'status' <> 'queued'
    or (repaired->>'outbox_created')::boolean is not true
    or (select count(*) from public.accounting_outbox_v2
        where source_id = 'a7000000-0000-4000-8000-000000000001') <> 1
    or (select count(*) from public.supplier_payment_accounting_repairs
        where payment_id = 'a7000000-0000-4000-8000-000000000001') <> 1
  then raise exception 'The repair did not create exactly one V2 outbox: %', repaired; end if;

  replay := public.repair_late_recorded_supplier_payment_draft_v1(
    'a9000000-0000-4000-8000-000000000001',
    'a7000000-0000-4000-8000-000000000001',
    preview_row->>'expected_fingerprint',
    'Revision contable autorizada'
  );

  if (replay->>'idempotent_replay')::boolean is not true
    or replay->>'outbox_id' <> repaired->>'outbox_id'
    or (select count(*) from public.accounting_outbox_v2
        where source_id = 'a7000000-0000-4000-8000-000000000001') <> 1
  then raise exception 'Replay was not idempotent: %', replay; end if;

  begin
    perform public.repair_late_recorded_supplier_payment_draft_v1(
      'a9000000-0000-4000-8000-000000000001',
      'a7000000-0000-4000-8000-000000000099',
      preview_row->>'expected_fingerprint',
      'Solicitud de contenido distinto'
    );
    raise exception 'A request key was reused with a different payload.';
  exception
    when unique_violation then null;
  end;
end;
$$;

-- The canonical worker, not the repair RPC, creates the draft.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  box_id uuid;
  worker_result jsonb;
  draft_id uuid;
begin
  select id into strict box_id
  from public.accounting_outbox_v2
  where source_id = 'a7000000-0000-4000-8000-000000000001';

  if exists (
    select 1
    from public.journal_entries entry
    join public.financial_events event on entry.source_id = event.id::text
    where event.source_id = 'a7000000-0000-4000-8000-000000000001'
      and entry.source_type = 'financial_event'
  ) then raise exception 'Repair inserted a draft directly.'; end if;

  worker_result := public.process_accounting_outbox_v2(
    box_id, 'late-payment-contract-worker', false
  );
  draft_id := nullif(worker_result->>'journal_entry_id', '')::uuid;

  if worker_result->>'outbox_status' <> 'completed'
    or worker_result->>'draft_status' <> 'borrador'
    or draft_id is null
  then raise exception 'Canonical worker did not create the draft: %', worker_result; end if;

  if not exists (
    select 1
    from public.journal_entries entry
    where entry.id = draft_id
      and entry.entry_date = date '2026-07-13'
      and entry.status = 'borrador'
      and entry.posted_at is null
      and entry.posted_by is null
      and entry.metadata->>'effective_paid_at'
        = '2026-07-13T06:00:00+00:00'
      and entry.metadata->>'recorded_at'
        = '2026-07-29T14:08:18+00:00'
      and entry.metadata->>'routing_origin'
        = 'late_recorded_supplier_payment'
      and (entry.metadata->>'manual_publication_required')::boolean
  ) then raise exception 'Draft date/metadata/publication contract failed.'; end if;

  if (select count(*) from public.journal_entry_lines
      where journal_entry_id = draft_id) <> 2
    or (select round(sum(debit), 2) from public.journal_entry_lines
        where journal_entry_id = draft_id) <> 3200
    or (select round(sum(credit), 2) from public.journal_entry_lines
        where journal_entry_id = draft_id) <> 3200
    or not exists (
      select 1 from public.journal_entry_lines
      where journal_entry_id = draft_id
        and account_id = 'a2000000-0000-4000-8000-000000000001'
        and debit = 3200 and credit = 0
    )
    or not exists (
      select 1 from public.journal_entry_lines
      where journal_entry_id = draft_id
        and account_id = 'a2000000-0000-4000-8000-000000000002'
        and debit = 0 and credit = 3200
    )
  then raise exception 'Draft lines are not the canonical balanced pair.'; end if;

  if (select status from public.financial_events
      where id = 'a6000000-0000-4000-8000-000000000002') <> 'pending'
    or (select journal_entry_id from public.financial_events
        where id = 'a6000000-0000-4000-8000-000000000002') is not null
  then raise exception 'The pending V1 event was falsified or linked as V1.'; end if;

  if not exists (
    select 1
    from public.supplier_payment_accounting_repairs
    where payment_id = 'a7000000-0000-4000-8000-000000000001'
      and status = 'completed'
      and covered_financial_event_v1_id
        = 'a6000000-0000-4000-8000-000000000002'
      and journal_entry_id = draft_id
  ) then raise exception 'The V1 event was not safely covered in the ledger.'; end if;
end;
$$;

-- Future late payments route automatically through the same economic key.
insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency, created_by,
  created_at
) values (
  'a4000000-0000-4000-8000-000000000002',
  'a3000000-0000-4000-8000-000000000001',
  150, 150, 'paid', 'HNL',
  'a1000000-0000-4000-8000-000000000001',
  '2026-07-28 22:30:00+00'
);

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, posted_by, posted_at
) values (
  'a5000000-0000-4000-8000-000000000002',
  'LATE-AP-RECOGNITION-2', date '2026-07-12',
  'Reconocimiento CxP fixture 2', 'borrador', 'financial_event',
  'a6000000-0000-4000-8000-000000000003',
  'a1000000-0000-4000-8000-000000000001',
  null, null
);
insert into public.journal_entry_lines (
  journal_entry_id, account_id, debit, credit, description
) values
  ('a5000000-0000-4000-8000-000000000002',
   'a2000000-0000-4000-8000-000000000004', 150, 0, 'Compra fixture 2'),
  ('a5000000-0000-4000-8000-000000000002',
   'a2000000-0000-4000-8000-000000000001', 0, 150, 'CxP fixture 2');
update public.journal_entries
set status = 'publicada',
    posted_by = 'a1000000-0000-4000-8000-000000000001',
    posted_at = now()
where id = 'a5000000-0000-4000-8000-000000000002';
insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, journal_entry_id, created_by
) values (
  'a6000000-0000-4000-8000-000000000003',
  'accounts_payable', 'a4000000-0000-4000-8000-000000000002',
  'accounts_payable_created', 'v1', 'posted', now(),
  'a5000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000001'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_at, created_by,
  idempotency_key, request_fingerprint
) values
  (
    'a7000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    50, 'bank_transfer', 'bank_transfer', 'paid',
    '2026-07-13 06:00:00+00', '2026-07-29 15:00:00+00',
    'a1000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000002', repeat('b', 32)
  ),
  (
    'a7000000-0000-4000-8000-000000000003',
    'a4000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    100, 'cash', 'cash', 'paid',
    '2026-07-29 06:00:00+00', '2026-07-29 15:01:00+00',
    'a1000000-0000-4000-8000-000000000001',
    'a8000000-0000-4000-8000-000000000003', repeat('c', 32)
  );

do $$
begin
  if (select count(*) from public.accounting_outbox_v2
      where source_id in (
        'a7000000-0000-4000-8000-000000000002',
        'a7000000-0000-4000-8000-000000000003'
      )) <> 2
  then raise exception 'Two payments did not get two distinct economic outboxes.'; end if;

  if (select occurred_at from public.accounting_outbox_v2
      where source_id = 'a7000000-0000-4000-8000-000000000002')
      <> '2026-07-29 15:00:00+00'::timestamptz
  then raise exception 'Future late payment did not route at created_at.'; end if;

  if (select occurred_at from public.accounting_outbox_v2
      where source_id = 'a7000000-0000-4000-8000-000000000003')
      <> '2026-07-29 06:00:00+00'::timestamptz
  then raise exception 'Normal payment did not retain paid_at.'; end if;
end;
$$;

-- Missing mapping, inactive account, invalid chronology and cancellation remain
-- classifications; none can create a recovery outbox.
alter table public.supplier_payments
  disable trigger supplier_payments_enqueue_accounting_v2;

insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_at, created_by,
  idempotency_key, request_fingerprint
) values (
  'a7000000-0000-4000-8000-000000000004',
  'a4000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  10, 'bank_transfer', 'bank_transfer', 'voided',
  '2026-07-13 06:00:00+00', '2026-07-29 16:00:00+00',
  'a1000000-0000-4000-8000-000000000001',
  'a8000000-0000-4000-8000-000000000004', repeat('d', 32)
);

alter table public.supplier_payments
  enable trigger supplier_payments_enqueue_accounting_v2;

do $$
declare assessment jsonb;
begin
  assessment := public.supplier_payment_accounting_assessment_v1(
    'a7000000-0000-4000-8000-000000000004'
  );
  if assessment->>'classification' <> 'cancelled_or_reversed'
  then raise exception 'Voided payment classification failed: %', assessment; end if;

  update public.accounting_accounts
  set is_active = false
  where id = 'a2000000-0000-4000-8000-000000000002';

  -- Reuse a no-outbox late candidate only for the mapping assessment.
  delete from public.supplier_payment_accounting_repairs
  where payment_id = 'a7000000-0000-4000-8000-000000000001';
  delete from public.accounting_event_log
  where source_type = 'supplier_payment'
    and source_id = 'a7000000-0000-4000-8000-000000000001';
  delete from public.journal_entry_lines
  where journal_entry_id in (
    select id from public.journal_entries
    where metadata->>'payment_id'
      = 'a7000000-0000-4000-8000-000000000001'
  );
  delete from public.journal_entries
  where metadata->>'payment_id'
    = 'a7000000-0000-4000-8000-000000000001';
  delete from public.financial_events
  where source_type = 'supplier_payment'
    and source_id = 'a7000000-0000-4000-8000-000000000001'
    and posting_version = 'v2';
  delete from public.accounting_outbox_v2
  where source_id = 'a7000000-0000-4000-8000-000000000001';

  assessment := public.supplier_payment_accounting_assessment_v1(
    'a7000000-0000-4000-8000-000000000001'
  );
  if assessment->>'classification' <> 'mapping_missing'
  then raise exception 'Inactive financial account was not detected: %', assessment; end if;
end;
$$;

-- RLS/grants: authenticated reads through policy and cannot mutate the ledger.
do $$
begin
  if not has_table_privilege(
      'authenticated', 'public.supplier_payment_accounting_repairs', 'select'
    )
    or has_table_privilege(
      'authenticated', 'public.supplier_payment_accounting_repairs', 'insert'
    )
    or has_table_privilege(
      'authenticated', 'public.supplier_payment_accounting_repairs', 'update'
    )
    or has_table_privilege(
      'authenticated', 'public.supplier_payment_accounting_repairs', 'delete'
    )
  then raise exception 'Repair ledger grants are not least privilege.'; end if;

  if has_function_privilege(
      'authenticated',
      'public.route_supplier_payment_accounting_v2(uuid,uuid)',
      'execute'
    )
  then raise exception 'Authenticated can call the internal router.'; end if;

  if not has_function_privilege(
      'authenticated',
      'public.preview_supplier_payment_accounting_repairs_v1(uuid)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.repair_late_recorded_supplier_payment_draft_v1(text,uuid,text,text)',
      'execute'
    )
  then raise exception 'Authenticated RPC contracts are unavailable.'; end if;
end;
$$;

-- Feature state/cutover and operational rows were never rewritten by repair.
do $$
begin
  if not exists (
    select 1 from public.accounting_feature_flags
    where key = 'supplier_payment_draft_v2'
      and state = 'enabled'
      and cutover_at = '2026-07-28 20:30:00+00'
  ) then raise exception 'The cutover or feature state changed.'; end if;

  if not exists (
    select 1 from public.supplier_payments
    where id = 'a7000000-0000-4000-8000-000000000001'
      and amount = 3200
      and paid_at = '2026-07-13 06:00:00+00'
      and created_at = '2026-07-29 14:08:18+00'
      and status = 'paid'
  ) then raise exception 'The canonical payment changed.'; end if;

  if not exists (
    select 1 from public.accounts_payable
    where id = 'a4000000-0000-4000-8000-000000000001'
      and paid_amount = 3200 and balance = 0 and status = 'paid'
  ) then raise exception 'The payable changed.'; end if;
end;
$$;

select pass('Supplier payment late-entry accounting transactional contract');
select * from finish();

rollback;

\echo 'Supplier payment late-entry accounting transactional contract: OK'
