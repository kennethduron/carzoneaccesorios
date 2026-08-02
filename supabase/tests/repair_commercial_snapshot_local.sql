\set ON_ERROR_STOP on
begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  '95300000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'repair-target@example.invalid', '', now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

update public.users
set full_name = 'Repair target', active = true
where id = '95300000-0000-4000-8000-000000000001';

set local session_replication_role = replica;

insert into public.customers (
  id, user_id, business_name, contact_name, email, phone, tax_id, address, city,
  is_wholesale, active, status, wholesale_status, wholesale_customer_type,
  wholesale_approved_at, commercial_version
) values
(
  '95300000-0000-4000-8000-000000000002', null, null, 'Duplicate guest',
  'duplicate@example.invalid', '99990001', '08011999123456', 'Old address', null,
  false, true, 'active', 'none', 'new', null, 2
),
(
  '95300000-0000-4000-8000-000000000003',
  '95300000-0000-4000-8000-000000000001',
  'Canonical Business', 'Canonical Contact', 'canonical@example.invalid',
  '99990002', '08011999123456', null, 'Canonical fiscal address',
  true, true, 'active', 'approved', 'existing', now(), 4
);

insert into public.customer_credit_accounts (
  customer_id, is_credit_enabled, credit_limit, terms_days, status, activated_at
) values (
  '95300000-0000-4000-8000-000000000003',
  true, 15000, 30, 'active', now()
);

insert into public.products (
  id, category_id, sku, internal_code, slug, name, brand, description, stock,
  retail_price, wholesale_price, cost_price, status, active
) values (
  '95300000-0000-4000-8000-000000000004',
  (select id from public.categories order by created_at limit 1),
  'REPAIR-SKU', 'REPAIR-CODE', 'repair-commercial-product',
  'Repair product', 'TEST', 'Transactional repair fixture', 0,
  1600, 1600, 600, 'inactive', false
);

insert into public.orders (
  id, order_number, customer_id, customer_name, email, phone, customer_phone,
  delivery_address, payment_method, price_mode, subtotal, tax, shipping_total,
  total, status, tracking_code, shipping_fee, cash_on_delivery_fee,
  small_order_fee, discount_total, fiscal_customer_name, fiscal_customer_rtn,
  payment_timing, calculation_version, commercial_terms_version, delivery_mode,
  requested_invoice_date
) values (
  '95300000-0000-4000-8000-000000000005', 'REPAIR-ORDER-001',
  '95300000-0000-4000-8000-000000000002', 'Duplicate guest',
  'duplicate@example.invalid', '99990001', '99990001', 'Old address',
  'cash', 'retail', 1391.30, 208.70, 0, 1600, 'entregado',
  'REPAIR-TRACK-001', 0, 0, 0, 0, 'Duplicate guest', '08011999123456',
  'on_delivery', 1, 1, 'store_pickup', current_date
);

insert into public.order_items (
  id, order_id, product_id, sku, product_name, quantity, applied_price_mode,
  unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot,
  unit_cost_snapshot, total_cost_snapshot, cost_source, cost_captured_at
) values (
  '95300000-0000-4000-8000-000000000006',
  '95300000-0000-4000-8000-000000000005',
  '95300000-0000-4000-8000-000000000004',
  'REPAIR-SKU', 'Repair product', 1, 'retail', 1600, 1600, 1600, 1600,
  600, 600, 'fixture', now()
);

insert into public.payments (
  id, order_id, customer_id, method, status, amount, paid_at,
  payment_method, payment_status, payment_timing
) values (
  '95300000-0000-4000-8000-000000000007',
  '95300000-0000-4000-8000-000000000005',
  '95300000-0000-4000-8000-000000000002',
  'cash', 'approved', 1600, now(), 'cash', 'approved', 'on_delivery'
);

insert into public.inventory_reservations (
  id, order_id, product_id, quantity, status, expires_at, confirmed_at
) values (
  '95300000-0000-4000-8000-000000000008',
  '95300000-0000-4000-8000-000000000005',
  '95300000-0000-4000-8000-000000000004',
  1, 'confirmed', now() + interval '1 day', now()
);

