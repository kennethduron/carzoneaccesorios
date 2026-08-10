\set ON_ERROR_STOP on
begin;
select no_plan();

select ok(to_regprocedure('public._get_customer_commercial_credit_state_v2(uuid)') is not null, 'canonical credit state helper exists');
select ok(to_regprocedure('public.get_pos_credit_overdue_override_capability_v1()') is not null, 'override capability RPC exists');
select ok(to_regprocedure('public.set_pos_credit_overdue_override_v1(boolean,text)') is not null, 'kill switch RPC exists');
select ok(to_regprocedure('public.enforce_pos_credit_before_receivable_v1()') is not null, 'authoritative receivable guard exists');
select ok((select prosecdef from pg_proc where oid='public.enforce_pos_credit_before_receivable_v1()'::regprocedure), 'receivable guard is SECURITY DEFINER');
select ok((select array_to_string(proconfig, ',') like '%search_path=public, extensions, pg_temp%'
  from pg_proc where oid='public.enforce_pos_credit_before_receivable_v1()'::regprocedure), 'receivable guard fixes search_path');
select ok(pg_get_functiondef('public._get_customer_commercial_credit_state_v2(uuid)'::regprocedure)
  like '%America/Tegucigalpa%', 'helper uses explicit Honduras timezone');
select ok(pg_get_functiondef('public._get_customer_commercial_credit_state_v2(uuid)'::regprocedure)
  like '%due_date <%', 'helper derives overdue from due_date');
select ok(pg_get_functiondef('public.enforce_pos_credit_before_receivable_v1()'::regprocedure)
  like '%POS_CREDIT_OVERDUE%', 'legacy confirmation path is guarded server-side');
select ok(pg_get_functiondef('public.enforce_pos_credit_before_receivable_v1()'::regprocedure)
  like '%open_balance + new.original_amount%', 'override never bypasses credit limit');
select ok((select relrowsecurity from pg_class where oid='public.pos_feature_flags'::regclass), 'POS flags use RLS');
select ok((select relrowsecurity from pg_class where oid='public.pos_credit_overdue_override_context'::regclass), 'override context uses RLS');
select ok(not has_table_privilege('authenticated','public.pos_feature_flags','insert'), 'authenticated cannot insert flags');
select ok(not has_table_privilege('authenticated','public.pos_credit_overdue_override_context','insert'), 'authenticated cannot forge override context');
select ok(not has_function_privilege('authenticated','public._prepare_pos_credit_overdue_override_v1(uuid,uuid,uuid,jsonb)','execute'), 'prepare helper is internal');
select is((select enabled from public.pos_feature_flags where key='pos_credit_overdue_override_v1'), false, 'override installs OFF');

