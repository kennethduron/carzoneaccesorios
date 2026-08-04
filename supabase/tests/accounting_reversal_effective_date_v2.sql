\set ON_ERROR_STOP on

begin;

select plan(1);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '61000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'reversal-effective-date@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    full_name = 'REVERSAL-DATE-REPAIR-LOCAL-ONLY',
    email = 'reversal-effective-date@example.test', active = true
where id = '61000000-0000-0000-0000-000000000001';

select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

insert into public.accounting_accounts (id, code, name, type, normal_balance, created_by)
values
  ('62000000-0000-0000-0000-000000000001', 'REV-DATE-DR', 'REVERSAL DATE DEBIT', 'asset', 'debit', '61000000-0000-0000-0000-000000000001'),
  ('62000000-0000-0000-0000-000000000002', 'REV-DATE-CR', 'REVERSAL DATE CREDIT', 'liability', 'credit', '61000000-0000-0000-0000-000000000001');

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, posted_by, posted_at, metadata
) values (
  '63000000-0000-0000-0000-000000000001', 'REV-DATE-ORIGINAL', '2026-07-31',
  'REVERSAL-DATE-REPAIR-LOCAL-ONLY original', 'borrador', 'manual', 'reversal-date-v2',
  '61000000-0000-0000-0000-000000000001', null, null, '{}'::jsonb
), (
  '63000000-0000-0000-0000-000000000002', 'REV-DATE-DRAFT', '2026-07-31',
  'REVERSAL-DATE-REPAIR-LOCAL-ONLY draft', 'borrador', 'manual', 'reversal-date-v2-draft',
  '61000000-0000-0000-0000-000000000001', null, null, '{}'::jsonb
), (
  '63000000-0000-0000-0000-000000000003', 'REV-DATE-VERSION', '2026-07-31',
  'REVERSAL-DATE-REPAIR-LOCAL-ONLY version', 'borrador', 'manual', 'reversal-date-v2-version',
  '61000000-0000-0000-0000-000000000001', null, null, '{}'::jsonb
);

insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
select entry_id, account_id, debit, credit, description
from (values
  ('63000000-0000-0000-0000-000000000001'::uuid, '62000000-0000-0000-0000-000000000001'::uuid, 12800.00, 0.00, 'Original debit'),
  ('63000000-0000-0000-0000-000000000001'::uuid, '62000000-0000-0000-0000-000000000002'::uuid, 0.00, 12800.00, 'Original credit'),
  ('63000000-0000-0000-0000-000000000002'::uuid, '62000000-0000-0000-0000-000000000001'::uuid, 100.00, 0.00, 'Draft debit'),
  ('63000000-0000-0000-0000-000000000002'::uuid, '62000000-0000-0000-0000-000000000002'::uuid, 0.00, 100.00, 'Draft credit'),
  ('63000000-0000-0000-0000-000000000003'::uuid, '62000000-0000-0000-0000-000000000001'::uuid, 200.00, 0.00, 'Version debit'),
  ('63000000-0000-0000-0000-000000000003'::uuid, '62000000-0000-0000-0000-000000000002'::uuid, 0.00, 200.00, 'Version credit')
) fixture(entry_id, account_id, debit, credit, description);

update public.journal_entries
set status = 'publicada', posted_by = '61000000-0000-0000-0000-000000000001', posted_at = now()
where id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000003');

do $contract$
declare
  expected_version bigint;
  version_entry_version bigint;
  first_response jsonb;
  retry_response jsonb;
  reversal public.journal_entries%rowtype;
  original public.journal_entries%rowtype;
  original_lines_before text;
  original_lines_after text;
  inverse_count integer;
  technical_created_at timestamptz;
  retry_number integer;
