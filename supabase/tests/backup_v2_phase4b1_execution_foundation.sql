\set ON_ERROR_STOP on
begin;
select no_plan();

create function pg_temp.record_measurements(target_run_id uuid, scopes text[])
returns void language plpgsql as $$
declare scope_name text;
begin
  foreach scope_name in array public.backup_v2_normalize_scope_set(
    scopes || array['full_recovery_set','runtime']::text[]
  ) loop
    perform public.record_backup_v2_measurement(
      target_run_id,
      scope_name,
      now() - interval '1 minute',
      jsonb_build_object(
        'encrypted_bytes','1','temporary_peak_bytes','1','object_count','1','operation_count','1',
        'runtime_seconds','1','github_actions_minutes','0','database_total_bytes','1',
        'table_bytes','1','index_bytes','0','estimated_logical_bytes','1',
        'observed_artifact_bytes','1','storage_metadata_bytes','1','storage_object_bytes','1',
        'external_asset_bytes','1',
        'runner_temp_disk_available_bytes','1000000','provider_quota_bytes','1000000'
      )
    );
  end loop;
end;
$$;

create function pg_temp.add_artifact_and_primary(
  target_run_id uuid, target_set_id uuid, owner_ref text, lease_token bigint, component_name text, ordinal integer
)
returns uuid language plpgsql as $$
declare artifact public.backup_v2_artifacts%rowtype; copy public.backup_v2_artifact_copies%rowtype;
  digest text := repeat(substr(md5(component_name),1,1),64);
  exact_size numeric := 1000 + ordinal;
begin
  artifact := public.record_backup_v2_artifact(
    target_run_id,owner_ref,lease_token,target_set_id,component_name,'artifact-'||component_name,
    'format-v1','generation-v1',exact_size,digest,'schema:synthetic','key-v1','custody:synthetic',
    'SHA256:synthetic-public-fingerprint'
  );
  artifact := public.verify_backup_v2_artifact(
    target_run_id,owner_ref,lease_token,artifact.id,exact_size,digest
  );
  copy := public.record_backup_v2_artifact_copy(
    target_run_id,owner_ref,lease_token,artifact.id,'primary-'||component_name,'primary',
    'copy:primary:'||component_name,'physical:primary:'||component_name,'primary-domain',exact_size,digest
  );
  copy := public.verify_backup_v2_artifact_copy(
    target_run_id,owner_ref,lease_token,copy.id,exact_size,digest
  );
  return artifact.id;
end;
$$;

create function pg_temp.add_secondary(
  target_run_id uuid, owner_ref text, lease_token bigint, target_artifact_id uuid,
  component_name text, ordinal integer, verify_copy boolean
)
returns uuid language plpgsql as $$
declare copy public.backup_v2_artifact_copies%rowtype;
  digest text := repeat(substr(md5(component_name),1,1),64);
  exact_size numeric := 1000 + ordinal;
begin
  copy := public.record_backup_v2_artifact_copy(
    target_run_id,owner_ref,lease_token,target_artifact_id,'secondary-'||component_name,
    'secondary_independent','copy:secondary:'||component_name,'physical:secondary:'||component_name,
    'secondary-domain',exact_size,digest
  );
  if verify_copy then
    copy := public.verify_backup_v2_artifact_copy(
      target_run_id,owner_ref,lease_token,copy.id,exact_size,digest
    );
  end if;
  return copy.id;
end;
$$;

create function pg_temp.create_running_component(
  test_name text, boundary timestamptz, component_scope text, owner_ref text
)
returns uuid language plpgsql as $$
declare run_id uuid;
begin
  run_id := (public.create_or_get_backup_v2_generation(
    'policy-v1','local-disposable',boundary,array[component_scope],'manual',test_name
  )).id;
  perform pg_temp.record_measurements(run_id,array[component_scope]);
  perform public.prepare_backup_v2_preflight(run_id,3600);
  perform public.claim_backup_v2_run_lease(run_id,owner_ref,60);
  perform public.transition_backup_v2_run_fenced(
    run_id,component_scope,'preflight','running',owner_ref,1,'worker',owner_ref
  );
  return run_id;
end;
$$;

create function pg_temp.create_running_auth(test_name text, boundary timestamptz)
returns uuid language sql as $$
  select pg_temp.create_running_component(test_name,boundary,'auth','terminal-worker');
$$;

select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in (
    'backup_v2_catalog_snapshots','backup_v2_artifacts','backup_v2_artifact_copies'
  ) and c.relkind='r'),3,'three canonical Phase 4B evidence tables');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname like 'backup_v2_%' and c.relrowsecurity),8,
  'RLS remains enabled on every Backup V2 table');
select is((select count(*)::integer from information_schema.role_table_grants where table_schema='public'
  and table_name like 'backup_v2_%' and grantee in ('PUBLIC','anon','authenticated')),0,
  'generic roles have no Backup V2 table privileges');
