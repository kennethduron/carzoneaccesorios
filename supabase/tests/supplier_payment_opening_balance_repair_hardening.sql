\set ON_ERROR_STOP on

begin;
select plan(1);
\ir fixtures/supplier_payment_opening_balance_repair_fixture.sql.inc

create or replace function pg_temp.expect_repair_error(
  case_name text,
  expected_message text
)
returns void
language plpgsql
as $$
declare
  failed boolean := false;
  repair_entries_before integer;
  repair_lines_before integer;
  repair_logs_before integer;
  event_status_before text;
  event_entry_before uuid;
begin
  select count(*) into repair_entries_before
  from public.journal_entries
  where metadata->>'repair_contract' = 'supplier_payment_9800_opening_balance_v2';

  select count(*) into repair_lines_before
  from public.journal_entry_lines line
  join public.journal_entries entry on entry.id = line.journal_entry_id
  where entry.metadata->>'repair_contract'
    = 'supplier_payment_9800_opening_balance_v2';

  select count(*) into repair_logs_before
  from public.accounting_event_log
  where event_type = 'accounting.directed_repair_supplier_payment_9800';

  select status, journal_entry_id
  into event_status_before, event_entry_before
  from public.financial_events
  where id = '6dd1e200-f628-450e-8bfc-f8a6c700b442';

  begin
    perform public.repair_existing_supplier_card_payment_v1(
      'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
      '6dd1e200-f628-450e-8bfc-f8a6c700b442',
      '5843045f-db47-429c-ad19-f75dc61cdd3e',
      '91000000-0000-4000-8000-000000000001'
    );
  exception when others then
    failed := true;
    if position(expected_message in sqlerrm) = 0 then
      raise exception '%: error inesperado: %', case_name, sqlerrm;
    end if;
  end;

  if not failed then
    raise exception '%: el RPC acepto evidencia invalida', case_name;
  end if;

  if (
      select count(*)
      from public.journal_entries
      where metadata->>'repair_contract'
        = 'supplier_payment_9800_opening_balance_v2'
    ) <> repair_entries_before
    or (
      select count(*)
      from public.journal_entry_lines line
      join public.journal_entries entry on entry.id = line.journal_entry_id
      where entry.metadata->>'repair_contract'
        = 'supplier_payment_9800_opening_balance_v2'
    ) <> repair_lines_before
    or (
      select count(*)
      from public.accounting_event_log
      where event_type = 'accounting.directed_repair_supplier_payment_9800'
    ) <> repair_logs_before
    or (
      select status from public.financial_events
      where id = '6dd1e200-f628-450e-8bfc-f8a6c700b442'
    ) is distinct from event_status_before
    or (
      select journal_entry_id from public.financial_events
      where id = '6dd1e200-f628-450e-8bfc-f8a6c700b442'
    ) is distinct from event_entry_before
  then
    raise exception '%: el error dejo escritura parcial', case_name;
  end if;
end;
$$;

do $$
declare
  auxiliary_count integer;
  auxiliary_total numeric;
  auxiliary_hash text;
