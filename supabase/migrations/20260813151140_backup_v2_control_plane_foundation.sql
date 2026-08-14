-- Modern Backup V2 Phase 4A: control-plane foundation only.
-- This migration stores operational metadata. It stores no backup payloads or business rows.

create table public.backup_v2_runs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  scope text not null check (scope in ('database', 'auth', 'storage_objects')),
  trigger_type text not null check (trigger_type in ('manual', 'scheduled', 'system')),
  lifecycle_state text not null default 'requested'
    check (lifecycle_state in (
      'requested', 'preflight', 'running', 'validating', 'completed',
      'completed_with_warnings', 'failed', 'cancelled'
    )),
  format_version integer not null check (format_version > 0),
  engine_version text not null check (length(engine_version) between 1 and 80),
  schema_version text check (schema_version is null or length(schema_version) between 1 and 160),
  classification_version text
    check (classification_version is null or length(classification_version) between 1 and 160),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  lease_owner_ref text check (lease_owner_ref is null or length(lease_owner_ref) between 1 and 160),
  lease_expires_at timestamptz,
  zero_spend_policy_version text not null
    check (length(zero_spend_policy_version) between 1 and 80),
  relations_discovered integer not null default 0 check (relations_discovered >= 0),
  relations_classified integer not null default 0 check (relations_classified >= 0),
  relations_unknown integer not null default 0 check (relations_unknown >= 0),
  terminal_error_code text
    check (terminal_error_code is null or length(terminal_error_code) between 1 and 80),
  terminal_error_summary text
    check (terminal_error_summary is null or length(terminal_error_summary) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (relations_classified <= relations_discovered),
  check (relations_unknown <= relations_discovered),
  check ((lease_owner_ref is null) = (lease_expires_at is null)),
  check (started_at is null or started_at >= requested_at),
  check (finished_at is null or started_at is not null),
  check (finished_at is null or finished_at >= started_at),
  check (
    (lifecycle_state in ('completed', 'completed_with_warnings', 'failed', 'cancelled') and finished_at is not null)
    or
    (lifecycle_state not in ('completed', 'completed_with_warnings', 'failed', 'cancelled') and finished_at is null)
  ),
  check (
    (lifecycle_state = 'failed' and terminal_error_code is not null)
    or
    (lifecycle_state <> 'failed' and terminal_error_code is null and terminal_error_summary is null)
  )
);

create unique index backup_v2_runs_one_active_scope_idx
  on public.backup_v2_runs (scope)
  where lifecycle_state in ('requested', 'preflight', 'running', 'validating');
create index backup_v2_runs_state_requested_idx
  on public.backup_v2_runs (lifecycle_state, requested_at desc);
create index backup_v2_runs_heartbeat_idx
  on public.backup_v2_runs (heartbeat_at)
  where lifecycle_state in ('preflight', 'running', 'validating');

create table public.backup_v2_run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.backup_v2_runs(id),
  scope text not null check (scope in ('database', 'auth', 'storage_objects')),
  sequence_number integer not null check (sequence_number > 0),
  previous_state text not null check (previous_state in (
    'requested', 'preflight', 'running', 'validating', 'completed',
    'completed_with_warnings', 'failed', 'cancelled'
  )),
  next_state text not null check (next_state in (
    'requested', 'preflight', 'running', 'validating', 'completed',
    'completed_with_warnings', 'failed', 'cancelled'
  )),
  actor_type text not null check (actor_type in ('system', 'worker', 'operator')),
  worker_identity_ref text
    check (worker_identity_ref is null or length(worker_identity_ref) between 1 and 160),
  attempt integer not null default 1 check (attempt > 0),
  occurred_at timestamptz not null default now(),
  sanitized_code text check (sanitized_code is null or length(sanitized_code) between 1 and 80),
  sanitized_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(sanitized_metadata) = 'object' and pg_column_size(sanitized_metadata) <= 4096),
  unique (run_id, sequence_number)
);

create index backup_v2_run_events_run_time_idx
  on public.backup_v2_run_events (run_id, occurred_at);

