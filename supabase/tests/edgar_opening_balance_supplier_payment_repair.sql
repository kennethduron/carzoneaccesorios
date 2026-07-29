\set ON_ERROR_STOP on

begin;
select plan(1);
\ir fixtures/edgar_opening_balance_supplier_payment_repair_fixture.sql

create or replace function pg_temp.repair_key()
returns text
language sql
immutable
as $$
  select
    'opening_balance_supplier_payment_repair:'
    || '3b88e1ac-74ae-460e-a399-3d1e0c0189e1:'
    || '1c85a425-8f28-4115-8ea3-d8217e8af897:v1';
$$;

create or replace function pg_temp.table_fingerprint(target_table regclass)
returns text
language plpgsql
as $$
declare
  result text;
begin
  execute format(
    $sql$
      select encode(
        extensions.digest(
          convert_to(
            coalesce(string_agg(to_jsonb(row_data)::text, E'\n' order by row_data.id), ''),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      from %s row_data
    $sql$,
    target_table
  )
  into result;
  return result;
end;
$$;

create or replace function pg_temp.call_repair()
returns jsonb
language sql
as $$
  select public.repair_edgar_opening_balance_supplier_payment_v1(
    '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
    '1c85a425-8f28-4115-8ea3-d8217e8af897',
    '5843045f-db47-429c-ad19-f75dc61cdd3e',
    '91000000-0000-4000-8000-000000000001',
    pg_temp.repair_key()
  );
$$;

create or replace function pg_temp.expect_repair_error(
  case_name text,
  expected_message text
)
returns void
language plpgsql
as $$
declare
  failed boolean := false;
  payable_hash text := pg_temp.table_fingerprint('public.accounts_payable');
  payment_hash text := pg_temp.table_fingerprint('public.supplier_payments');
  event_hash text := pg_temp.table_fingerprint('public.financial_events');
  outbox_hash text := pg_temp.table_fingerprint('public.accounting_outbox_v2');
  entry_hash text := pg_temp.table_fingerprint('public.journal_entries');
  line_hash text := pg_temp.table_fingerprint('public.journal_entry_lines');
  log_hash text := pg_temp.table_fingerprint('public.accounting_event_log');
begin
  begin
    perform pg_temp.call_repair();
  exception when others then
    failed := true;
    if position(expected_message in sqlerrm) = 0 then
      raise exception '%: error inesperado: %', case_name, sqlerrm;
    end if;
  end;

  if not failed then
    raise exception '%: el RPC acepto evidencia invalida', case_name;
  end if;

  if payable_hash <> pg_temp.table_fingerprint('public.accounts_payable')
    or payment_hash <> pg_temp.table_fingerprint('public.supplier_payments')
    or event_hash <> pg_temp.table_fingerprint('public.financial_events')
    or outbox_hash <> pg_temp.table_fingerprint('public.accounting_outbox_v2')
    or entry_hash <> pg_temp.table_fingerprint('public.journal_entries')
    or line_hash <> pg_temp.table_fingerprint('public.journal_entry_lines')
    or log_hash <> pg_temp.table_fingerprint('public.accounting_event_log')
  then
    raise exception '%: el error dejo una escritura parcial', case_name;
  end if;
end;
$$;

-- The fixture must reproduce the approved opening-balance population exactly.
do $$
declare
  auxiliary_count integer;
  supplier_count integer;
  auxiliary_total numeric;
  auxiliary_hash text;
begin
  select
    count(*),
    count(distinct supplier_id),
    round(sum(total_amount), 2),
    encode(
      extensions.digest(
        convert_to(string_agg(id::text, ',' order by id), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  into auxiliary_count, supplier_count, auxiliary_total, auxiliary_hash
  from public.accounts_payable
  where purchase_id is null
    and supplier_invoice_id is null
    and imported_from_batch_id is null
    and imported_from_row_id is null
    and created_at < '2026-07-14 20:23:42.016954+00'::timestamptz;

  if auxiliary_count <> 26
    or supplier_count <> 8
    or auxiliary_total <> 1589972.61
    or auxiliary_hash
      <> '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd'
  then
    raise exception 'El fixture no reproduce la evidencia aprobada.';
  end if;
end;
$$;

-- Wrong provider identity.
savepoint wrong_supplier;
update public.suppliers
set name = 'EDGAR JOEL LEIVA'
where id = '97226fc4-4e67-48d1-8108-33a511e5f2e2';
select pg_temp.expect_repair_error(
  'wrong_supplier',
  'EDGAR JOEL LEIVA PAZ no es un proveedor inequivoco.'
);
rollback to savepoint wrong_supplier;

-- Duplicate normalized provider.
savepoint duplicate_supplier;
insert into public.suppliers (id, name, is_active)
values (
  '99000000-0000-4000-8000-000000000101',
  'EDGAR  JOEL LEIVA PAZ',
  true
);
select pg_temp.expect_repair_error(
  'duplicate_supplier',
  'EDGAR JOEL LEIVA PAZ no es un proveedor inequivoco.'
);
rollback to savepoint duplicate_supplier;

-- Wrong obligation amount.
savepoint wrong_payable_amount;
update public.accounts_payable
set total_amount = 656938.42
where id = 'a2250e0c-7718-4203-92a1-178429a86018';
select pg_temp.expect_repair_error(
  'wrong_payable_amount',
  'El total del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_payable_amount;

-- Wrong remaining balance.
savepoint wrong_payable_balance;
update public.accounts_payable
set paid_amount = 2501.00
where id = 'a2250e0c-7718-4203-92a1-178429a86018';
select pg_temp.expect_repair_error(
  'wrong_payable_balance',
  'La obligacion dirigida de Edgar cambio'
);
rollback to savepoint wrong_payable_balance;

-- Wrong payable state.
savepoint wrong_payable_status;
update public.accounts_payable
set status = 'pending'
where id = 'a2250e0c-7718-4203-92a1-178429a86018';
select pg_temp.expect_repair_error(
  'wrong_payable_status',
  'La obligacion dirigida de Edgar cambio'
);
rollback to savepoint wrong_payable_status;

-- Payable no longer belongs to opening-balance population.
savepoint payable_has_purchase;
set local session_replication_role = replica;
update public.accounts_payable
set purchase_id = '99000000-0000-4000-8000-000000000102'
where id = 'a2250e0c-7718-4203-92a1-178429a86018';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'payable_has_purchase',
  'La cantidad del auxiliar inicial no coincide.'
);
rollback to savepoint payable_has_purchase;

-- Wrong payment amount.
savepoint wrong_payment_amount;
set local session_replication_role = replica;
update public.supplier_payments
set amount = 2500.01
where id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'wrong_payment_amount',
  'El pago historico de Edgar no es unico.'
);
rollback to savepoint wrong_payment_amount;

-- Wrong payment date.
savepoint wrong_payment_date;
set local session_replication_role = replica;
update public.supplier_payments
set paid_at = '2026-07-12 06:00:00+00'
where id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'wrong_payment_date',
  'El pago historico de Edgar no es unico.'
);
rollback to savepoint wrong_payment_date;

-- Wrong payment method.
savepoint wrong_payment_method;
set local session_replication_role = replica;
update public.supplier_payments
set payment_method_v2 = 'cash'
where id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'wrong_payment_method',
  'El pago historico dirigido de Edgar cambio.'
);
rollback to savepoint wrong_payment_method;

-- Voided/incompatible payment.
savepoint voided_payment;
set local session_replication_role = replica;
update public.supplier_payments
set status = 'voided',
    voided_at = now(),
    voided_by = '91000000-0000-4000-8000-000000000001'
where id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'voided_payment',
  'El pago historico de Edgar no es unico.'
);
rollback to savepoint voided_payment;

-- Duplicate equivalent payment.
savepoint duplicate_payment;
set local session_replication_role = replica;
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, notes, created_by,
  idempotency_key, request_fingerprint
) values (
  '99000000-0000-4000-8000-000000000103',
  'a2250e0c-7718-4203-92a1-178429a86018',
  '97226fc4-4e67-48d1-8108-33a511e5f2e2',
  2500.00, 'bank_transfer', 'bank_transfer', 'paid',
  '2026-07-13 06:00:00+00', '410000078',
  'a164cfce-d103-4bfb-a7cf-969b5eb195f3',
  'duplicate-fixture-idempotency-key',
  'abcdef0123456789abcdef0123456789'
);
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'duplicate_payment',
  'El pago historico de Edgar no es unico.'
);
rollback to savepoint duplicate_payment;

