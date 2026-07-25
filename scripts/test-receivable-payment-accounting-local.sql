\set ON_ERROR_STOP on

begin;

create temporary table rp_initial_mode (value jsonb not null) on commit drop;
insert into rp_initial_mode
select value from public.accounting_automation_settings where key = 'automation_mode';

insert into public.roles (id, name, description, permissions)
values
  ('94000000-0000-4000-8000-000000000003', 'admin', 'RECEIVABLE_PAYMENT_ACCOUNTING_LOCAL', '["credit:mark_paid","accounting:read","accounting:create","accounting:manage","accounting:post"]'::jsonb),
  ('94000000-0000-4000-8000-000000000004', 'contadora', 'RECEIVABLE_PAYMENT_ACCOUNTING_LOCAL', '["credit:mark_paid","accounting:read","accounting:create","accounting:manage","accounting:post"]'::jsonb),
  ('94000000-0000-4000-8000-000000000005', 'vendedor', 'RECEIVABLE_PAYMENT_ACCOUNTING_LOCAL', '[]'::jsonb);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '94100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rp-tech@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RP technical_owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '94100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rp-owner@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RP business_owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '94100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'rp-admin@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RP admin"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '94100000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'rp-accountant@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RP contadora"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '94100000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'rp-denied@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{"full_name":"RP vendedor"}', now(), now());

update public.users actor
set role_id = role_row.id, active = true
from public.roles role_row
where actor.id in (
  '94100000-0000-4000-8000-000000000001', '94100000-0000-4000-8000-000000000002',
  '94100000-0000-4000-8000-000000000003', '94100000-0000-4000-8000-000000000004',
  '94100000-0000-4000-8000-000000000005'
)
and role_row.name = case actor.id
  when '94100000-0000-4000-8000-000000000001'::uuid then 'technical_owner'
  when '94100000-0000-4000-8000-000000000002'::uuid then 'business_owner'
  when '94100000-0000-4000-8000-000000000003'::uuid then 'admin'
  when '94100000-0000-4000-8000-000000000004'::uuid then 'contadora'
  else 'vendedor'
end;

insert into public.customers (id, contact_name, business_name, active)
values ('94200000-0000-4000-8000-000000000001', 'RP Local', 'RECEIVABLE_PAYMENT_ACCOUNTING_LOCAL', true);

insert into public.accounts_receivable (id, customer_id, original_amount, balance_due, due_date, status, historical_invoice_number)
values
  ('94300000-0000-4000-8000-000000000001', '94200000-0000-4000-8000-000000000001', 1000, 1000, '2026-07-31', 'open', 'RP-TECH'),
  ('94300000-0000-4000-8000-000000000002', '94200000-0000-4000-8000-000000000001', 1000, 1000, '2026-07-31', 'open', 'RP-OWNER'),
  ('94300000-0000-4000-8000-000000000003', '94200000-0000-4000-8000-000000000001', 1000, 1000, '2026-07-31', 'open', 'RP-ADMIN'),
  ('94300000-0000-4000-8000-000000000004', '94200000-0000-4000-8000-000000000001', 400, 400, '2026-07-31', 'open', 'RP-ACCOUNTANT'),
  ('94300000-0000-4000-8000-000000000005', '94200000-0000-4000-8000-000000000001', 300, 300, '2026-06-30', 'open', 'RP-CLOSED'),
  ('94300000-0000-4000-8000-000000000006', '94200000-0000-4000-8000-000000000001', 200, 200, '2026-07-31', 'open', 'RP-VOID'),
  ('94300000-0000-4000-8000-000000000007', '94200000-0000-4000-8000-000000000001', 100, 100, '2026-07-31', 'open', 'RP-ATOMIC');

insert into public.accounting_accounts (id, code, name, type, normal_balance, is_active)
values
  ('94400000-0000-4000-8000-000000000001', 'RP-CASH', 'RP Caja', 'asset', 'debit', true),
  ('94400000-0000-4000-8000-000000000002', 'RP-BANK', 'RP Banco', 'asset', 'debit', true),
  ('94400000-0000-4000-8000-000000000003', 'RP-CARD', 'RP Tarjeta', 'asset', 'debit', true),
  ('94400000-0000-4000-8000-000000000004', 'RP-AR', 'RP Cuentas por cobrar', 'asset', 'debit', true);

