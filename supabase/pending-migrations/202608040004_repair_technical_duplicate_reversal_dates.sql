-- PENDING WRITTEN ACCOUNTING AUTHORIZATION. DO NOT APPLY AS-IS.
-- Forward-only repair of two technical duplicate reversals; no lines or economic records change.

begin;

select pg_advisory_xact_lock(hashtextextended('carzone:repair:technical-duplicate-reversal-dates:2026-07-31', 0));

create table if not exists public.accounting_technical_reversal_date_repairs (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action = 'ACCOUNTING_TECHNICAL_DUPLICATE_REVERSAL_DATE_REPAIR'),
  reason text not null check (reason = 'TECHNICAL_DUPLICATE_REVERSED_IN_WRONG_PERIOD'),
  authorization_reference text not null,
  authorized_date date not null,
  previous_entry_date date not null,
  new_entry_date date not null,
  journal_entry_id uuid not null references public.journal_entries(id),
  reversed_entry_id uuid not null references public.journal_entries(id),
  entry_number text not null,
  amount numeric(14,2) not null,
  line_hash text not null check (line_hash ~ '^[0-9a-f]{64}$'),
  before_hash text not null check (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash text not null check (after_hash ~ '^[0-9a-f]{64}$'),
  before_state jsonb not null,
  after_state jsonb not null,
  executed_by name not null default current_user,
  executed_at timestamptz not null default clock_timestamp(),
  unique (journal_entry_id)
);

alter table public.accounting_technical_reversal_date_repairs enable row level security;
revoke all on public.accounting_technical_reversal_date_repairs from public, anon, authenticated, service_role;
grant select on public.accounting_technical_reversal_date_repairs to service_role;

create or replace function public.guard_accounting_technical_reversal_date_repairs_v1()
returns trigger language plpgsql set search_path = public, pg_temp
as $function$
begin
  raise exception 'ACCOUNTING_TECHNICAL_REVERSAL_REPAIR_AUDIT_IMMUTABLE' using errcode = '55000';
end;
$function$;

revoke all on function public.guard_accounting_technical_reversal_date_repairs_v1()
  from public, anon, authenticated, service_role;
drop trigger if exists accounting_technical_reversal_date_repairs_append_only
  on public.accounting_technical_reversal_date_repairs;
create trigger accounting_technical_reversal_date_repairs_append_only
before update or delete on public.accounting_technical_reversal_date_repairs
for each row execute function public.guard_accounting_technical_reversal_date_repairs_v1();

do $repair$
declare
  authorization_reference constant text := 'AUTHORIZATION_PENDING';
  authorization_date constant date := '2026-07-31'::date;
  previous_date constant date := '2026-08-03'::date;
  guard_definition text;
  guard_hash_before text;
  guard_hash_after text;
  migration_role name := current_user;
  transaction_marker text := txid_current()::text;
  affected_rows integer;
  item record;
