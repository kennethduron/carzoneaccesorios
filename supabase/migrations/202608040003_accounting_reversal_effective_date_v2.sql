-- Expand step for explicit accounting reversal dates.
-- This migration creates no journal entry and changes no historical row.

begin;

create table if not exists public.accounting_reversal_requests (
  request_key uuid primary key,
  original_entry_id uuid not null references public.journal_entries(id),
  actor_id uuid not null references public.users(id),
  effective_date date not null,
  expected_version bigint not null check (expected_version > 0),
  reason_hash text not null check (reason_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'completed')),
  reversal_entry_id uuid unique references public.journal_entries(id),
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint accounting_reversal_requests_completion_check check (
    (status = 'processing' and reversal_entry_id is null and response is null and completed_at is null)
    or
    (status = 'completed' and reversal_entry_id is not null and response is not null and completed_at is not null)
  )
);

create unique index if not exists accounting_reversal_requests_original_entry_idx
  on public.accounting_reversal_requests (original_entry_id);

alter table public.accounting_reversal_requests enable row level security;

drop policy if exists accounting_reversal_requests_select_authorized on public.accounting_reversal_requests;
create policy accounting_reversal_requests_select_authorized
on public.accounting_reversal_requests
for select
to authenticated
using (
  actor_id = auth.uid()
  or public.has_permission('accounting:reverse')
  or public.has_permission('accounting:view')
);

revoke all on table public.accounting_reversal_requests from public, anon, authenticated;
grant select on table public.accounting_reversal_requests to authenticated;