insert into public.accounting_mappings (mapping_type, source_key, account_id, priority, is_active)
values
  ('payment_method', 'cash', '94400000-0000-4000-8000-000000000001', 1, true),
  ('payment_method', 'bank_transfer', '94400000-0000-4000-8000-000000000002', 1, true),
  ('payment_method', 'card', '94400000-0000-4000-8000-000000000003', 1, true),
  ('receivable', 'accounts_receivable', '94400000-0000-4000-8000-000000000004', 1, true);

insert into public.accounting_periods (id, name, start_date, end_date, status, period_type, fiscal_year)
values
  ('94500000-0000-4000-8000-000000000001', 'RP Junio cerrado', '2026-06-01', '2026-06-30', 'open', 'monthly', 2026),
  ('94500000-0000-4000-8000-000000000002', 'RP Julio abierto', '2026-07-01', '2026-07-31', 'open', 'monthly', 2026);

create temporary table rp_results (
  label text primary key, payment_id uuid, receivable_id uuid, previous_balance numeric,
  balance_due numeric, total_paid numeric, receivable_status text, queued_email_id uuid,
  outbox_id uuid, outbox_created boolean, idempotent_replay boolean
) on commit drop;

select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
insert into rp_results select 'technical_owner', result.* from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000001', 250, 'cash', 'RP-CASH', '2026-07-15 10:00:00-06', 'RP local', null, null, 'rp-key-tech') result;
select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000002', 'role', 'authenticated')::text, true);
insert into rp_results select 'business_owner', result.* from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000002', 300, 'bank_transfer', 'RP-BANK', '2026-07-15 11:00:00-06', 'RP local', null, null, 'rp-key-owner') result;
select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000003', 'role', 'authenticated')::text, true);
insert into rp_results select 'admin', result.* from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000003', 350, 'card', 'RP-CARD', '2026-07-15 12:00:00-06', 'RP local', null, null, 'rp-key-admin') result;
insert into rp_results select 'closed_period', result.* from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000005', 100, 'cash', 'RP-CLOSED', '2026-06-15 12:00:00-06', 'RP local', null, null, 'rp-key-closed') result;
insert into rp_results select 'voided', result.* from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000006', 50, 'cash', 'RP-VOID', '2026-07-15 12:30:00-06', 'RP local', null, null, 'rp-key-void') result;
select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000004', 'role', 'authenticated')::text, true);
insert into rp_results select 'contadora', result.* from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000004', 400, 'cash', 'RP-FINAL', '2026-07-15 13:00:00-06', 'RP local', null, null, 'rp-key-accountant') result;

do $$
declare replay record;
begin
  select * into replay from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000004', 400, 'cash', 'RP-FINAL', '2026-07-15 13:00:00-06', 'RP local', null, null, 'rp-key-accountant');
  if replay.payment_id <> (select payment_id from rp_results where label = 'contadora') or replay.idempotent_replay is not true or (select count(*) from public.accounts_receivable_payments where idempotency_key = 'rp-key-accountant') <> 1 then raise exception 'Idempotent replay duplicated or changed the payment'; end if;
  if (select previous_balance from rp_results where label = 'technical_owner') <> 1000 or (select balance_due from rp_results where label = 'technical_owner') <> 750 or (select balance_before from public.accounts_receivable_payments where id = (select payment_id from rp_results where label = 'technical_owner')) <> 1000 or (select balance_after from public.accounts_receivable_payments where id = (select payment_id from rp_results where label = 'technical_owner')) <> 750 then raise exception 'Partial-payment balance trace is invalid'; end if;
  if (select receivable_status from rp_results where label = 'contadora') <> 'paid' or (select balance_due from rp_results where label = 'contadora') <> 0 then raise exception 'Final payment did not close the receivable'; end if;
  if exists (select 1 from rp_results where outbox_id is null) or (select count(*) from public.accounting_outbox where source_id in (select payment_id from rp_results)) <> (select count(*) from rp_results) then raise exception 'A confirmed payment lacks transactional outbox'; end if;
  begin
    insert into public.accounting_outbox (source_type, source_id, event_purpose, posting_version) values ('receivable_payment', (select payment_id from rp_results where label = 'technical_owner'), 'receivable_payment', 'v1');
    raise exception 'Duplicate outbox was accepted';
  exception when unique_violation then null;
  end;
end $$;