-- Event absent.
savepoint missing_event;
delete from public.financial_events
where id = '1c85a425-8f28-4115-8ea3-d8217e8af897';
select pg_temp.expect_repair_error(
  'missing_event',
  'El evento financiero del pago de Edgar no es unico.'
);
rollback to savepoint missing_event;

-- Duplicate event for the same source.
savepoint duplicate_event;
insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status
) values (
  '99000000-0000-4000-8000-000000000104',
  'supplier_payment',
  '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
  'supplier_payment_duplicate',
  'v1',
  'pending'
);
select pg_temp.expect_repair_error(
  'duplicate_event',
  'El evento financiero del pago de Edgar no es unico.'
);
rollback to savepoint duplicate_event;

-- Event in incompatible state.
savepoint incompatible_event_status;
update public.financial_events
set status = 'failed'
where id = '1c85a425-8f28-4115-8ea3-d8217e8af897';
select pg_temp.expect_repair_error(
  'incompatible_event_status',
  'El evento financiero dirigido de Edgar cambio.'
);
rollback to savepoint incompatible_event_status;

-- Existing entry by source, with the event still pending.
savepoint existing_entry;
insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by
) values (
  '99000000-0000-4000-8000-000000000105',
  'TEST-EDGAR-EXISTING',
  date '2026-07-13',
  'Existing incompatible Edgar entry',
  'borrador',
  'financial_event',
  '1c85a425-8f28-4115-8ea3-d8217e8af897',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001'
);
insert into public.journal_entry_lines (
  journal_entry_id, account_id, debit, credit, description
) values (
  '99000000-0000-4000-8000-000000000105',
  '05847d56-7097-492b-b153-2db33a00b9cd',
  1.00, 0.00, 'Existing incompatible line'
);
select pg_temp.expect_repair_error(
  'existing_entry_and_lines',
  'Ya existe una partida candidata o incompatible para Edgar.'
);
rollback to savepoint existing_entry;