select ok(not has_table_privilege('service_role','public.backup_v2_artifacts','INSERT,UPDATE,DELETE,TRUNCATE')
  and has_table_privilege('service_role','public.backup_v2_artifacts','SELECT'),
  'service role cannot forge artifacts directly');
select ok(not has_table_privilege('service_role','public.backup_v2_artifact_copies','INSERT,UPDATE,DELETE,TRUNCATE')
  and has_table_privilege('service_role','public.backup_v2_artifact_copies','SELECT'),
  'service role cannot forge copies directly');
select ok(has_function_privilege('service_role',
  'public.create_or_get_backup_v2_generation(text,text,timestamptz,text[],text,text)','EXECUTE')
  and not has_function_privilege('authenticated',
  'public.create_or_get_backup_v2_generation(text,text,timestamptz,text[],text,text)','EXECUTE'),
  'canonical generation creation is backend-only');
select ok(has_function_privilege('service_role','public.prepare_backup_v2_preflight(uuid,integer)','EXECUTE')
  and not has_function_privilege('anon','public.prepare_backup_v2_preflight(uuid,integer)','EXECUTE'),
  'canonical preflight is backend-only');
select ok(has_function_privilege('service_role',
  'public.transition_backup_v2_run_fenced(uuid,text,text,text,text,bigint,text,text,integer,text,jsonb)','EXECUTE')
  and not has_function_privilege('authenticated',
  'public.transition_backup_v2_run_fenced(uuid,text,text,text,text,bigint,text,text,integer,text,jsonb)','EXECUTE'),
  'fenced transition is backend-only');
select ok(has_function_privilege('service_role',
  'public.create_or_get_backup_v2_recovery_set(uuid,bigint)','EXECUTE')
  and not has_function_privilege('authenticated',
  'public.create_or_get_backup_v2_recovery_set(uuid,bigint)','EXECUTE'),
  'canonical recovery-set creation is backend-only');
select ok(has_function_privilege('service_role',
  'public.attest_backup_v2_recovery_key_availability(uuid,text,bigint,uuid,text,text,text)','EXECUTE')
  and not has_function_privilege('anon',
  'public.attest_backup_v2_recovery_key_availability(uuid,text,bigint,uuid,text,text,text)','EXECUTE'),
  'recovery-key availability evidence is backend-only');
select ok(has_function_privilege('service_role',
  'public.backup_v2_normalize_scope_set(text[])','EXECUTE')
  and not has_function_privilege('authenticated',
  'public.backup_v2_normalize_scope_set(text[])','EXECUTE'),
  'pure constraint helper has minimum service-backend privilege');
select ok((select prosecdef and proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_proc
  where oid='public.prepare_backup_v2_preflight(uuid,integer)'::regprocedure),
  'canonical preflight is hardened SECURITY DEFINER');
select ok((select prosecdef and proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_proc
  where oid='public.record_backup_v2_artifact(uuid,text,bigint,uuid,text,text,text,text,numeric,text,text,text,text,text)'::regprocedure),
  'artifact recording is hardened SECURITY DEFINER');
select ok((select prosecdef and proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_proc
  where oid='public.create_or_get_backup_v2_recovery_set(uuid,bigint)'::regprocedure),
  'canonical recovery-set creation is hardened SECURITY DEFINER');

set local role service_role;
insert into public.backup_v2_runs(
  id,request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version
) values(
  '4a1f0000-0000-4000-8000-000000000001',gen_random_uuid(),'database','system',2,
  'phase4a-regression','zero-spend-v1'
);
select is((select contract_version from public.backup_v2_runs
  where id='4a1f0000-0000-4000-8000-000000000001'),'phase4a',
  'service role can still create a valid Phase 4A run');
select public.transition_backup_v2_run(
  '4a1f0000-0000-4000-8000-000000000001','database','requested','preflight',
  'system',null,1,'PHASE4A_REGRESSION_PREFLIGHT','{}'::jsonb
);
select public.transition_backup_v2_run(
  '4a1f0000-0000-4000-8000-000000000001','database','preflight','failed',
  'system',null,1,'PHASE4A_REGRESSION_COMPLETE','{}'::jsonb
);
insert into public.backup_v2_recovery_sets(
  id,request_id,policy_version,required_scopes
) values(
  '4a2f0000-0000-4000-8000-000000000001',gen_random_uuid(),'typed-recovery-v2',
  array['database','auth','storage_objects']
);
insert into public.backup_v2_recovery_set_components(recovery_set_id,scope,run_id)
values(
  '4a2f0000-0000-4000-8000-000000000001','database',
  '4a1f0000-0000-4000-8000-000000000001'
);
select is((select lifecycle_state from public.backup_v2_recovery_sets
  where id='4a2f0000-0000-4000-8000-000000000001'),'assembling',
  'service role can still create a valid Phase 4A recovery set');
select is((select generation_key from public.backup_v2_recovery_set_components
  where recovery_set_id='4a2f0000-0000-4000-8000-000000000001' and scope='database'),
  null,'service role can attach a legacy null-generation component to a Phase 4A set');
reset role;