create or replace function pg_temp.reject_rp_outbox() returns trigger language plpgsql as $$ begin raise exception 'forced outbox failure'; end $$;
create trigger rp_force_outbox_failure before insert on public.accounting_outbox for each row execute function pg_temp.reject_rp_outbox();
do $$
begin
  begin
    perform * from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000007', 25, 'cash', null, '2026-07-15 14:00:00-06', 'RP atomic', null, null, 'rp-key-atomic');
    raise exception 'Payment succeeded without outbox';
  exception when others then if sqlerrm = 'Payment succeeded without outbox' then raise; end if; end;
  if exists (select 1 from public.accounts_receivable_payments where idempotency_key = 'rp-key-atomic') or (select balance_due from public.accounts_receivable where id = '94300000-0000-4000-8000-000000000007') <> 100 then raise exception 'Outbox failure did not roll back the payment completely'; end if;
end $$;
drop trigger rp_force_outbox_failure on public.accounting_outbox;

select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
select public.close_accounting_period('94500000-0000-4000-8000-000000000001');
update public.accounting_mappings set is_active = false where mapping_type = 'payment_method' and source_key = 'card';
update public.accounts_receivable_payments set voided_at = now(), voided_by = '94100000-0000-4000-8000-000000000003', void_reason = 'RP local void test' where id = (select payment_id from rp_results where label = 'voided');

create temporary table rp_process (label text primary key, result jsonb) on commit drop;
insert into rp_process select label, public.process_receivable_payment_accounting_outbox_v1(outbox_id, 'rp-worker-' || label, false) from rp_results;

do $$
begin
  if exists (select 1 from rp_process where label in ('technical_owner','business_owner','contadora') and result->>'event_status' <> 'ready') then raise exception 'Valid payments were not ready'; end if;
  if (select result->>'reason' from rp_process where label = 'admin') <> 'mapping_missing' or (select result->>'event_status' from rp_process where label = 'admin') <> 'pending' then raise exception 'Missing mapping was not pending'; end if;
  if (select result->>'reason' from rp_process where label = 'closed_period') <> 'period_closed' or (select result->>'event_status' from rp_process where label = 'closed_period') <> 'pending' then raise exception 'Closed period was not pending'; end if;
  if (select result->>'reason' from rp_process where label = 'voided') <> 'payment_voided' or (select result->>'event_status' from rp_process where label = 'voided') <> 'skipped' then raise exception 'Voided payment was not skipped'; end if;
  if exists (select 1 from public.financial_events event join rp_results payment on payment.payment_id::text = event.source_id where (event.source_snapshot->>'amount')::numeric <> (select amount from public.accounts_receivable_payments where id = payment.payment_id) or event.occurred_at <> (select received_at from public.accounts_receivable_payments where id = payment.payment_id)) then raise exception 'Event amount/date differs from payment'; end if;
end $$;

create temporary table rp_drafts (label text primary key, result jsonb) on commit drop;
insert into rp_drafts select process.label, public.create_journal_draft_from_financial_event((process.result->>'event_id')::uuid, '2000-01-01', 'Untrusted description', '[]'::jsonb, null, 'rp-local-test') from rp_process process where process.label in ('technical_owner','business_owner','contadora');

do $$
begin
  if exists (select 1 from rp_drafts where result->>'status' <> 'borrador') then raise exception 'Directed entry was not a draft'; end if;
  if exists (select 1 from rp_drafts draft join rp_results payment on payment.label = draft.label cross join lateral (select count(*) line_count, sum(debit) debit, sum(credit) credit from public.journal_entry_lines where journal_entry_id = (draft.result->>'journal_entry_id')::uuid) totals where totals.line_count <> 2 or totals.debit <> (select amount from public.accounts_receivable_payments where id=payment.payment_id) or totals.credit <> (select amount from public.accounts_receivable_payments where id=payment.payment_id)) then raise exception 'Draft lines are not exact and balanced'; end if;
  if exists (select 1 from public.journal_entries where id in (select (result->>'journal_entry_id')::uuid from rp_drafts) and status <> 'borrador') then raise exception 'A draft was auto-posted'; end if;
end $$;

select public.complete_receivable_payment_accounting_outbox_v1(payment.outbox_id, 'rp-worker-' || payment.label, (process.result->>'event_id')::uuid, case when draft.result is null then null else (draft.result->>'journal_entry_id')::uuid end) from rp_results payment join rp_process process using (label) left join rp_drafts draft using (label);

