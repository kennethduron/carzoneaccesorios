\set ON_ERROR_STOP on

begin;
select no_plan();

create or replace function pg_temp.set_phase2_actor(actor_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(actor_id::text, ''), true);
  perform set_config('request.jwt.claim.role', case when actor_id is null then 'anon' else 'authenticated' end, true);
  perform set_config(
    'request.jwt.claims',
    case
      when actor_id is null then '{"role":"anon"}'
      else jsonb_build_object('sub', actor_id, 'role', 'authenticated')::text
    end,
    true
  );
end;
$$;

create or replace function pg_temp.capture_apply_error(batch_id uuid)
returns jsonb
language plpgsql
as $$
declare
  caught_state text;
  caught_message text;
begin
  begin
    perform public.apply_historical_accounts_payable_import(batch_id);
  exception when others then
    get stacked diagnostics
      caught_state = returned_sqlstate,
      caught_message = message_text;
    return jsonb_build_object('state', caught_state, 'message', caught_message);
  end;
  return null;
end;
$$;

create or replace function pg_temp.capture_rollback_error(batch_id uuid)
returns jsonb
language plpgsql
as $$
declare
  caught_state text;
  caught_message text;
begin
  begin
    perform public.rollback_historical_accounts_payable_import(
      batch_id,
      'PHASE2-LOCAL-ONLY'
    );
  exception when others then
    get stacked diagnostics
      caught_state = returned_sqlstate,
      caught_message = message_text;
    return jsonb_build_object('state', caught_state, 'message', caught_message);
  end;
  return null;
end;
$$;

create or replace function pg_temp.table_count(table_name regclass)
returns bigint
language plpgsql
as $$
declare
  result bigint;
begin
  execute format('select count(*) from %s', table_name) into result;
  return result;
end;
$$;

insert into public.roles (name, description, permissions)
select
  'admin',
  'PHASE2 LOCAL ONLY admin fixture',
  '[
    "payables:read",
    "payables:review",
    "payables:apply"
  ]'::jsonb
where not exists (select 1 from public.roles where name = 'admin');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    'a2100000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'phase2-owner@example.test', '',
    now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    'a2100000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'phase2-admin@example.test', '',
    now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    'a2100000-0000-4000-8000-000000000003',
    '00000000-0000-0000-8000-000000000000',
    'authenticated', 'authenticated', 'phase2-viewer@example.test', '',
    now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );

update public.users
set role_id = case id
      when 'a2100000-0000-4000-8000-000000000001'::uuid
        then (select id from public.roles where name = 'technical_owner')
      when 'a2100000-0000-4000-8000-000000000002'::uuid
        then (select id from public.roles where name = 'admin')
      else (select id from public.roles where name = 'soporte')
    end,
    full_name = case id
      when 'a2100000-0000-4000-8000-000000000001'::uuid then 'PHASE2 LOCAL OWNER'
      when 'a2100000-0000-4000-8000-000000000002'::uuid then 'PHASE2 LOCAL ADMIN'
      else 'PHASE2 LOCAL VIEWER'
    end,
    active = true
where id in (
  'a2100000-0000-4000-8000-000000000001',
  'a2100000-0000-4000-8000-000000000002',
  'a2100000-0000-4000-8000-000000000003'
);

insert into public.suppliers (id, name, is_active, created_by)
values (
  'a2100000-0000-4000-8000-000000000010',
  'PHASE2-LOCAL-ONLY HISTORICAL AP',
  true,
  'a2100000-0000-4000-8000-000000000001'
);

-- An unrelated payable proves rollback remains batch-scoped.
insert into public.supplier_invoices (
  id, supplier_id, invoice_number, invoice_date, due_date, status,
  subtotal, tax_amount, discount_amount, total, currency, created_by
) values (
  'a2100000-0000-4000-8000-000000000011',
  'a2100000-0000-4000-8000-000000000010',
  'PHASE2-UNRELATED', '2026-01-01', '2026-02-01', 'posted_to_ap',
  99, 0, 0, 99, 'HNL',
  'a2100000-0000-4000-8000-000000000001'
);
insert into public.accounts_payable (
  id, supplier_id, supplier_invoice_id, total_amount, paid_amount,
  due_date, status, currency, created_by
) values (
  'a2100000-0000-4000-8000-000000000012',
  'a2100000-0000-4000-8000-000000000010',
  'a2100000-0000-4000-8000-000000000011',
  99, 0, '2026-02-01', 'pending', 'HNL',
  'a2100000-0000-4000-8000-000000000001'
);