-- Event already linked to an incompatible draft.
savepoint event_already_linked;
insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by
) values (
  '99000000-0000-4000-8000-000000000106',
  'TEST-EDGAR-LINKED',
  date '2026-07-13',
  'Linked incompatible Edgar entry',
  'borrador',
  'financial_event',
  '1c85a425-8f28-4115-8ea3-d8217e8af897',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001'
);
update public.financial_events
set status = 'draft_created',
    journal_entry_id = '99000000-0000-4000-8000-000000000106'
where id = '1c85a425-8f28-4115-8ea3-d8217e8af897';
select pg_temp.expect_repair_error(
  'event_already_linked',
  'El evento de Edgar esta vinculado a una partida incompatible.'
);
rollback to savepoint event_already_linked;

-- V2 outbox preexists.
savepoint existing_outbox;
insert into public.accounting_outbox_v2 (
  id, feature_key, topic, source_type, source_id, event_purpose,
  posting_version, scenario, idempotency_key, occurred_at, cutover_at,
  status, actor_id
) values (
  '99000000-0000-4000-8000-000000000107',
  'supplier_payment_draft_v2',
  'payables.supplier_payment',
  'supplier_payment',
  '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
  'supplier_payment',
  'v2',
  'bank_transfer',
  'fixture:edgar:unexpected:v2:outbox',
  '2026-07-28 21:00:00+00',
  '2026-07-28 20:30:00+00',
  'queued',
  '91000000-0000-4000-8000-000000000001'
);
select pg_temp.expect_repair_error(
  'existing_outbox',
  'Aparecio una outbox V2 para el pago historico de Edgar.'
);
rollback to savepoint existing_outbox;

-- Previous repair evidence without a journal entry.
savepoint previous_repair_log;
insert into public.accounting_event_log (
  event_type, entity_type, source_type, source_id, metadata, created_by
) values (
  'accounting.directed_repair_edgar_supplier_payment_2500',
  'journal_entries',
  'supplier_payment',
  '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
  jsonb_build_object(
    'payment_id', '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
    'financial_event_id', '1c85a425-8f28-4115-8ea3-d8217e8af897',
    'repair_idempotency_key', pg_temp.repair_key()
  ),
  '91000000-0000-4000-8000-000000000001'
);
select pg_temp.expect_repair_error(
  'previous_repair_log',
  'Ya existe evidencia de otra reparacion para Edgar.'
);
rollback to savepoint previous_repair_log;

