\set ON_ERROR_STOP on
begin;
select plan(52);

select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('backup_v2_runs','backup_v2_run_events','backup_v2_recovery_sets','backup_v2_recovery_set_components','backup_v2_measurements') and c.relkind='r'),5,'five control tables');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname like 'backup_v2_%' and c.relrowsecurity),5,'RLS on all control tables');
select is((select count(*)::integer from information_schema.role_table_grants where table_schema='public' and table_name like 'backup_v2_%' and grantee in ('PUBLIC','anon','authenticated')),0,'generic roles have no table privileges');
select ok(not has_function_privilege('anon','public.transition_backup_v2_run(uuid,text,text,text,text,text,integer,text,jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.transition_backup_v2_run(uuid,text,text,text,text,text,integer,text,jsonb)','EXECUTE'),'generic roles cannot transition');
select ok(has_function_privilege('service_role','public.transition_backup_v2_run(uuid,text,text,text,text,text,integer,text,jsonb)','EXECUTE'),'service role can execute canonical transition');
select is((select count(*)::integer from information_schema.role_table_grants where table_schema='public' and table_name like 'backup_v2_%' and grantee='service_role' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')),0,'service role has no destructive/default privileges');
select ok(has_table_privilege('service_role','public.backup_v2_runs','SELECT,INSERT') and not has_table_privilege('service_role','public.backup_v2_runs','UPDATE,DELETE,TRUNCATE'),'run grants are least privilege');
select ok(has_table_privilege('service_role','public.backup_v2_run_events','SELECT') and not has_table_privilege('service_role','public.backup_v2_run_events','INSERT,UPDATE,DELETE,TRUNCATE'),'events cannot be forged directly');
select ok(not has_table_privilege('service_role','public.backup_v2_measurements','UPDATE,DELETE,TRUNCATE'),'measurements are append-only to backend');
select ok((select prosecdef and proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_proc where oid='public.transition_backup_v2_run(uuid,text,text,text,text,text,integer,text,jsonb)'::regprocedure),'transition is hardened SECURITY DEFINER');

select throws_ok($$insert into public.backup_v2_runs(request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version) values(gen_random_uuid(),'unknown','manual',2,'phase4a','zero')$$,'23514',null,'unknown scope rejected');
select throws_ok($$insert into public.backup_v2_runs(request_id,scope,trigger_type,lifecycle_state,format_version,engine_version,zero_spend_policy_version,started_at) values(gen_random_uuid(),'database','manual','running',2,'phase4a','zero',now())$$,'23514','BACKUP_V2_INITIAL_STATE_INVALID','invalid initial state rejected');
insert into public.backup_v2_runs(id,request_id,scope,trigger_type,format_version,engine_version,schema_version,classification_version,commit_sha,zero_spend_policy_version) values('4a100000-0000-4000-8000-000000000001',gen_random_uuid(),'database','manual',2,'phase4a','migration-head:dynamic','classification-contract-v1','55a259c67dedb31be909bf3528c2fa66e1982302','zero-spend-v1');
select pass('valid dynamic-provenance run accepted');
select throws_ok($$update public.backup_v2_runs set scope='auth' where id='4a100000-0000-4000-8000-000000000001'$$,'55000','BACKUP_V2_RUN_SCOPE_IMMUTABLE','run scope immutable');
select throws_ok($$update public.backup_v2_runs set lifecycle_state='preflight',started_at=now() where id='4a100000-0000-4000-8000-000000000001'$$,'55000','BACKUP_V2_DIRECT_STATE_MUTATION_DENIED','direct state mutation denied');
select throws_ok($$select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','auth','requested','preflight','worker')$$,'23514','BACKUP_V2_EVENT_SCOPE_MISMATCH','scope mismatch rejected');
select throws_ok($$select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','running','preflight','worker')$$,'23514','BACKUP_V2_EVENT_FROM_STATE_MISMATCH','wrong from state rejected');
select throws_ok($$select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','requested','completed','worker')$$,'23514','BACKUP_V2_INVALID_STATE_TRANSITION','illegal transition rejected');
select is((public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','requested','preflight','worker')).lifecycle_state,'preflight','canonical transition updates run');
select is((select next_state from public.backup_v2_run_events where run_id='4a100000-0000-4000-8000-000000000001' and sequence_number=1),'preflight','canonical transition appends event');
select is((select scope from public.backup_v2_run_events where run_id='4a100000-0000-4000-8000-000000000001' and sequence_number=1),'database','event scope matches run');
select throws_ok($$insert into public.backup_v2_run_events(run_id,scope,sequence_number,previous_state,next_state,actor_type) values('4a100000-0000-4000-8000-000000000001','database',2,'requested','completed','system')$$,'23514','BACKUP_V2_EVENT_TRANSITION_INVALID','contradictory event rejected');
select is((public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','preflight','running','worker')).lifecycle_state,'running','running transition');
select throws_ok($$insert into public.backup_v2_run_events(run_id,scope,sequence_number,previous_state,next_state,actor_type) values('4a100000-0000-4000-8000-000000000001','database',4,'preflight','running','system')$$,'23514','BACKUP_V2_EVENT_SEQUENCE_INVALID','out-of-order sequence rejected');
select throws_ok($$insert into public.backup_v2_run_events(run_id,scope,sequence_number,previous_state,next_state,actor_type) values('4a100000-0000-4000-8000-000000000001','database',2,'preflight','running','system')$$,'23514','BACKUP_V2_EVENT_SEQUENCE_INVALID','duplicate sequence rejected before persistence');
select is((select lifecycle_state || ':' || count(*)::text from public.backup_v2_runs r join public.backup_v2_run_events e on e.run_id=r.id where r.id='4a100000-0000-4000-8000-000000000001' group by lifecycle_state),'running:2','rejected events leave authoritative run and event chain consistent');
select is((public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','running','validating','worker')).lifecycle_state,'validating','validating transition');
select is((public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','validating','completed','worker')).lifecycle_state,'completed','completed transition');
select is((select count(*)::integer from public.backup_v2_run_events where run_id='4a100000-0000-4000-8000-000000000001'),4,'event chain complete and ordered');
select throws_ok($$select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000001','database','completed','running','worker')$$,'55000','BACKUP_V2_TERMINAL_STATE_IMMUTABLE','terminal transition rejected');

insert into public.backup_v2_runs(id,request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version,relations_discovered,relations_classified,relations_unknown) values
 ('4a100000-0000-4000-8000-000000000004',gen_random_uuid(),'database','manual',2,'phase4a','zero-spend-v1',2,1,1);
select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000004','database','requested','preflight','worker');
select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000004','database','preflight','running','worker');
select throws_ok($$select public.transition_backup_v2_run('4a100000-0000-4000-8000-000000000004','database','running','validating','worker')$$,'23514','BACKUP_V2_CATALOG_CLASSIFICATION_INCOMPLETE','unknown or unclassified relations fail closed');
select is((select lifecycle_state || ':' || count(*)::text from public.backup_v2_runs r join public.backup_v2_run_events e on e.run_id=r.id where r.id='4a100000-0000-4000-8000-000000000004' group by lifecycle_state),'running:2','catalog rejection leaves state and event evidence atomic');

insert into public.backup_v2_runs(id,request_id,scope,trigger_type,format_version,engine_version,zero_spend_policy_version) values
 ('4a100000-0000-4000-8000-000000000002',gen_random_uuid(),'auth','manual',2,'phase4a','zero-spend-v1'),
 ('4a100000-0000-4000-8000-000000000003',gen_random_uuid(),'storage_objects','manual',2,'phase4a','zero-spend-v1');
select pass('auth and storage runs created');
select public.transition_backup_v2_run(id,scope,'requested','preflight','worker') from public.backup_v2_runs where id in ('4a100000-0000-4000-8000-000000000002','4a100000-0000-4000-8000-000000000003');
select public.transition_backup_v2_run(id,scope,'preflight','running','worker') from public.backup_v2_runs where id in ('4a100000-0000-4000-8000-000000000002','4a100000-0000-4000-8000-000000000003');
select public.transition_backup_v2_run(id,scope,'running','validating','worker') from public.backup_v2_runs where id in ('4a100000-0000-4000-8000-000000000002','4a100000-0000-4000-8000-000000000003');
select public.transition_backup_v2_run(id,scope,'validating','completed','worker') from public.backup_v2_runs where id in ('4a100000-0000-4000-8000-000000000002','4a100000-0000-4000-8000-000000000003');
select is((select count(*)::integer from public.backup_v2_runs where id in ('4a100000-0000-4000-8000-000000000002','4a100000-0000-4000-8000-000000000003') and lifecycle_state='completed'),2,'component runs completed canonically');

select throws_ok($$insert into public.backup_v2_recovery_sets(request_id,policy_version,required_scopes) values(gen_random_uuid(),'typed-recovery-v2',array['database','unknown'])$$,'23514',null,'unknown required component rejected');
select throws_ok($$insert into public.backup_v2_recovery_sets(request_id,policy_version,recovery_key_requirement) values(gen_random_uuid(),'typed-recovery-v2','sometimes')$$,'23514',null,'unknown recovery-key requirement rejected');
insert into public.backup_v2_recovery_sets(id,request_id,policy_version) values('4a200000-0000-4000-8000-000000000001',gen_random_uuid(),'typed-recovery-v2');
select pass('typed recovery policy created');
insert into public.backup_v2_recovery_set_components(recovery_set_id,scope,run_id,artifact_status,completion_status,integrity_status,compatibility_status,backup_format_version,schema_compatibility_ref,exporter_version,compatibility_verified_at,primary_copy_status,primary_copy_ref,primary_copy_verified_at) values
 ('4a200000-0000-4000-8000-000000000001','database','4a100000-0000-4000-8000-000000000001','present','completed','verified','verified','format-v1','migration-head:dynamic','exporter-v1',now(),'verified','primary:database',now());
select throws_ok($$update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now() where id='4a200000-0000-4000-8000-000000000001'$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','database alone not full DR');
insert into public.backup_v2_recovery_set_components(recovery_set_id,scope,run_id,artifact_status,completion_status,integrity_status,compatibility_status,backup_format_version,schema_compatibility_ref,exporter_version,compatibility_verified_at,primary_copy_status,primary_copy_ref,primary_copy_verified_at) values
 ('4a200000-0000-4000-8000-000000000001','auth','4a100000-0000-4000-8000-000000000002','present','completed','verified','verified','format-v1','migration-head:dynamic','exporter-v1',now(),'verified','primary:auth',now()),
 ('4a200000-0000-4000-8000-000000000001','storage_objects','4a100000-0000-4000-8000-000000000003','present','completed','verified','verified','format-v1','migration-head:dynamic','exporter-v1',now(),'verified','primary:storage',now());
select pass('typed component evidence accepted');
select throws_ok($$update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now() where id='4a200000-0000-4000-8000-000000000001'$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','missing key attestation blocks readiness');
update public.backup_v2_recovery_sets set recovery_key_status='availability_attested',recovery_key_version='offline-v1',recovery_key_safe_ref='custody-attestation:synthetic',recovery_key_public_fingerprint='SHA256:synthetic-public-fingerprint',recovery_key_attested_at=now() where id='4a200000-0000-4000-8000-000000000001';
update public.backup_v2_recovery_set_components set offsite_copy_requirement='required' where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='auth';
select throws_ok($$update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now() where id='4a200000-0000-4000-8000-000000000001'$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','required independent copy blocks readiness until verified');
update public.backup_v2_recovery_set_components set offsite_copy_status='verified',offsite_copy_ref='offsite:auth',offsite_copy_verified_at=now() where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='auth';
update public.backup_v2_recovery_set_components set evidence_origin='synthetic_fixture' where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='storage_objects';
select throws_ok($$update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now() where id='4a200000-0000-4000-8000-000000000001'$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','synthetic evidence cannot establish runtime readiness');
update public.backup_v2_recovery_set_components set evidence_origin='runtime_verified' where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='storage_objects';
update public.backup_v2_recovery_sets set max_evidence_age_seconds=60 where id='4a200000-0000-4000-8000-000000000001';
update public.backup_v2_recovery_set_components set compatibility_verified_at=now()-interval '2 minutes' where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='database';
select throws_ok($$update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now() where id='4a200000-0000-4000-8000-000000000001'$$,'23514','BACKUP_V2_FULL_DR_INCOMPLETE','stale required evidence blocks readiness');
update public.backup_v2_recovery_set_components set compatibility_verified_at=now() where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='database';
update public.backup_v2_recovery_sets set lifecycle_state='full_dr_ready',ready_at=now() where id='4a200000-0000-4000-8000-000000000001';
select is((select lifecycle_state from public.backup_v2_recovery_sets where id='4a200000-0000-4000-8000-000000000001'),'full_dr_ready','all typed evidence reaches full DR');
select throws_ok($$update public.backup_v2_recovery_set_components set integrity_status='failed' where recovery_set_id='4a200000-0000-4000-8000-000000000001' and scope='auth'$$,'55000','BACKUP_V2_RECOVERY_COMPONENTS_IMMUTABLE','ready components immutable');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('backup_runs','backup_logs','operational_backup_checks')),3,'V1 tables remain');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name in ('backup_runs','backup_logs','operational_backup_checks') and column_name like 'backup_v2_%'),0,'V1 schemas unchanged');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name like 'backup_v2_%' and column_name ~* '(private.*key|secret|credential|password)'),0,'no private recovery material columns');
select is((select count(*)::integer from information_schema.role_table_grants where table_schema='public' and table_name like 'backup_v2_%' and grantee in ('PUBLIC','anon','authenticated') and privilege_type='TRUNCATE'),0,'TRUNCATE denied to generic roles');
select ok(to_regclass('public.backup_v2_runs_one_active_scope_idx') is not null and to_regclass('public.backup_v2_measurements_run_scope_idx') is not null,'required indexes exist');
select is((select count(*)::integer from pg_policies where schemaname='public' and tablename like 'backup_v2_%'),0,'no end-user RLS write policies');
select throws_ok($$insert into public.backup_v2_measurements(run_id,measurement_scope,source_kind,measured_at,runtime_seconds) values('4a100000-0000-4000-8000-000000000001','database','synthetic_local',now(),'NaN'::numeric)$$,'23514',null,'non-finite measurement rejected');

select * from finish();
rollback;
\echo 'Modern Backup V2 Phase 4A control-plane foundation: OK'
