\set ON_ERROR_STOP on
begin;
select plan(17);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('81000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-other@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wholesale-linked@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

update public.users set role_id = (select id from public.roles where name = 'technical_owner'), active = true
where id = '81000000-0000-4000-8000-000000000001';
update public.users set role_id = (select id from public.roles where name = 'cliente'), active = true
where id in ('81000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004');

insert into public.customers (
  id, contact_name, phone, wholesale_status, wholesale_requested_at,
  wholesale_request_source, wholesale_customer_type, is_wholesale, status, active
) values
  ('82000000-0000-4000-8000-000000000001', 'Solicitud sin portal', '99990001', 'pending', '2026-07-28 12:00:00+00', 'cuenta_registrada', 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000002', 'Grant directo', '99990002', 'none', null, null, 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000003', 'Cliente suspendido', '99990003', 'suspended', null, null, 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000004', 'Cliente inactivo', '99990004', 'none', null, null, 'new', false, 'inactive', false),
  ('82000000-0000-4000-8000-000000000005', 'Solicitud grant admin', '99990005', 'pending', '2026-07-28 13:00:00+00', 'cuenta_registrada', 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000006', 'Grant con portal', '99990006', 'none', null, null, 'new', false, 'active', true),
  ('82000000-0000-4000-8000-000000000007', 'Cliente rechazado', '99990007', 'rejected', '2026-07-27 10:00:00+00', 'cuenta_registrada', 'new', false, 'active', true);

update public.customers set user_id = '81000000-0000-4000-8000-000000000004'
where id = '82000000-0000-4000-8000-000000000006';

insert into public.crm_followups (customer_id, title, interaction_type, status)
values ('82000000-0000-4000-8000-000000000001', 'Solicitud de cuenta mayorista', 'solicitud_mayorista', 'pending');
insert into public.crm_followups (customer_id, title, interaction_type, status)
values ('82000000-0000-4000-8000-000000000005', 'Solicitud de cuenta mayorista', 'solicitud_mayorista', 'pending');

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

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000008','82000000-0000-4000-8000-000000000007','invalid','admin_direct_grant',0,'rejected',null,'motivo valido')$$,
  '22023', 'WHOLESALE_INVALID_TYPE',
  'invalid wholesale type is rejected before writes'
);

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000009','82000000-0000-4000-8000-000000000007','new','invalid_source',0,'rejected',null,'motivo valido')$$,
  '22023', 'WHOLESALE_INVALID_SOURCE',
  'invalid source is rejected before writes'
);

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000010','82000000-0000-4000-8000-000000000007','new','admin_direct_grant',0,'rejected',null,'')$$,
  '22023', 'WHOLESALE_INVALID_REASON',
  'direct grant requires an administrative reason'
);

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000011','82000000-0000-4000-8000-000000000005','new','customer_request',0,'pending','2026-07-28 13:01:00+00',null)$$,
  'PT409', 'WHOLESALE_REQUEST_CHANGED',
  'request approval rejects a changed request timestamp'
);

select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000012','82000000-0000-4000-8000-000000000005','new','customer_request',9,'pending','2026-07-28 13:00:00+00',null)$$,
  'PT409', 'WHOLESALE_VERSION_CONFLICT:0',
  'stale commercial version is rejected with the current version'
);

select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(
  $$select public.grant_customer_wholesale_access_v1('83000000-0000-4000-8000-000000000013','82000000-0000-4000-8000-000000000007','new','admin_direct_grant',0,'rejected',null,'motivo valido')$$,
  '42501', 'WHOLESALE_FORBIDDEN',
  'customer role cannot grant wholesale access'
);
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare result jsonb;
begin
  result := public.grant_customer_wholesale_access_v1(
    '83000000-0000-4000-8000-000000000014', '82000000-0000-4000-8000-000000000005',
    'new', 'admin_direct_grant', 0, 'pending', null, 'Solicitud resuelta administrativamente'
  );
  if not (result->>'ok')::boolean
     or (select status from public.crm_followups where customer_id = '82000000-0000-4000-8000-000000000005') <> 'completed'
     or (select not had_pending_request or requested_at <> '2026-07-28 13:00:00+00' or source <> 'admin_direct_grant' from public.wholesale_access_history where customer_id = '82000000-0000-4000-8000-000000000005')
     or (select wholesale_requested_at <> '2026-07-28 13:00:00+00' or wholesale_request_source <> 'cuenta_registrada' from public.customers where id = '82000000-0000-4000-8000-000000000005')
  then raise exception 'direct grant did not resolve and preserve pending request evidence'; end if;
end;
$$;
select pass('direct grant resolves a pending request atomically without inventing evidence');

do $$
declare result jsonb;
begin
  result := public.grant_customer_wholesale_access_v1(
    '83000000-0000-4000-8000-000000000015', '82000000-0000-4000-8000-000000000006',
    'existing', 'admin_direct_grant', 1, 'none', null, 'Cliente mayorista existente verificado'
  );
  if not (result->>'portalLinked')::boolean
     or (result->>'firstPurchaseRequired')::boolean
     or (select message not like '%Ya puedes consultar%' from public.customer_portal_notifications where customer_id = '82000000-0000-4000-8000-000000000006')
  then raise exception 'linked existing notification or first-purchase exemption failed'; end if;
end;
$$;
select pass('linked existing grant is exempt from first purchase and receives accurate notification');

update public.customers set user_id = '81000000-0000-4000-8000-000000000002'
where id = '82000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*)::integer from public.customer_portal_notifications), 0, 'another portal account cannot read customer notifications');
select set_config('request.jwt.claims', '{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*)::integer from public.customer_portal_notifications), 1, 'linked owner sees only its persistent notification');

do $$
declare notification_id uuid; first_claim jsonb; replay_claim jsonb; first_read jsonb; replay_read jsonb;
begin
  select id into notification_id from public.customer_portal_notifications
  where customer_id = '82000000-0000-4000-8000-000000000001';
  first_claim := public.mark_customer_portal_notification_toast_shown_v1(notification_id);
  replay_claim := public.mark_customer_portal_notification_toast_shown_v1(notification_id);
  if not (first_claim->>'ok')::boolean
     or replay_claim->>'code' <> 'NOTIFICATION_NOT_FOUND'
     or (select status <> 'unread' or toast_pending or toast_shown_at is null from public.customer_portal_notifications where id = notification_id)
  then raise exception 'toast once-only claim did not preserve unread notification'; end if;
  first_read := public.mark_customer_portal_notification_read_v1(notification_id);
  replay_read := public.mark_customer_portal_notification_read_v1(notification_id);
  if not (first_read->>'ok')::boolean
     or replay_read->>'code' <> 'ALREADY_READ'
     or (select status <> 'read' or read_at is null from public.customer_portal_notifications where id = notification_id)
  then raise exception 'persistent notification read contract failed'; end if;
end;
$$;
select pass('toast is claimed once while notification persists until explicitly read');
reset role;

select * from finish();
rollback;
\echo 'Wholesale approval, direct grant, idempotency and portal isolation: OK'
