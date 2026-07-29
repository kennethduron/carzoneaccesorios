\set ON_ERROR_STOP on
begin;
select plan(17);

insert into public.roles (name, description, permissions)
values
  ('technical_owner', 'Portal test technical owner', '["customers:link_portal_account"]'::jsonb),
  ('cliente', 'Portal test customer', '["store:buy"]'::jsonb),
  ('contadora', 'Portal test accountant', '[]'::jsonb)
on conflict (name) do update
set permissions = public.roles.permissions || excluded.permissions;

insert into public.company_settings (
  id, company_name, free_shipping_threshold, standard_shipping_fee,
  cash_on_delivery_percentage, enable_cash_on_delivery_fee, first_wholesale_minimum
) values (
  '9a000000-0000-4000-8000-000000000001', 'Car Zone Portal Test',
  3000, 120, 5, true, 10000
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('9a100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'portal-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('9a100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'portal-wholesale@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('9a100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'portal-retail@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('9a100000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated', 'portal-other@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('9a100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'portal-accountant@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, role_id, full_name, email, active)
values
  ('9a100000-0000-4000-8000-000000000001', (select id from public.roles where name = 'technical_owner'), 'Portal admin', 'portal-admin@example.test', true),
  ('9a100000-0000-4000-8000-000000000002', (select id from public.roles where name = 'cliente'), 'Portal wholesale', 'portal-wholesale@example.test', true),
  ('9a100000-0000-4000-8000-000000000003', (select id from public.roles where name = 'cliente'), 'Portal retail', 'portal-retail@example.test', true),
  ('9a100000-0000-4000-8000-000000000004', (select id from public.roles where name = 'cliente'), 'Portal other', 'portal-other@example.test', true),
  ('9a100000-0000-4000-8000-000000000005', (select id from public.roles where name = 'contadora'), 'Portal accountant', 'portal-accountant@example.test', true)
on conflict (id) do update
set role_id = excluded.role_id,
    full_name = excluded.full_name,
    email = excluded.email,
    active = excluded.active;
update public.users set role_id = (select id from public.roles where name = 'technical_owner'), active = true
where id = '9a100000-0000-4000-8000-000000000001';
update public.users set role_id = (select id from public.roles where name = 'cliente'), active = true
where id in (
  '9a100000-0000-4000-8000-000000000002',
  '9a100000-0000-4000-8000-000000000003',
  '9a100000-0000-4000-8000-000000000004'
);
update public.users set role_id = (select id from public.roles where name = 'contadora'), active = true
where id = '9a100000-0000-4000-8000-000000000005';

insert into public.customers (
  id, contact_name, email, phone, is_wholesale, wholesale_status,
  wholesale_customer_type, wholesale_first_purchase_completed, wholesale_approved_at, status, active
) values
  ('9a200000-0000-4000-8000-000000000001', 'Mayorista sin vínculo', 'portal-wholesale@example.test', '99991001', true, 'approved', 'existing', true, now(), 'active', true),
  ('9a200000-0000-4000-8000-000000000002', 'Minorista con crédito', 'portal-retail@example.test', '99991002', false, 'none', 'new', false, null, 'active', true),
  ('9a200000-0000-4000-8000-000000000003', 'Otro cliente', 'portal-other@example.test', '99991003', false, 'none', 'new', false, null, 'active', true);

update public.customers
set user_id = '9a100000-0000-4000-8000-000000000003'
where id = '9a200000-0000-4000-8000-000000000002';

insert into public.customer_credit_accounts (
  customer_id, is_credit_enabled, credit_limit, terms_days, status, activated_at, activated_by
) values
  ('9a200000-0000-4000-8000-000000000001', true, 20000, 30, 'active', now(), '9a100000-0000-4000-8000-000000000001'),
  ('9a200000-0000-4000-8000-000000000002', true, 5000, 15, 'active', now(), '9a100000-0000-4000-8000-000000000001');

insert into public.products (
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, retail_price, wholesale_price, wholesale_min_quantity, cost_price, status, active
) values (
  '9a400000-0000-4000-8000-000000000001',
  (select id from public.categories order by sort_order, name limit 1),
  'PORTAL-CHECKOUT-001', 'PORTAL-OEM-001', 'portal-checkout-test-product',
  'Producto checkout portal', 'Car Zone Test', 'Fixture transaccional de checkout idempotente',
  25, 115, 100, 1, 70, 'active', true
);

insert into public.audit_logs (
  id, user_id, table_name, record_id, action, old_data, new_data
) values (
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000002',
  'customers',
  '9a200000-0000-4000-8000-000000000001',
  'wholesale_request.created_from_account',
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.crm_notes (
  customer_id, user_id, note, note_type
) values (
  '9a200000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000002',
  'Solicitud mayorista enviada desde cuenta registrada.',
  'wholesale_status'
);

insert into public.wholesale_access_history (
  customer_id, operation, source, previous_status, new_status,
  previous_type, new_type, had_pending_request, requested_at, approved_at,
  actor_user_id, actor_role, reason, previous_commercial_version,
  new_commercial_version, first_purchase_required, first_purchase_minimum,
  request_key, payload_hash
) values (
  '9a200000-0000-4000-8000-000000000001',
  'approve_request', 'customer_request', 'pending', 'approved',
  'existing', 'existing', true, now() - interval '1 day', now(),
  '9a100000-0000-4000-8000-000000000001', 'technical_owner',
  'Aprobación fixture', 0, 1, false, 10000,
  '9a300000-0000-4000-8000-000000000002',
  repeat('a', 64)
);

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('public_catalog_products_v1', 'public_catalog_products_v2', 'portal_catalog_products_v1')
      and column_name = 'wholesale_price'
  ),
  'no public or portal catalog DTO exposes raw wholesale_price'
);

select ok(
  pg_get_viewdef('public.portal_catalog_products_v1'::regclass, true) like '%auth.uid()%'
  and pg_get_viewdef('public.portal_catalog_products_v1'::regclass, true) not like '%requested_price_mode%',
  'portal pricing derives identity from auth.uid and no browser price flag'
);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(
  public.resolve_portal_commercial_context_v1()->>'effectivePriceMode',
  'retail',
  'anonymous context is retail'
);
select is(
  public.resolve_portal_commercial_context_v1()->>'customerId',
  null,
  'anonymous context contains no customer identity'
);

select set_config('request.jwt.claims', '{"sub":"9a100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select ok(
  (public.resolve_portal_commercial_context_v1()->>'authenticated')::boolean
  and not (public.resolve_portal_commercial_context_v1()->>'linked')::boolean
  and public.resolve_portal_commercial_context_v1()->>'effectivePriceMode' = 'retail'
  and (public.resolve_portal_commercial_context_v1()->>'pendingLinkEvidence')::boolean,
  'authenticated account with exact evidence remains retail until explicitly linked'
);

select is(
  (
    select r.name
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.id = '9a100000-0000-4000-8000-000000000002'
  ),
  'cliente',
  'portal account fixture has customer role'
);
select set_config('request.jwt.claims', '{"sub":"9a100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare
  first_result jsonb;
  replay_result jsonb;
  expected_version integer;
begin
  select commercial_version into expected_version
  from public.customers
  where id = '9a200000-0000-4000-8000-000000000001';

  first_result := public.link_customer_portal_account_v2(
    '9a300000-0000-4000-8000-000000000003',
    '9a200000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000002',
    expected_version,
    'authenticated_wholesale_request',
    'audit:9a300000-0000-4000-8000-000000000001',
    'Solicitud autenticada verificada por administración'
  );
  replay_result := public.link_customer_portal_account_v2(
    '9a300000-0000-4000-8000-000000000003',
    '9a200000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000002',
    expected_version,
    'authenticated_wholesale_request',
    'audit:9a300000-0000-4000-8000-000000000001',
    'Solicitud autenticada verificada por administración'
  );

  if not (first_result->>'ok')::boolean
     or not (replay_result->>'idempotentReplay')::boolean
     or (select count(*) from public.customer_portal_link_history where customer_id = '9a200000-0000-4000-8000-000000000001') <> 1
     or (select count(*) from public.customer_portal_link_idempotency_requests where request_key = '9a300000-0000-4000-8000-000000000003') <> 1
  then
    raise exception 'secure link replay failed: %, %', first_result, replay_result;
  end if;
end;
$$;
select pass('exact evidence link is CAS-controlled and idempotent');

select throws_ok(
  $$select public.link_customer_portal_account_v2(
    '9a300000-0000-4000-8000-000000000004',
    '9a200000-0000-4000-8000-000000000003',
    '9a100000-0000-4000-8000-000000000002',
    (select commercial_version from public.customers where id = '9a200000-0000-4000-8000-000000000003'),
    'manual_verified_identity',
    'manual:9a200000-0000-4000-8000-000000000003:9a100000-0000-4000-8000-000000000002',
    'Identidad revisada manualmente con documentación suficiente'
  )$$,
  'PT409',
  'PORTAL_LINK_ACCOUNT_CONFLICT',
  'one portal account cannot be linked to a second customer'
);

select throws_ok(
  $$select public.link_customer_portal_account_v2(
    '9a300000-0000-4000-8000-000000000005',
    '9a200000-0000-4000-8000-000000000003',
    '9a100000-0000-4000-8000-000000000004',
    -1,
    'manual_verified_identity',
    'manual:9a200000-0000-4000-8000-000000000003:9a100000-0000-4000-8000-000000000004',
    'Identidad revisada manualmente con documentación suficiente'
  )$$,
  'PT409',
  'PORTAL_LINK_VERSION_CONFLICT:0',
  'stale commercial version is rejected'
);

select set_config('request.jwt.claims', '{"sub":"9a100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select ok(
  (public.resolve_portal_commercial_context_v1()->>'linked')::boolean
  and public.resolve_portal_commercial_context_v1()->>'effectivePriceMode' = 'wholesale'
  and (public.resolve_portal_commercial_context_v1()->>'creditUsable')::boolean
  and (public.resolve_portal_commercial_context_v1()->>'creditAvailable')::numeric = 20000,
  'linked existing wholesale receives wholesale pricing and independent active credit'
);

select ok(
  not (public.resolve_portal_commercial_context_v1()->>'firstPurchaseRequired')::boolean,
  'existing wholesale does not require first purchase minimum'
);

do $$
declare
  context_before jsonb;
  first_order_id uuid;
  replay_order_id uuid;
  replayed boolean;
begin
  perform set_config('request.jwt.claims', '{"sub":"9a100000-0000-4000-8000-000000000004","role":"authenticated"}', true);
  context_before := public.resolve_portal_commercial_context_v1();

  select result.order_id
  into first_order_id
  from public.create_checkout_order_v3(
    '9a500000-0000-4000-8000-000000000001',
    (context_before->>'commercialVersion')::integer,
    context_before->>'contextToken',
    'Otro cliente',
    'portal-other@example.test',
    '99991003',
    null,
    'Barrio El Centro, Tegucigalpa',
    'retail',
    'bank_transfer',
    'PORTAL-REPLAY-001',
    '[{"product_id":"9a400000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    null,
    null,
    null,
    'Honduras',
    'HN',
    'Francisco Morazán',
    'Tegucigalpa',
    'before_delivery'
  ) result;

  update public.customers
  set user_id = '9a100000-0000-4000-8000-000000000004'
  where id = '9a200000-0000-4000-8000-000000000003'
    and user_id is null;

  select result.order_id, result.idempotent_replay
  into replay_order_id, replayed
  from public.create_checkout_order_v3(
    '9a500000-0000-4000-8000-000000000001',
    (context_before->>'commercialVersion')::integer,
    context_before->>'contextToken',
    'Otro cliente',
    'portal-other@example.test',
    '99991003',
    null,
    'Barrio El Centro, Tegucigalpa',
    'retail',
    'bank_transfer',
    'PORTAL-REPLAY-001',
    '[{"product_id":"9a400000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    null,
    null,
    null,
    'Honduras',
    'HN',
    'Francisco Morazán',
    'Tegucigalpa',
    'before_delivery'
  ) result;

  if first_order_id is null
     or replay_order_id is distinct from first_order_id
     or not replayed
     or (select count(*) from public.orders where id = first_order_id) <> 1 then
    raise exception 'checkout replay contract failed: first=%, replay=%, replayed=%',
      first_order_id, replay_order_id, replayed;
  end if;
end;
$$;
select pass('checkout replay returns the committed order after commercial version changes');

select throws_ok(
  $$select * from public.create_checkout_order_v3(
    '9a500000-0000-4000-8000-000000000001',
    (public.resolve_portal_commercial_context_v1()->>'commercialVersion')::integer,
    public.resolve_portal_commercial_context_v1()->>'contextToken',
    'Payload diferente',
    'portal-other@example.test',
    '99991003',
    null,
    'Barrio El Centro, Tegucigalpa',
    'retail',
    'bank_transfer',
    'PORTAL-REPLAY-001',
    '[{"product_id":"9a400000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    null,
    null,
    null,
    'Honduras',
    'HN',
    'Francisco Morazán',
    'Tegucigalpa',
    'before_delivery'
  )$$,
  'PT409',
  'CHECKOUT_IDEMPOTENCY_CONFLICT',
  'checkout request key rejects a changed payload'
);
select set_config('request.jwt.claims', '{"sub":"9a100000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select ok(
  public.resolve_portal_commercial_context_v1()->>'effectivePriceMode' = 'retail'
  and (public.resolve_portal_commercial_context_v1()->>'creditUsable')::boolean
  and (public.resolve_portal_commercial_context_v1()->>'creditAvailable')::numeric = 5000,
  'retail and commercial credit are independent benefits'
);

select ok(
  not has_function_privilege('anon', 'public.link_customer_portal_account_v2(uuid,uuid,uuid,integer,text,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.link_customer_portal_account_v2(uuid,uuid,uuid,integer,text,text,text)', 'EXECUTE'),
  'link RPC is unavailable to anonymous callers'
);

select ok(
  not coalesce(
    (
      select permissions ? 'customers:link_portal_account'
      from public.roles
      where name = 'contadora'
    ),
    false
  ),
  'accountant role cannot administer portal identity links'
);

select set_config('request.jwt.claims', '{"sub":"9a100000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select throws_ok(
  $$select public.link_customer_portal_account_v2(
    '9a300000-0000-4000-8000-000000000006',
    '9a200000-0000-4000-8000-000000000003',
    '9a100000-0000-4000-8000-000000000004',
    0,
    'manual_verified_identity',
    'manual:9a200000-0000-4000-8000-000000000003:9a100000-0000-4000-8000-000000000004',
    'Identidad revisada manualmente con documentación suficiente'
  )$$,
  '42501',
  'PORTAL_LINK_FORBIDDEN',
  'customer role cannot link portal identities'
);

select * from finish();
rollback;
\echo 'Portal commercial context, secure link, catalog privacy and credit independence: OK'