select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
select public.post_journal_entry((select (result->>'journal_entry_id')::uuid from rp_drafts where label = 'technical_owner'), 1, null, 'rp-local-test');
do $$
begin
  begin perform public.post_journal_entry((select (result->>'journal_entry_id')::uuid from rp_drafts where label = 'technical_owner'), 2, null, 'rp-local-test'); raise exception 'Double publication was accepted';
  exception when others then if sqlerrm = 'Double publication was accepted' then raise; end if; end;
end $$;

update public.accounts_receivable_payments set voided_at = now(), voided_by = '94100000-0000-4000-8000-000000000001', void_reason = 'RP void before publish' where id = (select payment_id from rp_results where label = 'business_owner');
do $$
begin
  begin perform public.post_journal_entry((select (result->>'journal_entry_id')::uuid from rp_drafts where label = 'business_owner'), 1, null, 'rp-local-test'); raise exception 'Voided-payment draft was published';
  exception when others then if sqlerrm = 'Voided-payment draft was published' then raise; end if; end;
end $$;

insert into public.financial_events (source_type, source_id, event_purpose, posting_version, status, occurred_at, source_snapshot, validation_errors, created_by)
values ('accounts_receivable', '94300000-0000-4000-8000-000000000004', 'receivable_paid', 'v1', 'skipped', '2026-07-15 13:00:00-06', '{"event_type":"receivable_paid","amount":400}', '[]', '94100000-0000-4000-8000-000000000004');
select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000004', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform public.create_journal_draft_from_financial_event((select id from public.financial_events where event_purpose = 'receivable_paid' and source_id = '94300000-0000-4000-8000-000000000004'), '2026-07-15', 'Malicious control draft', jsonb_build_array(jsonb_build_object('account_id','94400000-0000-4000-8000-000000000001','debit',400,'credit',0), jsonb_build_object('account_id','94400000-0000-4000-8000-000000000004','debit',0,'credit',400)), null, 'rp-local-test');
    raise exception 'receivable_paid generated a draft';
  exception when others then if sqlerrm = 'receivable_paid generated a draft' then raise; end if; end;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000005', 'role', 'authenticated')::text, true);
do $$
begin
  begin perform * from public.register_credit_receivable_payment('94300000-0000-4000-8000-000000000007', 10, 'cash', null, now(), null, null, null, 'rp-key-denied'); raise exception 'Unauthorized role registered a payment';
  exception when others then if sqlerrm = 'Unauthorized role registered a payment' then raise; end if; end;
  begin set local role authenticated; insert into public.financial_events (source_type, source_id, event_purpose, posting_version, status, occurred_at, source_snapshot) values ('receivable_payment', gen_random_uuid()::text, 'receivable_payment', 'v1', 'ready', now(), '{}'); reset role; raise exception 'Direct financial-event write was accepted';
  exception when insufficient_privilege then reset role; end;
end $$;

do $$
begin
  if (select value from public.accounting_automation_settings where key = 'automation_mode') is distinct from (select value from rp_initial_mode) then raise exception 'Global automation mode changed'; end if;
  if (select count(*) from public.financial_events where event_purpose = 'receivable_paid' and journal_entry_id is not null) <> 0 then raise exception 'Control event linked a journal entry'; end if;
  if (select status from public.journal_entries where id = (select (result->>'journal_entry_id')::uuid from rp_drafts where label = 'technical_owner')) <> 'publicada' then raise exception 'Manual publication failed'; end if;
end $$;

