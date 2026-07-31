\set ON_ERROR_STOP on
begin;
select plan(40);

create temporary table checkout_v4_test_state (
  key text primary key,
  value jsonb not null
);

update public.company_settings
set wholesale_purchases_enabled = true,
    allow_bank_transfer = true,
    allow_cash_on_delivery = true,
    first_wholesale_minimum = 1000,
    free_shipping_threshold = 3000,
    standard_shipping_fee = 120,
    tax_rate = 0.15;

update public.checkout_feature_flags
set enabled = true, enabled_at = now(), updated_at = now()
where key = 'checkout_order_v4';

insert into public.roles(name, description, permissions)
values ('cliente', 'Checkout V4 fixture customer', '["store:buy"]'::jsonb)
on conflict (name) do update set permissions = excluded.permissions;

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('b4100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'v4-wholesale@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b4100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'v4-unlinked@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users(id, role_id, full_name, email, active)
values
  ('b4100000-0000-4000-8000-000000000001', (select id from public.roles where name = 'cliente'), 'V4 Wholesale', 'v4-wholesale@example.test', true),
  ('b4100000-0000-4000-8000-000000000002', (select id from public.roles where name = 'cliente'), 'V4 Unlinked', 'v4-unlinked@example.test', true)
on conflict (id) do update set role_id = excluded.role_id, active = true;

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'b4100000-0000-4000-8000-000000000003',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'v4-admin@example.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.users(id, role_id, full_name, email, active)
values (
  'b4100000-0000-4000-8000-000000000003',
  (select id from public.roles where name = 'technical_owner'),
  'V4 Admin', 'v4-admin@example.test', true
)
on conflict (id) do update set role_id = excluded.role_id, active = true;

update public.notification_preferences
set destination_roles = array['technical_owner']::text[],
    internal_enabled = true,
    email_enabled = true
where notification_type = 'order.created';
insert into public.customers(
  id, user_id, contact_name, email, phone, is_wholesale, wholesale_status,
  wholesale_customer_type, wholesale_first_purchase_completed,
  wholesale_approved_at, status, active
) values (
  'b4200000-0000-4000-8000-000000000001',
  'b4100000-0000-4000-8000-000000000001',
  'V4 Wholesale', 'v4-wholesale@example.test', '99990001', true, 'approved',
  'existing', true, now(), 'active', true
);

insert into public.customer_credit_accounts(
  customer_id, is_credit_enabled, credit_limit, terms_days, status, activated_at
) values (
  'b4200000-0000-4000-8000-000000000001', true, 20000, 30, 'active', now()
);

insert into public.products(
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, reserved_stock, retail_price, wholesale_price, wholesale_min_quantity,
  cost_price, tax_category, status, active
) values
  ('b4300000-0000-4000-8000-000000000001',
   (select id from public.categories order by sort_order, name limit 1),
   'CHECKOUT-V4-RETAIL', 'CHECKOUT-V4-RETAIL', 'checkout-v4-retail',
   'Checkout V4 Retail', 'TEST', 'Atomic checkout fixture',
   20, 0, 230, 180, 2, 90, 'standard', 'active', true),
  ('b4300000-0000-4000-8000-000000000002',
   (select id from public.categories order by sort_order, name limit 1),
   'CHECKOUT-V4-WHOLESALE', 'CHECKOUT-V4-WHOLESALE', 'checkout-v4-wholesale',
   'Checkout V4 Wholesale', 'TEST', 'Atomic checkout fixture',
   20, 0, 575, 500, 2, 250, 'standard', 'active', true),
  ('b4300000-0000-4000-8000-000000000003',
   (select id from public.categories order by sort_order, name limit 1),
   'CHECKOUT-V4-ROLLBACK', 'CHECKOUT-V4-ROLLBACK', 'checkout-v4-rollback',
   'Checkout V4 Rollback', 'TEST', 'Atomic rollback fixture',
   20, 0, 345, 300, 2, 150, 'standard', 'active', true);

select set_config('request.jwt.claims', '{"role":"anon"}', true);

select is(
  public.resolve_portal_commercial_context_v2(true)->>'status',
  'guest',
  'explicit anonymous intent resolves as a real guest'
);
select is(
  public.resolve_portal_commercial_context_v2(false)->>'reasonCode',
  'CHECKOUT_SESSION_REQUIRED',
  'session loss is not silently downgraded to guest'
);
select throws_ok(
  $$select public.checkout_normalize_items_v4('[{"product_id":"b4300000-0000-4000-8000-000000000001","quantity":1,"unit_price":1}]'::jsonb)$$,
  '22023',
  'CHECKOUT_INVALID_INPUT',
  'authoritative cart contract rejects browser price fields'
);
select throws_ok(
  $$select public.checkout_normalize_items_v4('[{"product_id":"b4300000-0000-4000-8000-000000000001","variant_id":"b4300000-0000-4000-8000-000000000002","quantity":1}]'::jsonb)$$,
  '22023',
  'CHECKOUT_INVALID_INPUT',
  'variant input is rejected while this schema has no variant inventory model'
);

do $$
declare
  context jsonb;
  cart jsonb;
  begun jsonb;
  created jsonb;
begin
  context := public.resolve_portal_commercial_context_v2(true);
  cart := public.resolve_checkout_cart_v4(
    '[{"product_id":"b4300000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    true
  );
  begun := public.begin_checkout_request_v1(
    'b4400000-0000-4000-8000-000000000001', repeat('g', 64), 'guest',
    context->>'contextToken', null, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    '{"name":"Invitado V4","email":"v4-guest@example.test","phone":"99990003","rtn":null,"email_updates_opt_in":true,"bank_reference":"V4-GUEST-001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Francisco Morazan","city":"Tegucigalpa","address":"Colonia V4 casa 1","mode":"home_delivery"}'::jsonb,
    'bank_transfer', 'before_delivery'
  );
  if begun->>'status' <> 'started' then
    raise exception 'guest request did not start: %', begun;
  end if;
  created := public.create_checkout_order_v4(
    'b4400000-0000-4000-8000-000000000001', begun->>'requestFingerprint',
    context->>'contextToken', null, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    '{"name":"Invitado V4","email":"v4-guest@example.test","phone":"99990003","rtn":null,"email_updates_opt_in":true,"bank_reference":"V4-GUEST-001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Francisco Morazan","city":"Tegucigalpa","address":"Colonia V4 casa 1","mode":"home_delivery"}'::jsonb,
    'bank_transfer', 'before_delivery', '{"bank_reference":"V4-GUEST-001"}'::jsonb
  );
  insert into checkout_v4_test_state values ('guest_created', created), ('guest_begun', begun), ('guest_cart', cart);
end;
$$;

select is((select value->>'status' from checkout_v4_test_state where key = 'guest_created'), 'committed', 'guest checkout commits');
select is((select value->>'priceMode' from checkout_v4_test_state where key = 'guest_created'), 'retail', 'guest checkout commits directly as retail');
select is((select count(*)::integer from public.orders where order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created')), 1, 'guest request creates exactly one order');
select ok(exists(select 1 from public.order_items oi join public.orders o on o.id = oi.order_id where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created') and oi.applied_price_mode = 'retail' and oi.unit_price = 230), 'retail line is inserted at its final authorized price');
select ok(exists(select 1 from public.inventory_reservations r join public.orders o on o.id = r.order_id where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created') and r.status = 'reserved'), 'inventory reservation is created atomically');
select ok(exists(select 1 from public.payments p join public.orders o on o.id = p.order_id where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created') and p.bank_reference_number = 'V4-GUEST-001'), 'payment metadata is committed atomically');
select ok(exists(select 1 from public.email_queue q join public.orders o on o.id = q.related_id where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created') and q.status = 'pending'), 'customer email is queued without synchronous delivery');
select is(
  (select count(*)::integer from public.email_queue q join public.orders o on o.id = q.related_id
   where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created')),
  2,
  'customer and configured admin emails are queued exactly once'
);
select is(
  (select count(*)::integer from public.email_queue q join public.orders o on o.id = q.related_id
   where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created')
     and q.template_key = 'customer.order_received'),
  1,
  'customer order email is unique'
);
select is(
  (select count(*)::integer from public.email_queue q join public.orders o on o.id = q.related_id
   where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created')
     and q.template_key = 'order.created'),
  1,
  'configured admin order email is unique'
);
select is(
  (select count(distinct q.idempotency_key)::integer from public.email_queue q join public.orders o on o.id = q.related_id
   where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created')),
  2,
  'customer and admin outbox rows use distinct durable idempotency keys'
);
select is(
  (select count(*)::integer from public.internal_notifications n join public.orders o on o.id = n.order_id
   where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created')
     and n.notification_type = 'order.created'),
  1,
  'configured internal order notification is queued exactly once'
);

select is(
  public.get_checkout_request_status_v1('b4400000-0000-4000-8000-000000000001', repeat('g', 64))->>'status',
  'committed',
  'guest can recover a committed request with its high entropy token'
);
select throws_ok(
  $$select public.get_checkout_request_status_v1(
    'b4400000-0000-4000-8000-000000000001', repeat('x', 64)
  )$$,
  '42501',
  'CHECKOUT_REQUEST_FORBIDDEN',
  'wrong guest recovery token exposes no order'
);
select ok(
  not (public.get_checkout_request_status_v1(
    'b4400000-0000-4000-8000-000000000001', repeat('g', 64)
  ) ?| array['email', 'phone', 'address', 'customerId', 'orderId']),
  'request recovery result exposes no unnecessary PII or internal IDs'
);

select public.record_checkout_browser_event_v1(
  'b4400000-0000-4000-8000-000000000001', repeat('g', 64),
  'checkout_confirmation_shown', 'local-test', repeat('a', 40), 250
);
select public.record_checkout_browser_event_v1(
  'b4400000-0000-4000-8000-000000000001', repeat('g', 64),
  'checkout_confirmation_shown', 'local-test', repeat('a', 40), 260
);
select is(
  (select count(*)::integer from public.checkout_observability_events e
   join public.checkout_requests_v4 r on r.id = e.request_id
   where r.request_key = 'b4400000-0000-4000-8000-000000000001'
     and e.event_name = 'checkout_confirmation_shown'),
  1,
  'browser confirmation observability is idempotent'
);
select ok(
  (select confirmation_shown_at is not null from public.checkout_requests_v4
   where request_key = 'b4400000-0000-4000-8000-000000000001'),
  'durable request records that the confirmation was rendered'
);
select ok(
  (select count(distinct e.event_name) from public.checkout_observability_events e
   join public.checkout_requests_v4 r on r.id = e.request_id
   where r.request_key = 'b4400000-0000-4000-8000-000000000001'
     and e.event_name in ('checkout_request_started','checkout_request_processing','checkout_order_committed','checkout_email_queued')) = 4,
  'sanitized observability records the complete server lifecycle'
);
update public.email_queue q
set status = 'failed', attempts = max_attempts, last_error = 'fixture failure'
from public.orders o
where q.related_id = o.id
  and o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'guest_created');
select is(
  (select count(*)::integer from public.checkout_observability_events e
   join public.checkout_requests_v4 r on r.id = e.request_id
   where r.request_key = 'b4400000-0000-4000-8000-000000000001'
     and e.event_name = 'checkout_email_failed'),
  1,
  'terminal asynchronous email failure is observed without changing the order'
);

do $$
declare
  conflict jsonb;
  cart jsonb := (select value from checkout_v4_test_state where key = 'guest_cart');
begin
  conflict := public.begin_checkout_request_v1(
    'b4400000-0000-4000-8000-000000000001', repeat('g', 64), 'guest',
    public.resolve_portal_commercial_context_v2(true)->>'contextToken', null,
    cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    '{"name":"Payload cambiado","email":"v4-guest@example.test","phone":"99990003","bank_reference":"V4-GUEST-001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Francisco Morazan","city":"Tegucigalpa","address":"Colonia V4 casa 1","mode":"home_delivery"}'::jsonb,
    'bank_transfer', 'before_delivery'
  );
  insert into checkout_v4_test_state values ('guest_conflict', conflict);
end;
$$;
select is((select value->>'code' from checkout_v4_test_state where key = 'guest_conflict'), 'CHECKOUT_REQUEST_CONFLICT', 'same key with changed payload is rejected without changing the committed order');

do $$
declare
  replay jsonb;
  original jsonb := (select value from checkout_v4_test_state where key = 'guest_created');
  begun jsonb := (select value from checkout_v4_test_state where key = 'guest_begun');
  cart jsonb := (select value from checkout_v4_test_state where key = 'guest_cart');
begin
  replay := public.create_checkout_order_v4(
    'b4400000-0000-4000-8000-000000000001', begun->>'requestFingerprint',
    public.resolve_portal_commercial_context_v2(true)->>'contextToken', null, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    '{"name":"Invitado V4","email":"v4-guest@example.test","phone":"99990003"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Francisco Morazan","city":"Tegucigalpa","address":"Colonia V4 casa 1"}'::jsonb,
    'bank_transfer', 'before_delivery', '{}'::jsonb
  );
  if replay->>'orderNumber' <> original->>'orderNumber' or coalesce((replay->>'replayed')::boolean, false) is not true then
    raise exception 'replay did not return canonical order: %', replay;
  end if;
end;
$$;
select pass('same request replay returns the canonical order');
select is((select count(*)::integer from public.orders where email = 'v4-guest@example.test'), 1, 'replay never duplicates the order');

select set_config('request.jwt.claims', '{"sub":"b4100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.resolve_portal_commercial_context_v2(false)->>'reasonCode', 'CHECKOUT_CUSTOMER_LINK_REQUIRED', 'authenticated account without customer link is blocked');

select set_config('request.jwt.claims', '{"sub":"b4100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.resolve_portal_commercial_context_v2(false)->>'priceMode', 'wholesale', 'linked approved account resolves wholesale authoritatively');

do $$
declare
  context jsonb := public.resolve_portal_commercial_context_v2(false);
  cart jsonb;
  begun jsonb;
  created jsonb;
begin
  cart := public.resolve_checkout_cart_v4('[{"product_id":"b4300000-0000-4000-8000-000000000002","quantity":2}]'::jsonb, false);
  begun := public.begin_checkout_request_v1(
    'b4400000-0000-4000-8000-000000000002', repeat('a', 64), 'authenticated',
    context->>'contextToken', (context->>'commercialVersion')::integer, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000002","quantity":2}]'::jsonb,
    '{"name":"V4 Wholesale","email":"v4-wholesale@example.test","phone":"99990001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Cortes","city":"San Pedro Sula","address":"Bodega V4"}'::jsonb,
    'commercial_credit', 'before_delivery'
  );
  created := public.create_checkout_order_v4(
    'b4400000-0000-4000-8000-000000000002', begun->>'requestFingerprint',
    context->>'contextToken', (context->>'commercialVersion')::integer, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000002","quantity":2}]'::jsonb,
    '{"name":"V4 Wholesale","email":"v4-wholesale@example.test","phone":"99990001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Cortes","city":"San Pedro Sula","address":"Bodega V4"}'::jsonb,
    'commercial_credit', 'before_delivery', '{}'::jsonb
  );
  insert into checkout_v4_test_state values ('wholesale_created', created);
end;
$$;

select is((select value->>'priceMode' from checkout_v4_test_state where key = 'wholesale_created'), 'wholesale', 'wholesale order is born wholesale without retail rewrite');
select ok(exists(select 1 from public.order_items oi join public.orders o on o.id = oi.order_id where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'wholesale_created') and oi.applied_price_mode = 'wholesale' and oi.unit_price = 500 and oi.line_total = 1000), 'wholesale line snapshots are authoritative on insert');
select ok(exists(select 1 from public.accounts_receivable ar join public.orders o on o.id = ar.order_id where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'wholesale_created') and ar.original_amount = o.total), 'commercial credit creates one matching receivable atomically');
select ok(
  exists(
    select 1 from public.orders o
    where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'wholesale_created')
      and o.user_id = 'b4100000-0000-4000-8000-000000000001'
      and o.customer_id = 'b4200000-0000-4000-8000-000000000001'
  ),
  'authenticated order persists the canonical user and linked customer'
);
select is(
  (select count(*)::integer from public.customers where user_id is null and lower(email) = 'v4-wholesale@example.test'),
  0,
  'authenticated checkout never creates a guest customer duplicate'
);
select ok(
  exists(
    select 1 from public.orders o
    where o.order_number = (select value->>'orderNumber' from checkout_v4_test_state where key = 'wholesale_created')
      and o.total = 1120
      and o.subtotal = 869.57
      and o.tax = 130.43
      and o.shipping_total = 120
  ),
  'server calculates exact included ISV, rounding, shipping and final total'
);

do $$
declare
  context jsonb := public.resolve_portal_commercial_context_v2(false);
  cart jsonb;
  begun jsonb;
begin
  cart := public.resolve_checkout_cart_v4('[{"product_id":"b4300000-0000-4000-8000-000000000003","quantity":2}]'::jsonb, false);
  begun := public.begin_checkout_request_v1(
    'b4400000-0000-4000-8000-000000000003', repeat('s', 64), 'authenticated',
    context->>'contextToken', (context->>'commercialVersion')::integer, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000003","quantity":2}]'::jsonb,
    '{"name":"V4 Wholesale","email":"v4-wholesale@example.test","phone":"99990001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Cortes","city":"San Pedro Sula","address":"Bodega V4"}'::jsonb,
    'cash', 'on_delivery'
  );
  insert into checkout_v4_test_state values ('session_begun', begun), ('session_cart', cart), ('session_context', context);
end;
$$;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select public.create_checkout_order_v4(
    'b4400000-0000-4000-8000-000000000003',
    (select value->>'requestFingerprint' from checkout_v4_test_state where key = 'session_begun'),
    (select value->>'contextToken' from checkout_v4_test_state where key = 'session_context'),
    ((select value->>'commercialVersion' from checkout_v4_test_state where key = 'session_context'))::integer,
    (select value->>'cartFingerprint' from checkout_v4_test_state where key = 'session_cart'),
    '[{"product_id":"b4300000-0000-4000-8000-000000000003","quantity":2}]'::jsonb,
    '{"name":"V4 Wholesale","email":"v4-wholesale@example.test","phone":"99990001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Cortes","city":"San Pedro Sula","address":"Bodega V4"}'::jsonb,
    'cash', 'on_delivery', '{}'::jsonb
  )$$,
  '42501',
  'CHECKOUT_SESSION_REQUIRED',
  'session loss cannot fall through to a guest order'
);
select is((select count(*)::integer from public.orders where email = 'v4-wholesale@example.test'), 1, 'session-loss attempt creates no extra order');

select set_config('request.jwt.claims', '{"sub":"b4100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create or replace function pg_temp.checkout_v4_payment_failpoint()
returns trigger
language plpgsql
as $$
begin
  if current_setting('checkout_v4.test_failpoint', true) = 'payments' then
    raise exception 'CHECKOUT_V4_TEST_PAYMENT_FAILURE';
  end if;
  return new;
end;
$$;
create trigger checkout_v4_test_payment_failure
before insert on public.payments
for each row execute function pg_temp.checkout_v4_payment_failpoint();

do $$
declare
  context jsonb := public.resolve_portal_commercial_context_v2(false);
  cart jsonb;
  begun jsonb;
begin
  cart := public.resolve_checkout_cart_v4('[{"product_id":"b4300000-0000-4000-8000-000000000003","quantity":2}]'::jsonb, false);
  begun := public.begin_checkout_request_v1(
    'b4400000-0000-4000-8000-000000000004', repeat('r', 64), 'authenticated',
    context->>'contextToken', (context->>'commercialVersion')::integer, cart->>'cartFingerprint',
    '[{"product_id":"b4300000-0000-4000-8000-000000000003","quantity":2}]'::jsonb,
    '{"name":"V4 Wholesale","email":"v4-wholesale@example.test","phone":"99990001"}'::jsonb,
    '{"country":"Honduras","country_code":"HN","department":"Cortes","city":"San Pedro Sula","address":"Bodega V4"}'::jsonb,
    'cash', 'on_delivery'
  );
  perform set_config('checkout_v4.test_failpoint', 'payments', true);
  begin
    perform public.create_checkout_order_v4(
      'b4400000-0000-4000-8000-000000000004', begun->>'requestFingerprint',
      context->>'contextToken', (context->>'commercialVersion')::integer, cart->>'cartFingerprint',
      '[{"product_id":"b4300000-0000-4000-8000-000000000003","quantity":2}]'::jsonb,
      '{"name":"V4 Wholesale","email":"v4-wholesale@example.test","phone":"99990001"}'::jsonb,
      '{"country":"Honduras","country_code":"HN","department":"Cortes","city":"San Pedro Sula","address":"Bodega V4"}'::jsonb,
      'cash', 'on_delivery', '{}'::jsonb
    );
    raise exception 'expected payment failpoint did not fire';
  exception when others then
    if sqlerrm <> 'CHECKOUT_V4_TEST_PAYMENT_FAILURE' then raise; end if;
  end;
  perform set_config('checkout_v4.test_failpoint', '', true);
end;
$$;
select is((select status from public.checkout_requests_v4 where request_key = 'b4400000-0000-4000-8000-000000000004'), 'started', 'failed atomic create rolls request processing state back');
select ok(
  not exists(select 1 from public.orders o join public.order_items oi on oi.order_id = o.id where oi.product_id = 'b4300000-0000-4000-8000-000000000003')
  and (select reserved_stock from public.products where id = 'b4300000-0000-4000-8000-000000000003') = 0,
  'failure after order lines leaves no order, line, reservation, payment or stock residue'
);

select ok(
  position('create_checkout_order_v3' in pg_get_functiondef('public.create_checkout_order_v4(uuid,text,text,integer,text,jsonb,jsonb,jsonb,public.payment_method,text,jsonb)'::regprocedure)) = 0
  and position('create_checkout_order_v2' in pg_get_functiondef('public.create_checkout_order_v4(uuid,text,text,integer,text,jsonb,jsonb,jsonb,public.payment_method,text,jsonb)'::regprocedure)) = 0
  and position('create_checkout_order(' in pg_get_functiondef('public.create_checkout_order_v4(uuid,text,text,integer,text,jsonb,jsonb,jsonb,public.payment_method,text,jsonb)'::regprocedure)) = 0,
  'V4 does not wrap any legacy retail-first checkout function'
);
select ok(
  has_function_privilege('anon', 'public.begin_checkout_request_v1(uuid,text,text,text,integer,text,jsonb,jsonb,jsonb,public.payment_method,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_checkout_order_v4(uuid,text,text,integer,text,jsonb,jsonb,jsonb,public.payment_method,text,jsonb)', 'EXECUTE')
  and not has_table_privilege('anon', 'public.checkout_requests_v4', 'SELECT'),
  'RPC grants allow checkout but durable request rows remain private'
);

select * from finish();
rollback;
\echo 'Checkout V4 atomic, direct pricing, recovery and strict-context contract: OK'