insert into public.inventory_movements (
  id, product_id, movement_type, quantity, stock_before, stock_after,
  reference_type, reference_id, unit_cost_snapshot, total_cost_snapshot,
  cost_source, cost_captured_at, order_item_id
) values (
  '95300000-0000-4000-8000-000000000009',
  '95300000-0000-4000-8000-000000000004',
  'sale', -1, 1, 0, 'orders',
  '95300000-0000-4000-8000-000000000005',
  600, 600, 'fixture', now(),
  '95300000-0000-4000-8000-000000000006'
);

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, created_by
) values
(
  '95300000-0000-4000-8000-000000000010', 'RPR-5101', 'Repair cost',
  'cost', 'debit', '95300000-0000-4000-8000-000000000001'
),
(
  '95300000-0000-4000-8000-000000000011', 'RPR-1103', 'Repair inventory',
  'asset', 'debit', '95300000-0000-4000-8000-000000000001'
);

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by, metadata
) values (
  '95300000-0000-4000-8000-000000000012', 'PC-REPAIR-0001', current_date,
  'Repair COGS draft', 'borrador', 'financial_event',
  '95300000-0000-4000-8000-000000000013',
  '95300000-0000-4000-8000-000000000001',
  '95300000-0000-4000-8000-000000000001',
  '{"manual_publication_required":true}'::jsonb
);

insert into public.journal_entry_lines (
  journal_entry_id, account_id, debit, credit, description, product_id
) values
(
  '95300000-0000-4000-8000-000000000012',
  '95300000-0000-4000-8000-000000000010',
  600, 0, 'Repair COGS', '95300000-0000-4000-8000-000000000004'
),
(
  '95300000-0000-4000-8000-000000000012',
  '95300000-0000-4000-8000-000000000011',
  0, 600, 'Repair inventory', '95300000-0000-4000-8000-000000000004'
);

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, journal_entry_id
) values (
  '95300000-0000-4000-8000-000000000013',
  'inventory_movement', '95300000-0000-4000-8000-000000000009',
  'inventory_cogs', 'v2', 'draft_created', now(), '{}'::jsonb,
  '95300000-0000-4000-8000-000000000012'
);

insert into public.accounting_outbox_v2 (
  id, feature_key, topic, source_type, source_id, event_purpose,
  posting_version, scenario, idempotency_key, occurred_at, cutover_at, status,
  financial_event_id, journal_entry_id, processed_at
) values (
  '95300000-0000-4000-8000-000000000014',
  'cogs_draft_v2', 'inventory.cogs', 'inventory_movement',
  '95300000-0000-4000-8000-000000000009',
  'inventory_cogs', 'v2', 'physical_sale_movement',
  'repair-cogs-fixture-0001', now(), now() - interval '1 second', 'completed',
  '95300000-0000-4000-8000-000000000013',
  '95300000-0000-4000-8000-000000000012', now()
),
(
  '95300000-0000-4000-8000-000000000015',
  'sales_draft_v2', 'sales.recognized', 'order',
  '95300000-0000-4000-8000-000000000005',
  'sale_recognized', 'v2', 'cash_or_cod_after_delivery',
  'repair-sale-fixture-0001', now(), now() - interval '1 second', 'failed',
  null, null, null
);

update public.accounting_outbox_v2
set processing_hold = true,
    hold_reason = 'Transactional repair fixture',
    held_at = now()
where id = '95300000-0000-4000-8000-000000000015';

set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  fingerprint text;
  result jsonb;
  replay jsonb;
  duplicate_before jsonb;
  cogs_before jsonb;