create table public.backup_v2_recovery_sets (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  lifecycle_state text not null default 'assembling'
    check (lifecycle_state in ('assembling', 'full_dr_ready', 'failed', 'expired')),
  policy_version text not null check (length(policy_version) between 1 and 80),
  max_evidence_age_seconds bigint
    check (max_evidence_age_seconds is null or max_evidence_age_seconds > 0),
  required_scopes text[] not null default array['database', 'auth', 'storage_objects']::text[],
  recovery_key_requirement text not null default 'required'
    check (recovery_key_requirement in ('required', 'optional')),
  recovery_key_status text not null default 'unknown'
    check (recovery_key_status in ('availability_attested', 'unattested', 'failed', 'unknown')),
  recovery_key_version text
    check (recovery_key_version is null or length(recovery_key_version) between 1 and 80),
  recovery_key_safe_ref text
    check (recovery_key_safe_ref is null or length(recovery_key_safe_ref) between 1 and 160),
  recovery_key_public_fingerprint text
    check (recovery_key_public_fingerprint is null or length(recovery_key_public_fingerprint) between 16 and 160),
  recovery_key_attested_at timestamptz,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  finished_at timestamptz,
  terminal_error_code text
    check (terminal_error_code is null or length(terminal_error_code) between 1 and 80),
  terminal_error_summary text
    check (terminal_error_summary is null or length(terminal_error_summary) between 1 and 1000),
  check (
    (lifecycle_state = 'full_dr_ready' and ready_at is not null)
    or (lifecycle_state <> 'full_dr_ready' and ready_at is null)
  ),
  check (
    cardinality(required_scopes) between 1 and 3
    and required_scopes <@ array['database', 'auth', 'storage_objects']::text[]
    and required_scopes @> array['database']::text[]
    and cardinality(array_positions(required_scopes, 'database')) <= 1
    and cardinality(array_positions(required_scopes, 'auth')) <= 1
    and cardinality(array_positions(required_scopes, 'storage_objects')) <= 1
  ),
  check (
    (recovery_key_status = 'availability_attested'
      and recovery_key_version is not null
      and recovery_key_safe_ref is not null
      and recovery_key_public_fingerprint is not null
      and recovery_key_attested_at is not null)
    or (recovery_key_status <> 'availability_attested')
  ),
  check (
    (lifecycle_state in ('failed', 'expired') and finished_at is not null)
    or (lifecycle_state not in ('failed', 'expired') and finished_at is null)
  ),
  check (
    (lifecycle_state = 'failed' and terminal_error_code is not null)
    or (lifecycle_state <> 'failed' and terminal_error_code is null and terminal_error_summary is null)
  )
);

create index backup_v2_recovery_sets_state_created_idx
  on public.backup_v2_recovery_sets (lifecycle_state, created_at desc);

