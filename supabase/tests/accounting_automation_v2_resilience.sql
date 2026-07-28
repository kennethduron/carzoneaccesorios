\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '91000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'accounting-v2-resilience@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    full_name = 'Accounting V2 resilience',
    email = 'accounting-v2-resilience@example.test',
    active = true
where id = '91000000-0000-4000-8000-000000000001';

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, created_by
) values
  ('92000000-0000-4000-8000-000000000001', 'V2-R-2101', 'Proveedores resiliencia', 'liability', 'credit', '91000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000002', 'V2-R-2102', 'Tarjeta resiliencia', 'liability', 'credit', '91000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000003', 'V2-R-5101', 'Compra resiliencia', 'cost', 'debit', '91000000-0000-4000-8000-000000000001');

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active, created_by
) values
  ('default_account', 'accounts_payable', '92000000-0000-4000-8000-000000000001', 1, true, '91000000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_card', '92000000-0000-4000-8000-000000000002', 1, true, '91000000-0000-4000-8000-000000000001');

update public.accounting_feature_flags
set state = 'enabled', cutover_at = now() - interval '1 minute',
    updated_by = '91000000-0000-4000-8000-000000000001'
where key = 'sales_draft_v2';

-- An active lease is not stolen. Once stale, the same fact is recovered and
-- validated without creating a duplicate economic row.
select public.route_accounting_fact_v2(
  'sales_draft_v2', 'sales.recognized', 'order',
  '93000000-0000-4000-8000-000000000001', 'sale_recognized',
  'resilience_missing_source', now(), '91000000-0000-4000-8000-000000000001'
);

update public.accounting_outbox_v2
set status = 'processing', lease_until = now() + interval '15 minutes',
    locked_by = 'other-worker', attempt_count = 1
where source_id = '93000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id from public.accounting_outbox_v2
  where source_id = '93000000-0000-4000-8000-000000000001';
  result := public.process_accounting_outbox_v2(box_id, 'second-worker', false);
  if result->>'reason' <> 'active_lease'
    or (select attempt_count from public.accounting_outbox_v2 where id = box_id) <> 1
  then raise exception 'An active lease was stolen: %', result; end if;

  update public.accounting_outbox_v2
  set lease_until = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
  where id = box_id;
  result := public.process_accounting_outbox_v2(box_id, 'recovery-worker', false);
  if result->>'outbox_status' <> 'pending_data'
    or result->>'reason' <> 'sale_source_missing'
    or (select attempt_count from public.accounting_outbox_v2 where id = box_id) <> 2
  then raise exception 'A stale lease was not recovered safely: %', result; end if;

  update public.accounting_outbox_v2
  set status = 'failed', attempt_count = max_attempts, next_attempt_at = now() - interval '1 second'
  where id = box_id;
  result := public.process_accounting_outbox_v2(box_id, 'limit-worker', false);
  if result->>'reason' <> 'max_attempts_reached'
  then raise exception 'The automatic attempt limit was bypassed: %', result; end if;
end;
$$;

-- A missing draft actor is treated as recoverable pending data, not as a
-- partially-created draft.
insert into public.accounting_outbox_v2 (
  feature_key, topic, source_type, source_id, event_purpose, posting_version,
  scenario, idempotency_key, occurred_at, cutover_at, status, actor_id
) values (
  'sales_draft_v2', 'sales.recognized', 'order',
  '93000000-0000-4000-8000-000000000002', 'sale_recognized', 'v2',
  'resilience_backoff', 'resilience-backoff-v2', now(), now() - interval '1 minute',
  'queued', null
);
update public.accounting_feature_flags set updated_by = null where key = 'sales_draft_v2';

do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id from public.accounting_outbox_v2
  where source_id = '93000000-0000-4000-8000-000000000002';
  result := public.process_accounting_outbox_v2(box_id, 'backoff-worker', false);
  if result->>'outbox_status' <> 'pending_data'
    or result->>'reason' <> 'missing_automation_actor'
    or (select next_attempt_at from public.accounting_outbox_v2 where id = box_id) < now() + interval '14 minutes'
  then raise exception 'Missing actor was not retained as recoverable data: %', result; end if;
end;
$$;

-- Directed repair fixture: null obligation remains pending_dependency; a
-- published L 73,200 liability allows exactly one unpublished L 9,800 draft.
update public.accounting_feature_flags
set state = 'enabled', cutover_at = '2026-07-01 00:00:00-06',
    updated_by = '91000000-0000-4000-8000-000000000001'
where key = 'supplier_payment_draft_v2';

insert into public.suppliers (id, name, is_active, created_by)
values ('94000000-0000-4000-8000-000000000001', 'CROMOS TORRE FUERTE', true, '91000000-0000-4000-8000-000000000001');

insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency, created_by
) values (
  '94000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000001',
  73200, 9800, 'partial', 'HNL', '91000000-0000-4000-8000-000000000001'
);