begin
  select
    count(*),
    round(sum(total_amount), 2),
    encode(
      extensions.digest(
        convert_to(string_agg(id::text, ',' order by id), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  into auxiliary_count, auxiliary_total, auxiliary_hash
  from public.accounts_payable;

  if auxiliary_count <> 26
    or auxiliary_total <> 1589972.61
    or auxiliary_hash
      <> '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd'
  then
    raise exception 'El fixture aprobado no reproduce conteo, total y hash: %, %, %',
      auxiliary_count, auxiliary_total, auxiliary_hash;
  end if;
end;
$$;

-- Diferencia exacta de un centavo.
savepoint difference_one_cent;
update public.accounts_payable
set total_amount = total_amount + 0.01
where id = '96a95d10-d4c6-4f2d-ac48-0e904e619cf4';
select pg_temp.expect_repair_error(
  'difference_one_cent',
  'El total del auxiliar inicial no coincide.'
);
rollback to savepoint difference_one_cent;

-- Partida inicial no publicada.
savepoint opening_not_published;
set local session_replication_role = replica;
update public.journal_entries
set status = 'borrador', posted_at = null, posted_by = null
where id = '5843045f-db47-429c-ad19-f75dc61cdd3e';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'opening_not_published',
  'La partida inicial aprobada cambio o dejo de estar publicada.'
);
rollback to savepoint opening_not_published;

-- Cuenta control incorrecta.
savepoint wrong_control_account;
set local session_replication_role = replica;
update public.journal_entry_lines
set account_id = '92000000-0000-4000-8000-000000000003'
where id = 'f7389203-9ac0-40b8-9822-edfceb0e38fb';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'wrong_control_account',
  'La linea de control 2101001 no coincide'
);
rollback to savepoint wrong_control_account;

-- Total auxiliar incorrecto.
savepoint wrong_auxiliary_total;
update public.accounts_payable
set total_amount = total_amount + 100
where id = '96a95d10-d4c6-4f2d-ac48-0e904e619cf4';
select pg_temp.expect_repair_error(
  'wrong_auxiliary_total',
  'El total del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_auxiliary_total;

-- Cantidad de obligaciones incorrecta sin alterar el total.
savepoint wrong_auxiliary_count;
insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency, created_at
) values (
  '99000000-0000-4000-8000-000000000001',
  '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
  0, 0, 'pending', 'HNL', '2026-07-14 19:00:26+00'
);
select pg_temp.expect_repair_error(
  'wrong_auxiliary_count',
  'La cantidad del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_auxiliary_count;

-- Hash incorrecto con conteo, proveedores y total sin cambios.
savepoint wrong_auxiliary_hash;
update public.accounts_payable
set id = '99000000-0000-4000-8000-000000000002'
where id = '96a95d10-d4c6-4f2d-ac48-0e904e619cf4';
select pg_temp.expect_repair_error(
  'wrong_auxiliary_hash',
  'El hash del auxiliar inicial no coincide.'
);
rollback to savepoint wrong_auxiliary_hash;

-- Proveedor normalizado duplicado.
savepoint duplicate_supplier;
insert into public.suppliers (id, name, is_active)
values (
  '99000000-0000-4000-8000-000000000003',
  'CROMOS  TORRE FUERTE',
  true
);
select pg_temp.expect_repair_error(
  'duplicate_supplier',
  'CROMOS TORRE FUERTE no es un proveedor inequivoco.'
);
rollback to savepoint duplicate_supplier;

-- Segunda obligacion L 73,200 manteniendo intactos conteo, total y hash.
savepoint duplicate_payable;
update public.accounts_payable
set supplier_id = '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    total_amount = 73200
where id = '96a95d10-d4c6-4f2d-ac48-0e904e619cf4';
update public.accounts_payable
set total_amount = total_amount - 67200
where id = 'a2250e0c-7718-4203-92a1-178429a86018';
select pg_temp.expect_repair_error(
  'duplicate_payable',
  'La obligacion de CROMOS no es unica.'
);
rollback to savepoint duplicate_payable;

-- Pago duplicado.
savepoint duplicate_payment;
set local session_replication_role = replica;
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at
) values (
  '99000000-0000-4000-8000-000000000004',
  '5421d871-4ab4-49f6-a778-99bdbe0f609e',
  '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
  9800, 'TARJETA', 'card_credit', 'paid', '2026-07-12 12:00:00-06'
);
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'duplicate_payment',
  'El pago historico de CROMOS no es unico.'
);
rollback to savepoint duplicate_payment;

-- Evento duplicado para el mismo pago.
savepoint duplicate_event;
insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status
) values (
  '99000000-0000-4000-8000-000000000005',
  'supplier_payment',
  'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
  'supplier_payment_duplicate',
  'v1',
  'pending'
);
select pg_temp.expect_repair_error(
  'duplicate_event',
  'El evento financiero del pago no es unico.'
);
rollback to savepoint duplicate_event;

