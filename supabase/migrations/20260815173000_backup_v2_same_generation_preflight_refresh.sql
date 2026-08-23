-- Phase 4B.6: atomic, fail-closed preflight refresh for a running generation
-- that has not produced any durable export evidence.

create or replace function public.refresh_backup_v2_same_generation_preflight(
  target_run_id uuid,
  expected_generation_key text,
  input_measurements jsonb,
  measurement_max_age_seconds integer default 3600
)
returns public.backup_v2_catalog_snapshots
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_run public.backup_v2_runs%rowtype;
  prior_snapshot public.backup_v2_catalog_snapshots%rowtype;
  snapshot_result public.backup_v2_catalog_snapshots%rowtype;
  measurement_item jsonb;
  measurement_scope text;
  measurement_time timestamptz;
  measurement_values jsonb;
  required_keys constant text[] := array[
    'encrypted_bytes', 'temporary_peak_bytes', 'object_count', 'operation_count',
    'runtime_seconds', 'github_actions_minutes'
  ];
  allowed_keys constant text[] := required_keys || array[
    'database_total_bytes', 'table_bytes', 'index_bytes', 'estimated_logical_bytes',
    'observed_artifact_bytes', 'storage_metadata_bytes', 'storage_object_bytes',
    'external_asset_bytes', 'runner_temp_disk_available_bytes', 'provider_quota_bytes'
  ];
  canonical_scopes constant text[] := array[
    'auth', 'database', 'external_assets', 'full_recovery_set', 'runtime',
    'storage_metadata', 'storage_objects'
  ];
  observed_scopes text[];
  catalog_entries jsonb;
  measurement_entries jsonb;
  catalog_findings jsonb;
  measurement_findings jsonb;
  all_findings jsonb;
  current_fingerprint text;
  relation_total integer;
  required_total integer;
  metadata_total integer;
  reconstructable_total integer;
  excluded_total integer;
  review_total integer;
  missing_measurement_total integer;
  outcome text;
  expiry timestamptz;
  reason_codes text[];
  recovery_set_count integer;
