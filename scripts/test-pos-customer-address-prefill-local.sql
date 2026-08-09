\set ON_ERROR_STOP on
begin;

insert into public.roles(name, description, permissions)
values (
  'admin', 'POS-ADDRESS-PREFILL-LOCAL-ONLY',
  jsonb_build_array(
    'pos:access','pos:create_sale','pos:drafts:create','pos:drafts:read',
    'pos:drafts:edit_own','pos:drafts:edit_any','pos:products:search',
    'pos:price_override','pos:confirm_sale','pos:reprint_documents',
    'customers:read_commercial','customers:read_credit','invoices:create'
  )
)
on conflict (name) do update set permissions = excluded.permissions;

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'a6100000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'pos-address-prefill-local@example.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.users(id, role_id, full_name, email, active)
values (
  'a6100000-0000-4000-8000-000000000001',
  (select id from public.roles where name = 'admin'),
  'POS-ADDRESS-PREFILL-LOCAL-ONLY', 'pos-address-prefill-local@example.test', true
)
on conflict (id) do update set role_id = excluded.role_id, active = true;

insert into public.customers(
  id, contact_name, email, phone, tax_id, address, city, active, status,
  is_wholesale, wholesale_status, wholesale_customer_type,
  wholesale_first_purchase_completed, commercial_version
) values (
  'a6200000-0000-4000-8000-000000000001',
  'POS-ADDRESS-PREFILL-LOCAL-ONLY', 'pos-address-prefill-customer@example.test',
  '99991061', '08011999123461', 'Dirección A', 'San Pedro Sula', true, 'active',
  false, 'none', 'new', false, 0
);

insert into public.products(
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, reserved_stock, retail_price, wholesale_price, wholesale_min_quantity,
  cost_price, tax_category, tracks_inventory, status, active
) values (
  'a6300000-0000-4000-8000-000000000001',
  (select id from public.categories order by sort_order, name limit 1),
  'POS-ADDRESS-PREFILL-LOCAL-ONLY', 'POS-ADDRESS-PREFILL-LOCAL-ONLY',
  'pos-address-prefill-local-only', 'Servicio POS address prefill', 'TEST',
  'Fixture local transaccional con rollback', 0, 0, 115, 100, 2, 50,
  'standard', false, 'active', true
);

insert into public.company_settings(
  id, company_name, currency, tax_rate, invoice_prefix, order_prefix,
  free_shipping_threshold, standard_shipping_fee, first_wholesale_minimum
) values (
  'a6600000-0000-4000-8000-000000000001', 'POS-ADDRESS-PREFILL-LOCAL-ONLY',
  'HNL', 0.15, 'PAP-F', 'PAP', 3000, 120, 10000
)
on conflict (id) do update set tax_rate = excluded.tax_rate;

update public.fiscal_settings
set legal_name = 'POS ADDRESS PREFILL LOCAL', rtn = '08011999123456',
    cai = 'POS-ADDRESS-PREFILL-LOCAL-ONLY-CAI',
    cai_authorization_date = (now() at time zone 'America/Tegucigalpa')::date - 60,
    invoice_range_start = '000-001-01-00000001',
    invoice_range_end = '000-001-01-00000999',
    current_invoice_number = '000-001-01-00000001',
    emission_deadline = (now() at time zone 'America/Tegucigalpa')::date + 60,
    fiscal_address = 'Tegucigalpa', phone = '99990000',
    email = 'pos-address-prefill-fiscal@example.test'
where id = true;

select set_config('request.jwt.claim.sub', 'a6100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','a6100000-0000-4000-8000-000000000001','role','authenticated'
)::text, true);

insert into public.pos_sale_drafts(
  id, owner_user_id, customer_id, customer_commercial_version,
  pricing_mode_snapshot, version, delivery_mode, delivery_address,
  merchandise_gross, taxable_gross, exempt_gross, taxable_base, tax_amount,
  grand_total, last_saved_by
) values (
  'a6400000-0000-4000-8000-000000000001',
  'a6100000-0000-4000-8000-000000000001',
  'a6200000-0000-4000-8000-000000000001', 0, 'retail', 1,
  'home_delivery', 'Dirección B', 115, 115, 0, 100, 15, 115,
  'a6100000-0000-4000-8000-000000000001'
);

insert into public.pos_sale_draft_items(
  draft_id, product_id, product_sales_version, sku_snapshot,
  product_name_snapshot, brand_snapshot, pricing_source, base_unit_price,
  final_unit_price, quantity, tax_category_snapshot, tax_rate_snapshot,
  line_merchandise_gross, line_taxable_base, line_tax_amount,
  line_exempt_amount, available_stock_snapshot, stock_observed_at,
  stock_status, validation_status, cost_floor_validated, cost_validated_at
)
select
  'a6400000-0000-4000-8000-000000000001', id, product_sales_version,
  sku, name, brand, 'retail', 115, 115, 1, 'standard', 0.15,
  115, 100, 15, 0, 0, now(), 'available', 'valid', true, now()
from public.products
where id = 'a6300000-0000-4000-8000-000000000001';

create temporary table pos_address_prefill_result(value jsonb not null);
insert into pos_address_prefill_result
select public.confirm_selectable_pos_sale_v1(
  'a6400000-0000-4000-8000-000000000001',
  'a6500000-0000-4000-8000-000000000001', 1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',115)
);

do $$
declare
  result jsonb := (select value from pos_address_prefill_result);
  order_row public.orders%rowtype;
  invoice_address text;
  customer_row public.customers%rowtype;
begin
  if result->>'status' <> 'confirmed' then
    raise exception 'POS address prefill fixture did not confirm: %', result;
  end if;

  select * into strict order_row from public.orders where id = (result->>'order_id')::uuid;
  select customer_address into strict invoice_address from public.invoices where id = (result->>'invoice_id')::uuid;
  select * into strict customer_row from public.customers where id = 'a6200000-0000-4000-8000-000000000001';

  if order_row.delivery_address <> 'Dirección B' then
    raise exception 'orders.delivery_address was not the POS override: %', order_row.delivery_address;
  end if;
  if order_row.fiscal_customer_address <> 'Dirección A' then
    raise exception 'orders.fiscal_customer_address changed incorrectly: %', order_row.fiscal_customer_address;
  end if;
  if invoice_address <> 'Dirección A' then
    raise exception 'invoices.customer_address changed incorrectly: %', invoice_address;
  end if;
  if customer_row.address <> 'Dirección A' or customer_row.city <> 'San Pedro Sula' then
    raise exception 'customer profile received forbidden writeback';
  end if;
end;
$$;

rollback;
\echo 'POS address prefill local order, fiscal snapshot, invoice snapshot and zero-writeback: PASS'