begin
  if authorization_reference = 'AUTHORIZATION_PENDING' then
    raise exception 'ACCOUNTING_WRITTEN_AUTHORIZATION_REQUIRED' using errcode = '42501';
  end if;

  if public.is_date_in_closed_accounting_period(authorization_date)
     or public.is_date_in_closed_accounting_period(previous_date) then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_PERIOD_CLOSED' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.accounting_technical_reversal_date_repairs
    where journal_entry_id in (
      'dcf4d9ef-3d2c-4182-b525-bdfc329fa362'::uuid,
      '2be246f3-458a-45bf-bb28-04abfc293d52'::uuid
    )
  ) then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_ALREADY_APPLIED' using errcode = '55000';
  end if;

  create temporary table target_reversal_date_repairs (
    journal_entry_id uuid primary key,
    entry_number text not null,
    original_entry_id uuid not null,
    correct_v2_entry_id uuid not null,
    original_entry_number text not null,
    correct_v2_entry_number text not null,
    amount numeric(14,2) not null,
    expected_line_count integer not null,
    expected_line_hash text not null,
    expected_source_id text not null
  ) on commit drop;

  insert into target_reversal_date_repairs values
    (
      'dcf4d9ef-3d2c-4182-b525-bdfc329fa362', 'PC-20260803-BF6B15AD',
      '717b01ae-2c84-4d65-8a31-b08094f83256', '32c7e93e-6a5b-4105-9c04-5047489df945',
      'PC-20260803-F8060ABF', 'PC-20260731-67D1AB41',
      2800.00, 2, '695d76ae2ef6d50ee3f7208aae412881022fa71dd7650df9012e84cf18162039',
      '717b01ae-2c84-4d65-8a31-b08094f83256'
    ), (
      '2be246f3-458a-45bf-bb28-04abfc293d52', 'PC-20260803-7B07A0CE',
      '90d8668c-fd9b-4bcb-baa9-9382f32393f1', 'a0994cc6-90f9-4d0e-8711-adbdde18049e',
      'PC-20260803-A0DB413A', 'PC-20260731-23909F68',
      3800.00, 3, '512ebcb3e18334e028cc2bafa5eaf48125f9f0ddc36e439fdb4622d981396f92',
      '90d8668c-fd9b-4bcb-baa9-9382f32393f1'
    );

  perform 1 from public.journal_entries
  where id in (
    select journal_entry_id from target_reversal_date_repairs
    union all select original_entry_id from target_reversal_date_repairs
    union all select correct_v2_entry_id from target_reversal_date_repairs
  ) for update;

  for item in select * from target_reversal_date_repairs order by journal_entry_id loop
    if not exists (
      select 1
      from public.journal_entries reversal
      join public.journal_entries original on original.id = item.original_entry_id
      join public.journal_entries correct_v2 on correct_v2.id = item.correct_v2_entry_id
      where reversal.id = item.journal_entry_id
        and reversal.entry_number = item.entry_number
        and reversal.status = 'publicada'
        and reversal.entry_date = previous_date
        and reversal.source_type = 'journal_reversal'
        and reversal.source_id = item.expected_source_id
        and reversal.metadata->>'entry_kind' = 'reversal'
        and reversal.metadata->>'reversal_reason' = 'Partida duplicada'
        and original.status = 'reversada'
        and original.entry_number = item.original_entry_number
        and original.reversed_entry_id = reversal.id
        and correct_v2.status = 'publicada'
        and correct_v2.entry_number = item.correct_v2_entry_number
        and correct_v2.entry_date = authorization_date
        and not exists (
          select 1 from public.journal_entries later_reversal
          where later_reversal.source_type = 'journal_reversal'
            and later_reversal.source_id = reversal.id::text
        )
    ) then
      raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_RELATION_PRECONDITION_FAILED: %', item.journal_entry_id
        using errcode = '23514';
    end if;

    if not exists (
      select 1 from (
        select count(*)::integer line_count,
               coalesce(sum(line.debit), 0)::numeric(14,2) debit_total,
               coalesce(sum(line.credit), 0)::numeric(14,2) credit_total
        from public.journal_entry_lines line
        where line.journal_entry_id = item.journal_entry_id
      ) totals
      where totals.line_count = item.expected_line_count
        and totals.debit_total = item.amount
        and totals.credit_total = item.amount
    ) or public.accounting_entry_date_repair_line_hash_v1(item.journal_entry_id) <> item.expected_line_hash then
      raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_LINE_PRECONDITION_FAILED: %', item.journal_entry_id
        using errcode = '23514';
    end if;
  end loop;

  if not exists (
    select 1
    from public.journal_entry_lines line
    join public.accounting_accounts account on account.id = line.account_id
    where line.journal_entry_id = 'dcf4d9ef-3d2c-4182-b525-bdfc329fa362'
    group by line.journal_entry_id
    having bool_and(
      (account.code = '1103001' and line.debit = 2800.00 and line.credit = 0)
      or (account.code = '5101001' and line.debit = 0 and line.credit = 2800.00)
    ) and count(*) = 2
  ) or not exists (
    select 1
    from public.journal_entry_lines line
    join public.accounting_accounts account on account.id = line.account_id
    where line.journal_entry_id = '2be246f3-458a-45bf-bb28-04abfc293d52'
    group by line.journal_entry_id
    having bool_and(
      (account.code = '4101001' and line.debit = 3304.35 and line.credit = 0)
      or (account.code = '2101002' and line.debit = 495.65 and line.credit = 0)
      or (account.code = '1101004' and line.debit = 0 and line.credit = 3800.00)
    ) and count(*) = 3
  ) then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_ACCOUNT_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.inventory_movements
    where id = '40f20755-586b-46ec-805e-2ae0cc7a893a'
      and total_cost_snapshot = 2800.00
  ) or not exists (
    select 1 from public.orders
    where id = '1948d5be-82b8-4718-809d-eed30aa99ed6' and total = 3800.00
  ) or not exists (
    select 1 from public.invoices
    where id = '1cbdfe14-4f1e-4b6c-880c-5a08d8186fb1'
      and invoice_number = '000-001-01-00001022'
      and invoice_date = '2026-07-31' and total = 3800.00
  ) then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_DOCUMENT_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  create temporary table reversal_date_repair_before on commit drop as
  select entry.id,
         to_jsonb(entry) entry_row,
         public.accounting_entry_date_repair_line_hash_v1(entry.id) line_hash,
         encode(extensions.digest(to_jsonb(entry)::text, 'sha256'), 'hex') before_hash
  from public.journal_entries entry
  join target_reversal_date_repairs target on target.journal_entry_id = entry.id;

  select pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure),
         encode(extensions.digest(pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure), 'sha256'), 'hex')
  into guard_definition, guard_hash_before;
  if guard_definition is null or not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.journal_entries'::regclass
      and tgname in ('journal_entries_guard_status_update', 'journal_entries_guard_status_delete')
      and tgenabled <> 'D'
    group by tgrelid having count(*) = 2
  ) then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_GUARD_MISSING' using errcode = '55000';
  end if;

  perform set_config('app.technical_reversal_date_repair', transaction_marker, true);
  execute format($ddl$
    create or replace function public.guard_journal_entry_status()
    returns trigger language plpgsql as $guard$
    begin
      if tg_op = 'UPDATE'
        and current_user = %L
        and current_setting('app.technical_reversal_date_repair', true) = txid_current()::text
        and old.id in (
          'dcf4d9ef-3d2c-4182-b525-bdfc329fa362'::uuid,
          '2be246f3-458a-45bf-bb28-04abfc293d52'::uuid
        )
        and old.status = 'publicada'
        and old.entry_date = '2026-08-03'::date
        and new.entry_date = '2026-07-31'::date
        and (to_jsonb(new) - 'entry_date' - 'updated_at')
          is not distinct from (to_jsonb(old) - 'entry_date' - 'updated_at')
      then return new;
      end if;
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
        if new.status = 'reversada' and new.reversed_entry_id is not null
          and new.entry_number = old.entry_number and new.entry_date = old.entry_date
          and new.description = old.description
          and coalesce(new.source_type, '') = coalesce(old.source_type, '')
          and coalesce(new.source_id, '') = coalesce(old.source_id, '')
          and new.created_by = old.created_by and new.posted_by = old.posted_by
          and new.posted_at = old.posted_at then return new;
        end if;
        raise exception 'Las partidas publicadas no se editan. Debes registrar un reverso.';
      end if;
      return new;
    end;
    $guard$
  $ddl$, migration_role);

  update public.journal_entries
  set entry_date = authorization_date
  where id in (select journal_entry_id from target_reversal_date_repairs)
    and entry_date = previous_date;
  get diagnostics affected_rows = row_count;
  if affected_rows <> 2 then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_ROW_COUNT: %', affected_rows using errcode = '23514';
  end if;

  execute guard_definition;
  perform set_config('app.technical_reversal_date_repair', '', true);
  guard_hash_after := encode(extensions.digest(pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure), 'sha256'), 'hex');
  if guard_hash_after <> guard_hash_before then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_GUARD_RESTORE_FAILED' using errcode = '55000';
  end if;

  if exists (
    select 1
    from target_reversal_date_repairs target
    join public.journal_entries entry on entry.id = target.journal_entry_id
    join reversal_date_repair_before before_row on before_row.id = entry.id
    where entry.entry_date <> authorization_date
      or public.accounting_entry_date_repair_line_hash_v1(entry.id) <> before_row.line_hash
      or (to_jsonb(entry) - 'entry_date' - 'updated_at')
        is distinct from (before_row.entry_row - 'entry_date' - 'updated_at')
  ) then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_POSTCONDITION_FAILED' using errcode = '23514';
  end if;

  insert into public.accounting_technical_reversal_date_repairs (
    action, reason, authorization_reference, authorized_date,
    previous_entry_date, new_entry_date, journal_entry_id, reversed_entry_id,
    entry_number, amount, line_hash, before_hash, after_hash, before_state, after_state
  )
  select
    'ACCOUNTING_TECHNICAL_DUPLICATE_REVERSAL_DATE_REPAIR',
    'TECHNICAL_DUPLICATE_REVERSED_IN_WRONG_PERIOD',
    authorization_reference, authorization_date, previous_date, authorization_date,
    target.journal_entry_id, target.original_entry_id, target.entry_number, target.amount,
    before_row.line_hash, before_row.before_hash,
    encode(extensions.digest(to_jsonb(entry)::text, 'sha256'), 'hex'),
    before_row.entry_row,
    to_jsonb(entry)
  from target_reversal_date_repairs target
  join reversal_date_repair_before before_row on before_row.id = target.journal_entry_id
  join public.journal_entries entry on entry.id = target.journal_entry_id;

  if (select count(*) from public.accounting_technical_reversal_date_repairs
      where journal_entry_id in (select journal_entry_id from target_reversal_date_repairs)) <> 2 then
    raise exception 'ACCOUNTING_REVERSAL_DATE_REPAIR_AUDIT_FAILED' using errcode = '23514';
  end if;
end;
$repair$;

commit;