select throws_ok($$
  insert into public.backup_v2_runs(
    request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version,contract_version
  ) values(gen_random_uuid(),'database','manual',2,'phase4b1','zero-spend-v1','phase4b1')
$$,'23514',null,'direct Phase 4B insert without canonical keys is denied');
select throws_ok($$
  insert into public.backup_v2_runs(
    request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version,contract_version,
    generation_key,generation_scope_set,source_environment,generation_boundary
  ) values(gen_random_uuid(),'database','system',2,'phase4b1','zero-spend-v1','phase4b1',
    'backup-v2-generation:'||repeat('b',64),array['database'],'production',now())
$$,'23514',null,'direct Phase 4B insert without semantic request key is denied');
select throws_ok($$
  insert into public.backup_v2_runs(
    request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version,contract_version,
    semantic_request_key,generation_scope_set,source_environment,generation_boundary
  ) values(gen_random_uuid(),'database','system',2,'phase4b1','zero-spend-v1','phase4b1',
    'backup-v2:'||repeat('c',64),array['database'],'production',now())
$$,'23514',null,'direct Phase 4B insert without generation key is denied');

set local role service_role;
select throws_ok($$
  insert into public.backup_v2_runs(
    request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version,
    contract_version,semantic_request_key,generation_key,generation_scope_set,source_environment,generation_boundary
  ) values(gen_random_uuid(),'database','system',2,'phase4b1','zero-spend-v1','phase4b1',
    'backup-v2:'||repeat('a',64),'backup-v2-generation:'||repeat('a',64),array['database'],
    'production',now())
$$,'42501','BACKUP_V2_CANONICAL_CREATION_REQUIRED','service role cannot fabricate canonical identities directly');
reset role;

create temp table phase4b_ids(name text primary key,id uuid not null);
insert into phase4b_ids values
('missing',(public.create_or_get_backup_v2_generation(
  'policy-v1','production','2026-08-14 12:00:00+00',array['storage_objects'],'scheduled',null)).id),
('blocked',(public.create_or_get_backup_v2_generation(
  'policy-v1','production','2026-08-14 13:00:00+00',array['database'],'scheduled',null)).id),
('review',(public.create_or_get_backup_v2_generation(
  'policy-v1','production','2026-08-14 14:00:00+00',array['external_assets'],'scheduled',null)).id),
('main',(public.create_or_get_backup_v2_generation(
  'policy-v1','production','2026-08-14 15:00:00+00',
  array['storage_objects','auth','external_assets','database','storage_metadata','auth'],
  'scheduled',null)).id);
grant select on phase4b_ids to service_role;

set local role service_role;
select throws_ok($$
  insert into public.backup_v2_measurements(
    run_id,measurement_scope,source_kind,measured_at,measurement_quality
  ) values((select id from phase4b_ids where name='main'),'auth','runtime_verified',now(),'measured')
$$,'42501','BACKUP_V2_CANONICAL_MEASUREMENT_REQUIRED',
  'service role cannot forge Phase 4B measured evidence directly');
reset role;

select is(
  (public.create_or_get_backup_v2_generation(
    'policy-v1','PRODUCTION','2026-08-14 15:00:00+00',
    array['database','external_assets','auth','storage_objects','storage_metadata'],'scheduled',null)).id,
  (select id from phase4b_ids where name='main'),
  'same semantic request in different order and with duplicates returns one generation'
);
select is((select generation_scope_set from public.backup_v2_runs where id=(select id from phase4b_ids where name='main')),
  array['auth','database','external_assets','storage_metadata','storage_objects']::text[],
  'scope set is canonical and multi-component');
select throws_ok(format(
  'select public.claim_backup_v2_run_lease(%L::uuid,%L,60)',
  (select id from phase4b_ids where name='missing'),'worker-x'
),'55000','BACKUP_V2_LEASE_STATE_INVALID','missing preflight cannot claim');

select is((public.prepare_backup_v2_preflight(
  (select id from phase4b_ids where name='blocked'),3600)).preflight_outcome,
  'blocked','missing exact measurements block canonical preflight');
select throws_ok(format(
  'select public.claim_backup_v2_run_lease(%L::uuid,%L,60)',
  (select id from phase4b_ids where name='blocked'),'worker-x'
),'55000','BACKUP_V2_PREFLIGHT_NOT_AUTHORITATIVE','blocked preflight cannot claim');

create table public.backup_v2_future_unknown(id bigint primary key);
select is((public.prepare_backup_v2_preflight(
  (select id from phase4b_ids where name='review'),3600)).preflight_outcome,
  'blocked','BLOCKED takes precedence over REVIEW_REQUIRED');
select pg_temp.record_measurements(
  (select id from phase4b_ids where name='review'),array['external_assets']);
select is((public.prepare_backup_v2_preflight(
  (select id from phase4b_ids where name='review'),3600)).preflight_outcome,
  'review_required','unknown live relation forces review after measurements are complete');
