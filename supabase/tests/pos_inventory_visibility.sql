\set ON_ERROR_STOP on
begin;
select plan(31);

select ok(to_regprocedure('public.get_pos_product_inventory_snapshot_v1(uuid[])') is not null, 'inventory snapshot RPC exists');
select ok(to_regprocedure('public.get_pos_product_reservations_v1(uuid,integer,integer)') is not null, 'related reservations RPC exists');
select ok((select prosecdef from pg_proc where oid='public.get_pos_product_inventory_snapshot_v1(uuid[])'::regprocedure), 'snapshot uses SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid='public.get_pos_product_reservations_v1(uuid,integer,integer)'::regprocedure), 'reservations use SECURITY DEFINER');
select is((select provolatile::text from pg_proc where oid='public.get_pos_product_inventory_snapshot_v1(uuid[])'::regprocedure), 's', 'snapshot is STABLE');
select is((select provolatile::text from pg_proc where oid='public.get_pos_product_reservations_v1(uuid,integer,integer)'::regprocedure), 's', 'reservations RPC is STABLE');
select ok((select array_to_string(proconfig, ',') like '%search_path=public%' from pg_proc where oid='public.get_pos_product_inventory_snapshot_v1(uuid[])'::regprocedure), 'snapshot search_path is fixed');
select ok((select array_to_string(proconfig, ',') like '%search_path=public%' from pg_proc where oid='public.get_pos_product_reservations_v1(uuid,integer,integer)'::regprocedure), 'reservations search_path is fixed');
select ok(not has_function_privilege('anon', 'public.get_pos_product_inventory_snapshot_v1(uuid[])', 'execute'), 'anon cannot execute snapshot');
select ok(not has_function_privilege('anon', 'public.get_pos_product_reservations_v1(uuid,integer,integer)', 'execute'), 'anon cannot execute reservations detail');
select ok(has_function_privilege('authenticated', 'public.get_pos_product_inventory_snapshot_v1(uuid[])', 'execute'), 'authenticated can execute guarded snapshot');
select ok(has_function_privilege('authenticated', 'public.get_pos_product_reservations_v1(uuid,integer,integer)', 'execute'), 'authenticated can execute guarded reservations detail');
select throws_ok(
  $$select * from public.get_pos_product_inventory_snapshot_v1(array[]::uuid[])$$,
  '42501', 'POS_PERMISSION_DENIED', 'snapshot requires an authenticated POS actor'
);

insert into public.roles(name, description, permissions)
values ('admin', 'POS inventory visibility fixture', '["pos:access","pos:products:search"]'::jsonb)
on conflict (name) do update set permissions=excluded.permissions;

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'd8100000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'pos-inventory-visibility@example.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.users(id, role_id, full_name, email, active)
values (
  'd8100000-0000-4000-8000-000000000001',
  (select id from public.roles where name='admin'),
  'POS Inventory Visibility', 'pos-inventory-visibility@example.test', true
)
on conflict(id) do update
set role_id=excluded.role_id, full_name=excluded.full_name, active=true;

insert into public.products(
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, reserved_stock, retail_price, wholesale_price, wholesale_min_quantity,
  cost_price, tax_category, tracks_inventory, status, active
) values
  ('d8200000-0000-4000-8000-000000000001',
   (select id from public.categories order by sort_order, name limit 1),
   'POS-VISIBLE-STOCK', 'POS-VISIBLE-STOCK', 'pos-visible-stock',
   'POS Visible Stock', 'TEST', 'POS-INVENTORY-VISIBILITY-LOCAL-ONLY',
   5, 3, 115, 100, 1, 50, 'standard', true, 'active', true),
  ('d8200000-0000-4000-8000-000000000002',
   (select id from public.categories order by sort_order, name limit 1),
   'POS-VISIBLE-SERVICE', 'POS-VISIBLE-SERVICE', 'pos-visible-service',
   'POS Visible Service', 'TEST', 'POS-INVENTORY-VISIBILITY-LOCAL-ONLY',
   0, 0, 115, 100, 1, 0, 'standard', false, 'active', true);

insert into public.orders(
  id, order_number, customer_name, phone, delivery_address, payment_method,
  price_mode, subtotal, tax, shipping_total, total, status,
  order_reservation_status, reservation_expires_at
) values
  ('d8300000-0000-4000-8000-000000000001', 'POS-RESERVE-LOCAL-001',
   'Fixture local', '99990001', 'Fixture local', 'cash', 'retail', 230, 30, 0, 230,
   'pending', 'reserved', now() + interval '30 minutes'),
  ('d8300000-0000-4000-8000-000000000002', 'POS-RESERVE-LOCAL-002',
   'Fixture local', '99990002', 'Fixture local', 'cash', 'retail', 115, 15, 0, 115,
   'pending', 'reserved', now() + interval '45 minutes');

insert into public.inventory_reservations(
  id, order_id, product_id, quantity, status, expires_at, review_required
) values
  ('d8400000-0000-4000-8000-000000000001', 'd8300000-0000-4000-8000-000000000001', 'd8200000-0000-4000-8000-000000000001', 2, 'reserved', now() + interval '30 minutes', true),
  ('d8400000-0000-4000-8000-000000000002', 'd8300000-0000-4000-8000-000000000002', 'd8200000-0000-4000-8000-000000000001', 1, 'reserved', now() + interval '45 minutes', false);

select set_config('request.jwt.claim.sub', 'd8100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','d8100000-0000-4000-8000-000000000001','role','authenticated'
)::text, true);