begin
  if expected_generation_key is null
    or expected_generation_key !~ '^backup-v2-generation:[0-9a-f]{64}$'
    or measurement_max_age_seconds not between 60 and 86400
    or jsonb_typeof(input_measurements) <> 'array'
    or jsonb_array_length(input_measurements) <> 7 then
    raise exception using errcode = '22023', message = 'BACKUP_V2_PREFLIGHT_REFRESH_INPUT_INVALID';
  end if;

  select * into current_run
  from public.backup_v2_runs
  where id = target_run_id
  for update;
  if current_run.id is null then
    raise exception using errcode = 'P0002', message = 'BACKUP_V2_RUN_NOT_FOUND';
  end if;
  if current_run.contract_version <> 'phase4b1'
    or current_run.lifecycle_state <> 'running'
    or current_run.generation_key is distinct from expected_generation_key
    or current_run.preflight_outcome <> 'go'
    or current_run.preflight_snapshot_id is null then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_REFRESH_STATE_INVALID';
  end if;
  if current_run.lease_owner_ref is not null and current_run.lease_expires_at > now() then
    raise exception using errcode = '55P03', message = 'BACKUP_V2_PREFLIGHT_REFRESH_LEASE_UNAVAILABLE';
  end if;

  select * into prior_snapshot
  from public.backup_v2_catalog_snapshots
  where id = current_run.preflight_snapshot_id
    and run_id = current_run.id
    and generation_key = current_run.generation_key
  for update;
  if prior_snapshot.id is null or prior_snapshot.preflight_outcome <> 'go' then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_REFRESH_PREDECESSOR_INVALID';
  end if;

  select count(*)::integer into recovery_set_count
  from public.backup_v2_recovery_sets
  where generation_run_id = current_run.id
    and generation_key = current_run.generation_key;
  if recovery_set_count <> 1
    or exists(select 1 from public.backup_v2_recovery_set_components where run_id = current_run.id)
    or exists(select 1 from public.backup_v2_artifacts where run_id = current_run.id)
    or exists(
      select 1 from public.backup_v2_artifact_copies copy
      join public.backup_v2_artifacts artifact on artifact.id = copy.artifact_id
      where artifact.run_id = current_run.id
    ) then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_REFRESH_LATER_STATE_DENIED';
  end if;

  select array_agg(scope order by convert_to(scope, 'UTF8')) into observed_scopes
  from (
    select distinct item->>'scope' as scope
    from jsonb_array_elements(input_measurements) item
  ) scopes;
  if observed_scopes is distinct from canonical_scopes then
    raise exception using errcode = '22023', message = 'BACKUP_V2_PREFLIGHT_REFRESH_SCOPE_SET_INVALID';
  end if;

  for measurement_item in select value from jsonb_array_elements(input_measurements) loop
    measurement_scope := measurement_item->>'scope';
    measurement_time := (measurement_item->>'measured_at')::timestamptz;
    measurement_values := measurement_item->'values';
    if measurement_scope is null
      or measurement_time is null or measurement_time > now()
      or jsonb_typeof(measurement_values) <> 'object'
      or exists(select 1 from jsonb_object_keys(measurement_values) key where not key = any(allowed_keys))
      or exists(select 1 from unnest(required_keys) key where not measurement_values ? key)
      or exists(
        select 1 from jsonb_each_text(measurement_values) item
        where item.key <> all(array['runtime_seconds', 'github_actions_minutes'])
          and item.value !~ '^(0|[1-9][0-9]*)$'
      )
      or coalesce(measurement_values->>'runtime_seconds', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$'
      or coalesce(measurement_values->>'github_actions_minutes', '') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$' then
      raise exception using errcode = '22023', message = 'BACKUP_V2_PREFLIGHT_REFRESH_MEASUREMENT_INVALID';
    end if;

    insert into public.backup_v2_measurements(
      run_id, measurement_scope, source_kind, measured_at, measurement_quality,
      encrypted_bytes, temporary_peak_bytes, object_count, operation_count,
      runtime_seconds, github_actions_minutes, database_total_bytes, table_bytes, index_bytes,
      estimated_logical_bytes, observed_artifact_bytes, storage_metadata_bytes,
      storage_object_bytes, external_asset_bytes, runner_temp_disk_available_bytes, provider_quota_bytes
    ) values (
      target_run_id, measurement_scope, 'runtime_verified', measurement_time, 'measured',
      (measurement_values->>'encrypted_bytes')::bigint,
      (measurement_values->>'temporary_peak_bytes')::bigint,
      (measurement_values->>'object_count')::bigint,
      (measurement_values->>'operation_count')::bigint,
      (measurement_values->>'runtime_seconds')::numeric,
      (measurement_values->>'github_actions_minutes')::numeric,
      (measurement_values->>'database_total_bytes')::numeric,
      (measurement_values->>'table_bytes')::numeric,
      (measurement_values->>'index_bytes')::numeric,
      (measurement_values->>'estimated_logical_bytes')::numeric,
      (measurement_values->>'observed_artifact_bytes')::numeric,
      (measurement_values->>'storage_metadata_bytes')::numeric,
      (measurement_values->>'storage_object_bytes')::numeric,
      (measurement_values->>'external_asset_bytes')::numeric,
      (measurement_values->>'runner_temp_disk_available_bytes')::numeric,
      (measurement_values->>'provider_quota_bytes')::numeric
    );
  end loop;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'schemaName', schema_name, 'relationName', relation_name, 'relationKind', relation_kind,
      'classification', classification, 'classificationReason', classification_reason,
      'estimatedRows', estimated_rows::text, 'totalBytes', total_bytes::text,
      'tableBytes', table_bytes::text, 'indexBytes', index_bytes::text
    ) order by convert_to(schema_name || '.' || relation_name, 'UTF8')), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (where classification = 'required_backup')::integer,
    count(*) filter (where classification = 'metadata_only')::integer,
    count(*) filter (where classification = 'reconstructable')::integer,
    count(*) filter (where classification = 'exclude_with_justification')::integer,
    count(*) filter (where classification = 'review_required')::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'severity', 'review_required', 'reason', 'catalog_review_required',
      'detail', schema_name || '.' || relation_name
    ) order by convert_to(schema_name || '.' || relation_name, 'UTF8'))
      filter (where classification = 'review_required'), '[]'::jsonb)
  into catalog_entries, relation_total, required_total, metadata_total, reconstructable_total,
       excluded_total, review_total, catalog_findings
  from public.backup_v2_current_catalog();
  current_fingerprint := public.backup_v2_current_catalog_fingerprint();

  with required_scopes as (
    select unnest(canonical_scopes) as scope
  ), ranked as (
    select distinct on (measurement.measurement_scope) measurement.*
    from public.backup_v2_measurements measurement
    join required_scopes required on required.scope = measurement.measurement_scope
    where measurement.run_id = target_run_id
      and measurement.source_kind = 'runtime_verified'
      and measurement.measurement_quality = 'measured'
      and measurement.measured_at <= now()
      and measurement.measured_at >= now() - make_interval(secs => measurement_max_age_seconds)
      and case measurement.measurement_scope
        when 'database' then measurement.database_total_bytes is not null
        when 'storage_metadata' then measurement.storage_metadata_bytes is not null
        when 'storage_objects' then measurement.storage_object_bytes is not null
        when 'external_assets' then measurement.external_asset_bytes is not null
        when 'full_recovery_set' then measurement.observed_artifact_bytes is not null
        when 'runtime' then measurement.runner_temp_disk_available_bytes is not null
          and measurement.provider_quota_bytes is not null
        else true
      end
    order by measurement.measurement_scope, measurement.measured_at desc, measurement.id
  ), missing as (
    select required.scope
    from required_scopes required
    left join ranked measurement on measurement.measurement_scope = required.scope
    where measurement.id is null
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'measurementId', ranked.id, 'scope', ranked.measurement_scope, 'quality', ranked.measurement_quality,
      'source', ranked.source_kind, 'measuredAt', ranked.measured_at
    ) order by convert_to(ranked.measurement_scope, 'UTF8')) from ranked), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'severity', 'blocked', 'reason', 'measurement_exact_required',
      'detail', scope || ' requires current measured runtime evidence'
    ) order by convert_to(scope, 'UTF8')) from missing), '[]'::jsonb),
    (select count(*)::integer from missing),
    coalesce((select min(ranked.measured_at + make_interval(secs => measurement_max_age_seconds)) from ranked), now())
  into measurement_entries, measurement_findings, missing_measurement_total, expiry;

  all_findings := catalog_findings || measurement_findings;
  outcome := case
    when missing_measurement_total > 0 then 'blocked'
    when review_total > 0 then 'review_required'
    else 'go'
  end;
  select coalesce(array_agg(reason order by convert_to(reason, 'UTF8')), '{}'::text[])
  into reason_codes
  from (
    select distinct finding->>'reason' as reason
    from jsonb_array_elements(all_findings) finding
  ) reasons;

  insert into public.backup_v2_catalog_snapshots(
    run_id, generation_key, policy_version, catalog_fingerprint,
    relation_count, required_backup_count, metadata_only_count, reconstructable_count,
    excluded_count, review_required_count, classification_entries, measurement_evidence,
    findings, preflight_outcome, discovered_at, preflight_expires_at, evidence_origin
  ) values (
    target_run_id, current_run.generation_key, 'car-zone-phase4b1-catalog-v2', current_fingerprint,
    relation_total, required_total, metadata_total, reconstructable_total,
    excluded_total, review_total, catalog_entries, measurement_entries,
    all_findings, outcome, now(), greatest(expiry, now()), 'runtime_verified'
  )
  on conflict (run_id) do update set
    generation_key = excluded.generation_key,
    policy_version = excluded.policy_version,
    catalog_fingerprint = excluded.catalog_fingerprint,
    relation_count = excluded.relation_count,
    required_backup_count = excluded.required_backup_count,
    metadata_only_count = excluded.metadata_only_count,
    reconstructable_count = excluded.reconstructable_count,
    excluded_count = excluded.excluded_count,
    review_required_count = excluded.review_required_count,
    classification_entries = excluded.classification_entries,
    measurement_evidence = excluded.measurement_evidence,
    findings = excluded.findings,
    preflight_outcome = excluded.preflight_outcome,
    discovered_at = excluded.discovered_at,
    preflight_expires_at = excluded.preflight_expires_at,
    evidence_origin = excluded.evidence_origin,
    created_at = now()
  returning * into snapshot_result;

  update public.backup_v2_runs set
    preflight_snapshot_id = snapshot_result.id,
    preflight_outcome = outcome,
    preflight_reasons = reason_codes,
    catalog_policy_version = snapshot_result.policy_version,
    relations_discovered = relation_total,
    relations_classified = relation_total,
    relations_unknown = review_total
  where id = target_run_id;

  if snapshot_result.generation_key is distinct from expected_generation_key
    or snapshot_result.id is distinct from prior_snapshot.id
    or snapshot_result.preflight_outcome <> 'go'
    or snapshot_result.preflight_expires_at <= now() then
    raise exception using errcode = '55000', message = 'BACKUP_V2_PREFLIGHT_REFRESH_NOT_AUTHORITATIVE';
  end if;
  return snapshot_result;
exception when numeric_value_out_of_range or invalid_text_representation then
  raise exception using errcode = '22023', message = 'BACKUP_V2_PREFLIGHT_REFRESH_MEASUREMENT_INVALID';
end;
$$;

revoke all on function public.refresh_backup_v2_same_generation_preflight(uuid,text,jsonb,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_backup_v2_same_generation_preflight(uuid,text,jsonb,integer)
  to service_role;

comment on function public.refresh_backup_v2_same_generation_preflight(uuid,text,jsonb,integer) is
  'Atomically refreshes all seven runtime measurements and the canonical catalog snapshot for the same running pre-export generation after lease/preflight expiry; never creates a generation.';