select throws_ok(format(
  'select public.claim_backup_v2_run_lease(%L::uuid,%L,60)',
  (select id from phase4b_ids where name='review'),'worker-x'
),'55000','BACKUP_V2_PREFLIGHT_NOT_AUTHORITATIVE','review-required preflight cannot claim');
drop table public.backup_v2_future_unknown;

select set_config('app.backup_v2_transition_run_id',
  (select id::text from phase4b_ids where name='missing'),true);
update public.backup_v2_runs set lifecycle_state='failed',started_at=coalesce(started_at,now()),
  finished_at=now(),terminal_error_code='TEST_FIXTURE_COMPLETE'
where id=(select id from phase4b_ids where name='missing');
select set_config('app.backup_v2_transition_run_id',
  (select id::text from phase4b_ids where name='blocked'),true);
update public.backup_v2_runs set lifecycle_state='failed',finished_at=now(),
  terminal_error_code='TEST_FIXTURE_COMPLETE'
where id=(select id from phase4b_ids where name='blocked');
select set_config('app.backup_v2_transition_run_id',
  (select id::text from phase4b_ids where name='review'),true);
update public.backup_v2_runs set lifecycle_state='failed',finished_at=now(),
  terminal_error_code='TEST_FIXTURE_COMPLETE'
where id=(select id from phase4b_ids where name='review');

select pg_temp.record_measurements(
  (select id from phase4b_ids where name='main'),
  array['database','auth','storage_metadata','storage_objects','external_assets']);
select is((public.prepare_backup_v2_preflight(
  (select id from phase4b_ids where name='main'),3600)).preflight_outcome,'go',
  'current measured catalog produces canonical GO');