-- Debit account inactive.
savepoint debit_account_inactive;
update public.accounting_accounts
set is_active = false
where id = '05847d56-7097-492b-b153-2db33a00b9cd';
select pg_temp.expect_repair_error(
  'debit_account_inactive',
  'La linea de control 2101001 no coincide'
);
rollback to savepoint debit_account_inactive;

-- Credit account inactive.
savepoint credit_account_inactive;
update public.accounting_accounts
set is_active = false
where id = 'f5d451ec-4985-4c07-97a1-6d8e0a0fadf6';
select pg_temp.expect_repair_error(
  'credit_account_inactive',
  'Las cuentas o mappings dirigidos de Edgar no coinciden.'
);
rollback to savepoint credit_account_inactive;

-- Bank mapping inactive.
savepoint bank_mapping_inactive;
update public.accounting_mappings
set is_active = false
where id = 'ae4ccc50-4ad4-40ba-b92e-d2549c51bf0b';
select pg_temp.expect_repair_error(
  'bank_mapping_inactive',
  'Las cuentas o mappings dirigidos de Edgar no coinciden.'
);
rollback to savepoint bank_mapping_inactive;

-- Wrong opening auxiliary count.
savepoint wrong_auxiliary_count;
insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency, created_at
) values (
  '99000000-0000-4000-8000-000000000108',
  '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
  0.00, 0.00, 'pending', 'HNL', '2026-07-14 19:30:00+00'
);
select pg_temp.expect_repair_error(
  'wrong_auxiliary_count',
  'La cantidad del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_auxiliary_count;

-- Wrong opening auxiliary total.
savepoint wrong_auxiliary_total;
update public.accounts_payable
set total_amount = total_amount + 0.01
where id = '96a95d10-d4c6-4f2d-ac48-0e904e619cf4';
select pg_temp.expect_repair_error(
  'wrong_auxiliary_total',
  'El total del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_auxiliary_total;

-- Wrong opening auxiliary hash with count and total preserved.
savepoint wrong_auxiliary_hash;
update public.accounts_payable
set id = '99000000-0000-4000-8000-000000000109'
where id = '96a95d10-d4c6-4f2d-ac48-0e904e619cf4';
select pg_temp.expect_repair_error(
  'wrong_auxiliary_hash',
  'El hash del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_auxiliary_hash;

-- Opening entry modified.
savepoint opening_entry_modified;
set local session_replication_role = replica;
update public.journal_entries
set description = 'BALANCE INICIAL MODIFICADO'
where id = '5843045f-db47-429c-ad19-f75dc61cdd3e';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'opening_entry_modified',
  'La partida inicial aprobada cambio'
);
rollback to savepoint opening_entry_modified;

-- CROMOS modified.
savepoint cromos_modified;
set local session_replication_role = replica;
update public.supplier_payments
set amount = 9800.01
where id = 'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'cromos_modified',
  'La evidencia protegida de CROMOS cambio.'
);
rollback to savepoint cromos_modified;

-- Wrong exact idempotency key and same key with wrong payload.
do $$
declare
  failed boolean := false;
begin
  begin
    perform public.repair_edgar_opening_balance_supplier_payment_v1(
      '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
      '1c85a425-8f28-4115-8ea3-d8217e8af897',
      '5843045f-db47-429c-ad19-f75dc61cdd3e',
      '91000000-0000-4000-8000-000000000001',
      'opening_balance_supplier_payment_repair:wrong'
    );
  exception when unique_violation then
    failed := true;
  end;
  if not failed then
    raise exception 'Una clave de idempotencia incorrecta fue aceptada.';
  end if;

  failed := false;
  begin
    perform public.repair_edgar_opening_balance_supplier_payment_v1(
      '99000000-0000-4000-8000-000000000110',
      '1c85a425-8f28-4115-8ea3-d8217e8af897',
      '5843045f-db47-429c-ad19-f75dc61cdd3e',
      '91000000-0000-4000-8000-000000000001',
      pg_temp.repair_key()
    );
  exception when invalid_parameter_value then
    failed := true;
  end;
  if not failed then
    raise exception 'La misma clave acepto identificadores diferentes.';
  end if;
end;
$$;

-- Least privilege.
do $$
begin
  if has_function_privilege(
      'anon',
      'public.repair_edgar_opening_balance_supplier_payment_v1(uuid,uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.repair_edgar_opening_balance_supplier_payment_v1(uuid,uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.repair_edgar_opening_balance_supplier_payment_v1(uuid,uuid,uuid,uuid,text)',
      'EXECUTE'
    )
  then
    raise exception 'Los grants del RPC de Edgar no respetan minimo privilegio.';
  end if;
end;
$$;

set local role authenticated;
do $$
declare
  denied boolean := false;
begin
  begin
    perform pg_temp.call_repair();
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Authenticated pudo ejecutar el RPC dirigido de Edgar.';
  end if;
end;
$$;
reset role;

-- Forced failure after entry/lines/event update must roll back everything.
create function pg_temp.fail_edgar_repair_log()
returns trigger
language plpgsql
as $$
begin
  if new.event_type =
    'accounting.directed_repair_edgar_supplier_payment_2500'
  then
    raise exception 'forced Edgar accounting log failure';
  end if;
  return new;
end;
$$;

create trigger fail_edgar_repair_log
before insert on public.accounting_event_log
for each row execute function pg_temp.fail_edgar_repair_log();

select pg_temp.expect_repair_error(
  'rollback_after_event_update',
  'forced Edgar accounting log failure'
);

drop trigger fail_edgar_repair_log on public.accounting_event_log;
drop function pg_temp.fail_edgar_repair_log();

-- Approved path, negative snapshots and idempotent replay.
do $$
declare
  first_result jsonb;
  replay_result jsonb;
  repair_entry_id uuid;
  event_errors_before jsonb;
  protected_before jsonb;
  protected_after jsonb;
begin
  select validation_errors into event_errors_before
  from public.financial_events
  where id = '1c85a425-8f28-4115-8ea3-d8217e8af897';

  protected_before := jsonb_build_object(
    'accounts_payable', pg_temp.table_fingerprint('public.accounts_payable'),
    'supplier_payments', pg_temp.table_fingerprint('public.supplier_payments'),
    'outbox', pg_temp.table_fingerprint('public.accounting_outbox_v2'),
    'inventory_movements', pg_temp.table_fingerprint('public.inventory_movements'),
    'inventory_reservations', pg_temp.table_fingerprint('public.inventory_reservations'),
    'orders', pg_temp.table_fingerprint('public.orders'),
    'order_items', pg_temp.table_fingerprint('public.order_items'),
    'invoices', pg_temp.table_fingerprint('public.invoices'),
    'payments', pg_temp.table_fingerprint('public.payments'),
    'pos_sale_drafts', pg_temp.table_fingerprint('public.pos_sale_drafts'),
    'pos_sale_draft_items', pg_temp.table_fingerprint('public.pos_sale_draft_items'),
    'products', pg_temp.table_fingerprint('public.products'),
    'audit_logs', pg_temp.table_fingerprint('public.audit_logs')
  );

  first_result := pg_temp.call_repair();
  replay_result := pg_temp.call_repair();
  repair_entry_id := (first_result->>'journal_entry_id')::uuid;

  protected_after := jsonb_build_object(
    'accounts_payable', pg_temp.table_fingerprint('public.accounts_payable'),
    'supplier_payments', pg_temp.table_fingerprint('public.supplier_payments'),
    'outbox', pg_temp.table_fingerprint('public.accounting_outbox_v2'),
    'inventory_movements', pg_temp.table_fingerprint('public.inventory_movements'),
    'inventory_reservations', pg_temp.table_fingerprint('public.inventory_reservations'),
    'orders', pg_temp.table_fingerprint('public.orders'),
    'order_items', pg_temp.table_fingerprint('public.order_items'),
    'invoices', pg_temp.table_fingerprint('public.invoices'),
    'payments', pg_temp.table_fingerprint('public.payments'),
    'pos_sale_drafts', pg_temp.table_fingerprint('public.pos_sale_drafts'),
    'pos_sale_draft_items', pg_temp.table_fingerprint('public.pos_sale_draft_items'),
    'products', pg_temp.table_fingerprint('public.products'),
    'audit_logs', pg_temp.table_fingerprint('public.audit_logs')
  );

  if protected_before <> protected_after then
    raise exception 'La reparacion modifico una tabla protegida: antes %, despues %',
      protected_before, protected_after;
  end if;

  if first_result->>'status' <> 'repaired'
    or (first_result->>'idempotent_replay')::boolean
    or replay_result->>'status' <> 'already_repaired'
    or not (replay_result->>'idempotent_replay')::boolean
    or (replay_result->>'journal_entry_id')::uuid <> repair_entry_id
    or (first_result->>'total_debit')::numeric <> 2500.00
    or (first_result->>'total_credit')::numeric <> 2500.00
    or (first_result->>'difference')::numeric <> 0.00
  then
    raise exception 'El camino aprobado o replay no fue idempotente: %, %',
      first_result, replay_result;
  end if;

  if (
      select count(*) from public.journal_entries
      where metadata->>'repair_contract'
        = 'edgar_opening_balance_supplier_payment_2500_v1'
    ) <> 1
    or (
      select count(*) from public.journal_entry_lines
      where journal_entry_id = repair_entry_id
    ) <> 2
    or (
      select count(*) from public.accounting_event_log
      where event_type =
        'accounting.directed_repair_edgar_supplier_payment_2500'
    ) <> 1
  then
    raise exception 'La reparacion creo filas adicionales.';
  end if;

  if (
      select status <> 'borrador'
        or entry_date <> date '2026-07-13'
        or posted_at is not null
        or posted_by is not null
        or source_type <> 'financial_event'
        or source_id <> '1c85a425-8f28-4115-8ea3-d8217e8af897'
      from public.journal_entries
      where id = repair_entry_id
    )
  then
    raise exception 'El borrador no conserva fecha, fuente o publicacion manual.';
  end if;

  if not exists (
      select 1 from public.journal_entry_lines
      where journal_entry_id = repair_entry_id
        and account_id = '05847d56-7097-492b-b153-2db33a00b9cd'
        and vendor_id = '97226fc4-4e67-48d1-8108-33a511e5f2e2'
        and debit = 2500.00 and credit = 0.00
    )
    or not exists (
      select 1 from public.journal_entry_lines
      where journal_entry_id = repair_entry_id
        and account_id = 'f5d451ec-4985-4c07-97a1-6d8e0a0fadf6'
        and vendor_id = '97226fc4-4e67-48d1-8108-33a511e5f2e2'
        and debit = 0.00 and credit = 2500.00
    )
  then
    raise exception 'Las lineas exactas de Edgar no fueron creadas.';
  end if;

  if (
      select status <> 'draft_created'
        or journal_entry_id <> repair_entry_id
        or validation_errors is distinct from event_errors_before
      from public.financial_events
      where id = '1c85a425-8f28-4115-8ea3-d8217e8af897'
    )
  then
    raise exception 'El evento V1 no fue reutilizado o perdio su validacion.';
  end if;

  if (
      select count(*) from public.financial_events
      where source_type = 'supplier_payment'
        and source_id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1'
    ) <> 1
    or (
      select count(*) from public.accounting_outbox_v2
      where source_type = 'supplier_payment'
        and source_id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1'
    ) <> 0
  then
    raise exception 'Se creo evento adicional u outbox V2.';
  end if;

  if (
      select count(*) <> 1
        or min(total_amount) <> 656938.41
        or min(paid_amount) <> 2500.00
        or min(balance) <> 654438.41
        or min(status) <> 'partial'
      from public.accounts_payable
      where id = 'a2250e0c-7718-4203-92a1-178429a86018'
    )
    or (
      select count(*) <> 1
        or min(amount) <> 2500.00
        or min(status) <> 'paid'
        or min(paid_at) <> '2026-07-13 06:00:00+00'::timestamptz
      from public.supplier_payments
      where id = '3b88e1ac-74ae-460e-a399-3d1e0c0189e1'
    )
  then
    raise exception 'La CxP o el pago de Edgar cambiaron.';
  end if;
end;
$$;

select ok(true, 'Edgar repair invariants, rollback and idempotency');
select * from finish();

rollback;

\echo 'Edgar opening-balance supplier-payment repair: OK'
