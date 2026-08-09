\set ON_ERROR_STOP on
begin;
select plan(44);

insert into public.roles (name, description, permissions)
values
  ('admin','Set-once test admin','["customers:manage","customers:update_identity"]'::jsonb),
  ('cliente','Set-once test customer','["store:buy"]'::jsonb),
  ('vendedor','Set-once test seller','["customers:manage","crm:manage"]'::jsonb),
  ('contadora','Set-once test accountant','[]'::jsonb),
  ('bodega','Set-once test warehouse','[]'::jsonb)
on conflict (name) do update
set permissions = public.roles.permissions || excluded.permissions;

select ok(to_regprocedure('public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)') is not null, 'set-once RPC exists');
select ok((select prosecdef from pg_proc where oid='public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)'::regprocedure), 'set-once RPC is SECURITY DEFINER');
select ok((select array_to_string(proconfig, ',') like '%search_path=public, pg_temp%' from pg_proc where oid='public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)'::regprocedure), 'set-once RPC fixes search_path');
select ok(not has_function_privilege('anon','public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)','execute'), 'anonymous cannot execute set-once RPC');
select ok(has_function_privilege('authenticated','public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)','execute'), 'authenticated can execute guarded set-once RPC');
select ok(not has_table_privilege('authenticated','public.customers','update'), 'authenticated has no generic customer UPDATE');
select ok(not has_column_privilege('authenticated','public.customers','tax_id','update'), 'authenticated cannot directly update tax_id');
select ok(not has_column_privilege('authenticated','public.customers','city','update'), 'authenticated cannot directly update city');
select ok(not has_column_privilege('authenticated','public.customers','business_name','update'), 'authenticated cannot directly update business_name');
select ok(not has_column_privilege('authenticated','public.customers','company_name','update'), 'authenticated cannot directly update company_name');
select ok(has_column_privilege('authenticated','public.customers','contact_name','update'), 'required non-commercial CRM column update remains scoped');
select is((select count(*)::integer from pg_policies where schemaname='public' and tablename='customers' and policyname='Users can update own customer record'),0,'broad own-customer UPDATE policy is removed');
select is((select count(*)::integer from public.roles where name in ('technical_owner','business_owner','admin') and permissions ? 'customers:update_identity'),3,'exact administrative identity roles remain authorized');
select is((select count(*)::integer from public.roles where name in ('contadora','vendedor','bodega','soporte','cliente') and permissions ? 'customers:update_identity'),0,'denied roles do not receive identity permission');
select ok(pg_get_functiondef('public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)'::regprocedure) like '%pg_advisory_xact_lock%', 'set-once RPC takes an advisory lock');
select ok(pg_get_functiondef('public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)'::regprocedure) like '%for update%', 'set-once RPC takes a row lock');
select ok(pg_get_functiondef('public.set_my_customer_profile_fields_once_v1(uuid,text,text,text)'::regprocedure) like '%customer.profile.field_set_once%', 'set-once RPC writes privacy-safe audit event');
select is(public.normalize_customer_tax_id_hn_v1('0801-1999-123456'),'08011999123456','shared RTN normalizer accepts separators');
select is(public.normalize_customer_tax_id_hn_v1('0801199912345'),null,'shared RTN normalizer rejects non-14-digit input');