select is(
  (select relation_count from public.backup_v2_catalog_snapshots
    where run_id=(select id from phase4b_ids where name='main')),
  (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m')),
  'snapshot relation count is derived dynamically from the disposable schema'
);
select is((select review_required_count from public.backup_v2_catalog_snapshots
  where run_id=(select id from phase4b_ids where name='main')),0,
  'every current relation has an explicit safe policy classification');
select is((select count(*)::integer from jsonb_array_elements(
  (select classification_entries from public.backup_v2_catalog_snapshots
    where run_id=(select id from phase4b_ids where name='main'))
  ) entry where entry->>'classification' is null),0,'every snapshot entry is canonically classified');
select is((select jsonb_array_length(measurement_evidence) from public.backup_v2_catalog_snapshots
  where run_id=(select id from phase4b_ids where name='main')),7,
  'preflight persists the exact measurement evidence used');

set local role service_role;
select is((public.create_or_get_backup_v2_recovery_set(
  (select id from phase4b_ids where name='main'),3600)).generation_run_id,
  (select id from phase4b_ids where name='main'),
  'service backend creates the canonical generation-bound recovery set');
select is((public.create_or_get_backup_v2_recovery_set(
  (select id from phase4b_ids where name='main'),3600)).id,
  (select id from public.backup_v2_recovery_sets
    where generation_run_id=(select id from phase4b_ids where name='main')),
  'canonical recovery-set creation is idempotent');
reset role;
create temp table phase4b_set as
select id from public.backup_v2_recovery_sets
where generation_run_id=(select id from phase4b_ids where name='main');
grant select on phase4b_set to service_role;
select throws_ok($$
  update public.backup_v2_recovery_sets
  set generation_key=(select generation_key from public.backup_v2_runs
    where id=(select id from phase4b_ids where name='blocked'))
  where id=(select id from phase4b_set)
$$,'55000','BACKUP_V2_RECOVERY_SET_GENERATION_IMMUTABLE',
  'recovery-set generation binding is immutable');
set local role service_role;
select throws_ok($$
  insert into public.backup_v2_recovery_sets(
    request_id,policy_version,required_scopes,generation_run_id,generation_key
  ) select gen_random_uuid(),'car-zone-phase4b1-direct',generation_scope_set,id,generation_key
    from public.backup_v2_runs where id=(select id from phase4b_ids where name='main')
$$,'42501','BACKUP_V2_CANONICAL_RECOVERY_SET_CREATION_REQUIRED',
  'service role cannot bypass canonical Phase 4B recovery-set creation');
reset role;
select throws_ok($$
  insert into public.backup_v2_recovery_sets(request_id,policy_version,required_scopes)
  values(gen_random_uuid(),'car-zone-phase4b1-reduced',array['database'])
$$,'23514',null,'Car Zone Phase 4B full-DR policy cannot omit Auth, Storage, or external assets');

set local role service_role;
select throws_ok($$
  insert into public.backup_v2_recovery_set_components(recovery_set_id,scope,run_id)
  values((select id from phase4b_set),'database','4a1f0000-0000-4000-8000-000000000001')
$$,'23514','BACKUP_V2_COMPONENT_GENERATION_CONTRACT_INVALID',
  'service role cannot attach a legacy null-generation component to a Phase 4B set');
select throws_ok($$
  insert into public.backup_v2_recovery_set_components(recovery_set_id,scope,run_id,generation_key)
  select (select id from phase4b_set),'database',id,generation_key
  from public.backup_v2_runs where id=(select id from phase4b_ids where name='blocked')
$$,'23514','BACKUP_V2_COMPONENT_GENERATION_CONTRACT_INVALID',
  'service role cannot attach a different-generation Phase 4B component to a Phase 4B set');
select throws_ok($$
  insert into public.backup_v2_recovery_set_components(recovery_set_id,scope,run_id,generation_key)
  select (select id from phase4b_set),'auth',id,generation_key
  from public.backup_v2_runs where id=(select id from phase4b_ids where name='main')
$$,'42501','BACKUP_V2_CANONICAL_COMPONENT_EVIDENCE_REQUIRED',
  'service role cannot forge Phase 4B component evidence directly');
select throws_ok($$
  update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now()
  where id=(select id from phase4b_set)
$$,'42501','BACKUP_V2_CANONICAL_READINESS_OPERATION_REQUIRED',
  'service role cannot declare Phase 4B readiness directly');
reset role;

select is((public.claim_backup_v2_run_lease(
  (select id from phase4b_ids where name='main'),'worker-a',60)).lease_generation,1::bigint,
  'first authoritative claim returns fencing generation 1');
select throws_ok(format(
  'select public.claim_backup_v2_run_lease(%L::uuid,%L,60)',
  (select id from phase4b_ids where name='main'),'worker-b'
),'55P03','BACKUP_V2_LEASE_UNAVAILABLE','unexpired concurrent claim is denied');

update public.backup_v2_runs set lease_acquired_at=now()-interval '3 minutes',
  heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute'
where id=(select id from phase4b_ids where name='main');
select is((public.claim_backup_v2_run_lease(
  (select id from phase4b_ids where name='main'),'worker-b',60)).lease_generation,2::bigint,
  'expired lease is reclaimed with fencing generation 2');
select throws_ok(format(
  'select public.heartbeat_backup_v2_run_lease(%L::uuid,%L,1,60)',
  (select id from phase4b_ids where name='main'),'worker-a'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','stale worker heartbeat is denied');
select throws_ok(format(
  'select public.transition_backup_v2_run_fenced(%L::uuid,%L,%L,%L,%L,1,%L,%L)',
  (select id from phase4b_ids where name='main'),'auth','preflight','running','worker-a','worker','worker-a'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','stale worker transition is denied');
select throws_ok(format(
  'select public.record_backup_v2_artifact(%L::uuid,%L,1,%L::uuid,%L,%L,%L,%L,1,%L,%L,%L,%L,%L)',
  (select id from phase4b_ids where name='main'),'worker-a',(select id from phase4b_set),
  'database','stale-artifact','format-v1','generation-v1',repeat('a',64),'schema:x','key-v1',
  'custody:x','SHA256:synthetic-public'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','stale worker artifact recording is denied');
select throws_ok(format(
  'select public.record_backup_v2_artifact_copy(%L::uuid,%L,1,%L::uuid,%L,%L,%L,%L,%L,1,%L)',
  (select id from phase4b_ids where name='main'),'worker-a',gen_random_uuid(),'stale-copy','primary',
  'copy:stale','physical:stale','domain:stale',repeat('a',64)
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','stale worker copy recording is denied');
select throws_ok(format(
  'select public.record_backup_v2_component_evidence(%L::uuid,%L,1,%L::uuid,%L,%L,%L,%L)',
  (select id from phase4b_ids where name='main'),'worker-a',(select id from phase4b_set),
  'database','format-v1','schema:x','exporter-v1'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','stale worker component evidence is denied');
select throws_ok(format(
  'select public.transition_backup_v2_run(%L::uuid,%L,%L,%L,%L)',
  (select id from phase4b_ids where name='main'),'auth','preflight','running','worker'
),'55000','BACKUP_V2_FENCED_TRANSITION_REQUIRED','unfenced legacy transition cannot mutate Phase 4B');

set local role service_role;
select public.heartbeat_backup_v2_run_lease(
  (select id from phase4b_ids where name='main'),'worker-b',2,60);
select public.transition_backup_v2_run_fenced(
  (select id from phase4b_ids where name='main'),'auth','preflight','running',
  'worker-b',2,'worker','worker-b');
reset role;
select is((select lifecycle_state from public.backup_v2_runs
  where id=(select id from phase4b_ids where name='main')),'running',
  'service backend with the current owner and fencing generation is authorized');
select is((public.transition_backup_v2_run_fenced(
  (select id from phase4b_ids where name='main'),'auth','running','validating',
  'worker-b',2,'worker','worker-b')).lifecycle_state,'validating','current worker enters validation');

set local role service_role;
select is((public.attest_backup_v2_recovery_key_availability(
  (select id from phase4b_ids where name='main'),'worker-b',2,(select id from phase4b_set),
  'key-v1','custody:synthetic','SHA256:synthetic-public-fingerprint')).recovery_key_status,
  'availability_attested','current fenced backend records public key-availability metadata');
reset role;

create temp table phase4b_cross(
  component text primary key,id uuid not null,owner_ref text not null,ordinal integer not null
);
insert into phase4b_cross values
('database',pg_temp.create_running_component(
  'cross-generation-database','2026-08-14 16:00:00+00','database','cross-database'),
  'cross-database',11),
('storage_metadata',pg_temp.create_running_component(
  'cross-generation-storage-metadata','2026-08-14 16:01:00+00','storage_metadata','cross-metadata'),
  'cross-metadata',12),
('storage_objects',pg_temp.create_running_component(
  'cross-generation-storage-objects','2026-08-14 16:02:00+00','storage_objects','cross-objects'),
  'cross-objects',13),
('external_assets',pg_temp.create_running_component(
  'cross-generation-external-assets','2026-08-14 16:03:00+00','external_assets','cross-external'),
  'cross-external',14);
select throws_ok(format(
  'select public.record_backup_v2_artifact(%L::uuid,%L,1,%L::uuid,%L,%L,%L,%L,1,%L,%L,%L,%L,%L)',
  cross_run.id,cross_run.owner_ref,(select id from phase4b_set),cross_run.component,
  'cross-generation-artifact-'||cross_run.component,'format-v1','generation-v1',
  repeat(substr(md5(cross_run.component),1,1),64),
  'schema:x','key-v1','custody:x','SHA256:synthetic-public'
),'22023','BACKUP_V2_INVALID_ARTIFACT_EVIDENCE',
  'artifact from generation '||cross_run.component||' cannot enter generation A recovery set')
from phase4b_cross cross_run;

select throws_ok($$
  select public.finalize_backup_v2_recovery_set(
    (select id from phase4b_set),
    (select id from phase4b_ids where name='main'),'worker-b',2)
$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','zero canonical artifacts can never certify full DR');

create temp table phase4b_artifacts(component text primary key,artifact_id uuid not null,ordinal integer not null);
insert into phase4b_artifacts values
('database',pg_temp.add_artifact_and_primary(
  (select id from phase4b_ids where name='main'),(select id from phase4b_set),'worker-b',2,'database',1),1),
('auth',pg_temp.add_artifact_and_primary(
  (select id from phase4b_ids where name='main'),(select id from phase4b_set),'worker-b',2,'auth',2),2),
('storage_objects',pg_temp.add_artifact_and_primary(
  (select id from phase4b_ids where name='main'),(select id from phase4b_set),'worker-b',2,'storage_objects',3),3);

grant select on phase4b_artifacts to service_role;
set local role service_role;
select is((public.record_backup_v2_component_evidence(
  (select id from phase4b_ids where name='main'),'worker-b',2,
  (select id from phase4b_set),'auth','format-v1','schema:synthetic','exporter-v1')).generation_key,
  (select generation_key from public.backup_v2_runs
    where id=(select id from phase4b_ids where name='main')),
  'service role can record valid same-generation Phase 4B component evidence canonically');
reset role;
select public.record_backup_v2_component_evidence(
  (select id from phase4b_ids where name='main'),'worker-b',2,
  (select id from phase4b_set),component,'format-v1','schema:synthetic','exporter-v1')
from phase4b_artifacts where component<>'auth';

select throws_ok(format(
  'select public.record_backup_v2_artifact_copy(%L::uuid,%L,1,%L::uuid,%L,%L,%L,%L,%L,%s,%L)',
  (select id from phase4b_cross where component='database'),
  (select owner_ref from phase4b_cross where component='database'),
  (select artifact_id from phase4b_artifacts where component='database'),
  'cross-generation-copy','secondary_independent','copy:cross-generation',
  'physical:cross-generation','cross-domain',1001,repeat(substr(md5('database'),1,1),64)
),'23514','BACKUP_V2_COPY_EQUIVALENCE_FAILED',
  'copy operation cannot attach another generation to an artifact');
select is((public.transition_backup_v2_run_fenced(
  id,component,'running','failed',owner_ref,1,'worker',owner_ref,1,'CROSS_TEST_COMPLETE')).lifecycle_state,
  'failed','cross-generation '||component||' fixture closes safely')
from phase4b_cross;

select throws_ok($$
  select public.finalize_backup_v2_recovery_set(
    (select id from phase4b_set),
    (select id from phase4b_ids where name='main'),'worker-b',2)
$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE',
  'missing storage metadata and external-assets artifacts keeps readiness false');

insert into phase4b_artifacts values
('external_assets',pg_temp.add_artifact_and_primary(
  (select id from phase4b_ids where name='main'),(select id from phase4b_set),'worker-b',2,'external_assets',4),4);
select public.record_backup_v2_component_evidence(
  (select id from phase4b_ids where name='main'),'worker-b',2,
  (select id from phase4b_set),'external_assets','format-v1','schema:synthetic','exporter-v1');

select throws_ok($$
  select public.finalize_backup_v2_recovery_set(
    (select id from phase4b_set),
    (select id from phase4b_ids where name='main'),'worker-b',2)
$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','missing storage_metadata alone keeps readiness false');

insert into phase4b_artifacts values
('storage_metadata',pg_temp.add_artifact_and_primary(
  (select id from phase4b_ids where name='main'),(select id from phase4b_set),
  'worker-b',2,'storage_metadata',5),5);
select public.record_backup_v2_component_evidence(
  (select id from phase4b_ids where name='main'),'worker-b',2,
  (select id from phase4b_set),'storage_metadata','format-v1','schema:synthetic','exporter-v1');

select throws_ok($$
  select public.finalize_backup_v2_recovery_set(
    (select id from phase4b_set),
    (select id from phase4b_ids where name='main'),'worker-b',2)
$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','primary copies alone cannot certify full DR');

select throws_ok(format(
  'select public.record_backup_v2_artifact_copy(%L::uuid,%L,2,%L::uuid,%L,%L,%L,%L,%L,%s,%L)',
  (select id from phase4b_ids where name='main'),'worker-b',
  (select artifact_id from phase4b_artifacts where component='database'),'secondary-alias','secondary_independent',
  'copy:secondary:alias','physical:primary:database','secondary-domain',1001,
  repeat(substr(md5('database'),1,1),64)
),'23505',null,'same physical object identity cannot masquerade as an independent copy');
select throws_ok(format(
  'select public.record_backup_v2_artifact_copy(%L::uuid,%L,2,%L::uuid,%L,%L,%L,%L,%L,%s,%L)',
  (select id from phase4b_ids where name='main'),'worker-b',
  (select artifact_id from phase4b_artifacts where component='database'),'secondary-bad-hash',
  'secondary_independent','copy:secondary:bad-hash','physical:secondary:bad-hash','secondary-domain',1001,
  repeat('f',64)
),'23514','BACKUP_V2_COPY_EQUIVALENCE_FAILED','hash mismatch is rejected before evidence persistence');
select throws_ok(format(
  'select public.record_backup_v2_artifact_copy(%L::uuid,%L,2,%L::uuid,%L,%L,%L,%L,%L,%s,%L)',
  (select id from phase4b_ids where name='main'),'worker-b',
  (select artifact_id from phase4b_artifacts where component='database'),'secondary-bad-size',
  'secondary_independent','copy:secondary:bad-size','physical:secondary:bad-size','secondary-domain',9999,
  repeat(substr(md5('database'),1,1),64)
),'23514','BACKUP_V2_COPY_EQUIVALENCE_FAILED','byte-count mismatch is rejected before evidence persistence');

select pg_temp.add_secondary(
  (select id from phase4b_ids where name='main'),'worker-b',2,artifact_id,component,ordinal,true)
from phase4b_artifacts where component<>'external_assets';
select throws_ok($$
  select public.finalize_backup_v2_recovery_set(
    (select id from phase4b_set),
    (select id from phase4b_ids where name='main'),'worker-b',2)
$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','missing required external-assets copy keeps readiness false');

select pg_temp.add_secondary(
  (select id from phase4b_ids where name='main'),'worker-b',2,artifact_id,component,ordinal,false)
from phase4b_artifacts where component='external_assets';
select throws_ok($$
  select public.finalize_backup_v2_recovery_set(
    (select id from phase4b_set),
    (select id from phase4b_ids where name='main'),'worker-b',2)
$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','unverified independent copy keeps readiness false');

select public.verify_backup_v2_artifact_copy(
  (select id from phase4b_ids where name='main'),'worker-b',2,copy.id,
  artifact.ciphertext_size_bytes,artifact.ciphertext_hash)
from public.backup_v2_artifact_copies copy
join public.backup_v2_artifacts artifact on artifact.id=copy.artifact_id
where artifact.component='external_assets' and copy.copy_role='secondary_independent';
select is((public.finalize_backup_v2_recovery_set(
  (select id from phase4b_set),
  (select id from phase4b_ids where name='main'),'worker-b',2)).lifecycle_state,
  'full_dr_ready','only complete canonical artifact/copy/component evidence certifies full DR');
select is((public.transition_backup_v2_run_fenced(
  (select id from phase4b_ids where name='main'),'auth','validating','completed',
  'worker-b',2,'worker','worker-b')).lifecycle_state,'completed',
  'completed generation is chained to full canonical DR readiness');
select is((select lease_owner_ref from public.backup_v2_runs
  where id=(select id from phase4b_ids where name='main')),null,'terminal transition clears lease authority');
select throws_ok(format(
  'select public.claim_backup_v2_run_lease(%L::uuid,%L,60)',
  (select id from phase4b_ids where name='main'),'worker-c'
),'55000','BACKUP_V2_LEASE_STATE_INVALID','terminal run cannot be reclaimed');

create temp table terminal_runs(name text primary key,id uuid not null);
insert into terminal_runs values
('fresh_failed',pg_temp.create_running_auth('terminal-fresh-failed','2026-08-14 17:00:00+00'));
select is((public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='fresh_failed'),'auth','running','failed',
  'terminal-worker',1,'worker','terminal-worker',1,'EXPECTED_FAILURE')).lifecycle_state,
  'failed','current fenced owner can fail with fresh preflight');

insert into terminal_runs values
('stale_failed',pg_temp.create_running_auth('terminal-stale-failed','2026-08-14 17:01:00+00'));
update public.backup_v2_catalog_snapshots set preflight_expires_at=discovered_at
where run_id=(select id from terminal_runs where name='stale_failed');
select is((public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='stale_failed'),'auth','running','failed',
  'terminal-worker',1,'worker','terminal-worker',1,'EXPECTED_STALE_FAILURE')).lifecycle_state,
  'failed','current fenced owner can fail after preflight expiry');

insert into terminal_runs values
('stale_cancelled',pg_temp.create_running_auth('terminal-stale-cancelled','2026-08-14 17:02:00+00'));
update public.backup_v2_catalog_snapshots set preflight_expires_at=discovered_at
where run_id=(select id from terminal_runs where name='stale_cancelled');
select is((public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='stale_cancelled'),'auth','running','cancelled',
  'terminal-worker',1,'worker','terminal-worker',1,'EXPECTED_CANCELLATION')).lifecycle_state,
  'cancelled','current fenced owner can cancel after preflight expiry');

insert into terminal_runs values
('stale_success',pg_temp.create_running_auth('terminal-stale-success','2026-08-14 17:03:00+00'));
select public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='stale_success'),'auth','running','validating',
  'terminal-worker',1,'worker','terminal-worker');
update public.backup_v2_catalog_snapshots set preflight_expires_at=discovered_at
where run_id=(select id from terminal_runs where name='stale_success');
select throws_ok(format(
  'select public.transition_backup_v2_run_fenced(%L::uuid,%L,%L,%L,%L,1,%L,%L)',
  (select id from terminal_runs where name='stale_success'),'auth','validating','completed',
  'terminal-worker','worker','terminal-worker'
),'55000','BACKUP_V2_PREFLIGHT_NOT_AUTHORITATIVE',
  'successful completion remains denied with stale preflight');
select public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='stale_success'),'auth','validating','failed',
  'terminal-worker',1,'worker','terminal-worker',1,'STALE_SUCCESS_CLOSED');

insert into terminal_runs values
('wrong_owner',pg_temp.create_running_auth('terminal-wrong-owner','2026-08-14 17:04:00+00'));
select throws_ok(format(
  'select public.transition_backup_v2_run_fenced(%L::uuid,%L,%L,%L,%L,1,%L,%L)',
  (select id from terminal_runs where name='wrong_owner'),'auth','running','failed',
  'wrong-worker','worker','wrong-worker'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','wrong owner cannot record FAILED');
select public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='wrong_owner'),'auth','running','failed',
  'terminal-worker',1,'worker','terminal-worker',1,'WRONG_OWNER_CLOSED');

insert into terminal_runs values
('stale_generation',pg_temp.create_running_auth('terminal-stale-generation','2026-08-14 17:05:00+00'));
select throws_ok(format(
  'select public.transition_backup_v2_run_fenced(%L::uuid,%L,%L,%L,%L,2,%L,%L)',
  (select id from terminal_runs where name='stale_generation'),'auth','running','failed',
  'terminal-worker','worker','terminal-worker'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','stale generation cannot record FAILED');
select public.transition_backup_v2_run_fenced(
  (select id from terminal_runs where name='stale_generation'),'auth','running','failed',
  'terminal-worker',1,'worker','terminal-worker',1,'STALE_GENERATION_CLOSED');

insert into terminal_runs values
('expired_lease',pg_temp.create_running_auth('terminal-expired-lease','2026-08-14 17:06:00+00'));
update public.backup_v2_runs set lease_acquired_at=now()-interval '3 minutes',
  heartbeat_at=now()-interval '2 minutes',lease_expires_at=now()-interval '1 minute'
where id=(select id from terminal_runs where name='expired_lease');
select throws_ok(format(
  'select public.transition_backup_v2_run_fenced(%L::uuid,%L,%L,%L,%L,1,%L,%L)',
  (select id from terminal_runs where name='expired_lease'),'auth','running','failed',
  'terminal-worker','worker','terminal-worker'
),'55000','BACKUP_V2_LEASE_NOT_AUTHORITATIVE','expired lease cannot record FAILED');

select is((select count(*)::integer from information_schema.columns where table_schema='public'
  and table_name like 'backup_v2_%' and column_name ~* '(private.*key|secret|credential|password)'),0,
  'no private key, secret, credential, or password column exists');
select is((select count(*)::integer from pg_policies where schemaname='public'
  and tablename like 'backup_v2_%'),0,'no end-user Backup V2 RLS policy exists');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('backup_runs','backup_logs','operational_backup_checks')),3,
  'Backup V1 technical tables remain intact');

select * from finish();
rollback;
\echo 'Modern Backup V2 Phase 4B.1 authoritative correction: OK'
