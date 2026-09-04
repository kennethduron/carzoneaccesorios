\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(31);

insert into public.roles(name,description,permissions) values
('admin','Phase 4 test','["commissions:read_all","commissions:rules:manage","commissions:policies:manage","commercial:reports:read","commercial:reports:generate"]'),
('vendedor','Phase 4 test','["commissions:read_own"]')
on conflict(name) do update set permissions=excluded.permissions;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('d4100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-admin@example.test','',now(),'{}','{}',now(),now()),
('d4100000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-seller-a@example.test','',now(),'{}','{}',now(),now()),
('d4100000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-seller-b@example.test','',now(),'{}','{}',now(),now()),
('d4100000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-seller-c@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active) values
('d4100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'Phase 4 Admin','phase4-admin@example.test',true),
('d4100000-0000-4000-8000-000000000002',(select id from public.roles where name='vendedor'),'Seller A','phase4-seller-a@example.test',true),
('d4100000-0000-4000-8000-000000000003',(select id from public.roles where name='vendedor'),'Seller B','phase4-seller-b@example.test',true),
('d4100000-0000-4000-8000-000000000004',(select id from public.roles where name='vendedor'),'Seller C','phase4-seller-c@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,full_name=excluded.full_name,active=excluded.active;
select set_config('request.jwt.claim.sub','d4100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"d4100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select lives_ok($$select public.create_commission_policy_v1('d4200000-0000-4000-8000-000000000001','Vendedores estándar','PERCENTAGE',5,'Política estándar de prueba.')$$,'admin creates percentage policy');
select is((select rule_value from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001'),5.0000::numeric,'percentage value persists exactly');
select is((public.create_commission_policy_v1('d4200000-0000-4000-8000-000000000001','Vendedores estándar','PERCENTAGE',5,'Política estándar de prueba.')->>'idempotentReplay')::boolean,true,'policy retry is idempotent');
select lives_ok($$select public.create_commission_policy_v1('d4200000-0000-4000-8000-000000000002','Comisión fija','FIXED_AMOUNT',250,'Política fija de prueba.')$$,'fixed policy is supported');
select lives_ok($$select public.duplicate_commission_policy_v1('d4200000-0000-4000-8000-000000000003',(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),'Comisión fija duplicada')$$,'policy duplication creates a distinct template');
select is((select duplicated_from from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000003'),(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),'duplicate records provenance');
select lives_ok($$select public.deactivate_commission_policy_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000003'),'Plantilla duplicada retirada de la operación.')$$,'policy can be deactivated with reason');
select throws_ok($$update public.sales_commission_policies set rule_value=99 where request_key='d4200000-0000-4000-8000-000000000001'$$,'42501','COMMISSION_POLICY_IMMUTABLE','policy economics are immutable');

create temporary table phase4_state(key text primary key,value text);
insert into phase4_state values('first_preview',(public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],(now() at time zone 'America/Tegucigalpa')::date)->>'previewToken'));
select is((public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],(now() at time zone 'America/Tegucigalpa')::date)->>'willCreate')::integer,2,'multi-seller preview creates two rules');
select lives_ok($$select public.apply_commission_policy_assignment_v1('d4300000-0000-4000-8000-000000000001',(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],(now() at time zone 'America/Tegucigalpa')::date,'Asignación inicial auditada de vendedores.',(select value from phase4_state where key='first_preview'))$$,'atomic multi-seller assignment succeeds');
select is((select count(*)::integer from public.sales_commission_rules where assignment_operation_id is not null),2,'two individual immutable rules are created');
select is((select count(distinct seller_user_id)::integer from public.sales_commission_rules where policy_id=(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001')),2,'policy assignment covers two distinct sellers');
select is((public.apply_commission_policy_assignment_v1('d4300000-0000-4000-8000-000000000001',(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],(now() at time zone 'America/Tegucigalpa')::date,'Asignación inicial auditada de vendedores.',(select value from phase4_state where key='first_preview'))->>'idempotentReplay')::boolean,true,'double submit replays one operation');
select is((public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000001'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],(now() at time zone 'America/Tegucigalpa')::date)->>'noOp')::integer,2,'same-rule assignment previews as no-op');

insert into phase4_state values('stale_preview',(public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),array['d4100000-0000-4000-8000-000000000004'::uuid],((now() at time zone 'America/Tegucigalpa')::date+5))->>'previewToken'));
update public.users set active=false where id='d4100000-0000-4000-8000-000000000004';
select throws_ok($$select public.apply_commission_policy_assignment_v1('d4300000-0000-4000-8000-000000000002',(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),array['d4100000-0000-4000-8000-000000000004'::uuid],((now() at time zone 'America/Tegucigalpa')::date+5),'Asignación que debe detectar cambio de estado.',(select value from phase4_state where key='stale_preview'))$$,'PT409','COMMISSION_ASSIGNMENT_PREVIEW_STALE','seller inactive after preview invalidates token');
select is((select count(*)::integer from public.sales_commission_rules where seller_user_id='d4100000-0000-4000-8000-000000000004'),0,'stale preview creates no partial seller rule');

select lives_ok($$select public.create_sales_commission_rule_v1('d4400000-0000-4000-8000-000000000001','d4100000-0000-4000-8000-000000000002','PERCENTAGE',6,((now() at time zone 'America/Tegucigalpa')::date+3),'Regla futura individual para conflicto.')$$,'future individual rule is scheduled');
select is((public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],((now() at time zone 'America/Tegucigalpa')::date+5))->>'conflicts')::integer,1,'mixed set exposes scheduled-rule conflict');
insert into phase4_state values('conflict_preview',(public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],((now() at time zone 'America/Tegucigalpa')::date+5))->>'previewToken'));
select throws_ok($$select public.apply_commission_policy_assignment_v1('d4300000-0000-4000-8000-000000000003',(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),array['d4100000-0000-4000-8000-000000000002'::uuid,'d4100000-0000-4000-8000-000000000003'::uuid],((now() at time zone 'America/Tegucigalpa')::date+5),'Conjunto mixto debe fallar completamente.',(select value from phase4_state where key='conflict_preview'))$$,'PT409','COMMISSION_ASSIGNMENT_CONFLICT','mixed valid/conflict set fails closed');
select is((select count(*)::integer from public.sales_commission_assignment_operations where request_key='d4300000-0000-4000-8000-000000000003'),0,'failed mixed set persists no operation');
select is((select count(*)::integer from public.sales_commission_rules where seller_user_id='d4100000-0000-4000-8000-000000000003'),1,'failed mixed set creates no partial valid-seller rule');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select md5('phase4-bulk-'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-bulk-'||n||'@example.test','',now(),'{}','{}',now(),now()
from generate_series(1,50)n;
insert into public.users(id,role_id,full_name,email,active)
select md5('phase4-bulk-'||n)::uuid,(select id from public.roles where name='vendedor'),'Bulk Seller '||n,'phase4-bulk-'||n||'@example.test',true from generate_series(1,50)n
on conflict(id) do update set role_id=excluded.role_id,full_name=excluded.full_name,active=excluded.active;
insert into phase4_state values('bulk_preview',(public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),(select array_agg(md5('phase4-bulk-'||n)::uuid order by n) from generate_series(1,50)n),((now() at time zone 'America/Tegucigalpa')::date+10))->>'previewToken'));
select lives_ok($$select public.apply_commission_policy_assignment_v1('d4300000-0000-4000-8000-000000000004',(select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),(select array_agg(md5('phase4-bulk-'||n)::uuid order by n) from generate_series(1,50)n),((now() at time zone 'America/Tegucigalpa')::date+10),'Asignación límite de cincuenta vendedores.',(select value from phase4_state where key='bulk_preview'))$$,'50-seller boundary succeeds atomically');
select is((select created_count from public.sales_commission_assignment_operations where request_key='d4300000-0000-4000-8000-000000000004'),50,'50-seller operation records all created versions');
select throws_ok($$select public.preview_commission_policy_assignment_v1((select id from public.sales_commission_policies where request_key='d4200000-0000-4000-8000-000000000002'),(select array_agg(md5('phase4-over-'||n)::uuid) from generate_series(1,51)n),((now() at time zone 'America/Tegucigalpa')::date+10))$$,'22023','COMMISSION_ASSIGNMENT_INVALID','more than 50 sellers is rejected');

select is((public.create_commercial_report_generation_v1('d4500000-0000-4000-8000-000000000001','COMMERCIAL_SUMMARY','PDF','Resumen de prueba',jsonb_build_object('from','2026-09-01','to','2026-09-30'),jsonb_build_array('summary'),jsonb_build_array('total'),null)->>'status'),'PENDING','report metadata begins pending');
select lives_ok($$select public.complete_commercial_report_generation_v1((select id from public.commercial_report_generations where request_key='d4500000-0000-4000-8000-000000000001'),jsonb_build_object('kpis',jsonb_build_object('sold',100,'collected',75,'outstanding',25)),1,repeat('a',64))$$,'bounded report snapshot completes');
select is((select status from public.commercial_report_generations where request_key='d4500000-0000-4000-8000-000000000001'),'READY','report metadata becomes ready');
select throws_ok($$update public.commercial_report_generations set report_snapshot='{}' where request_key='d4500000-0000-4000-8000-000000000001'$$,'42501','PHASE4_AUDIT_IMMUTABLE','report snapshot cannot be rewritten directly');

select set_config('request.jwt.claim.sub','d4100000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"d4100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.get_commercial_dashboard_v1('{"from":"2026-09-01","to":"2026-09-30"}'::jsonb,20,0)$$,'42501','PHASE4_ACCESS_DENIED','seller cannot read global commercial reporting');
select throws_ok($$select public.list_commission_policies_v1(null,'all','all')$$,'42501','PHASE4_ACCESS_DENIED','seller cannot manage policy templates');
select throws_ok($$select public.get_commercial_report_snapshot_v1((select id from public.commercial_report_generations where request_key='d4500000-0000-4000-8000-000000000001'))$$,'42501','PHASE4_ACCESS_DENIED','seller cannot download elevated report snapshot');

select * from finish();
rollback;