create table public.backup_v2_recovery_set_components (
  recovery_set_id uuid not null references public.backup_v2_recovery_sets(id),
  scope text not null check (scope in ('database', 'auth', 'storage_objects')),
  run_id uuid not null unique references public.backup_v2_runs(id),
  artifact_status text not null default 'unknown'
    check (artifact_status in ('present', 'missing', 'unknown')),
  completion_status text not null default 'unknown'
    check (completion_status in ('completed', 'incomplete', 'failed', 'unknown')),
  integrity_status text not null default 'unknown'
    check (integrity_status in ('verified', 'unverified', 'failed', 'unknown')),
  compatibility_status text not null default 'unknown'
    check (compatibility_status in ('verified', 'unverified', 'failed', 'unknown')),
  backup_format_version text
    check (backup_format_version is null or length(backup_format_version) between 1 and 80),
  schema_compatibility_ref text
    check (schema_compatibility_ref is null or length(schema_compatibility_ref) between 1 and 160),
  exporter_version text
    check (exporter_version is null or length(exporter_version) between 1 and 80),
  compatibility_verified_at timestamptz,
  primary_copy_requirement text not null default 'required'
    check (primary_copy_requirement in ('required', 'optional')),
  primary_copy_status text not null default 'unknown'
    check (primary_copy_status in ('verified', 'unverified', 'failed', 'unknown')),
  primary_copy_ref text
    check (primary_copy_ref is null or length(primary_copy_ref) between 1 and 160),
  primary_copy_verified_at timestamptz,
  offsite_copy_requirement text not null default 'optional'
    check (offsite_copy_requirement in ('required', 'optional')),
  offsite_copy_status text not null default 'unknown'
    check (offsite_copy_status in ('verified', 'unverified', 'failed', 'unknown')),
  offsite_copy_ref text
    check (offsite_copy_ref is null or length(offsite_copy_ref) between 1 and 160),
  offsite_copy_verified_at timestamptz,
  evidence_origin text not null default 'runtime_verified'
    check (evidence_origin in ('runtime_verified', 'synthetic_fixture')),
  fail_closed_reasons text[] not null default '{}'::text[],
  verification_code text
    check (verification_code is null or length(verification_code) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (recovery_set_id, scope),
  check (
    (compatibility_status = 'verified' and backup_format_version is not null
      and schema_compatibility_ref is not null and exporter_version is not null
      and compatibility_verified_at is not null)
    or compatibility_status <> 'verified'
  ),
  check (
    (primary_copy_status = 'verified' and primary_copy_ref is not null and primary_copy_verified_at is not null)
    or primary_copy_status <> 'verified'
  ),
  check (
    (offsite_copy_status = 'verified' and offsite_copy_ref is not null and offsite_copy_verified_at is not null)
    or offsite_copy_status <> 'verified'
  )
);

create index backup_v2_recovery_components_run_idx
  on public.backup_v2_recovery_set_components (run_id);

create table public.backup_v2_measurements (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.backup_v2_runs(id),
  recovery_set_id uuid references public.backup_v2_recovery_sets(id),
  measurement_scope text not null check (measurement_scope in (
    'database', 'auth', 'storage_objects', 'full_recovery_set', 'runtime'
  )),
  source_kind text not null check (source_kind in ('synthetic_local', 'runtime_verified')),
  measured_at timestamptz not null,
  encrypted_bytes bigint not null default 0 check (encrypted_bytes >= 0),
  temporary_peak_bytes bigint not null default 0 check (temporary_peak_bytes >= 0),
  object_count bigint not null default 0 check (object_count >= 0),
  operation_count bigint not null default 0 check (operation_count >= 0),
  runtime_seconds numeric(14,3) not null default 0 check (
    runtime_seconds >= 0
    and runtime_seconds not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  ),
  github_actions_minutes numeric(14,3) not null default 0 check (
    github_actions_minutes >= 0
    and github_actions_minutes not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  ),
  created_at timestamptz not null default now(),
  check (run_id is not null or recovery_set_id is not null),
  check (measured_at <= created_at)
);

create index backup_v2_measurements_run_scope_idx
  on public.backup_v2_measurements (run_id, measurement_scope, measured_at desc);
create index backup_v2_measurements_set_scope_idx
  on public.backup_v2_measurements (recovery_set_id, measurement_scope, measured_at desc);

create function public.backup_v2_enforce_run_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  transition_allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_state <> 'requested' then
      raise exception using errcode = '23514', message = 'BACKUP_V2_INITIAL_STATE_INVALID';
    end if;
    return new;
  end if;

  if new.scope is distinct from old.scope then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RUN_SCOPE_IMMUTABLE';
  end if;

  if old.lifecycle_state in ('completed', 'completed_with_warnings', 'failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_TERMINAL_STATE_IMMUTABLE';
  end if;

  if new.lifecycle_state <> old.lifecycle_state then
    if current_setting('app.backup_v2_transition_run_id', true) is distinct from old.id::text then
      raise exception using errcode = '55000', message = 'BACKUP_V2_DIRECT_STATE_MUTATION_DENIED';
    end if;
    transition_allowed := case old.lifecycle_state
      when 'requested' then new.lifecycle_state in ('preflight', 'failed', 'cancelled')
      when 'preflight' then new.lifecycle_state in ('running', 'failed', 'cancelled')
      when 'running' then new.lifecycle_state in ('validating', 'failed', 'cancelled')
      when 'validating' then new.lifecycle_state in (
        'completed', 'completed_with_warnings', 'failed', 'cancelled'
      )
      else false
    end;
    if not transition_allowed then
      raise exception using errcode = '23514', message = 'BACKUP_V2_INVALID_STATE_TRANSITION';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger backup_v2_runs_transition_guard
before insert or update on public.backup_v2_runs
for each row execute function public.backup_v2_enforce_run_transition();

create function public.backup_v2_enforce_event_sequence()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  expected_sequence integer;
  run_scope text;
  run_state text;
  prior_state text;
  transition_allowed boolean;
begin
  select scope, lifecycle_state into run_scope, run_state
    from public.backup_v2_runs where id = new.run_id for update;
  if run_scope is null then
    raise exception using errcode = '23503', message = 'BACKUP_V2_EVENT_RUN_REQUIRED';
  end if;
  if new.scope is distinct from run_scope then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_SCOPE_MISMATCH';
  end if;
  if new.previous_state is null then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_FROM_STATE_REQUIRED';
  end if;
  transition_allowed := case new.previous_state
    when 'requested' then new.next_state in ('preflight', 'failed', 'cancelled')
    when 'preflight' then new.next_state in ('running', 'failed', 'cancelled')
    when 'running' then new.next_state in ('validating', 'failed', 'cancelled')
    when 'validating' then new.next_state in (
      'completed', 'completed_with_warnings', 'failed', 'cancelled'
    )
    else false
  end;
  if not transition_allowed then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_TRANSITION_INVALID';
  end if;
  if run_state is distinct from new.next_state then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_RUN_STATE_CONFLICT';
  end if;
  select coalesce(max(sequence_number), 0) + 1
    into expected_sequence
    from public.backup_v2_run_events
    where run_id = new.run_id;
  if new.sequence_number <> expected_sequence then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_SEQUENCE_INVALID';
  end if;
  if expected_sequence = 1 then
    if new.previous_state <> 'requested' then
      raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_FROM_STATE_MISMATCH';
    end if;
  else
    select next_state into prior_state
      from public.backup_v2_run_events
      where run_id = new.run_id and sequence_number = expected_sequence - 1;
    if prior_state is distinct from new.previous_state then
      raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_FROM_STATE_MISMATCH';
    end if;
  end if;
  return new;
end;
$$;

create trigger backup_v2_run_events_sequence_guard
before insert on public.backup_v2_run_events
for each row execute function public.backup_v2_enforce_event_sequence();

create function public.backup_v2_reject_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'BACKUP_V2_EVENTS_APPEND_ONLY';
end;
$$;

create trigger backup_v2_run_events_append_only
before update or delete on public.backup_v2_run_events
for each row execute function public.backup_v2_reject_event_mutation();

create function public.transition_backup_v2_run(
  target_run_id uuid,
  expected_scope text,
  expected_state text,
  target_state text,
  event_actor_type text,
  event_worker_identity_ref text default null,
  event_attempt integer default 1,
  event_sanitized_code text default null,
  event_sanitized_metadata jsonb default '{}'::jsonb
)
returns public.backup_v2_runs
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  next_sequence integer;
begin
  select * into current_run from public.backup_v2_runs where id = target_run_id for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if expected_scope not in ('database', 'auth', 'storage_objects')
    or current_run.scope is distinct from expected_scope then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_SCOPE_MISMATCH';
  end if;
  if current_run.lifecycle_state is distinct from expected_state then
    raise exception using errcode = '23514', message = 'BACKUP_V2_EVENT_FROM_STATE_MISMATCH';
  end if;
  if event_actor_type not in ('system', 'worker', 'operator')
    or event_attempt <= 0
    or jsonb_typeof(event_sanitized_metadata) <> 'object'
    or pg_column_size(event_sanitized_metadata) > 4096 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_EVENT_INPUT_INVALID';
  end if;
  if target_state in ('validating', 'completed', 'completed_with_warnings')
    and (
      current_run.relations_unknown <> 0
      or current_run.relations_classified <> current_run.relations_discovered
    ) then
    raise exception using errcode = '23514', message = 'BACKUP_V2_CATALOG_CLASSIFICATION_INCOMPLETE';
  end if;
  select coalesce(max(sequence_number), 0) + 1 into next_sequence
    from public.backup_v2_run_events where run_id = target_run_id;

  perform set_config('app.backup_v2_transition_run_id', target_run_id::text, true);
  update public.backup_v2_runs
  set lifecycle_state = target_state,
      started_at = case when target_state = 'preflight' then coalesce(started_at, now()) else started_at end,
      finished_at = case when target_state in ('completed', 'completed_with_warnings', 'failed', 'cancelled')
        then now() else null end,
      terminal_error_code = case when target_state = 'failed'
        then coalesce(nullif(left(btrim(coalesce(event_sanitized_code, '')), 80), ''), 'BACKUP_V2_FAILED')
        else null end,
      terminal_error_summary = null
  where id = target_run_id
  returning * into current_run;

  insert into public.backup_v2_run_events(
    run_id, scope, sequence_number, previous_state, next_state, actor_type,
    worker_identity_ref, attempt, sanitized_code, sanitized_metadata
  ) values (
    target_run_id, expected_scope, next_sequence, expected_state, target_state, event_actor_type,
    event_worker_identity_ref, event_attempt, event_sanitized_code, event_sanitized_metadata
  );
  return current_run;
end;
$$;

create function public.backup_v2_validate_component()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  run_scope text;
  run_state text;
  set_state text;
begin
  select lifecycle_state into set_state
    from public.backup_v2_recovery_sets where id = new.recovery_set_id for update;
  if set_state <> 'assembling' then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RECOVERY_COMPONENTS_IMMUTABLE';
  end if;
  select scope, lifecycle_state into run_scope, run_state
    from public.backup_v2_runs where id = new.run_id;
  if run_scope is distinct from new.scope then
    raise exception using errcode = '23514', message = 'BACKUP_V2_COMPONENT_SCOPE_MISMATCH';
  end if;
  if new.completion_status = 'completed' and run_state not in ('completed', 'completed_with_warnings') then
    raise exception using errcode = '23514', message = 'BACKUP_V2_COMPONENT_RUN_NOT_COMPLETED';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger backup_v2_recovery_components_guard
before insert or update on public.backup_v2_recovery_set_components
for each row execute function public.backup_v2_validate_component();

create function public.backup_v2_guard_component_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  set_state text;
begin
  select lifecycle_state into set_state
    from public.backup_v2_recovery_sets where id = old.recovery_set_id for update;
  if set_state <> 'assembling' then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RECOVERY_COMPONENTS_IMMUTABLE';
  end if;
  return old;
end;
$$;

create trigger backup_v2_recovery_components_delete_guard
before delete on public.backup_v2_recovery_set_components
for each row execute function public.backup_v2_guard_component_delete();

create function public.backup_v2_enforce_recovery_set_state()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  verified_component_count integer;
  required_component_count integer;
begin
  if tg_op = 'INSERT' then
    if new.lifecycle_state <> 'assembling' then
      raise exception using errcode = '23514', message = 'BACKUP_V2_RECOVERY_INITIAL_STATE_INVALID';
    end if;
    return new;
  end if;

  if old.lifecycle_state in ('full_dr_ready', 'failed', 'expired') then
    raise exception using errcode = '55000', message = 'BACKUP_V2_RECOVERY_TERMINAL_STATE_IMMUTABLE';
  end if;
  if new.lifecycle_state = old.lifecycle_state then return new; end if;
  if new.lifecycle_state not in ('full_dr_ready', 'failed', 'expired') then
    raise exception using errcode = '23514', message = 'BACKUP_V2_RECOVERY_STATE_TRANSITION_INVALID';
  end if;
  if new.lifecycle_state = 'full_dr_ready' then
    required_component_count := cardinality(new.required_scopes);
    select count(*) into verified_component_count
      from public.backup_v2_recovery_set_components
      where recovery_set_id = new.id
        and scope = any(new.required_scopes)
        and artifact_status = 'present'
        and completion_status = 'completed'
        and integrity_status = 'verified'
        and compatibility_status = 'verified'
        and backup_format_version is not null
        and schema_compatibility_ref is not null
        and exporter_version is not null
        and compatibility_verified_at is not null
        and compatibility_verified_at <= now()
        and (
          new.max_evidence_age_seconds is null
          or compatibility_verified_at >= now() - make_interval(secs => new.max_evidence_age_seconds)
        )
        and primary_copy_requirement = 'required'
        and primary_copy_status = 'verified'
        and primary_copy_ref is not null
        and primary_copy_verified_at is not null
        and primary_copy_verified_at <= now()
        and (
          new.max_evidence_age_seconds is null
          or primary_copy_verified_at >= now() - make_interval(secs => new.max_evidence_age_seconds)
        )
        and (
          offsite_copy_requirement = 'optional'
          or (offsite_copy_status = 'verified' and offsite_copy_ref is not null
            and offsite_copy_verified_at is not null
            and offsite_copy_verified_at <= now()
            and (
              new.max_evidence_age_seconds is null
              or offsite_copy_verified_at >= now() - make_interval(secs => new.max_evidence_age_seconds)
            ))
        )
        and cardinality(fail_closed_reasons) = 0
        and evidence_origin = 'runtime_verified';
    if verified_component_count <> required_component_count
      or (
        new.recovery_key_requirement = 'required'
        and (
          new.recovery_key_status <> 'availability_attested'
          or new.recovery_key_version is null
          or new.recovery_key_safe_ref is null
          or new.recovery_key_public_fingerprint is null
          or new.recovery_key_attested_at is null
          or new.recovery_key_attested_at > now()
          or (
            new.max_evidence_age_seconds is not null
            and new.recovery_key_attested_at < now() - make_interval(secs => new.max_evidence_age_seconds)
          )
        )
      )
    then
      raise exception using errcode = '23514', message = 'BACKUP_V2_FULL_DR_INCOMPLETE';
    end if;
  end if;
  return new;
end;
$$;

create trigger backup_v2_recovery_sets_state_guard
before insert or update on public.backup_v2_recovery_sets
for each row execute function public.backup_v2_enforce_recovery_set_state();

alter table public.backup_v2_runs enable row level security;
alter table public.backup_v2_run_events enable row level security;
alter table public.backup_v2_recovery_sets enable row level security;
alter table public.backup_v2_recovery_set_components enable row level security;
alter table public.backup_v2_measurements enable row level security;

revoke all on table public.backup_v2_runs from public, anon, authenticated;
revoke all on table public.backup_v2_run_events from public, anon, authenticated;
revoke all on table public.backup_v2_recovery_sets from public, anon, authenticated;
revoke all on table public.backup_v2_recovery_set_components from public, anon, authenticated;
revoke all on table public.backup_v2_measurements from public, anon, authenticated;
revoke all on sequence public.backup_v2_run_events_id_seq from public, anon, authenticated;
revoke all on table public.backup_v2_runs from service_role;
revoke all on table public.backup_v2_run_events from service_role;
revoke all on table public.backup_v2_recovery_sets from service_role;
revoke all on table public.backup_v2_recovery_set_components from service_role;
revoke all on table public.backup_v2_measurements from service_role;
revoke all on sequence public.backup_v2_run_events_id_seq from service_role;

grant select, insert on table public.backup_v2_runs to service_role;
grant select on table public.backup_v2_run_events to service_role;
grant select, insert, update on table public.backup_v2_recovery_sets to service_role;
grant select, insert, update on table public.backup_v2_recovery_set_components to service_role;
grant select, insert on table public.backup_v2_measurements to service_role;

revoke all on function public.backup_v2_enforce_run_transition() from public, anon, authenticated;
revoke all on function public.backup_v2_enforce_event_sequence() from public, anon, authenticated;
revoke all on function public.backup_v2_reject_event_mutation() from public, anon, authenticated;
revoke all on function public.transition_backup_v2_run(
  uuid, text, text, text, text, text, integer, text, jsonb
) from public, anon, authenticated;
revoke all on function public.backup_v2_validate_component() from public, anon, authenticated;
revoke all on function public.backup_v2_guard_component_delete() from public, anon, authenticated;
revoke all on function public.backup_v2_enforce_recovery_set_state() from public, anon, authenticated;
revoke all on function public.transition_backup_v2_run(
  uuid, text, text, text, text, text, integer, text, jsonb
) from service_role;
grant execute on function public.transition_backup_v2_run(
  uuid, text, text, text, text, text, integer, text, jsonb
) to service_role;

comment on table public.backup_v2_runs is
  'Modern Backup V2 control metadata; never stores backup payloads, business rows, or recovery material.';
comment on table public.backup_v2_run_events is
  'Append-only sanitized lifecycle evidence for Modern Backup V2 runs.';
comment on table public.backup_v2_measurements is
  'Size, runtime, operation, and quota-gate metrics only; never backup content.';
comment on table public.backup_v2_recovery_sets is
  'Typed recovery requirements and safe key-availability attestations; never stores private recovery material.';
