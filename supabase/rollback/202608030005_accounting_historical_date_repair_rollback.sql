-- Compensating rollback for 202608030004_accounting_historical_date_repair.sql.
-- Do not apply unless the verified post-deployment state requires restoration.

begin;

do $rollback$
declare
  target_hash constant text := '45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857';
  rollback_name constant text := '202608030005_accounting_historical_date_repair_rollback.sql';
  batch public.accounting_entry_date_repair_batches%rowtype;
  before_row record;
  migration_role name := current_user;
  transaction_marker text := txid_current()::text;
  strict_guard_definition text;
  supplier_observer_definition text;
  opening_observer_definition text;
  strict_guard_hash text;
  supplier_observer_hash text;
  opening_observer_hash text;
  guard_rejected boolean := false;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'accounting_historical_date_repair:' || target_hash, 0
  ));
  select * into batch
  from public.accounting_entry_date_repair_batches
  where manifest_hash = target_hash
  for update;
  if batch.manifest_hash is null then
    raise exception using errcode = '22023', message = 'ACCOUNTING_DATE_REPAIR_BATCH_NOT_FOUND';
  end if;
  if batch.status = 'rolled_back'
    and (select count(*) from public.accounting_entry_date_repairs
      where manifest_hash = target_hash and action = 'rollback') = 37
  then
    raise notice 'ACCOUNTING_DATE_REPAIR_ROLLBACK_ALREADY_APPLIED';
    return;
  end if;
  if batch.status <> 'applied'
    or (select count(*) from public.accounting_entry_date_repairs
      where manifest_hash = target_hash and action = 'repair') <> 37
    or exists (select 1 from public.accounting_entry_date_repairs
      where manifest_hash = target_hash and action = 'rollback')
  then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_ROLLBACK_STATE_INVALID';
  end if;

  lock table public.journal_entries in access exclusive mode;
  lock table public.journal_entry_lines in share mode;
  lock table public.financial_events in share row exclusive mode;
  lock table public.accounting_outbox_v2 in share row exclusive mode;

  if exists (
    select 1
    from public.accounting_entry_date_repair_manifest manifest
    join public.journal_entries entry on entry.id = manifest.journal_entry_id
    join public.financial_events event on event.id = manifest.financial_event_id
    left join public.accounting_outbox_v2 box on box.id = manifest.accounting_outbox_id
    where manifest.manifest_hash = target_hash
      and (entry.status <> 'publicada'
        or entry.reversed_entry_id is not null
        or exists (select 1 from public.journal_entries reversal
          where reversal.source_type = 'journal_reversal'
            and reversal.source_id = entry.id::text)
        or entry.entry_date is distinct from manifest.new_accounting_date
        or event.accounting_date is distinct from manifest.new_accounting_date
        or (manifest.accounting_outbox_id is not null and (
          box.accounting_date is distinct from manifest.new_accounting_date
          or box.accounting_date_source is distinct from manifest.accounting_date_source))
        or public.accounting_entry_date_repair_line_hash_v1(entry.id) <> manifest.line_hash)
  ) then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_ROLLBACK_PRECONDITION_FAILED';
  end if;

  create temporary table accounting_entry_date_rollback_before
  on commit drop
  as
  select manifest.journal_entry_id, manifest.financial_event_id,
    manifest.accounting_outbox_id,
    to_jsonb(entry) entry_row, to_jsonb(event) event_row,
    case when box.id is null then null else to_jsonb(box) end outbox_row
  from public.accounting_entry_date_repair_manifest manifest
  join public.journal_entries entry on entry.id = manifest.journal_entry_id
  join public.financial_events event on event.id = manifest.financial_event_id
  left join public.accounting_outbox_v2 box on box.id = manifest.accounting_outbox_id
  where manifest.manifest_hash = target_hash;

  select pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure),
    pg_get_functiondef('public.observe_supplier_payment_outbox_v2()'::regprocedure),
    pg_get_functiondef(
      'public.observe_opening_balance_supplier_payment_completion_v1()'::regprocedure
    )
  into strict_guard_definition, supplier_observer_definition,
    opening_observer_definition;
  strict_guard_hash := encode(extensions.digest(strict_guard_definition, 'sha256'), 'hex');
  supplier_observer_hash := encode(extensions.digest(
    supplier_observer_definition, 'sha256'), 'hex');
  opening_observer_hash := encode(extensions.digest(
    opening_observer_definition, 'sha256'), 'hex');

  perform set_config('app.accounting_date_repair_manifest_hash', target_hash, true);
  perform set_config('app.accounting_date_repair_transaction', transaction_marker, true);
  execute format($ddl$
    create or replace function public.guard_journal_entry_status()
    returns trigger language plpgsql
    as $restricted_guard$
    begin
      if tg_op = 'UPDATE'
        and current_user = %L
        and current_setting('app.accounting_date_repair_manifest_hash', true) = %L
        and current_setting('app.accounting_date_repair_transaction', true) = txid_current()::text
        and (to_jsonb(new) - 'entry_date') is not distinct from (to_jsonb(old) - 'entry_date')
        and exists (
          select 1 from public.accounting_entry_date_repair_manifest manifest
          where manifest.manifest_hash = %L
            and manifest.journal_entry_id = old.id
            and old.status = 'publicada'
            and old.entry_date = manifest.new_accounting_date
            and new.entry_date = manifest.old_entry_date
        )
      then return new; end if;
      if tg_op = 'DELETE' then
        if old.status <> 'borrador' then
          raise exception 'Las partidas publicadas no se eliminan. Debes registrar un reverso.';
        end if;
        return old;
      end if;
      if old.status in ('reversada', 'anulada') then
        raise exception 'Esta partida ya no admite cambios.';
      end if;
      if old.status = 'publicada' then
        if new.status = 'reversada'
          and new.reversed_entry_id is not null
          and new.entry_number = old.entry_number
          and new.entry_date = old.entry_date
          and new.description = old.description
          and coalesce(new.source_type, '') = coalesce(old.source_type, '')
          and coalesce(new.source_id, '') = coalesce(old.source_id, '')
          and new.created_by = old.created_by
          and new.posted_by = old.posted_by
          and new.posted_at = old.posted_at
        then return new; end if;
        raise exception 'Las partidas publicadas no se editan. Debes registrar un reverso.';
      end if;
      return new;
    end;
    $restricted_guard$
  $ddl$, migration_role, target_hash, target_hash);
  execute $observer$
    create or replace function public.observe_supplier_payment_outbox_v2()
    returns trigger language plpgsql security definer
    set search_path = public, pg_temp
    as $body$ begin return new; end; $body$
  $observer$;
  execute $observer$
    create or replace function public.observe_opening_balance_supplier_payment_completion_v1()
    returns trigger language plpgsql security definer
    set search_path = public, pg_temp
    as $body$ begin return new; end; $body$
  $observer$;

  update public.financial_events event
  set accounting_date = manifest.old_event_accounting_date
  from public.accounting_entry_date_repair_manifest manifest
  where manifest.manifest_hash = target_hash
    and event.id = manifest.financial_event_id;
  update public.accounting_outbox_v2 box
  set accounting_date = manifest.old_outbox_accounting_date,
      accounting_date_source = null
  from public.accounting_entry_date_repair_manifest manifest
  where manifest.manifest_hash = target_hash
    and manifest.accounting_outbox_id is not null
    and box.id = manifest.accounting_outbox_id;
  update public.journal_entries entry
  set entry_date = manifest.old_entry_date
  from public.accounting_entry_date_repair_manifest manifest
  where manifest.manifest_hash = target_hash
    and entry.id = manifest.journal_entry_id;

  execute strict_guard_definition;
  execute supplier_observer_definition;
  execute opening_observer_definition;
  perform set_config('app.accounting_date_repair_manifest_hash', '', true);
  perform set_config('app.accounting_date_repair_transaction', '', true);
  if encode(extensions.digest(pg_get_functiondef(
      'public.guard_journal_entry_status()'::regprocedure), 'sha256'), 'hex') <> strict_guard_hash
    or encode(extensions.digest(pg_get_functiondef(
      'public.observe_supplier_payment_outbox_v2()'::regprocedure), 'sha256'), 'hex')
      <> supplier_observer_hash
    or encode(extensions.digest(pg_get_functiondef(
      'public.observe_opening_balance_supplier_payment_completion_v1()'::regprocedure
    ), 'sha256'), 'hex') <> opening_observer_hash
  then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_ROLLBACK_GUARD_RESTORE_FAILED';
  end if;

  if exists (
    select 1
    from public.accounting_entry_date_repair_manifest manifest
    join public.journal_entries entry on entry.id = manifest.journal_entry_id
    join public.financial_events event on event.id = manifest.financial_event_id
    left join public.accounting_outbox_v2 box on box.id = manifest.accounting_outbox_id
    join pg_temp.accounting_entry_date_rollback_before snapshot
      on snapshot.journal_entry_id = manifest.journal_entry_id
    where manifest.manifest_hash = target_hash
      and (entry.entry_date is distinct from manifest.old_entry_date
        or event.accounting_date is distinct from manifest.old_event_accounting_date
        or (manifest.accounting_outbox_id is not null and (
          box.accounting_date is distinct from manifest.old_outbox_accounting_date
          or box.accounting_date_source is not null))
        or public.accounting_entry_date_repair_line_hash_v1(entry.id) <> manifest.line_hash
        or (to_jsonb(entry) - 'entry_date' - 'updated_at')
          is distinct from (snapshot.entry_row - 'entry_date' - 'updated_at')
        or (to_jsonb(event) - 'accounting_date' - 'updated_at')
          is distinct from (snapshot.event_row - 'accounting_date' - 'updated_at')
        or (manifest.accounting_outbox_id is not null
          and (to_jsonb(box) - 'accounting_date' - 'accounting_date_source' - 'updated_at')
            is distinct from (snapshot.outbox_row - 'accounting_date' - 'accounting_date_source' - 'updated_at')))
  ) then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_ROLLBACK_POSTCONDITION_FAILED';
  end if;

  insert into public.accounting_entry_date_repairs (
    manifest_hash, migration_name, action,
    journal_entry_id, financial_event_id, accounting_outbox_id,
    source_type, source_id, document_number,
    old_entry_date, new_entry_date,
    old_event_accounting_date, new_event_accounting_date,
    old_outbox_accounting_date, new_outbox_accounting_date,
    debit_total, credit_total, line_count, line_hash, source_hash,
    reason, before_state, after_state, executed_by
  )
  select manifest.manifest_hash, rollback_name, 'rollback',
    manifest.journal_entry_id, manifest.financial_event_id,
    manifest.accounting_outbox_id, manifest.source_type, manifest.source_id,
    manifest.document_number, manifest.new_accounting_date, manifest.old_entry_date,
    manifest.new_accounting_date, manifest.old_event_accounting_date,
    case when manifest.accounting_outbox_id is null then null
      else manifest.new_accounting_date end,
    manifest.old_outbox_accounting_date,
    manifest.debit_total, manifest.credit_total, manifest.line_count,
    manifest.line_hash, manifest.source_hash,
    'Rollback compensatorio de la corrección histórica de fecha contable canónica.',
    jsonb_build_object('entry_date', snapshot.entry_row->'entry_date',
      'event_accounting_date', snapshot.event_row->'accounting_date',
      'outbox_accounting_date', snapshot.outbox_row->'accounting_date',
      'line_hash', manifest.line_hash),
    jsonb_build_object('entry_date', entry.entry_date,
      'event_accounting_date', event.accounting_date,
      'outbox_accounting_date', box.accounting_date,
      'line_hash', public.accounting_entry_date_repair_line_hash_v1(entry.id)),
    migration_role
  from public.accounting_entry_date_repair_manifest manifest
  join pg_temp.accounting_entry_date_rollback_before snapshot
    on snapshot.journal_entry_id = manifest.journal_entry_id
  join public.journal_entries entry on entry.id = manifest.journal_entry_id
  join public.financial_events event on event.id = manifest.financial_event_id
  left join public.accounting_outbox_v2 box on box.id = manifest.accounting_outbox_id
  where manifest.manifest_hash = target_hash;
  if (select count(*) from public.accounting_entry_date_repairs
      where manifest_hash = target_hash and action = 'rollback') <> 37 then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_ROLLBACK_AUDIT_COUNT_MISMATCH';
  end if;
  update public.accounting_entry_date_repair_batches
  set status = 'rolled_back', rolled_back_at = clock_timestamp()
  where manifest_hash = target_hash;

  begin
    update public.journal_entries
    set description = description || ' [ACCOUNTING-GUARD-ROLLBACK-CHECK]'
    where id = (select journal_entry_id
      from public.accounting_entry_date_repair_manifest
      where manifest_hash = target_hash order by journal_entry_id limit 1);
  exception when others then
    if sqlerrm like 'Las partidas publicadas no se editan.%' then
      guard_rejected := true;
    else raise;
    end if;
  end;
  if not guard_rejected then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_ROLLBACK_STRICT_GUARD_NOT_ACTIVE';
  end if;
end;
$rollback$;

commit;
