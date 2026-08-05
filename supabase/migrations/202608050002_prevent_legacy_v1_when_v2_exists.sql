-- Prevent legacy V1 sales/COGS drafts when a canonical V2 chain exists.

begin;

create or replace function public.canonical_v2_purpose_for_legacy_v1(
  legacy_purpose text
)
returns text
language sql
immutable
set search_path = public
as $function$
  select case legacy_purpose
    when 'sale_revenue' then 'sale_recognized'
    when 'inventory_cogs' then 'inventory_cogs'
    else null
  end
$function$;

create or replace function public.has_canonical_v2_accounting_chain_v1(
  target_source_type text,
  target_source_id text,
  legacy_purpose text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when public.canonical_v2_purpose_for_legacy_v1(legacy_purpose) is null then false
    else exists (
      select 1
      from public.accounting_outbox_v2 box
      where box.posting_version = 'v2'
        and box.source_type = target_source_type
        and box.source_id::text = target_source_id
        and box.event_purpose = public.canonical_v2_purpose_for_legacy_v1(legacy_purpose)
        and box.status <> 'cancelled'
    ) or exists (
      select 1
      from public.financial_events event
      where event.posting_version = 'v2'
        and event.source_type = target_source_type
        and event.source_id = target_source_id
        and event.event_purpose = public.canonical_v2_purpose_for_legacy_v1(legacy_purpose)
        and event.status <> 'reversed'
    )
  end
$function$;

revoke all on function public.canonical_v2_purpose_for_legacy_v1(text)
  from public, anon, authenticated;
revoke all on function public.has_canonical_v2_accounting_chain_v1(text, text, text)
  from public, anon, authenticated;
grant execute on function public.canonical_v2_purpose_for_legacy_v1(text)
  to service_role;
grant execute on function public.has_canonical_v2_accounting_chain_v1(text, text, text)
  to service_role;

create or replace function public.guard_legacy_v1_financial_event_when_v2_exists()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  superseded_reason constant text := 'SUPERSEDED_BY_CANONICAL_V2_EVENT';
begin
  if new.posting_version = 'v1'
    and new.event_purpose in ('sale_revenue', 'inventory_cogs')
    and public.has_canonical_v2_accounting_chain_v1(
      new.source_type, new.source_id, new.event_purpose
    )
  then
    if new.journal_entry_id is not null
      or new.status in ('draft_created', 'posted', 'reversed')
    then
      raise exception 'LEGACY_V1_SUPERSEDED_BY_CANONICAL_V2_EVENT'
        using errcode = '23514';
    end if;
    new.status := 'skipped';
    new.journal_entry_id := null;
    if not coalesce(new.validation_errors, '[]'::jsonb)
      @> jsonb_build_array(superseded_reason)
    then
      new.validation_errors := coalesce(new.validation_errors, '[]'::jsonb)
        || jsonb_build_array(superseded_reason);
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_legacy_v1_financial_event_when_v2_exists()
  from public, anon, authenticated, service_role;

drop trigger if exists financial_events_guard_legacy_v1_when_v2_exists
  on public.financial_events;
create trigger financial_events_guard_legacy_v1_when_v2_exists
before insert or update on public.financial_events
for each row execute function public.guard_legacy_v1_financial_event_when_v2_exists();

create or replace function public.guard_legacy_v1_journal_when_v2_exists()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  source_event public.financial_events%rowtype;
begin
  if new.source_type <> 'financial_event' or new.source_id is null then
    return new;
  end if;
  select * into source_event
  from public.financial_events
  where id::text = new.source_id;
  if source_event.id is not null
    and source_event.posting_version = 'v1'
    and source_event.event_purpose in ('sale_revenue', 'inventory_cogs')
    and public.has_canonical_v2_accounting_chain_v1(
      source_event.source_type, source_event.source_id,
      source_event.event_purpose
    )
  then
    raise exception 'LEGACY_V1_JOURNAL_BLOCKED_BY_CANONICAL_V2_EVENT'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_legacy_v1_journal_when_v2_exists()
  from public, anon, authenticated, service_role;

drop trigger if exists journal_entries_guard_legacy_v1_when_v2_exists
  on public.journal_entries;
create trigger journal_entries_guard_legacy_v1_when_v2_exists
before insert or update of source_type, source_id, status on public.journal_entries
for each row execute function public.guard_legacy_v1_journal_when_v2_exists();

create table if not exists public.accounting_v1_v2_supersessions (
  id uuid primary key default gen_random_uuid(),
  legacy_event_id uuid not null references public.financial_events(id) on delete restrict,
  canonical_v2_event_id uuid not null references public.financial_events(id) on delete restrict,
  canonical_v2_outbox_id uuid not null references public.accounting_outbox_v2(id) on delete restrict,
  action text not null check (action = 'ACCOUNTING_V1_EVENT_SUPERSEDED'),
  reason text not null check (reason = 'SUPERSEDED_BY_CANONICAL_V2_EVENT'),
  previous_status text not null,
  next_status text not null check (next_status = 'skipped'),
  before_hash text not null check (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash text not null check (after_hash ~ '^[0-9a-f]{64}$'),
  before_state jsonb not null,
  after_state jsonb not null,
  executed_by name not null default current_user,
  executed_at timestamptz not null default clock_timestamp(),
  unique (legacy_event_id)
);

alter table public.accounting_v1_v2_supersessions enable row level security;
revoke all on public.accounting_v1_v2_supersessions from public, anon, authenticated, service_role;
grant select on public.accounting_v1_v2_supersessions to service_role;

create or replace function public.guard_accounting_v1_v2_supersessions_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception 'ACCOUNTING_V1_V2_SUPERSESSION_AUDIT_IMMUTABLE' using errcode = '55000';
end;
$function$;

revoke all on function public.guard_accounting_v1_v2_supersessions_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists accounting_v1_v2_supersessions_append_only
  on public.accounting_v1_v2_supersessions;
create trigger accounting_v1_v2_supersessions_append_only
before update or delete on public.accounting_v1_v2_supersessions
for each row execute function public.guard_accounting_v1_v2_supersessions_v1();

do $neutralize$
declare
  sale_v1 constant uuid := '26c413f2-68df-4a16-818a-155f98394d2f';
  cogs_v1 constant uuid := '48398a6a-ed3f-4a89-8786-021beaf1549f';
  sale_v2 constant uuid := '2bcd9b7b-b343-44b6-a450-709cfdaab58a';
  cogs_v2 constant uuid := '087f323f-fe9b-44d3-97ce-6c07a36690f9';
  sale_box constant uuid := '04fde1d0-b14e-4206-869f-e10203246429';
  cogs_box constant uuid := '7ef7d0ef-059c-4113-803c-8404d8cefcfd';
  cogs_entry constant uuid := '939ad70f-d748-4724-a0df-cbefae7feb40';
  target_count integer;
  item record;
  previous_row jsonb;
  next_row jsonb;
  previous_status text;
  before_hash text;
  after_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('carzone:accounting:invoice-1025:v1-neutralization', 0));

  select count(*) into target_count
  from public.financial_events where id in (sale_v1, cogs_v1);
  if target_count = 0
    and not exists (
      select 1 from public.orders
      where id = '44db4982-e382-4661-b858-e49256d17f56'
    )
  then
    return;
  end if;
  if target_count <> 2 then
    raise exception 'INVOICE_1025_V1_TARGET_SET_MISMATCH' using errcode = '23514';
  end if;

  perform 1 from public.financial_events
  where id in (sale_v1, cogs_v1, sale_v2, cogs_v2)
  order by id for update;
  perform 1 from public.accounting_outbox_v2
  where id in (sale_box, cogs_box)
  order by id for update;
  perform 1 from public.journal_entries where id = cogs_entry for share;

  if not exists (
    select 1 from public.financial_events
    where id = sale_v1 and posting_version = 'v1'
      and source_type = 'order'
      and source_id = '44db4982-e382-4661-b858-e49256d17f56'
      and event_purpose = 'sale_revenue'
      and status = 'pending' and journal_entry_id is null
  ) or not exists (
    select 1
    from public.financial_events event
    join public.inventory_movements movement
      on movement.id::text = event.source_id
    where event.id = cogs_v1 and event.posting_version = 'v1'
      and event.source_type = 'inventory_movement'
      and event.event_purpose = 'inventory_cogs'
      and event.status = 'ready' and event.journal_entry_id is null
      and movement.reference_type = 'orders'
      and movement.reference_id = '44db4982-e382-4661-b858-e49256d17f56'
  ) then
    raise exception 'INVOICE_1025_V1_EVENT_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.journal_entries
    where source_type = 'financial_event'
      and source_id in (sale_v1::text, cogs_v1::text)
  ) then
    raise exception 'INVOICE_1025_V1_JOURNAL_ALREADY_EXISTS' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.accounting_outbox_v2
    where id = sale_box and financial_event_id = sale_v2
      and source_type = 'order'
      and source_id = '44db4982-e382-4661-b858-e49256d17f56'
      and event_purpose = 'sale_recognized'
      and status = 'pending_mapping' and attempt_count = 8
      and missing_key = 'revenue:sale_cod_fee'
      and journal_entry_id is null
  ) or not exists (
    select 1 from public.accounting_outbox_v2
    where id = cogs_box and financial_event_id = cogs_v2
      and event_purpose = 'inventory_cogs' and status = 'completed'
      and journal_entry_id = cogs_entry
  ) or not exists (
    select 1 from public.journal_entries
    where id = cogs_entry and status = 'publicada'
      and entry_date = date '2026-07-16'
  ) then
    raise exception 'INVOICE_1025_V2_CHAIN_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  for item in
    select sale_v1 legacy_id, sale_v2 canonical_id, sale_box outbox_id
    union all
    select cogs_v1, cogs_v2, cogs_box
  loop
    select to_jsonb(event), event.status into previous_row, previous_status
    from public.financial_events event where event.id = item.legacy_id;
    before_hash := encode(extensions.digest(convert_to(previous_row::text, 'UTF8'), 'sha256'), 'hex');

    update public.financial_events
    set status = 'skipped',
        journal_entry_id = null,
        validation_errors = case
          when coalesce(validation_errors, '[]'::jsonb)
            @> '["SUPERSEDED_BY_CANONICAL_V2_EVENT"]'::jsonb
          then validation_errors
          else coalesce(validation_errors, '[]'::jsonb)
            || '["SUPERSEDED_BY_CANONICAL_V2_EVENT"]'::jsonb
        end
    where id = item.legacy_id;

    select to_jsonb(event) into next_row
    from public.financial_events event where event.id = item.legacy_id;
    after_hash := encode(extensions.digest(convert_to(next_row::text, 'UTF8'), 'sha256'), 'hex');

    insert into public.accounting_v1_v2_supersessions (
      legacy_event_id, canonical_v2_event_id, canonical_v2_outbox_id,
      action, reason, previous_status, next_status,
      before_hash, after_hash, before_state, after_state
    ) values (
      item.legacy_id, item.canonical_id, item.outbox_id,
      'ACCOUNTING_V1_EVENT_SUPERSEDED', 'SUPERSEDED_BY_CANONICAL_V2_EVENT',
      previous_status, 'skipped', before_hash, after_hash,
      previous_row, next_row
    );

  end loop;
end;
$neutralize$;

comment on function public.has_canonical_v2_accounting_chain_v1(text, text, text) is
  'Returns true when a non-cancelled V2 sales or COGS chain supersedes the same legacy V1 fact.';

commit;
