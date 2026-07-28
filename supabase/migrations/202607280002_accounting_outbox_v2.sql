-- Accounting automation V2 foundation.
-- Additive and prospective only: all module flags start disabled and this
-- migration does not scan historical business rows or create financial events.

create table public.accounting_feature_flags (
  key text primary key,
  state text not null default 'disabled',
  cutover_at timestamptz,
  version text not null default 'v2',
  updated_by uuid references public.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_feature_flags_key_check check (
    key in ('sales_draft_v2', 'cogs_draft_v2', 'supplier_payment_draft_v2')
  ),
  constraint accounting_feature_flags_state_check check (
    state in ('disabled', 'shadow', 'enabled')
  ),
  constraint accounting_feature_flags_version_check check (
    version = 'v2'
  ),
  constraint accounting_feature_flags_cutover_check check (
    state = 'disabled' or cutover_at is not null
  ),
  constraint accounting_feature_flags_notes_check check (
    notes is null or char_length(notes) <= 500
  )
);

insert into public.accounting_feature_flags (key, state, version, notes)
values
  ('sales_draft_v2', 'disabled', 'v2', 'Prospective sale-recognition drafts; no historical scan.'),
  ('cogs_draft_v2', 'disabled', 'v2', 'Prospective inventory-movement COGS drafts; no historical scan.'),
  ('supplier_payment_draft_v2', 'disabled', 'v2', 'Prospective supplier-payment drafts; no historical scan.')
on conflict (key) do nothing;

create trigger accounting_feature_flags_set_updated_at
before update on public.accounting_feature_flags
for each row execute function public.set_updated_at();

create table public.accounting_shadow_observations (
  id uuid primary key default gen_random_uuid(),
  feature_key text not null references public.accounting_feature_flags(key) on delete restrict,
  topic text not null,
  source_type text not null,
  source_id uuid not null,
  event_purpose text not null,
  posting_version text not null default 'v2',
  scenario text not null,
  occurred_at timestamptz not null,
  cutover_at timestamptz not null,
  validation_status text not null default 'eligible',
  validation_code text,
  created_at timestamptz not null default now(),
  constraint accounting_shadow_observations_contract_check check (
    posting_version = 'v2'
    and validation_status in ('eligible', 'ineligible', 'pending_mapping', 'pending_data')
  ),
  constraint accounting_shadow_observations_lengths_check check (
    char_length(topic) between 3 and 120
    and char_length(source_type) between 2 and 120
    and char_length(event_purpose) between 2 and 120
    and char_length(scenario) between 2 and 120
    and (validation_code is null or char_length(validation_code) <= 120)
  ),
  constraint accounting_shadow_observations_unique unique (
    feature_key, source_type, source_id, event_purpose, posting_version
  )
);

create index accounting_shadow_observations_feature_created_idx
  on public.accounting_shadow_observations(feature_key, created_at desc);

create table public.accounting_outbox_v2 (
  id uuid primary key default gen_random_uuid(),
  feature_key text not null references public.accounting_feature_flags(key) on delete restrict,
  topic text not null,
  source_type text not null,
  source_id uuid not null,
  event_purpose text not null,
  posting_version text not null default 'v2',
  scenario text not null,
  idempotency_key text not null,
  occurred_at timestamptz not null,
  cutover_at timestamptz not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  missing_key text,
  financial_event_id uuid references public.financial_events(id) on delete set null,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  actor_id uuid references public.users(id) on delete set null,
  duplicate_avoided boolean not null default false,
  compensated_event_id uuid references public.financial_events(id) on delete set null,
  processed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_outbox_v2_status_check check (
    status in (
      'queued', 'processing', 'completed', 'failed', 'pending_mapping',
      'pending_data', 'cancelled', 'shadow_validated'
    )
  ),
  constraint accounting_outbox_v2_version_check check (posting_version = 'v2'),
  constraint accounting_outbox_v2_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 25
  ),
  constraint accounting_outbox_v2_lease_check check (
    (status = 'processing' and lease_until is not null and locked_by is not null)
    or status <> 'processing'
  ),
  constraint accounting_outbox_v2_lengths_check check (
    char_length(topic) between 3 and 120
    and char_length(source_type) between 2 and 120
    and char_length(event_purpose) between 2 and 120
    and char_length(scenario) between 2 and 120
    and char_length(idempotency_key) between 8 and 300
    and (locked_by is null or char_length(locked_by) <= 120)
    and (last_error_code is null or char_length(last_error_code) <= 120)
    and (last_error_message is null or char_length(last_error_message) <= 500)
    and (missing_key is null or char_length(missing_key) <= 240)
  ),
  constraint accounting_outbox_v2_cutover_check check (occurred_at >= cutover_at),
  constraint accounting_outbox_v2_fact_unique unique (
    source_type, source_id, event_purpose, posting_version
  ),
  constraint accounting_outbox_v2_idempotency_unique unique (idempotency_key)
);