insert into auth.users (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('cb100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set-once-client@example.test','',now(),'{}','{}',now(),now()),
 ('cb100000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set-once-unverified@example.test','',null, '{}','{}',now(),now()),
 ('cb100000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set-once-inactive@example.test','',now(),'{}','{}',now(),now()),
 ('cb100000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set-once-seller@example.test','',now(),'{}','{}',now(),now()),
 ('cb100000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set-once-admin@example.test','',now(),'{}','{}',now(),now()),
 ('cb100000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','set-once-accountant@example.test','',now(),'{}','{}',now(),now());

insert into public.users (id,role_id,full_name,email,active)
values
 ('cb100000-0000-4000-8000-000000000001',(select id from roles where name='cliente'),'Set Once Client','set-once-client@example.test',true),
 ('cb100000-0000-4000-8000-000000000002',(select id from roles where name='cliente'),'Set Once Unverified','set-once-unverified@example.test',true),
 ('cb100000-0000-4000-8000-000000000003',(select id from roles where name='cliente'),'Set Once Inactive','set-once-inactive@example.test',true),
 ('cb100000-0000-4000-8000-000000000004',(select id from roles where name='vendedor'),'Set Once Seller','set-once-seller@example.test',true),
 ('cb100000-0000-4000-8000-000000000005',(select id from roles where name='admin'),'Set Once Admin','set-once-admin@example.test',true),
 ('cb100000-0000-4000-8000-000000000006',(select id from roles where name='contadora'),'Set Once Accountant','set-once-accountant@example.test',true)
on conflict (id) do nothing;

insert into public.customers (id,user_id,contact_name,email,status,active,source)
values
 ('cb200000-0000-4000-8000-000000000001','cb100000-0000-4000-8000-000000000001','Set Once Client','set-once-client@example.test','active',true,'portal_registration'),
 ('cb200000-0000-4000-8000-000000000002','cb100000-0000-4000-8000-000000000002','Set Once Unverified','set-once-unverified@example.test','active',true,'portal_registration'),
 ('cb200000-0000-4000-8000-000000000003','cb100000-0000-4000-8000-000000000003','Set Once Inactive','set-once-inactive@example.test','disabled',false,'portal_registration'),
 ('cb200000-0000-4000-8000-000000000004',null,'Atomic Conflict','atomic-conflict@example.test','active',true,'internal')
on conflict (id) do nothing;

select set_config('request.jwt.claim.sub','cb100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"cb100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000001',null,' San Pedro Sula ',null)->>'code'),'FIELDS_SET','verified client sets empty city');
reset role;
select is((select city from public.customers where id='cb200000-0000-4000-8000-000000000001'),'San Pedro Sula','city is trimmed and persisted');
select is((select count(*)::integer from public.audit_logs where record_id='cb200000-0000-4000-8000-000000000001' and action='customer.profile.field_set_once'),1,'first write creates one audit event');
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000001',null,'San Pedro Sula',null)->>'code'),'IDEMPOTENT_REPLAY','same-value retry is idempotent');
reset role;
select is((select count(*)::integer from public.audit_logs where record_id='cb200000-0000-4000-8000-000000000001' and action='customer.profile.field_set_once'),1,'idempotent retry does not duplicate audit');
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000002',null,'Tegucigalpa',null)->>'code'),'FIELD_ALREADY_SET','different second value is rejected');
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000003',null,null,' Taller Águila ')->>'code'),'FIELDS_SET','business name can be set independently');
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000004','0801-1999-123456',null,null)->>'code'),'FIELDS_SET','valid RTN is accepted');
reset role;
select is((select tax_id from public.customers where id='cb200000-0000-4000-8000-000000000001'),'08011999123456','RTN is stored canonically');
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000005',null,'   ',null)->>'code'),'FIELD_REQUIRED','whitespace remains unset');
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000006','0801199912345',null,null)->>'code'),'RTN_INVALID','invalid RTN produces controlled validation');
select throws_ok($$update public.customers set tax_id='08011999111111' where id='cb200000-0000-4000-8000-000000000001'$$,'42501',null,'direct authenticated tax update is denied');
select throws_ok($$update public.customers set city='La Ceiba' where id='cb200000-0000-4000-8000-000000000001'$$,'42501',null,'direct authenticated city update is denied');
reset role;

grant update (tax_id) on public.customers to authenticated;
update public.users set role_id=(select id from public.roles where name='vendedor')
where id='cb100000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$update public.customers set tax_id='08011999111111' where id='cb200000-0000-4000-8000-000000000001'$$,'42501','CUSTOMER_COMMERCIAL_IDENTITY_RPC_ONLY','defense trigger blocks a future accidental column grant');
select throws_ok($$update public.customers set tax_id='08011999111111' where id='cb200000-0000-4000-8000-000000000004'$$,'42501','CUSTOMER_COMMERCIAL_IDENTITY_RPC_ONLY','defense trigger also protects unlinked customer rows from browser roles');
reset role;
revoke update (tax_id) on public.customers from authenticated;
update public.users set role_id=(select id from public.roles where name='cliente')
where id='cb100000-0000-4000-8000-000000000001';