insert into public.roles(name,description,permissions) values
('admin','POS credit override fixture',jsonb_build_array('pos:access','pos:confirm_sale','customers:read_commercial','customers:read_credit'))
on conflict(name) do update set permissions=excluded.permissions;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('b9100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pos-credit-override@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active)
values('b9100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'POS Credit Override','pos-credit-override@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,active=true;
select set_config('request.jwt.claim.sub','b9100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','b9100000-0000-4000-8000-000000000001','role','authenticated')::text,true);

insert into public.customers(id,contact_name,email,phone,address,city,active,status,is_wholesale,wholesale_status,wholesale_customer_type,wholesale_first_purchase_completed,commercial_version)
values('b9200000-0000-4000-8000-000000000001','POS Credit Fixture','pos-credit-customer@example.test','99992001','Tegucigalpa','Tegucigalpa',true,'active',false,'none','new',false,0);
insert into public.customer_credit_accounts(customer_id,is_credit_enabled,credit_limit,terms_days,status,activated_at,activated_by)
values('b9200000-0000-4000-8000-000000000001',true,10000,30,'active',now(),'b9100000-0000-4000-8000-000000000001');

insert into public.orders(id,order_number,customer_id,customer_name,phone,delivery_address,payment_method,subtotal,tax,total)
values
('b9300000-0000-4000-8000-000000000001','POS-OVR-T1','b9200000-0000-4000-8000-000000000001','Fixture','99992001','Tegucigalpa','commercial_credit',1600,0,1600),
('b9300000-0000-4000-8000-000000000002','POS-OVR-T2','b9200000-0000-4000-8000-000000000001','Fixture','99992001','Tegucigalpa','commercial_credit',100,0,100),
('b9300000-0000-4000-8000-000000000003','POS-OVR-T3','b9200000-0000-4000-8000-000000000001','Fixture','99992001','Tegucigalpa','commercial_credit',200,0,200),
('b9300000-0000-4000-8000-000000000004','POS-OVR-T4','b9200000-0000-4000-8000-000000000001','Fixture','99992001','Tegucigalpa','commercial_credit',50,0,50),
('b9300000-0000-4000-8000-000000000005','POS-OVR-T5','b9200000-0000-4000-8000-000000000001','Fixture','99992001','Tegucigalpa','commercial_credit',75,0,75);
insert into public.accounts_receivable(customer_id,order_id,original_amount,balance_due,due_date,status,paid_at,payment_received_method)
values
('b9200000-0000-4000-8000-000000000001','b9300000-0000-4000-8000-000000000001',1600,1600,(now() at time zone 'America/Tegucigalpa')::date-1,'open',null,null),
('b9200000-0000-4000-8000-000000000001','b9300000-0000-4000-8000-000000000002',100,100,(now() at time zone 'America/Tegucigalpa')::date,'open',null,null),
('b9200000-0000-4000-8000-000000000001','b9300000-0000-4000-8000-000000000003',300,200,(now() at time zone 'America/Tegucigalpa')::date+1,'partial',null,null),
('b9200000-0000-4000-8000-000000000001','b9300000-0000-4000-8000-000000000004',50,0,(now() at time zone 'America/Tegucigalpa')::date-10,'paid',now(),'cash'),
('b9200000-0000-4000-8000-000000000001','b9300000-0000-4000-8000-000000000005',75,0,(now() at time zone 'America/Tegucigalpa')::date-10,'cancelled',null,null);

select is((select open_balance from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),1900::numeric,'open balance includes active open and partial only');
select is((select effective_overdue_balance from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),1600::numeric,'yesterday open is effectively overdue');
select is((select effective_overdue_count from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),1::bigint,'today and future are not overdue');
select is((select available_credit from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),8100::numeric,'available is limit minus all open exposure');
select is((select block_reason from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),'OVERDUE_BALANCE','effective overdue controls block reason');
select is((select credit_status from public.get_pos_customer_context_v1('b9200000-0000-4000-8000-000000000001')),'on_hold','POS context reuses canonical helper');
select is((select overdue_balance from public.get_pos_customer_context_v1('b9200000-0000-4000-8000-000000000001')),1600::numeric,'POS context exposes effective overdue');
select is((select can_use_credit from public.get_pos_customer_context_v1('b9200000-0000-4000-8000-000000000001')),false,'POS context blocks effective overdue');

update public.customer_credit_accounts set credit_limit=20000 where customer_id='b9200000-0000-4000-8000-000000000001';
select is((select has_effective_overdue from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),true,'raising limit does not remove hold');
update public.customer_credit_accounts set terms_days=60 where customer_id='b9200000-0000-4000-8000-000000000001';
select is((select due_date from public.accounts_receivable where order_id='b9300000-0000-4000-8000-000000000001'),(now() at time zone 'America/Tegucigalpa')::date-1,'changing terms preserves historical due date');
update public.accounts_receivable set balance_due=1000,status='partial' where order_id='b9300000-0000-4000-8000-000000000001';
select is((select effective_overdue_balance from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),1000::numeric,'partial payment keeps remaining overdue');
update public.accounts_receivable set balance_due=0,status='paid',paid_at=now(),payment_received_method='cash' where order_id='b9300000-0000-4000-8000-000000000001';
select is((select effective_overdue_balance from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),0::numeric,'full overdue payment clears hold');
select is((select has_effective_overdue from public._get_customer_commercial_credit_state_v2('b9200000-0000-4000-8000-000000000001')),false,'no other overdue means hold disappears');

select is((select feature_enabled from public.get_pos_credit_overdue_override_capability_v1()),false,'capability reports flag OFF');
select is((select override_allowed from public.get_pos_credit_overdue_override_capability_v1()),true,'admin is override eligible');
select is((select enabled from public.set_pos_credit_overdue_override_v1(true,'Enable local pgTAP override test')),true,'authorized role enables kill switch');
select is((select feature_enabled from public.get_pos_credit_overdue_override_capability_v1()),true,'capability reports flag ON');
select is((select enabled from public.set_pos_credit_overdue_override_v1(false,'Disable local pgTAP override test')),false,'kill switch turns OFF');
select is((select enabled from public.set_pos_credit_overdue_override_v1(true,'Restore local pgTAP override test')),true,'kill switch returns ON');

select * from finish();
rollback;
\echo 'POS credit overdue override V1: OK'