begin
  fingerprint := public.checkout_order_commercial_repair_fingerprint_v1(
    '95300000-0000-4000-8000-000000000005'
  );
  select to_jsonb(c) into duplicate_before from public.customers c
  where c.id = '95300000-0000-4000-8000-000000000002';
  select jsonb_agg(to_jsonb(j) order by j.id) into cogs_before
  from public.journal_entries j
  where j.id = '95300000-0000-4000-8000-000000000012';

  result := public.repair_checkout_order_commercial_snapshot_v1(
    '95300000-0000-4000-8000-000000000016',
    '95300000-0000-4000-8000-000000000005',
    'REPAIR-ORDER-001', 'REPAIR-TRACK-001',
    '95300000-0000-4000-8000-000000000002',
    '95300000-0000-4000-8000-000000000003',
    '95300000-0000-4000-8000-000000000001',
    1600, 1, 15000, 30, fingerprint,
    'Controlled transactional fixture repair'
  );
  replay := public.repair_checkout_order_commercial_snapshot_v1(
    '95300000-0000-4000-8000-000000000016',
    '95300000-0000-4000-8000-000000000005',
    'REPAIR-ORDER-001', 'REPAIR-TRACK-001',
    '95300000-0000-4000-8000-000000000002',
    '95300000-0000-4000-8000-000000000003',
    '95300000-0000-4000-8000-000000000001',
    1600, 1, 15000, 30, fingerprint,
    'Controlled transactional fixture repair'
  );

  if result->>'status' <> 'repaired'
    or coalesce((result->>'replayed')::boolean, true)
    or not coalesce((replay->>'replayed')::boolean, false)
    or (select customer_id from public.orders where id = '95300000-0000-4000-8000-000000000005')
      <> '95300000-0000-4000-8000-000000000003'
    or (select user_id from public.orders where id = '95300000-0000-4000-8000-000000000005')
      <> '95300000-0000-4000-8000-000000000001'
    or (select price_mode::text from public.orders where id = '95300000-0000-4000-8000-000000000005')
      <> 'wholesale'
    or (select fiscal_customer_name from public.orders where id = '95300000-0000-4000-8000-000000000005')
      <> 'Canonical Business'
    or (select fiscal_customer_address from public.orders where id = '95300000-0000-4000-8000-000000000005')
      <> 'Canonical fiscal address'
    or (select applied_price_mode::text from public.order_items where id = '95300000-0000-4000-8000-000000000006')
      <> 'wholesale'
    or (select unit_price from public.order_items where id = '95300000-0000-4000-8000-000000000006') <> 1600
    or (select line_total from public.order_items where id = '95300000-0000-4000-8000-000000000006') <> 1600
    or (select customer_id from public.payments where id = '95300000-0000-4000-8000-000000000007')
      <> '95300000-0000-4000-8000-000000000003'
    or duplicate_before is distinct from (
      select to_jsonb(c) from public.customers c
      where c.id = '95300000-0000-4000-8000-000000000002'
    )
    or cogs_before is distinct from (
      select jsonb_agg(to_jsonb(j) order by j.id) from public.journal_entries j
      where j.id = '95300000-0000-4000-8000-000000000012'
    )
    or (select count(*) from public.inventory_movements where reference_id = '95300000-0000-4000-8000-000000000005') <> 1
    or not (select processing_hold from public.accounting_outbox_v2 where id = '95300000-0000-4000-8000-000000000015')
    or not exists (
      select 1 from public.audit_logs
      where record_id = '95300000-0000-4000-8000-000000000005'
        and action = 'checkout.order.commercial_snapshot_repaired'
    ) then
    raise exception 'REPAIR_FIXTURE_MISMATCH result=%, replay=%', result, replay;
  end if;

  begin
    perform public.repair_checkout_order_commercial_snapshot_v1(
      '95300000-0000-4000-8000-000000000016',
      '95300000-0000-4000-8000-000000000005',
      'REPAIR-ORDER-001', 'REPAIR-TRACK-001',
      '95300000-0000-4000-8000-000000000002',
      '95300000-0000-4000-8000-000000000003',
      '95300000-0000-4000-8000-000000000001',
      1601, 1, 15000, 30, fingerprint,
      'Controlled transactional fixture repair'
    );
    raise exception 'EXPECTED_REQUEST_KEY_CONFLICT';
  exception when unique_violation then null;
  end;
end;
$$;

rollback;

select plan(1);

do $$
begin
  if exists (select 1 from public.orders where order_number = 'REPAIR-ORDER-001')
    or exists (select 1 from auth.users where email = 'repair-target@example.invalid') then
    raise exception 'Repair fixtures remained after rollback.';
  end if;
end;
$$;

select pass('Commercial snapshot repair transaction and zero-residue contract');
select * from finish();

\echo 'Commercial snapshot repair transaction, replay, conflict, preservation, audit and zero-residue checks passed.'