update auth.users set email_confirmed_at=null
where id='cb100000-0000-4000-8000-000000000001';
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000007',null,'Comayagua',null)->>'code'),'ACCOUNT_NOT_VERIFIED','unverified client is denied');
reset role;
update auth.users set email_confirmed_at=now()
where id='cb100000-0000-4000-8000-000000000001';
update public.customers set active=false, status='disabled'
where id='cb200000-0000-4000-8000-000000000001';
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000008',null,'Comayagua',null)->>'code'),'CUSTOMER_INACTIVE','inactive customer is denied');
reset role;
update public.customers set active=true, status='active'
where id='cb200000-0000-4000-8000-000000000001';
update public.users set role_id=(select id from public.roles where name='vendedor')
where id='cb100000-0000-4000-8000-000000000001';
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000009',null,'Comayagua',null)->>'code'),'CUSTOMER_ROLE_REQUIRED','seller cannot use customer set-once RPC');
reset role;
update public.users set role_id=(select id from public.roles where name='admin')
where id='cb100000-0000-4000-8000-000000000001';
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000010',null,'Comayagua',null)->>'code'),'CUSTOMER_ROLE_REQUIRED','admin cannot misuse customer set-once RPC');
reset role;
update public.users set role_id=(select id from public.roles where name='cliente')
where id='cb100000-0000-4000-8000-000000000001';

update public.customers set city='Tegucigalpa' where id='cb200000-0000-4000-8000-000000000004';
update public.customers set user_id=null where id='cb200000-0000-4000-8000-000000000001';
update public.customers set user_id='cb100000-0000-4000-8000-000000000001' where id='cb200000-0000-4000-8000-000000000004';
select set_config('request.jwt.claim.sub','cb100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"cb100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select is((public.set_my_customer_profile_fields_once_v1('cb300000-0000-4000-8000-000000000011',null,'La Ceiba','Negocio Nuevo')->>'code'),'FIELD_ALREADY_SET','multi-field conflict rejects the request atomically');
reset role;
select is((select business_name from public.customers where id='cb200000-0000-4000-8000-000000000004'),null,'multi-field conflict applies no partial business write');

alter table public.customers disable trigger customers_01_canonical_tax_id_write_v1;
update public.customers set tax_id='RTN-HISTORICO'
where id='cb200000-0000-4000-8000-000000000004';
alter table public.customers enable trigger customers_01_canonical_tax_id_write_v1;
update public.users set role_id=(select id from public.roles where name='admin')
where id='cb100000-0000-4000-8000-000000000001';
set local role authenticated;
select is((select status from public.update_customer_identity_manual('cb200000-0000-4000-8000-000000000004','Corrección Admin','Atomic Conflict','atomic-conflict@example.test',null,'RTN-HISTORICO','Tegucigalpa',(select updated_at from public.customers where id='cb200000-0000-4000-8000-000000000004'),null,null)),'updated','authorized admin correction preserves an unchanged historical RTN');
reset role;
update public.users set role_id=(select id from public.roles where name='contadora')
where id='cb100000-0000-4000-8000-000000000001';
set local role authenticated;
select is((select status from public.update_customer_identity_manual('cb200000-0000-4000-8000-000000000004','Intento Contadora','Atomic Conflict','atomic-conflict@example.test',null,'RTN-HISTORICO','Tegucigalpa',(select updated_at from public.customers where id='cb200000-0000-4000-8000-000000000004'),null,null)),'permission_denied','accountant identity correction remains denied');
reset role;

select ok(pg_get_functiondef('public.finalize_portal_registration_commercial_fields_v1(uuid,uuid)'::regprocedure) like '%source = ''portal_registration''%','registration finalizer is scoped to portal-created customers');
select ok(not exists(select 1 from pg_constraint where conrelid='public.customers'::regclass and pg_get_constraintdef(oid) ilike '%unique%tax_id%'),'RTN remains non-unique');

select * from finish();
rollback;
\echo 'Customer profile set-once certification: OK'