-- Borrador ya vinculado por source.
savepoint existing_draft;
insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by
) values (
  '99000000-0000-4000-8000-000000000006',
  'TEST-EXISTING-DRAFT',
  '2026-07-12',
  'Borrador incompatible prueba',
  'borrador',
  'financial_event',
  '6dd1e200-f628-450e-8bfc-f8a6c700b442',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001'
);
select pg_temp.expect_repair_error(
  'existing_draft',
  'Ya existe una partida candidata o incompatible para el pago.'
);
rollback to savepoint existing_draft;

-- Partida publicada ya asociada directamente al pago.
savepoint existing_posted_entry;
set local session_replication_role = replica;
insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by, posted_by, posted_at
) values (
  '99000000-0000-4000-8000-000000000007',
  'TEST-EXISTING-POSTED',
  '2026-07-12',
  'Partida publicada incompatible prueba',
  'publicada',
  'supplier_payment',
  'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  now()
);
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'existing_posted_entry',
  'Ya existe una partida candidata o incompatible para el pago.'
);
rollback to savepoint existing_posted_entry;

-- Metodo v2 incompatible.
savepoint wrong_method;
set local session_replication_role = replica;
update public.supplier_payments
set payment_method_v2 = 'card_debit'
where id = 'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804';
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'wrong_method',
  'El pago historico dirigido cambio.'
);
rollback to savepoint wrong_method;

-- Cuenta de tarjeta incompatible.
savepoint wrong_card_account;
update public.accounting_mappings
set account_id = '92000000-0000-4000-8000-000000000003'
where mapping_type = 'payment_method'
  and source_key = 'supplier_payment_card';
select pg_temp.expect_repair_error(
  'wrong_card_account',
  'Las cuentas contables dirigidas no coinciden.'
);
rollback to savepoint wrong_card_account;

-- Periodo cerrado.
savepoint closed_period;
set local session_replication_role = replica;
insert into public.accounting_periods (
  name, start_date, end_date, status, period_type, fiscal_year,
  closed_by, closed_at
) values (
  'Julio 2026 cerrado prueba',
  '2026-07-01', '2026-07-31', 'closed', 'monthly', 2026,
  '91000000-0000-4000-8000-000000000001', now()
);
set local session_replication_role = origin;
select pg_temp.expect_repair_error(
  'closed_period',
  'El periodo contable de la reparacion esta cerrado.'
);
rollback to savepoint closed_period;

-- RLS/grants: ningun cliente publico puede invocar el RPC.
do $$
begin
  if has_function_privilege(
      'anon',
      'public.repair_existing_supplier_card_payment_v1(uuid,uuid,uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.repair_existing_supplier_card_payment_v1(uuid,uuid,uuid,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.repair_existing_supplier_card_payment_v1(uuid,uuid,uuid,uuid)',
      'EXECUTE'
    )
  then
    raise exception 'Los grants del RPC no respetan minimo privilegio.';
  end if;
end;
$$;