select set_config('request.jwt.claims', jsonb_build_object('sub', '94100000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
insert into public.import_batches (id, module, status, created_by, total_rows, applied_rows)
values
  ('94700000-0000-4000-8000-000000000001', 'accounts_receivable', 'applied', '94100000-0000-4000-8000-000000000001', 1, 1),
  ('94700000-0000-4000-8000-000000000002', 'accounts_receivable', 'applied', '94100000-0000-4000-8000-000000000001', 1, 1);

insert into public.import_rows (id, batch_id, module, row_number, validation_status, apply_status)
values
  ('94800000-0000-4000-8000-000000000001', '94700000-0000-4000-8000-000000000001', 'accounts_receivable', 1, 'valid', 'applied'),
  ('94800000-0000-4000-8000-000000000002', '94700000-0000-4000-8000-000000000002', 'accounts_receivable', 1, 'valid', 'applied');

insert into public.accounts_receivable (
  id, customer_id, original_amount, balance_due, due_date, status,
  historical_invoice_number, imported_from_batch_id
)
values (
  '94300000-0000-4000-8000-000000000008',
  '94200000-0000-4000-8000-000000000001',
  125,
  125,
  '2026-07-31',
  'open',
  'RP-ROLLBACK',
  '94700000-0000-4000-8000-000000000001'
);

create temporary table rp_rollback_payment on commit drop as
select *
from public.register_credit_receivable_payment(
  '94300000-0000-4000-8000-000000000008',
  25,
  'cash',
  'RP-ROLLBACK',
  '2026-07-15 15:00:00-06',
  'RP rollback local',
  null,
  null,
  'rp-key-rollback'
);

select public.process_receivable_payment_accounting_outbox_v1(
  (select outbox_id from rp_rollback_payment),
  'rp-worker-rollback',
  false
);

do $$
declare
  rollback_result jsonb;
begin
  rollback_result := public.rollback_historical_accounts_receivable_import(
    '94700000-0000-4000-8000-000000000001',
    'RP local rollback'
  );

  if rollback_result <> jsonb_build_object('receivables', 1, 'payments', 1) then
    raise exception 'Historical rollback returned unexpected counts: %', rollback_result;
  end if;
  if exists (select 1 from public.accounts_receivable where id = '94300000-0000-4000-8000-000000000008') then
    raise exception 'Historical rollback kept the imported receivable';
  end if;
  if exists (select 1 from public.accounts_receivable_payments where id = (select payment_id from rp_rollback_payment)) then
    raise exception 'Historical rollback kept the imported payment';
  end if;
  if exists (select 1 from public.accounting_outbox where source_id = (select payment_id from rp_rollback_payment)) then
    raise exception 'Historical rollback kept the accounting outbox';
  end if;
  if exists (select 1 from public.financial_events where source_type = 'receivable_payment' and source_id = (select payment_id::text from rp_rollback_payment)) then
    raise exception 'Historical rollback kept the unlinked financial event';
  end if;
  if (select status from public.import_batches where id = '94700000-0000-4000-8000-000000000001') <> 'rolled_back'
    or (select apply_status from public.import_rows where id = '94800000-0000-4000-8000-000000000001') <> 'rolled_back'
  then
    raise exception 'Historical rollback did not update the import state';
  end if;
  if not exists (
    select 1
    from public.import_audit_events
    where batch_id = '94700000-0000-4000-8000-000000000001'
      and event_type = 'batch_rolled_back'
      and metadata->>'accounting_trace_removed' = 'true'
  ) then
    raise exception 'Historical rollback did not record accounting trace removal';
  end if;
end $$;

update public.accounts_receivable
set imported_from_batch_id = '94700000-0000-4000-8000-000000000002'
where id = '94300000-0000-4000-8000-000000000001';

do $$
begin
  begin
    perform public.rollback_historical_accounts_receivable_import(
      '94700000-0000-4000-8000-000000000002',
      'Must be blocked'
    );
    raise exception 'Historical rollback deleted a payment with a journal entry';
  exception
    when others then
      if sqlerrm = 'Historical rollback deleted a payment with a journal entry' then
        raise;
      end if;
      if sqlerrm not like 'El lote tiene abonos con partidas contables.%' then
        raise;
      end if;
  end;

  if (select status from public.import_batches where id = '94700000-0000-4000-8000-000000000002') <> 'applied'
    or not exists (select 1 from public.accounts_receivable_payments where id = (select payment_id from rp_results where label = 'technical_owner'))
  then
    raise exception 'Blocked historical rollback changed protected data';
  end if;
end $$;

select jsonb_build_object('authorized_roles', 4, 'payments', (select count(*) from rp_results), 'outboxes', (select count(*) from public.accounting_outbox where source_id in (select payment_id from rp_results)), 'events', (select count(*) from public.financial_events where source_type = 'receivable_payment' and source_id in (select payment_id::text from rp_results)), 'drafts', (select count(*) from rp_drafts), 'published', (select count(*) from public.journal_entries where id in (select (result->>'journal_entry_id')::uuid from rp_drafts) and status = 'publicada'), 'historical_rollback', true, 'journal_protected_rollback', true, 'global_mode', (select value from public.accounting_automation_settings where key = 'automation_mode'), 'global_mode_unchanged', (select value from public.accounting_automation_settings where key = 'automation_mode') is not distinct from (select value from rp_initial_mode));

rollback;