create index accounting_outbox_v2_dispatch_idx
  on public.accounting_outbox_v2(status, next_attempt_at, created_at)
  where status in ('queued', 'failed', 'pending_mapping', 'pending_data');
create index accounting_outbox_v2_lease_idx
  on public.accounting_outbox_v2(lease_until)
  where status = 'processing';
create index accounting_outbox_v2_topic_status_idx
  on public.accounting_outbox_v2(topic, status, occurred_at desc);
create index accounting_outbox_v2_event_idx
  on public.accounting_outbox_v2(financial_event_id)
  where financial_event_id is not null;
create index accounting_outbox_v2_journal_idx
  on public.accounting_outbox_v2(journal_entry_id)
  where journal_entry_id is not null;

create trigger accounting_outbox_v2_set_updated_at
before update on public.accounting_outbox_v2
for each row execute function public.set_updated_at();

alter table public.accounting_feature_flags enable row level security;
alter table public.accounting_shadow_observations enable row level security;
alter table public.accounting_outbox_v2 enable row level security;

create policy accounting_feature_flags_authorized_read
  on public.accounting_feature_flags for select
  using (
    public.has_permission('accounting:read')
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin', 'contadora')
  );
create policy accounting_shadow_observations_authorized_read
  on public.accounting_shadow_observations for select
  using (
    public.has_permission('accounting:read')
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin', 'contadora')
  );
create policy accounting_outbox_v2_authorized_read
  on public.accounting_outbox_v2 for select
  using (
    public.has_permission('accounting:read')
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin', 'contadora')
  );

grant select on public.accounting_feature_flags to authenticated;
grant select on public.accounting_shadow_observations to authenticated;
grant select on public.accounting_outbox_v2 to authenticated;
revoke insert, update, delete on public.accounting_feature_flags from authenticated;
revoke insert, update, delete on public.accounting_shadow_observations from authenticated;
revoke insert, update, delete on public.accounting_outbox_v2 from authenticated;
grant select, insert, update, delete on public.accounting_feature_flags to service_role;
grant select, insert, update, delete on public.accounting_shadow_observations to service_role;
grant select, insert, update, delete on public.accounting_outbox_v2 to service_role;

comment on table public.accounting_outbox_v2 is
  'Prospective, generalized accounting outbox. Contains identifiers and processing metadata only; no PII or receipt data.';
comment on table public.accounting_shadow_observations is
  'Non-economic shadow validation records. Shadow never creates a real outbox, financial event or journal draft.';

create or replace function public.set_accounting_feature_flag_v2(
  target_key text,
  target_state text,
  target_cutover_at timestamptz,
  technical_notes text default null
)
returns public.accounting_feature_flags
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  result public.accounting_feature_flags%rowtype;
begin
  if actor_id is null
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:settings')
  then
    raise exception using errcode = '42501', message = 'No tienes permiso para configurar la automatizacion contable.';
  end if;

  if target_key not in ('sales_draft_v2', 'cogs_draft_v2', 'supplier_payment_draft_v2') then
    raise exception using errcode = '22023', message = 'El feature flag contable no es valido.';
  end if;
  if target_state not in ('disabled', 'shadow', 'enabled') then
    raise exception using errcode = '22023', message = 'El estado del feature flag no es valido.';
  end if;
  if target_state <> 'disabled' and target_cutover_at is null then
    raise exception using errcode = '22023', message = 'Shadow y enabled requieren una fecha de corte explicita.';
  end if;
  if target_state = 'enabled' and target_cutover_at < now() then
    raise exception using errcode = '22023', message = 'Enabled requiere una fecha de corte prospectiva.';
  end if;

  update public.accounting_feature_flags
  set state = target_state,
      cutover_at = case when target_state = 'disabled' then null else target_cutover_at end,
      updated_by = actor_id,
      notes = nullif(left(btrim(coalesce(technical_notes, '')), 500), '')
  where key = target_key
  returning * into result;

  insert into public.accounting_event_log (
    event_type, entity_type, source_type, source_id, metadata, created_by
  )
  values (
    'accounting_v2.feature_flag_changed',
    'accounting_feature_flags',
    'accounting_feature_flag',
    target_key,
    jsonb_build_object(
      'state', result.state,
      'cutover_at', result.cutover_at,
      'version', result.version
    ),
    actor_id
  );

  return result;