set local role authenticated;
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.repair_existing_supplier_card_payment_v1(
      'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
      '6dd1e200-f628-450e-8bfc-f8a6c700b442',
      '5843045f-db47-429c-ad19-f75dc61cdd3e',
      '91000000-0000-4000-8000-000000000001'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Authenticated pudo ejecutar el RPC dirigido.';
  end if;
end;
$$;
reset role;

-- Error al final del RPC: toda la partida, lineas y transicion se revierten.
create function pg_temp.fail_directed_repair_log()
returns trigger
language plpgsql
as $$
begin
  if new.event_type = 'accounting.directed_repair_supplier_payment_9800' then
    raise exception 'forced accounting log failure';
  end if;
  return new;
end;
$$;

create trigger fail_directed_repair_log
before insert on public.accounting_event_log
for each row execute function pg_temp.fail_directed_repair_log();

select pg_temp.expect_repair_error(
  'rollback_after_event_update',
  'forced accounting log failure'
);

drop trigger fail_directed_repair_log on public.accounting_event_log;
drop function pg_temp.fail_directed_repair_log();

-- Camino aprobado y replay idempotente.
do $$
declare
  first_result jsonb;
  replay_result jsonb;
  repair_entry_id uuid;
  entry_metadata jsonb;
begin
  first_result := public.repair_existing_supplier_card_payment_v1(
    'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
    '6dd1e200-f628-450e-8bfc-f8a6c700b442',
    '5843045f-db47-429c-ad19-f75dc61cdd3e',
    '91000000-0000-4000-8000-000000000001'
  );
  replay_result := public.repair_existing_supplier_card_payment_v1(
    'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
    '6dd1e200-f628-450e-8bfc-f8a6c700b442',
    '5843045f-db47-429c-ad19-f75dc61cdd3e',
    '91000000-0000-4000-8000-000000000001'
  );
  repair_entry_id := (first_result->>'journal_entry_id')::uuid;

  select metadata into entry_metadata
  from public.journal_entries
  where id = repair_entry_id;

  if first_result->>'status' <> 'repaired'
    or (first_result->>'idempotent_replay')::boolean
    or replay_result->>'status' <> 'already_repaired'
    or not (replay_result->>'idempotent_replay')::boolean
    or (replay_result->>'journal_entry_id')::uuid <> repair_entry_id
    or (
      select count(*) from public.journal_entries
      where metadata->>'repair_contract'
        = 'supplier_payment_9800_opening_balance_v2'
    ) <> 1
    or (
      select count(*) from public.journal_entry_lines
      where journal_entry_id = repair_entry_id
    ) <> 2
    or (
      select count(*) from public.accounting_event_log
      where event_type = 'accounting.directed_repair_supplier_payment_9800'
    ) <> 1
  then
    raise exception 'La ejecucion doble no fue idempotente: %, %',
      first_result, replay_result;
  end if;

  if (
      select status <> 'borrador'
        or entry_date <> date '2026-07-12'
        or posted_at is not null
        or posted_by is not null
      from public.journal_entries
      where id = repair_entry_id
    )
    or coalesce(
      (entry_metadata->>'manual_publication_required')::boolean,
      false
    ) is not true
    or entry_metadata ? 'auto_post'
    or entry_metadata->>'evidence_type'
      <> 'opening_balance_control_account_reconciliation'
    or entry_metadata->>'opening_auxiliary_hash'
      <> '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd'
    or (entry_metadata->>'reconciliation_difference')::numeric <> 0
  then
    raise exception 'El borrador o su evidencia no exige publicacion manual.';
  end if;

  if not exists (
      select 1 from public.journal_entry_lines
      where journal_entry_id = repair_entry_id
        and account_id = '05847d56-7097-492b-b153-2db33a00b9cd'
        and debit = 9800 and credit = 0
    )
    or not exists (
      select 1 from public.journal_entry_lines
      where journal_entry_id = repair_entry_id
        and account_id = 'a84f16c1-42da-4ed5-bca8-d3b20c5c3733'
        and debit = 0 and credit = 9800
    )
  then
    raise exception 'Las dos lineas del borrador no son exactas.';
  end if;

  if (
      select status <> 'draft_created'
        or journal_entry_id <> repair_entry_id
      from public.financial_events
      where id = '6dd1e200-f628-450e-8bfc-f8a6c700b442'
    )
  then
    raise exception 'El evento no quedo vinculado como draft_created.';
  end if;
end;
$$;

-- Invariantes operativas y ausencia de procesamiento automatico.
do $$
begin
  if (
      select count(*) <> 1
        or min(amount) <> 9800
        or min(status) <> 'paid'
      from public.supplier_payments
      where id = 'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804'
    )
    or (
      select count(*) <> 1
        or min(total_amount) <> 73200
        or min(paid_amount) <> 9800
        or min(balance) <> 63400
        or min(status) <> 'partial'
      from public.accounts_payable
      where id = '5421d871-4ab4-49f6-a778-99bdbe0f609e'
    )
    or (
      select count(*) <> 1
      from public.journal_entries
      where id = '5843045f-db47-429c-ad19-f75dc61cdd3e'
        and status = 'publicada'
    )
    or (select count(*) from public.accounting_outbox_v2) <> 0
  then
    raise exception 'La reparacion altero una operacion o creo outbox historica.';
  end if;
end;
$$;

select pass('Supplier payment opening-balance repair hardening contract');
select * from finish();

rollback;

\echo 'Supplier payment opening-balance repair hardening: OK'