begin
  select version into expected_version from public.journal_entries
  where id = '63000000-0000-0000-0000-000000000001';
  select version into version_entry_version from public.journal_entries
  where id = '63000000-0000-0000-0000-000000000003';

  select encode(extensions.digest(string_agg(to_jsonb(line)::text, E'\n' order by line.id), 'sha256'), 'hex')
  into original_lines_before
  from public.journal_entry_lines line
  where line.journal_entry_id = '63000000-0000-0000-0000-000000000001';

  first_response := public.reverse_journal_entry_v2(
    '63000000-0000-0000-0000-000000000001',
    'Corrección técnica con fecha efectiva elegida explícitamente',
    '2026-07-31',
    '64000000-0000-0000-0000-000000000001',
    expected_version,
    '127.0.0.1',
    'reversal-effective-date-contract'
  );

  for retry_number in 1..5 loop
    retry_response := public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000001',
      'Corrección técnica con fecha efectiva elegida explícitamente',
      '2026-07-31',
      '64000000-0000-0000-0000-000000000001',
      expected_version,
      '127.0.0.1',
      'reversal-effective-date-contract-retry'
    );
  end loop;

  if first_response is distinct from retry_response then
    raise exception 'El reintento idempotente no devolvió la respuesta original.';
  end if;
  if first_response->>'effective_date' <> '2026-07-31'
     or first_response->>'status' <> 'publicada'
     or first_response->>'entry_number' is null
     or first_response->>'created_at' is null then
    raise exception 'La respuesta V2 no conserva el contrato requerido.';
  end if;

  select * into strict original from public.journal_entries
  where id = '63000000-0000-0000-0000-000000000001';
  select * into strict reversal from public.journal_entries
  where id = (first_response->>'reversal_entry_id')::uuid;
  technical_created_at := (first_response->>'created_at')::timestamptz;

  if original.status <> 'reversada' or original.reversed_entry_id <> reversal.id then
    raise exception 'La original no quedó reversada exactamente una vez.';
  end if;
  if reversal.status <> 'publicada' or reversal.entry_date <> '2026-07-31'
     or reversal.source_id <> original.id::text
     or reversal.metadata->>'reversal_effective_date' <> '2026-07-31'
     or reversal.metadata->>'original_entry_date' <> '2026-07-31'
     or reversal.metadata->>'reversal_request_key' <> '64000000-0000-0000-0000-000000000001'
     or reversal.created_at > technical_created_at + interval '1 second' then
    raise exception 'La reversión no separó correctamente fecha efectiva y fecha técnica.';
  end if;

  select count(*) into inverse_count
  from public.journal_entry_lines source_line
  join public.journal_entry_lines reversal_line
    on reversal_line.journal_entry_id = reversal.id
   and reversal_line.account_id = source_line.account_id
   and reversal_line.debit = source_line.credit
   and reversal_line.credit = source_line.debit
  where source_line.journal_entry_id = original.id;
  if inverse_count <> 2 then
    raise exception 'Las líneas V2 no son el inverso exacto.';
  end if;

  select encode(extensions.digest(string_agg(to_jsonb(line)::text, E'\n' order by line.id), 'sha256'), 'hex')
  into original_lines_after
  from public.journal_entry_lines line where line.journal_entry_id = original.id;
  if original_lines_after <> original_lines_before then
    raise exception 'Las líneas originales fueron modificadas.';
  end if;
  if (select count(*) from public.accounting_reversal_requests
      where original_entry_id = original.id and status = 'completed') <> 1
     or (select count(*) from public.journal_entries
         where source_type = 'journal_reversal' and source_id = original.id::text) <> 1 then
    raise exception 'Cinco reintentos no quedarían protegidos por una única solicitud/reversión.';
  end if;

  begin
    perform public.reverse_journal_entry_v2(
      original.id, 'Corrección técnica con fecha efectiva elegida explícitamente',
      '2026-07-30', '64000000-0000-0000-0000-000000000001', expected_version, null, null
    );
    raise exception 'Se reutilizó una request key con payload distinto.';
  exception when sqlstate '22023' then
    if sqlerrm <> 'REVERSAL_IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;

  begin
    perform public.reverse_journal_entry_v2(
      original.id, 'Nuevo intento con otra llave sobre partida reversada',
      '2026-07-31', '64000000-0000-0000-0000-000000000008', expected_version, null, null
    );
    raise exception 'Se aceptó otra request key para la misma partida.';
  exception when sqlstate '22023' then
    if sqlerrm <> 'REVERSAL_ALREADY_EXISTS' then raise; end if;
  end;

  begin
    perform public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000002', 'Motivo válido para borrador',
      '2026-07-31', '64000000-0000-0000-0000-000000000002', 1, null, null
    );
    raise exception 'Se reversó una partida en borrador.';
  exception when sqlstate '22023' then
    if sqlerrm <> 'REVERSAL_ENTRY_NOT_PUBLISHED' then raise; end if;
  end;

  begin
    perform public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000003', 'Motivo válido para versión conflictiva',
      '2026-07-31', '64000000-0000-0000-0000-000000000003', version_entry_version + 1, null, null
    );
    raise exception 'Se aceptó una versión obsoleta.';
  exception when sqlstate '40001' then
    if sqlerrm <> 'REVERSAL_VERSION_CONFLICT' then raise; end if;
  end;

  begin
    perform public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000003', 'Motivo válido con fecha faltante',
      null, '64000000-0000-0000-0000-000000000004', version_entry_version, null, null
    );
    raise exception 'Se aceptó una fecha efectiva nula.';
  exception when sqlstate '22023' then
    if sqlerrm <> 'REVERSAL_EFFECTIVE_DATE_REQUIRED' then raise; end if;
  end;

  begin
    perform public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000003', 'Motivo válido con fecha futura',
      '2999-01-01', '64000000-0000-0000-0000-000000000005', version_entry_version, null, null
    );
    raise exception 'Se aceptó una fecha efectiva futura.';
  exception when sqlstate '22023' then
    if sqlerrm <> 'REVERSAL_EFFECTIVE_DATE_IN_FUTURE' then raise; end if;
  end;

  insert into public.accounting_periods (
    id, name, period_type, fiscal_year, start_date, end_date, status, created_by
  ) values (
    '65000000-0000-0000-0000-000000000001', 'REVERSAL DATE CLOSED LOCAL',
    'monthly', 2026, '2026-06-01', '2026-06-30', 'open',
    '61000000-0000-0000-0000-000000000001'
  );
  update public.accounting_periods
  set status = 'closed', closed_at = now(), closed_by = '61000000-0000-0000-0000-000000000001'
  where id = '65000000-0000-0000-0000-000000000001';

  begin
    perform public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000003', 'Motivo válido para período cerrado',
      '2026-06-15', '64000000-0000-0000-0000-000000000006', version_entry_version, null, null
    );
    raise exception 'Se aceptó una fecha dentro de un período cerrado.';
  exception when sqlstate '22023' then
    if sqlerrm <> 'REVERSAL_ACCOUNTING_PERIOD_CLOSED' then raise; end if;
  end;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"66000000-0000-0000-0000-000000000001","role":"authenticated"}',
    true
  );
  begin
    perform public.reverse_journal_entry_v2(
      '63000000-0000-0000-0000-000000000003', 'Motivo válido sin permiso contable',
      '2026-07-31', '64000000-0000-0000-0000-000000000007', version_entry_version, null, null
    );
    raise exception 'Se aceptó un actor sin permiso accounting:reverse.';
  exception when sqlstate '42501' then
    if sqlerrm <> 'REVERSAL_PERMISSION_DENIED' then raise; end if;
  end;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"61000000-0000-0000-0000-000000000001","role":"authenticated"}',
    true
  );

  if (select count(*) from public.accounting_event_log
      where event_type = 'journal_reversal.created_v2'
        and entity_id = reversal.id
        and metadata->>'original_entry_date' = '2026-07-31'
        and metadata->>'reversal_effective_date' = '2026-07-31'
        and metadata->>'reversal_technical_created_at' is not null
        and metadata->>'reversal_request_key' = '64000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'El event log V2 no separó fechas y request key.';
  end if;
  if (select count(*) from public.audit_logs
      where table_name = 'journal_entries'
        and record_id = reversal.id
        and action = 'accounting.journal_reversal.created_v2') <> 1 then
    raise exception 'La auditoría V2 no registró una única reversión.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.reverse_journal_entry_v2(uuid,text,date,uuid,bigint,text,text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.reverse_journal_entry_v2(uuid,text,date,uuid,bigint,text,text)',
    'execute'
  ) then
    raise exception 'Los privilegios del RPC V2 no son mínimos.';
  end if;
end;
$contract$;

select pass('Explicit effective-date reversal V2: civil date, permission, versioning, immutability and idempotency');
select * from finish();

rollback;

\echo 'Accounting reversal effective-date V2 contract: OK'