insert into public.import_batches (
  id, module, status, created_by, metadata
) values (
  'a2100000-0000-4000-8000-000000000020',
  'accounts_payable', 'ready',
  'a2100000-0000-4000-8000-000000000001',
  '{"fixture":"PHASE2-LOCAL-ONLY","scenario":"main"}'::jsonb
);

insert into public.import_rows (
  id, batch_id, module, row_number, normalized_data,
  validation_status, assignment_type, assignment_status,
  assigned_supplier_id, assigned_by, assigned_at, apply_status
) values
  (
    'a2100000-0000-4000-8000-000000000021',
    'a2100000-0000-4000-8000-000000000020',
    'accounts_payable', 1,
    '{"supplier_invoice_number":"PHASE2-CASH","issue_date":"2026-01-10","due_date":"2026-02-10","original_amount":1000,"paid_amount":200,"balance_due":800,"status":"partial","currency":"HNL","payment_method":"cash","payment_label":"Efectivo","payment_reference":"CASH-LOCAL","payment_date":"2026-01-15","notes":"PHASE2-LOCAL-ONLY"}'::jsonb,
    'valid', 'supplier', 'confirmed',
    'a2100000-0000-4000-8000-000000000010',
    'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  ),
  (
    'a2100000-0000-4000-8000-000000000022',
    'a2100000-0000-4000-8000-000000000020',
    'accounts_payable', 2,
    '{"supplier_invoice_number":"PHASE2-BANK","issue_date":"2026-01-11","due_date":"2026-02-11","original_amount":500,"paid_amount":500,"balance_due":0,"status":"paid","currency":"HNL","payment_method":"bank_transfer","payment_label":"Transferencia","payment_reference":"BANK-LOCAL","payment_date":"2026-01-16","notes":"PHASE2-LOCAL-ONLY"}'::jsonb,
    'warning', 'supplier', 'confirmed',
    'a2100000-0000-4000-8000-000000000010',
    'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  ),
  (
    'a2100000-0000-4000-8000-000000000023',
    'a2100000-0000-4000-8000-000000000020',
    'accounts_payable', 3,
    '{"supplier_invoice_number":"PHASE2-OPEN","issue_date":"2026-01-12","due_date":"2026-02-12","original_amount":300,"paid_amount":0,"balance_due":300,"status":"pending","currency":"HNL","payment_method":null,"payment_label":null,"notes":"PHASE2-LOCAL-ONLY"}'::jsonb,
    'valid', 'supplier', 'confirmed',
    'a2100000-0000-4000-8000-000000000010',
    'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  ),
  (
    'a2100000-0000-4000-8000-000000000024',
    'a2100000-0000-4000-8000-000000000020',
    'accounts_payable', 4,
    '{"supplier_invoice_number":"PHASE2-CANCELLED","issue_date":"2026-01-13","due_date":"2026-02-13","original_amount":100,"paid_amount":0,"balance_due":0,"status":"cancelled","currency":"HNL","payment_method":null,"payment_label":null,"notes":"PHASE2-LOCAL-ONLY"}'::jsonb,
    'valid', 'supplier', 'confirmed',
    'a2100000-0000-4000-8000-000000000010',
    'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  );

create temporary table phase2_protected_counts as
select
  pg_temp.table_count('public.financial_events') as financial_events,
  pg_temp.table_count('public.accounting_outbox') as outbox_v1,
  pg_temp.table_count('public.accounting_outbox_v2') as outbox_v2,
  pg_temp.table_count('public.journal_entries') as journal_entries,
  pg_temp.table_count('public.journal_entry_lines') as journal_lines,
  pg_temp.table_count('public.inventory_movements') as inventory_movements,
  pg_temp.table_count('public.accounting_event_log') as accounting_event_log;

select pg_temp.set_phase2_actor(
  'a2100000-0000-4000-8000-000000000001'
);

create temporary table phase2_results (
  name text primary key,
  result jsonb not null
) on commit drop;

insert into phase2_results values (
  'main_apply',
  public.apply_historical_accounts_payable_import(
    'a2100000-0000-4000-8000-000000000020'
  )
);

select is(
  (select result from phase2_results where name = 'main_apply'),
  '{"invoices":3,"payables":3,"payments":2,"skipped":1}'::jsonb,
  'apply returns the original compatible summary shape'
);
select is(
  (select count(*)::integer from public.supplier_invoices where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  3,
  'apply creates exactly three supplier invoices'
);
select is(
  (select count(*)::integer from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  3,
  'apply creates exactly three payables'
);
select is(
  (select jsonb_agg(jsonb_build_object('method', payment_method, 'method_v2', payment_method_v2, 'amount', amount) order by amount) from public.supplier_payments where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  '[{"method":"cash","method_v2":"cash","amount":200.00},{"method":"bank_transfer","method_v2":"bank_transfer","amount":500.00}]'::jsonb,
  'cash and bank transfer keep exact confirmed canonical equivalence'
);
select ok(
  not exists (
    select 1 from public.supplier_payments
    where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'
      and (
        imported_metadata->>'source' <> 'historical_accounts_payable_import'
        or imported_metadata->>'legacy_payment_method' <> payment_method
        or imported_metadata->>'legacy_payment_label' is null
        or imported_metadata->>'prospective_accounting_v2_excluded' <> 'true'
      )
  ),
  'payment metadata preserves the legacy method, label and exclusion reason'
);
select is(
  (select coalesce(sum(total_amount), 0) from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  1800.00::numeric,
  'imported payable totals are correct'
);
select is(
  (select coalesce(sum(paid_amount), 0) from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  700.00::numeric,
  'imported payable paid amounts are correct'
);
select ok(
  (select status = 'applied' and applied_rows = 3 and total_rows = 4 from public.import_batches where id = 'a2100000-0000-4000-8000-000000000020'),
  'batch counts and state are recounted after apply'
);
select is(
  (select apply_status from public.import_rows where id = 'a2100000-0000-4000-8000-000000000024'),
  'skipped',
  'cancelled historical rows remain staging-only'
);
select ok(
  exists (
    select 1 from public.import_audit_events
    where batch_id = 'a2100000-0000-4000-8000-000000000020'
      and event_type = 'apply_completed'
      and created_by = 'a2100000-0000-4000-8000-000000000001'
      and metadata->>'action' = 'historical_accounts_payable_import_applied'
      and metadata->>'batch_id' = 'a2100000-0000-4000-8000-000000000020'
      and (metadata->>'record_count')::integer = 3
      and (metadata->>'total_amount')::numeric = 1800
      and (metadata->>'paid_amount')::numeric = 700
  ),
  'apply audit uses the real schema with actor, amounts and structured metadata'
);
select is(
  (select count(*)::integer from historical_ap_internal.payment_insert_context),
  0,
  'transactional historical payment context is removed immediately'
);
select ok(
  (select
    financial_events = pg_temp.table_count('public.financial_events')
    and outbox_v1 = pg_temp.table_count('public.accounting_outbox')
    and outbox_v2 = pg_temp.table_count('public.accounting_outbox_v2')
    and journal_entries = pg_temp.table_count('public.journal_entries')
    and journal_lines = pg_temp.table_count('public.journal_entry_lines')
    and inventory_movements = pg_temp.table_count('public.inventory_movements')
    and accounting_event_log = pg_temp.table_count('public.accounting_event_log')
   from phase2_protected_counts),
  'verified historical payments create no V2 routing, event, journal or inventory effect'
);

insert into phase2_results values (
  'second_apply',
  public.apply_historical_accounts_payable_import(
    'a2100000-0000-4000-8000-000000000020'
  )
);
select is(
  (select result from phase2_results where name = 'second_apply'),
  '{"invoices":0,"payables":0,"payments":0,"skipped":0}'::jsonb,
  'second apply is economically idempotent'
);
select is(
  (select count(*)::integer from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  3,
  'second apply creates no duplicates'
);

-- A different SECURITY DEFINER function cannot impersonate the historical
-- context even when it can write the underlying economic table.
create or replace function pg_temp.spoof_historical_payment()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_payable uuid;
begin
  select id into target_payable
  from public.accounts_payable
  where imported_from_row_id = 'a2100000-0000-4000-8000-000000000021';

  insert into public.supplier_payments (
    accounts_payable_id, supplier_id, amount, payment_method,
    payment_method_v2, status, paid_at, created_by,
    imported_from_batch_id, imported_from_row_id, imported_metadata,
    allocation_mode, currency
  ) values (
    target_payable,
    'a2100000-0000-4000-8000-000000000010',
    200, 'cash', 'cash', 'paid', now(),
    'a2100000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000020',
    'a2100000-0000-4000-8000-000000000021',
    '{"source":"historical_accounts_payable_import","legacy_payment_method":"cash"}'::jsonb,
    'legacy_single', 'HNL'
  );
end;
$$;
select throws_ok(
  'select pg_temp.spoof_historical_payment()',
  '42501',
  'El pago historico no tiene un contexto de importacion autorizado.',
  'another SECURITY DEFINER function cannot activate the historical exception'
);
select is(
  (select count(*)::integer from public.supplier_payments where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020'),
  2,
  'spoof attempt leaves no payment'
);

select ok(
  not has_schema_privilege('authenticated', 'historical_ap_internal', 'USAGE')
  and not has_schema_privilege('service_role', 'historical_ap_internal', 'USAGE')
  and not has_table_privilege('authenticated', 'historical_ap_internal.payment_insert_context', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('service_role', 'historical_ap_internal.payment_insert_context', 'SELECT,INSERT,UPDATE,DELETE'),
  'historical context has no frontend or service role privileges'
);
select is(
  (
    select count(*)::integer
    from pg_proc function
    where function.prokind = 'f'
      and pg_get_functiondef(function.oid) like '%historical_ap_internal.payment_insert_context%'
  ),
  3,
  'no function beyond apply and the two validated triggers references the private context'
);

-- Ambiguous historical methods are rejected before any row is applied.
insert into public.import_batches (id, module, status, created_by, metadata)
values (
  'a2100000-0000-4000-8000-000000000030',
  'accounts_payable', 'ready',
  'a2100000-0000-4000-8000-000000000001',
  '{"fixture":"PHASE2-LOCAL-ONLY","scenario":"ambiguous"}'::jsonb
);
insert into public.import_rows (
  id, batch_id, module, row_number, normalized_data,
  validation_status, assignment_type, assignment_status,
  assigned_supplier_id, assigned_by, assigned_at, apply_status
) values
  (
    'a2100000-0000-4000-8000-000000000031', 'a2100000-0000-4000-8000-000000000030',
    'accounts_payable', 1,
    '{"supplier_invoice_number":"PHASE2-CARD","issue_date":"2026-01-20","due_date":"2026-02-20","original_amount":100,"paid_amount":10,"balance_due":90,"status":"partial","currency":"HNL","payment_method":"card","payment_label":"Tarjeta"}'::jsonb,
    'valid', 'supplier', 'confirmed', 'a2100000-0000-4000-8000-000000000010', 'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  ),
  (
    'a2100000-0000-4000-8000-000000000032', 'a2100000-0000-4000-8000-000000000030',
    'accounts_payable', 2,
    '{"supplier_invoice_number":"PHASE2-CHECK","issue_date":"2026-01-21","due_date":"2026-02-21","original_amount":100,"paid_amount":10,"balance_due":90,"status":"partial","currency":"HNL","payment_method":"check","payment_label":"Cheque"}'::jsonb,
    'valid', 'supplier', 'confirmed', 'a2100000-0000-4000-8000-000000000010', 'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  ),
  (
    'a2100000-0000-4000-8000-000000000033', 'a2100000-0000-4000-8000-000000000030',
    'accounts_payable', 3,
    '{"supplier_invoice_number":"PHASE2-OTHER","issue_date":"2026-01-22","due_date":"2026-02-22","original_amount":100,"paid_amount":10,"balance_due":90,"status":"partial","currency":"HNL","payment_method":"other","payment_label":"Otro"}'::jsonb,
    'valid', 'supplier', 'confirmed', 'a2100000-0000-4000-8000-000000000010', 'a2100000-0000-4000-8000-000000000001', now(), 'ready'
  );

create temporary table phase2_errors (
  name text primary key,
  error jsonb not null
) on commit drop;
insert into phase2_errors values (
  'ambiguous',
  pg_temp.capture_apply_error('a2100000-0000-4000-8000-000000000030')
);
select ok(
  (select error->>'state' = '22023'
    and error->>'message' like '%card%'
    and error->>'message' like '%check%'
    and error->>'message' like '%other%'
   from phase2_errors where name = 'ambiguous'),
  'card, check and other require explicit canonical resolution'
);
select ok(
  not exists (select 1 from public.supplier_invoices where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000030')
  and not exists (select 1 from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000030')
  and not exists (select 1 from public.supplier_payments where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000030')
  and (select bool_and(apply_status = 'ready') from public.import_rows where batch_id = 'a2100000-0000-4000-8000-000000000030'),
  'ambiguous-method preflight leaves the entire batch untouched'
);

-- Anonymous, invalid and non-authorized actors cannot apply.
insert into public.import_batches (id, module, status, created_by)
values ('a2100000-0000-4000-8000-000000000040', 'accounts_payable', 'ready', 'a2100000-0000-4000-8000-000000000001');
insert into public.import_rows (
  id, batch_id, module, row_number, normalized_data,
  validation_status, assignment_type, assignment_status,
  assigned_supplier_id, assigned_by, assigned_at, apply_status
) values (
  'a2100000-0000-4000-8000-000000000041', 'a2100000-0000-4000-8000-000000000040',
  'accounts_payable', 1,
  '{"supplier_invoice_number":"PHASE2-AUTH","issue_date":"2026-02-01","due_date":"2026-03-01","original_amount":50,"paid_amount":0,"balance_due":50,"status":"pending","currency":"HNL","payment_method":null}'::jsonb,
  'valid', 'supplier', 'confirmed', 'a2100000-0000-4000-8000-000000000010', 'a2100000-0000-4000-8000-000000000001', now(), 'ready'
);

select pg_temp.set_phase2_actor(null);
insert into phase2_errors values ('anonymous', pg_temp.capture_apply_error('a2100000-0000-4000-8000-000000000040'));
select pg_temp.set_phase2_actor('a2100000-0000-4000-8000-000000000003');
insert into phase2_errors values ('viewer', pg_temp.capture_apply_error('a2100000-0000-4000-8000-000000000040'));
select ok(
  (select error->>'message' = 'No tienes permiso para aplicar cuentas por pagar historicas.' from phase2_errors where name = 'anonymous')
  and (select error->>'message' = 'No tienes permiso para aplicar cuentas por pagar historicas.' from phase2_errors where name = 'viewer'),
  'anonymous and non-authorized actors cannot apply'
);
select ok(
  not exists (select 1 from public.supplier_invoices where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000040'),
  'authorization failures leave no economic rows'
);

-- Admin can apply but cannot rollback; owner can perform the cleanup.
select pg_temp.set_phase2_actor('a2100000-0000-4000-8000-000000000002');
insert into phase2_results values (
  'admin_apply',
  public.apply_historical_accounts_payable_import('a2100000-0000-4000-8000-000000000040')
);
select is(
  (select result from phase2_results where name = 'admin_apply'),
  '{"invoices":1,"payables":1,"payments":0,"skipped":0}'::jsonb,
  'authorized admin can apply a no-payment historical row'
);
insert into phase2_errors values ('admin_rollback', pg_temp.capture_rollback_error('a2100000-0000-4000-8000-000000000040'));
select is(
  (select error->>'message' from phase2_errors where name = 'admin_rollback'),
  'Solo technical_owner o business_owner pueden revertir lotes aplicados.',
  'admin cannot use the owner-only rollback'
);
select pg_temp.set_phase2_actor('a2100000-0000-4000-8000-000000000001');
select public.rollback_historical_accounts_payable_import('a2100000-0000-4000-8000-000000000040', 'cleanup local');

-- Audit failure must roll back every economic and private-context write.
insert into public.import_batches (id, module, status, created_by)
values ('a2100000-0000-4000-8000-000000000050', 'accounts_payable', 'ready', 'a2100000-0000-4000-8000-000000000001');
insert into public.import_rows (
  id, batch_id, module, row_number, normalized_data,
  validation_status, assignment_type, assignment_status,
  assigned_supplier_id, assigned_by, assigned_at, apply_status
) values (
  'a2100000-0000-4000-8000-000000000051', 'a2100000-0000-4000-8000-000000000050',
  'accounts_payable', 1,
  '{"supplier_invoice_number":"PHASE2-AUDIT-FAIL","issue_date":"2026-02-02","due_date":"2026-03-02","original_amount":75,"paid_amount":25,"balance_due":50,"status":"partial","currency":"HNL","payment_method":"cash","payment_label":"Efectivo","payment_date":"2026-02-05"}'::jsonb,
  'valid', 'supplier', 'confirmed', 'a2100000-0000-4000-8000-000000000010', 'a2100000-0000-4000-8000-000000000001', now(), 'ready'
);
create or replace function pg_temp.fail_phase2_audit()
returns trigger
language plpgsql
as $$
begin
  if new.batch_id = 'a2100000-0000-4000-8000-000000000050'::uuid then
    raise exception using errcode = 'P0001', message = 'PHASE2 controlled audit failure';
  end if;
  return new;
end;
$$;
create trigger phase2_controlled_audit_failure
before insert on public.import_audit_events
for each row execute function pg_temp.fail_phase2_audit();
insert into phase2_errors values ('audit_failure', pg_temp.capture_apply_error('a2100000-0000-4000-8000-000000000050'));
drop trigger phase2_controlled_audit_failure on public.import_audit_events;
select ok(
  (select error->>'state' = 'P0001' from phase2_errors where name = 'audit_failure')
  and not exists (select 1 from public.supplier_invoices where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000050')
  and not exists (select 1 from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000050')
  and not exists (select 1 from public.supplier_payments where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000050')
  and not exists (select 1 from historical_ap_internal.payment_insert_context)
  and (select status = 'ready' from public.import_batches where id = 'a2100000-0000-4000-8000-000000000050')
  and (select apply_status = 'ready' from public.import_rows where id = 'a2100000-0000-4000-8000-000000000051'),
  'audit failure is fully atomic including the private context'
);

-- A later application protects rollback atomically through existing FKs.
insert into public.import_batches (id, module, status, created_by)
values ('a2100000-0000-4000-8000-000000000060', 'accounts_payable', 'ready', 'a2100000-0000-4000-8000-000000000001');
insert into public.import_rows (
  id, batch_id, module, row_number, normalized_data,
  validation_status, assignment_type, assignment_status,
  assigned_supplier_id, assigned_by, assigned_at, apply_status
) values (
  'a2100000-0000-4000-8000-000000000061', 'a2100000-0000-4000-8000-000000000060',
  'accounts_payable', 1,
  '{"supplier_invoice_number":"PHASE2-DEPENDENCY","issue_date":"2026-02-03","due_date":"2026-03-03","original_amount":80,"paid_amount":20,"balance_due":60,"status":"partial","currency":"HNL","payment_method":"cash","payment_label":"Efectivo","payment_date":"2026-02-06"}'::jsonb,
  'valid', 'supplier', 'confirmed', 'a2100000-0000-4000-8000-000000000010', 'a2100000-0000-4000-8000-000000000001', now(), 'ready'
);
select public.apply_historical_accounts_payable_import('a2100000-0000-4000-8000-000000000060');
insert into public.journal_entries (
  id, entry_number, entry_date, description, status,
  source_type, source_id, created_by
) values (
  'a2100000-0000-4000-8000-000000000062',
  'PHASE2-DEPENDENCY', '2026-02-03', 'PHASE2 local dependency',
  'borrador', 'phase2_local', 'a2100000-0000-4000-8000-000000000060',
  'a2100000-0000-4000-8000-000000000001'
);
insert into public.supplier_payment_applications (
  id, supplier_payment_id, accounts_payable_id, supplier_invoice_id,
  applied_amount, currency, balance_before, balance_after,
  status_before, status_after, recognition_origin,
  recognition_journal_entry_id, recognition_date, status
)
select
  'a2100000-0000-4000-8000-000000000063',
  payment.id, payable.id, payable.supplier_invoice_id,
  20, 'HNL', 80, 60, 'pending', 'partial', 'direct_event',
  'a2100000-0000-4000-8000-000000000062', '2026-02-03', 'applied'
from public.supplier_payments payment
join public.accounts_payable payable on payable.id = payment.accounts_payable_id
where payment.imported_from_batch_id = 'a2100000-0000-4000-8000-000000000060';
insert into phase2_errors values ('dependency_rollback', pg_temp.capture_rollback_error('a2100000-0000-4000-8000-000000000060'));
select ok(
  (select error->>'state' = '23503' from phase2_errors where name = 'dependency_rollback')
  and exists (select 1 from public.supplier_payments where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000060')
  and exists (select 1 from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000060')
  and exists (select 1 from public.supplier_invoices where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000060')
  and (select status = 'applied' from public.import_batches where id = 'a2100000-0000-4000-8000-000000000060'),
  'subsequent payment applications block rollback without partial deletion'
);

-- Roll back the main batch and verify scope, audit and idempotency.
insert into phase2_results values (
  'main_rollback',
  public.rollback_historical_accounts_payable_import(
    'a2100000-0000-4000-8000-000000000020',
    'PHASE2 certified rollback'
  )
);
select is(
  (select result from phase2_results where name = 'main_rollback'),
  '{"invoices":3,"payables":3,"payments":2}'::jsonb,
  'rollback returns the original compatible summary shape'
);
select ok(
  not exists (select 1 from public.supplier_payments where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020')
  and not exists (select 1 from public.accounts_payable where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020')
  and not exists (select 1 from public.supplier_invoices where imported_from_batch_id = 'a2100000-0000-4000-8000-000000000020')
  and exists (select 1 from public.accounts_payable where id = 'a2100000-0000-4000-8000-000000000012')
  and exists (select 1 from public.supplier_invoices where id = 'a2100000-0000-4000-8000-000000000011'),
  'rollback deletes only economic rows created by its batch'
);
select ok(
  (select status = 'rolled_back' and rollback_reason = 'PHASE2 certified rollback' from public.import_batches where id = 'a2100000-0000-4000-8000-000000000020')
  and (select count(*) = 3 from public.import_rows where batch_id = 'a2100000-0000-4000-8000-000000000020' and apply_status = 'rolled_back')
  and (select count(*) = 1 from public.import_rows where batch_id = 'a2100000-0000-4000-8000-000000000020' and apply_status = 'skipped'),
  'rollback preserves staging evidence and correct row states'
);
select ok(
  exists (
    select 1 from public.import_audit_events
    where batch_id = 'a2100000-0000-4000-8000-000000000020'
      and event_type = 'rollback_completed'
      and created_by = 'a2100000-0000-4000-8000-000000000001'
      and metadata->>'action' = 'historical_accounts_payable_import_rolled_back'
      and (metadata->>'record_count')::integer = 3
      and (metadata->>'total_amount')::numeric = 1800
      and (metadata->>'paid_amount')::numeric = 700
      and (metadata->>'payment_amount')::numeric = 700
  ),
  'rollback audit contains actor, batch, counts and amounts'
);
insert into phase2_results values (
  'second_rollback',
  public.rollback_historical_accounts_payable_import(
    'a2100000-0000-4000-8000-000000000020',
    'PHASE2 second rollback'
  )
);
select is(
  (select result from phase2_results where name = 'second_rollback'),
  '{"invoices":0,"payables":0,"payments":0}'::jsonb,
  'second rollback is economically idempotent'
);

-- The normal V2 controls remain mandatory and the normal enqueue path remains
-- active outside the verified historical context.
select throws_ok(
  $$
    insert into public.supplier_payments (
      accounts_payable_id, supplier_id, amount, payment_method,
      status, paid_at, created_by, allocation_mode, currency
    ) values (
      'a2100000-0000-4000-8000-000000000012',
      'a2100000-0000-4000-8000-000000000010',
      10, 'cash', 'draft', now(),
      'a2100000-0000-4000-8000-000000000001',
      'legacy_single', 'HNL'
    )
  $$,
  '22023',
  'Los pagos nuevos requieren un metodo cerrado: cash, bank_transfer, card_credit o card_debit.',
  'normal payments still require payment_method_v2'
);

update public.accounting_feature_flags
set state = 'enabled', cutover_at = '2026-01-01 00:00:00+00'
where key = 'supplier_payment_draft_v2';
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by,
  allocation_mode, currency
) values (
  'a2100000-0000-4000-8000-000000000072',
  'a2100000-0000-4000-8000-000000000012',
  'a2100000-0000-4000-8000-000000000010',
  10, 'cash', 'cash', 'paid', now(),
  'a2100000-0000-4000-8000-000000000001',
  'legacy_single', 'HNL'
);
select ok(
  exists (
    select 1 from public.accounting_outbox_v2
    where source_type = 'supplier_payment'
      and source_id = 'a2100000-0000-4000-8000-000000000072'
  ),
  'a normal paid supplier payment still follows V2 enqueue routing'
);

-- Public contracts, owner/security settings and the active regression are fixed.
select ok(
  (
    select p.prosecdef
      and p.provolatile = 'v'
      and p.proparallel = 'u'
      and p.proconfig = array['search_path=public']
      and pg_get_userbyid(p.proowner) = 'postgres'
      and pg_get_function_identity_arguments(p.oid) = 'target_batch_id uuid'
      and pg_get_function_result(p.oid) = 'jsonb'
    from pg_proc p
    where p.oid = 'public.apply_historical_accounts_payable_import(uuid)'::regprocedure
  ),
  'apply public signature and execution contract are preserved'
);
select ok(
  (
    select p.prosecdef
      and p.provolatile = 'v'
      and p.proparallel = 'u'
      and p.proconfig = array['search_path=public']
      and pg_get_userbyid(p.proowner) = 'postgres'
      and pg_get_function_identity_arguments(p.oid) = 'target_batch_id uuid, rollback_reason text'
      and pg_get_function_arguments(p.oid) = 'target_batch_id uuid, rollback_reason text DEFAULT NULL::text'
      and pg_get_function_result(p.oid) = 'jsonb'
    from pg_proc p
    where p.oid = 'public.rollback_historical_accounts_payable_import(uuid,text)'::regprocedure
  ),
  'rollback signature, default and execution contract are preserved'
);
select ok(
  pg_get_functiondef('public.apply_historical_accounts_payable_import(uuid)'::regprocedure)
    not like '%import_audit_events (batch_id, module, event_type, actor_id, summary, metadata)%'
  and pg_get_functiondef('public.rollback_historical_accounts_payable_import(uuid,text)'::regprocedure)
    not like '%import_audit_events (batch_id, module, event_type, actor_id, summary, metadata)%',
  'both RPC definitions remove the incompatible audit columns'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'historical_ap_internal.payment_insert_context'::regclass)
  and not has_function_privilege('authenticated', 'public.require_supplier_payment_method_v2()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.enqueue_supplier_payment_v2()', 'EXECUTE'),
  'private context uses RLS and trigger helpers remain non-callable'
);

select * from finish();
rollback;