alter table public.supplier_payments disable trigger supplier_payments_require_method_v2;
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, idempotency_key, request_fingerprint
) values (
  '94000000-0000-4000-8000-000000000003',
  '94000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000001',
  9800, 'TARJETA', null, 'paid', '2026-07-12 12:00:00-06',
  '91000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000004', repeat('a', 32)
);
alter table public.supplier_payments enable trigger supplier_payments_require_method_v2;
update public.supplier_payments
set payment_method_v2 = 'card_credit'
where id = '94000000-0000-4000-8000-000000000003';

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values (
  '94000000-0000-4000-8000-000000000005', 'supplier_payment',
  '94000000-0000-4000-8000-000000000003', 'supplier_payment', 'v1', 'pending',
  '2026-07-12 12:00:00-06', '{}'::jsonb, '[]'::jsonb,
  '91000000-0000-4000-8000-000000000001'
);

-- Force one deterministic internal exception inside a savepoint. The worker
-- must sanitize it, release its lease and schedule exponential backoff. The
-- savepoint restores the real period function before the repair test.
savepoint technical_failure_contract;
create or replace function public.is_date_in_closed_accounting_period(target_date date)
returns boolean
language plpgsql
stable
as $$
begin
  raise exception 'fixture internal detail that must stay server-side';
end;
$$;

do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id
  from public.accounting_outbox_v2
  where source_type = 'supplier_payment'
    and source_id = '94000000-0000-4000-8000-000000000003'
    and posting_version = 'v2';
  result := public.process_accounting_outbox_v2(box_id, 'backoff-worker', false);
  if result->>'outbox_status' <> 'failed'
    or (select last_error_code from public.accounting_outbox_v2 where id = box_id) <> 'technical_error'
    or (select lease_until from public.accounting_outbox_v2 where id = box_id) is not null
    or (select next_attempt_at from public.accounting_outbox_v2 where id = box_id) < now() + interval '1 minute'
  then raise exception 'Technical failure did not retain the fact with backoff: %', result; end if;
end;
$$;
rollback to savepoint technical_failure_contract;

do $$
declare result jsonb;
begin
  result := public.repair_existing_supplier_card_payment_v1(
    '94000000-0000-4000-8000-000000000003',
    '94000000-0000-4000-8000-000000000005', null,
    '91000000-0000-4000-8000-000000000001'
  );
  if result->>'status' <> 'pending_dependency'
    or exists (select 1 from public.journal_entries where source_id = '94000000-0000-4000-8000-000000000005')
  then raise exception 'Missing original liability did not block the repair: %', result; end if;
end;
$$;

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by, posted_by, posted_at, metadata
) values (
  '94000000-0000-4000-8000-000000000006', 'V2-OBL-73200', date '2026-07-01',
  'Obligacion original fixture', 'borrador', 'fixture',
  '94000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001',
  null, null, '{}'::jsonb
);
insert into public.journal_entry_lines (
  journal_entry_id, account_id, debit, credit, description, vendor_id
) values
  ('94000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000003', 73200, 0, 'Compra fixture', '94000000-0000-4000-8000-000000000001'),
  ('94000000-0000-4000-8000-000000000006', '92000000-0000-4000-8000-000000000001', 0, 73200, 'Proveedor fixture', '94000000-0000-4000-8000-000000000001');
update public.journal_entries
set status = 'publicada',
    posted_by = '91000000-0000-4000-8000-000000000001',
    posted_at = now()
where id = '94000000-0000-4000-8000-000000000006';

do $$
declare
  first_result jsonb;
  replay_result jsonb;
  first_entry uuid;
begin
  first_result := public.repair_existing_supplier_card_payment_v1(
    '94000000-0000-4000-8000-000000000003',
    '94000000-0000-4000-8000-000000000005',
    '94000000-0000-4000-8000-000000000006',
    '91000000-0000-4000-8000-000000000001'
  );
  replay_result := public.repair_existing_supplier_card_payment_v1(
    '94000000-0000-4000-8000-000000000003',
    '94000000-0000-4000-8000-000000000005',
    '94000000-0000-4000-8000-000000000006',
    '91000000-0000-4000-8000-000000000001'
  );
  first_entry := (first_result->>'journal_entry_id')::uuid;

  if first_result->>'status' <> 'repaired'
    or replay_result->>'status' <> 'already_repaired'
    or (replay_result->>'journal_entry_id')::uuid <> first_entry
    or (select count(*) from public.journal_entries where source_id = '94000000-0000-4000-8000-000000000005') <> 1
    or (select status from public.journal_entries where id = first_entry) <> 'borrador'
    or (select entry_date from public.journal_entries where id = first_entry) <> date '2026-07-12'
    or (select paid_amount from public.accounts_payable where id = '94000000-0000-4000-8000-000000000002') <> 9800
    or (select status from public.supplier_payments where id = '94000000-0000-4000-8000-000000000003') <> 'paid'
  then raise exception 'Directed repair was not exact and idempotent: %, %', first_result, replay_result; end if;

  if not exists (
    select 1 from public.journal_entry_lines
    where journal_entry_id = first_entry
      and account_id = '92000000-0000-4000-8000-000000000001'
      and debit = 9800 and credit = 0
  ) or not exists (
    select 1 from public.journal_entry_lines
    where journal_entry_id = first_entry
      and account_id = '92000000-0000-4000-8000-000000000002'
      and debit = 0 and credit = 9800
  ) then raise exception 'Directed repair used incorrect accounts or amount.'; end if;
end;
$$;

rollback;

\echo 'Accounting automation V2 resilience and directed-repair contract: OK'