select is((select count(*)::integer from public.get_pos_product_inventory_snapshot_v1(array[]::uuid[])), 0, 'empty snapshot request avoids product rows');
select is((select count(*)::integer from public.get_pos_product_inventory_snapshot_v1(array['d8200000-0000-4000-8000-000000000001','d8200000-0000-4000-8000-000000000001']::uuid[])), 1, 'snapshot deduplicates product ids');
select results_eq(
  $$select tracks_inventory, physical_stock, reserved_stock, available_stock, has_active_reservations from public.get_pos_product_inventory_snapshot_v1(array['d8200000-0000-4000-8000-000000000001']::uuid[])$$,
  $$values (true, 5, 3, 2, true)$$,
  'tracked product exposes canonical physical, reserved, and available quantities'
);
select results_eq(
  $$select tracks_inventory, physical_stock, reserved_stock, available_stock, has_active_reservations from public.get_pos_product_inventory_snapshot_v1(array['d8200000-0000-4000-8000-000000000002']::uuid[])$$,
  $$values (false, null::integer, null::integer, null::integer, false)$$,
  'non-tracked product exposes null inventory quantities'
);
select throws_ok(
  $$select * from public.get_pos_product_inventory_snapshot_v1(array(select gen_random_uuid() from generate_series(1,51)))$$,
  '22023', 'POS_PRODUCT_QUERY_INVALID', 'snapshot rejects more than 50 unique ids'
);
select throws_ok(
  $$select * from public.get_pos_product_reservations_v1('d8200000-0000-4000-8000-000000000001',20,0)$$,
  '42501', 'POS_PERMISSION_DENIED', 'reservation details also require order read permission'
);

update public.roles
set permissions=permissions || '["orders:read"]'::jsonb
where name='admin';

select is((select count(*)::integer from public.get_pos_product_reservations_v1('d8200000-0000-4000-8000-000000000001',20,0)), 2, 'only active reservations are listed');
select is((select total_count::integer from public.get_pos_product_reservations_v1('d8200000-0000-4000-8000-000000000001',1,0)), 2, 'reservation detail reports total count across pagination');
select ok(pg_get_function_result('public.get_pos_product_reservations_v1(uuid,integer,integer)'::regprocedure) !~* '(customer|email|phone|address|rtn|payment)', 'reservation contract exposes no customer or payment PII');
select throws_ok(
  $$select * from public.get_pos_product_reservations_v1('d8200000-0000-4000-8000-000000000001',51,0)$$,
  '22023', 'POS_RESERVATION_QUERY_INVALID', 'reservation detail enforces the 50 row maximum'
);
select is(
  (select reserved_stock from public.products where id='d8200000-0000-4000-8000-000000000001'),
  (select coalesce(sum(quantity),0)::integer from public.inventory_reservations where product_id='d8200000-0000-4000-8000-000000000001' and status='reserved'),
  'materialized reserved stock matches the active ledger after reservation'
);
select is(public.release_order_reservation('d8300000-0000-4000-8000-000000000001','released','POS-INVENTORY-VISIBILITY-LOCAL-ONLY','d8100000-0000-4000-8000-000000000001'), 1, 'release lifecycle processes one reservation row');
select is(
  (select reserved_stock from public.products where id='d8200000-0000-4000-8000-000000000001'),
  (select coalesce(sum(quantity),0)::integer from public.inventory_reservations where product_id='d8200000-0000-4000-8000-000000000001' and status='reserved'),
  'materialized reserved stock matches the active ledger after release'
);
select is(public.confirm_order_reservation('d8300000-0000-4000-8000-000000000002','d8100000-0000-4000-8000-000000000001'), 1, 'confirmation consumes one reserved line');
select is(
  (select reserved_stock from public.products where id='d8200000-0000-4000-8000-000000000001'),
  (select coalesce(sum(quantity),0)::integer from public.inventory_reservations where product_id='d8200000-0000-4000-8000-000000000001' and status='reserved'),
  'materialized reserved stock matches the active ledger after consumption'
);
select results_eq(
  $$select stock, reserved_stock, available_stock from public.products where id='d8200000-0000-4000-8000-000000000001'$$,
  $$values (4,0,4)$$,
  'consumption decrements physical stock once and leaves no active reservation'
);
select is((select count(*)::integer from public.get_pos_product_reservations_v1('d8200000-0000-4000-8000-000000000001',20,0)), 0, 'released and confirmed reservations are not shown as active');
select results_eq(
  $$select status from public.inventory_reservations where id in ('d8400000-0000-4000-8000-000000000001','d8400000-0000-4000-8000-000000000002') order by id$$,
  $$values ('released'::text), ('confirmed'::text)$$,
  'ledger retains released and confirmed traceability'
);

select * from finish();
rollback;
\echo 'POS inventory visibility read models: OK'