end;
$$;

revoke all on function public.set_accounting_feature_flag_v2(text, text, timestamptz, text)
  from public, anon;
grant execute on function public.set_accounting_feature_flag_v2(text, text, timestamptz, text)
  to authenticated;

create or replace function public.route_accounting_fact_v2(
  target_feature_key text,
  target_topic text,
  target_source_type text,
  target_source_id uuid,
  target_event_purpose text,
  target_scenario text,
  target_occurred_at timestamptz,
  target_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  flag public.accounting_feature_flags%rowtype;
  result_id uuid;
  stable_key text;
  shadow_status text;
  shadow_code text;
begin
  select *
    into flag
    from public.accounting_feature_flags
    where key = target_feature_key;

  if not found or flag.state = 'disabled' then
    return null;
  end if;
  if target_source_id is null or target_occurred_at is null then
    return null;
  end if;
  if flag.cutover_at is null or target_occurred_at < flag.cutover_at then
    return null;
  end if;

  stable_key := target_source_type || ':' || target_source_id::text
    || ':' || target_event_purpose || ':v2';

  if flag.state = 'shadow' then
    select validation_status, validation_code
    into shadow_status, shadow_code
    from public.validate_accounting_shadow_fact_v2(
      flag.key,
      target_source_type,
      target_source_id,
      target_scenario,
      target_occurred_at
    );

    insert into public.accounting_shadow_observations (
      feature_key, topic, source_type, source_id, event_purpose,
      posting_version, scenario, occurred_at, cutover_at, validation_status,
      validation_code
    )
    values (
      flag.key, target_topic, target_source_type, target_source_id,
      target_event_purpose, 'v2', target_scenario, target_occurred_at,
      flag.cutover_at, shadow_status, shadow_code
    )
    on conflict (feature_key, source_type, source_id, event_purpose, posting_version)
    do update set
      validation_status = excluded.validation_status,
      validation_code = excluded.validation_code
    returning id into result_id;
    return result_id;
  end if;

  insert into public.accounting_outbox_v2 (
    feature_key, topic, source_type, source_id, event_purpose,
    posting_version, scenario, idempotency_key, occurred_at, cutover_at,
    status, next_attempt_at, actor_id
  )
  values (
    flag.key, target_topic, target_source_type, target_source_id,
    target_event_purpose, 'v2', target_scenario, stable_key,
    target_occurred_at, flag.cutover_at, 'queued', now(),
    coalesce(target_actor_id, auth.uid())
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do update set duplicate_avoided = true
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.route_accounting_fact_v2(
  text, text, text, uuid, text, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.route_accounting_fact_v2(
  text, text, text, uuid, text, text, timestamptz, uuid
) to service_role;

create or replace function public.retry_accounting_outbox_v2(
  target_outbox_id uuid,
  retry_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  box public.accounting_outbox_v2%rowtype;
begin
  if actor_id is null
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  then
    raise exception using errcode = '42501', message = 'No tienes permiso para reintentar eventos contables.';
  end if;

  select * into box
  from public.accounting_outbox_v2
  where id = target_outbox_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'La outbox contable no existe.';
  end if;
  if box.status not in ('failed', 'pending_mapping', 'pending_data') then
    raise exception using errcode = '22023', message = 'El estado actual no admite reintento.';
  end if;

  update public.accounting_outbox_v2
  set status = 'queued',
      next_attempt_at = now(),
      lease_until = null,
      locked_by = null,
      last_error_code = null,
      last_error_message = null,
      missing_key = null
  where id = box.id;

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  )
  values (
    'accounting_v2.outbox_retry_requested',
    'accounting_outbox_v2',
    box.id,
    box.source_type,
    box.source_id::text,
    jsonb_build_object(
      'attempt_count', box.attempt_count,
      'reason', left(coalesce(nullif(btrim(retry_reason), ''), 'authorized_retry'), 200)
    ),
    actor_id
  );

  return box.id;
end;
$$;

revoke all on function public.retry_accounting_outbox_v2(uuid, text) from public, anon;
grant execute on function public.retry_accounting_outbox_v2(uuid, text) to authenticated;