create or replace function public.reverse_journal_entry_v2(
  target_entry_id uuid,
  p_reversal_reason text,
  p_effective_date date,
  p_request_key uuid,
  p_expected_version bigint,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $function$
declare
  actor_user_id uuid := auth.uid();
  original_entry public.journal_entries%rowtype;
  existing_request public.accounting_reversal_requests%rowtype;
  existing_reversal_id uuid;
  created_reversal_entry_id uuid;
  reversal_entry_number text;
  normalized_reason text := btrim(regexp_replace(coalesce(p_reversal_reason, ''), '\s+', ' ', 'g'));
  reason_hash_value text;
  reversed_at_value timestamptz := now();
  line_count integer;
  total_debit numeric(14, 2);
  total_credit numeric(14, 2);
  linked_event_id uuid;
  result_payload jsonb;
begin
  if actor_user_id is null or not public.has_permission('accounting:reverse') then
    raise exception 'REVERSAL_PERMISSION_DENIED' using errcode = '42501';
  end if;

  if target_entry_id is null then
    raise exception 'REVERSAL_ENTRY_NOT_FOUND' using errcode = '22023';
  end if;
  if p_effective_date is null then
    raise exception 'REVERSAL_EFFECTIVE_DATE_REQUIRED' using errcode = '22023';
  end if;
  if p_effective_date > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'REVERSAL_EFFECTIVE_DATE_IN_FUTURE' using errcode = '22023';
  end if;
  if p_request_key is null then
    raise exception 'REVERSAL_REQUEST_KEY_REQUIRED' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'REVERSAL_EXPECTED_VERSION_REQUIRED' using errcode = '22023';
  end if;
  if char_length(normalized_reason) < 10 or char_length(normalized_reason) > 500 then
    raise exception 'REVERSAL_REASON_INVALID' using errcode = '22023';
  end if;

  reason_hash_value := encode(digest(normalized_reason, 'sha256'), 'hex');

  select * into existing_request
  from public.accounting_reversal_requests
  where request_key = p_request_key
  for update;

  if found then
    if existing_request.original_entry_id <> target_entry_id
       or existing_request.actor_id <> actor_user_id
       or existing_request.effective_date <> p_effective_date
       or existing_request.expected_version <> p_expected_version
       or existing_request.reason_hash <> reason_hash_value then
      raise exception 'REVERSAL_IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
    end if;
    if existing_request.status = 'completed' then
      return existing_request.response;
    end if;
    raise exception 'REVERSAL_REQUEST_IN_PROGRESS' using errcode = '40001';
  end if;

  select * into original_entry
  from public.journal_entries
  where id = target_entry_id
  for update;

  if not found then
    raise exception 'REVERSAL_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into existing_request
  from public.accounting_reversal_requests
  where original_entry_id = target_entry_id
  for update;
  if found then
    raise exception 'REVERSAL_ALREADY_EXISTS' using errcode = '22023';
  end if;

  insert into public.accounting_reversal_requests (
    request_key, original_entry_id, actor_id, effective_date, expected_version, reason_hash
  ) values (
    p_request_key, target_entry_id, actor_user_id, p_effective_date, p_expected_version, reason_hash_value
  )
  on conflict (request_key) do nothing;

  if not found then
    select * into existing_request
    from public.accounting_reversal_requests
    where request_key = p_request_key
    for update;
    if existing_request.original_entry_id <> target_entry_id
       or existing_request.actor_id <> actor_user_id
       or existing_request.effective_date <> p_effective_date
       or existing_request.expected_version <> p_expected_version
       or existing_request.reason_hash <> reason_hash_value then
      raise exception 'REVERSAL_IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
    end if;
    if existing_request.status = 'completed' then
      return existing_request.response;
    end if;
    raise exception 'REVERSAL_REQUEST_IN_PROGRESS' using errcode = '40001';
  end if;

  if original_entry.version <> p_expected_version then
    raise exception 'REVERSAL_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if original_entry.source_type = 'journal_reversal'
     or coalesce(original_entry.metadata->>'entry_kind', '') = 'reversal' then
    raise exception 'REVERSAL_OF_REVERSAL_NOT_ALLOWED' using errcode = '22023';
  end if;
  if original_entry.status <> 'publicada' then
    raise exception 'REVERSAL_ENTRY_NOT_PUBLISHED' using errcode = '22023';
  end if;
  if original_entry.reversed_entry_id is not null then
    raise exception 'REVERSAL_ALREADY_EXISTS' using errcode = '22023';
  end if;
  if public.is_date_in_closed_accounting_period(p_effective_date) then
    raise exception 'REVERSAL_ACCOUNTING_PERIOD_CLOSED' using errcode = '22023';
  end if;

  select id into existing_reversal_id
  from public.journal_entries
  where source_type = 'journal_reversal'
    and source_id = original_entry.id::text
  limit 1;
  if existing_reversal_id is not null then
    raise exception 'REVERSAL_ALREADY_EXISTS' using errcode = '22023';
  end if;

  select count(*)::integer,
         coalesce(sum(debit), 0)::numeric(14, 2),
         coalesce(sum(credit), 0)::numeric(14, 2)
  into line_count, total_debit, total_credit
  from public.journal_entry_lines
  where journal_entry_id = original_entry.id;
  if line_count < 2 or total_debit <= 0 or total_debit <> total_credit then
    raise exception 'REVERSAL_ENTRY_UNBALANCED' using errcode = '23514';
  end if;

  reversal_entry_number := public.next_journal_entry_number();
  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id,
    created_by, updated_by, metadata
  ) values (
    reversal_entry_number,
    p_effective_date,
    left(format('Reverso de %s: %s', original_entry.entry_number, original_entry.description), 500),
    'borrador',
    'journal_reversal',
    original_entry.id::text,
    actor_user_id,
    actor_user_id,
    jsonb_build_object(
      'entry_kind', 'reversal',
      'original_entry_id', original_entry.id,
      'original_entry_date', original_entry.entry_date,
      'reversal_effective_date', p_effective_date,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversal_request_key', p_request_key,
      'reversed_at', reversed_at_value
    )
  ) returning id into created_reversal_entry_id;

  insert into public.journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description,
    customer_id, vendor_id, product_id
  )
  select created_reversal_entry_id, account_id, credit, debit,
         coalesce('Reverso: ' || nullif(description, ''), 'Reverso de ' || original_entry.entry_number),
         customer_id, vendor_id, product_id
  from public.journal_entry_lines
  where journal_entry_id = original_entry.id
  order by created_at, id;

  update public.journal_entries
  set status = 'publicada', posted_by = actor_user_id, posted_at = reversed_at_value,
      updated_by = actor_user_id, version = version + 1
  where id = created_reversal_entry_id;

  update public.journal_entries
  set status = 'reversada', reversed_entry_id = created_reversal_entry_id,
      updated_by = actor_user_id,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'reversal_entry_id', created_reversal_entry_id,
        'reversal_effective_date', p_effective_date,
        'reversal_reason', normalized_reason,
        'reversal_actor_id', actor_user_id,
        'reversal_request_key', p_request_key,
        'reversed_at', reversed_at_value
      ),
      version = version + 1
  where id = original_entry.id;

  if original_entry.source_type = 'financial_event' then
    begin
      linked_event_id := original_entry.source_id::uuid;
    exception when others then
      linked_event_id := null;
    end;
    if linked_event_id is not null then
      update public.financial_events
      set status = 'reversed', journal_entry_id = original_entry.id, updated_at = now()
      where id = linked_event_id and journal_entry_id = original_entry.id;
    end if;
  end if;

  result_payload := jsonb_build_object(
    'ok', true,
    'original_entry_id', original_entry.id,
    'original_version', original_entry.version + 1,
    'reversal_entry_id', created_reversal_entry_id,
    'entry_number', reversal_entry_number,
    'effective_date', p_effective_date,
    'created_at', reversed_at_value,
    'status', 'publicada'
  );

  perform public.write_audit_log(
    'journal_entries', created_reversal_entry_id, 'accounting.journal_reversal.created_v2', null,
    jsonb_build_object(
      'status', 'publicada', 'original_entry_id', original_entry.id,
      'original_entry_date', original_entry.entry_date,
      'reversal_effective_date', p_effective_date,
      'reversal_technical_created_at', reversed_at_value,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversal_request_key', p_request_key,
      'total_debit', total_debit, 'total_credit', total_credit
    ), actor_ip, actor_user_agent
  );
  perform public.write_audit_log(
    'journal_entries', original_entry.id, 'accounting.journal_entry.reversed_v2',
    jsonb_build_object('status', 'publicada', 'version', original_entry.version),
    jsonb_build_object(
      'status', 'reversada', 'version', original_entry.version + 1,
      'reversal_entry_id', created_reversal_entry_id,
      'original_entry_date', original_entry.entry_date,
      'reversal_effective_date', p_effective_date,
      'reversal_technical_created_at', reversed_at_value,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversal_request_key', p_request_key,
      'financial_event_id', linked_event_id
    ), actor_ip, actor_user_agent
  );

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  ) values (
    'journal_reversal.created_v2', 'journal_entries', created_reversal_entry_id,
    'journal_reversal', original_entry.id::text,
    jsonb_build_object(
      'original_entry_id', original_entry.id,
      'original_entry_date', original_entry.entry_date,
      'reversal_entry_number', reversal_entry_number,
      'reversal_effective_date', p_effective_date,
      'reversal_technical_created_at', reversed_at_value,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversal_request_key', p_request_key,
      'total_debit', total_debit, 'total_credit', total_credit
    ), actor_user_id
  ), (
    'journal_entry.reversed_v2', 'journal_entries', original_entry.id,
    'journal_reversal', created_reversal_entry_id::text,
    jsonb_build_object(
      'reversal_entry_id', created_reversal_entry_id,
      'original_entry_date', original_entry.entry_date,
      'reversal_effective_date', p_effective_date,
      'reversal_technical_created_at', reversed_at_value,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversal_request_key', p_request_key,
      'financial_event_id', linked_event_id,
      'previous_status', 'publicada', 'next_status', 'reversada'
    ), actor_user_id
  );

  update public.accounting_reversal_requests
  set status = 'completed', reversal_entry_id = created_reversal_entry_id,
      response = result_payload, completed_at = now()
  where request_key = p_request_key;

  return result_payload;
end;
$function$;

revoke all on function public.reverse_journal_entry_v2(uuid, text, date, uuid, bigint, text, text) from public, anon;
grant execute on function public.reverse_journal_entry_v2(uuid, text, date, uuid, bigint, text, text) to authenticated;

comment on function public.reverse_journal_entry_v2(uuid, text, date, uuid, bigint, text, text) is
  'Creates one idempotent reversal using an explicitly selected civil accounting date. Never derives the effective date from server time.';

comment on function public.reverse_journal_entry(uuid, text, text, text) is
  'LEGACY compatibility RPC. Operational callers must migrate to reverse_journal_entry_v2; it will be retired after caller verification.';

commit;
