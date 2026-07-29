\set ON_ERROR_STOP on
begin;
select plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('81000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-other@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

update public.users set role_id = (select id from public.roles where name = 'technical_owner'), active = true
where id = '81000000-0000-4000-8000-000000000001';
update public.users set role_id = (select id from public.roles where name = 'cliente'), active = true
where id in ('81000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000003');

insert into public.customers (
  id, contact_name, phone, wholesale_status, wholesale_requested_at,
  wholesale_request_source, wholesale_customer_type, is_wholesale, status, active
) values
  ('82000000-0000-4000-8000-000000000001', 'Solicitud sin portal', '99990001', 'pending', '2026-07-28 12:00:00+00', 'cuenta_registrada', 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000002', 'Grant directo', '99990002', 'none', null, null, 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000003', 'Cliente suspendido', '99990003', 'suspended', null, null, 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000004', 'Cliente inactivo', '99990004', 'none', null, null, 'new', false, 'inactive', false);

insert into public.crm_followups (customer_id, title, interaction_type, status)
values ('82000000-0000-4000-8000-000000000001', 'Solicitud de cuenta mayorista', 'solicitud_mayorista', 'pending');

select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select ok(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_active_wholesale_requires_user_id'
  )
  and has_function_privilege('authenticated', 'public.grant_customer_wholesale_access_v1(uuid,uuid,text,text,integer,text,timestamptz,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.grant_customer_wholesale_access_v1(uuid,uuid,text,text,integer,text,timestamptz,text)', 'EXECUTE'),
  'approval is separated from portal linking and RPC grants are least privilege'
);

do $$
declare first_result jsonb; replay jsonb;
begin
  first_result := public.grant_customer_wholesale_access_v1(
    '83000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    'new', 'customer_request', 0, 'pending', '2026-07-28 12:00:00+00', null
  );
  replay := public.grant_customer_wholesale_access_v1(
    '83000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    'new', 'customer_request', 0, 'pending', '2026-07-28 12:00:00+00', null
  );
  if not (first_result->>'ok')::boolean
     or (first_result->>'commercialVersion')::integer <> 1
     or not (replay->>'idempotentReplay')::boolean
     or (select count(*) from public.wholesale_access_history where customer_id = '82000000-0000-4000-8000-000000000001') <> 1
     or (select count(*) from public.customer_portal_notifications where customer_id = '82000000-0000-4000-8000-000000000001') <> 1
     or (select count(*) from public.wholesale_idempotency_requests where request_key = '83000000-0000-4000-8000-000000000001') <> 1
     or (select status from public.crm_followups where customer_id = '82000000-0000-4000-8000-000000000001') <> 'completed'
     or (select user_id is not null or not is_wholesale or wholesale_status <> 'approved' or wholesale_first_purchase_completed or commercial_version <> 1 from public.customers where id = '82000000-0000-4000-8000-000000000001')
  then raise exception 'pending approval or idempotent replay contract failed: %, %', first_result, replay; end if;
end;
$$;
select pass('pending customer without user_id is approved once as new and follow-up is completed');

do $$
declare direct_result jsonb;
begin
  direct_result := public.grant_customer_wholesale_access_v1(
    '83000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000002',
    'existing', 'admin_direct_grant', 0, 'none', null, 'Cliente mayorista verificado por gerencia'
  );
  if (direct_result->>'wholesaleCustomerType') <> 'existing'
    or (select wholesale_requested_at is not null or wholesale_request_source is not null or user_id is not null from public.customers where id = '82000000-0000-4000-8000-000000000002')
    or (select operation <> 'direct_grant' or source <> 'admin_direct_grant' or reason is null from public.wholesale_access_history where customer_id = '82000000-0000-4000-8000-000000000002')
  then raise exception 'direct grant invented a request or portal link'; end if;
end;
$$;
select pass('direct existing grant preserves absent request and portal link');

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000003','new','admin_direct_grant',0,'none',null,'motivo valido')$$,
  '22023', 'WHOLESALE_CUSTOMER_SUSPENDED',
  'suspended customer cannot be reactivated through grant'
);

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000004','82000000-0000-4000-8000-000000000004','new','admin_direct_grant',0,'none',null,'motivo valido')$$,
  '22023', 'WHOLESALE_CUSTOMER_INACTIVE',
  'inactive customer cannot receive direct grant'
);

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000002','new','admin_direct_grant',0,'none',null,'payload diferente')$$,
  'PT409', 'WHOLESALE_IDEMPOTENCY_CONFLICT',
  'same key with different payload conflicts without duplicate writes'
);

update public.customers set user_id = '81000000-0000-4000-8000-000000000002'
where id = '82000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*)::integer from public.customer_portal_notifications), 0, 'another portal account cannot read customer notifications');
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*)::integer from public.customer_portal_notifications), 1, 'linked owner sees its persistent notification');
reset role;

select * from finish();
rollback;
\echo 'Wholesale approval, direct grant, idempotency and portal isolation: OK'
