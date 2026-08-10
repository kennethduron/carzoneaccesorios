\set ON_ERROR_STOP on
begin;
select no_plan();

insert into public.roles(name, description, permissions)
values (
  'admin', 'POS Stage 5 fixture',
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
  'a5100000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'pos5-admin@example.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.users(id, role_id, full_name, email, active)
values (
  'a5100000-0000-4000-8000-000000000001',
  (select id from public.roles where name = 'admin'),
  'POS Stage 5 Admin', 'pos5-admin@example.test', true
)
on conflict (id) do update set role_id = excluded.role_id, active = true;

insert into public.customers(
  id, contact_name, email, phone, tax_id, address, city, active, status,
  is_wholesale, wholesale_status, wholesale_customer_type,
  wholesale_first_purchase_completed, commercial_version
) values
  ('a5200000-0000-4000-8000-000000000001', 'POS Retail', 'retail@example.test',
   '99991001', '08011999123456', 'Tegucigalpa', 'Tegucigalpa', true, 'active',
   false, 'none', 'new', false, 0),
  ('a5200000-0000-4000-8000-000000000002', 'POS Credit', 'credit@example.test',
   '99991002', '08011999123457', 'Tegucigalpa', 'Tegucigalpa', true, 'active',
   false, 'none', 'new', false, 0);

insert into public.customer_credit_accounts(
  customer_id, is_credit_enabled, credit_limit, terms_days, status, activated_at,
  activated_by
) values (
  'a5200000-0000-4000-8000-000000000002', true, 1000, 30, 'active', now(),
  'a5100000-0000-4000-8000-000000000001'
);

insert into public.products(
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, reserved_stock, retail_price, wholesale_price, wholesale_min_quantity,
  cost_price, tax_category, tracks_inventory, status, active
) values
  ('a5300000-0000-4000-8000-000000000001',
   (select id from public.categories order by sort_order, name limit 1),
   'POS5-TAX', 'POS5-TAX', 'pos5-tax', 'POS Taxable', 'TEST', 'Fixture',
   10, 0, 115, 100, 2, 50, 'standard', true, 'active', true),
  ('a5300000-0000-4000-8000-000000000002',
   (select id from public.categories order by sort_order, name limit 1),
   'POS5-EXEMPT', 'POS5-EXEMPT', 'pos5-exempt', 'POS Exempt', 'TEST', 'Fixture',
   10, 0, 100, 90, 2, 40, 'exempt', true, 'active', true),
  ('a5300000-0000-4000-8000-000000000003',
   (select id from public.categories order by sort_order, name limit 1),
   'POS5-SERVICE', 'POS5-SERVICE', 'pos5-service', 'POS Service', 'TEST', 'Fixture',
   0, 0, 230, 200, 2, 0, 'standard', false, 'active', true);

insert into public.company_settings(
  id, company_name, currency, tax_rate, invoice_prefix, order_prefix,
  free_shipping_threshold, standard_shipping_fee, first_wholesale_minimum
) values (
  'a5600000-0000-4000-8000-000000000001', 'POS5 COMPANY', 'HNL', 0.15,
  'POS5-F', 'POS5', 3000, 120, 10000
)
on conflict (id) do update set tax_rate = excluded.tax_rate;
update public.fiscal_settings
set legal_name = 'POS5 LEGAL', rtn = '08011999123456', cai = 'POS5-LOCAL-CAI',
    cai_authorization_date = (now() at time zone 'America/Tegucigalpa')::date - 60,
    invoice_range_start = '000-001-01-00000001',
    invoice_range_end = '000-001-01-00000999',
    current_invoice_number = '000-001-01-00000001',
    emission_deadline = (now() at time zone 'America/Tegucigalpa')::date + 60,
    fiscal_address = 'Tegucigalpa', phone = '99990000', email = 'pos5@example.test'
where id = true;

select set_config('request.jwt.claim.sub', 'a5100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','a5100000-0000-4000-8000-000000000001','role','authenticated'
)::text, true);

insert into public.accounting_accounts(
  id, code, name, type, normal_balance, created_by
) values (
  'a5700000-0000-4000-8000-000000000001', 'POS5-4199',
  'POS optional charges fixture', 'revenue', 'credit',
  'a5100000-0000-4000-8000-000000000001'
),(
  'a5700000-0000-4000-8000-000000000002', 'POS5-1109',
  'POS payment clearing fixture', 'asset', 'debit',
  'a5100000-0000-4000-8000-000000000001'
);
insert into public.accounting_mappings(
  mapping_type, source_key, account_id, priority, is_active, created_by
) values
  ('revenue','sale_shipping_fee','a5700000-0000-4000-8000-000000000001',1,true,'a5100000-0000-4000-8000-000000000001'),
  ('revenue','sale_cod_fee','a5700000-0000-4000-8000-000000000001',1,true,'a5100000-0000-4000-8000-000000000001'),
  ('revenue','sale_other_charge','a5700000-0000-4000-8000-000000000001',1,true,'a5100000-0000-4000-8000-000000000001'),
  ('payment_method','bank_transfer','a5700000-0000-4000-8000-000000000002',1,true,'a5100000-0000-4000-8000-000000000001'),
  ('payment_method','card','a5700000-0000-4000-8000-000000000002',1,true,'a5100000-0000-4000-8000-000000000001');

create temporary table pos5_state(key text primary key, value jsonb not null);

create or replace function pg_temp.pos5_single_line_draft(
  target_draft_id uuid,
  target_customer_id uuid,
  target_product_id uuid
)
returns void
language plpgsql
as $$
declare
  product_row public.products%rowtype;
  gross numeric(14,2);
  taxable_base numeric(14,2);
  tax_amount numeric(14,2);
  exempt_amount numeric(14,2);
begin
  select * into product_row from public.products where id = target_product_id;
  gross := product_row.retail_price;
  taxable_base := case when product_row.tax_category = 'standard' then round(gross / 1.15, 2) else 0 end;
  tax_amount := case when product_row.tax_category = 'standard' then gross - taxable_base else 0 end;
  exempt_amount := case when product_row.tax_category = 'exempt' then gross else 0 end;
  insert into public.pos_sale_drafts(
    id, owner_user_id, customer_id, customer_commercial_version,
    pricing_mode_snapshot, version, merchandise_gross, taxable_gross,
    exempt_gross, taxable_base, tax_amount, grand_total, last_saved_by
  ) values (
    target_draft_id, 'a5100000-0000-4000-8000-000000000001', target_customer_id,
    (select commercial_version from public.customers where id = target_customer_id),
    'retail', 1, gross,
    case when product_row.tax_category = 'standard' then gross else 0 end,
    exempt_amount, taxable_base, tax_amount, gross,
    'a5100000-0000-4000-8000-000000000001'
  );
  insert into public.pos_sale_draft_items(
    draft_id, product_id, product_sales_version, sku_snapshot,
    product_name_snapshot, brand_snapshot, pricing_source, base_unit_price,
    final_unit_price, quantity, tax_category_snapshot, tax_rate_snapshot,
    line_merchandise_gross, line_taxable_base, line_tax_amount,
    line_exempt_amount, available_stock_snapshot, stock_observed_at,
    stock_status, validation_status, cost_floor_validated, cost_validated_at
  ) values (
    target_draft_id, product_row.id, product_row.product_sales_version,
    product_row.sku, product_row.name, product_row.brand, 'retail', gross, gross, 1,
    product_row.tax_category,
    case when product_row.tax_category = 'standard' then 0.15 else 0 end,
    gross, taxable_base, tax_amount, exempt_amount, product_row.available_stock, now(),
    case when not product_row.tracks_inventory then 'available'
      when product_row.available_stock > 0 then 'available' else 'insufficient' end,
    'valid', product_row.cost_price > 0, now()
  );
end;
$$;

insert into public.pos_sale_drafts(
  id, owner_user_id, customer_id, customer_commercial_version,
  pricing_mode_snapshot, version, merchandise_gross, taxable_gross,
  exempt_gross, taxable_base, tax_amount, grand_total, last_saved_by
) values (
  'a5400000-0000-4000-8000-000000000001',
  'a5100000-0000-4000-8000-000000000001',
  'a5200000-0000-4000-8000-000000000001', 0, 'retail', 1,
  215, 115, 100, 100, 15, 215,
  'a5100000-0000-4000-8000-000000000001'
);

insert into public.pos_sale_draft_items(
  draft_id, product_id, product_sales_version, sku_snapshot,
  product_name_snapshot, brand_snapshot, pricing_source, base_unit_price,
  final_unit_price, quantity, tax_category_snapshot, tax_rate_snapshot,
  line_merchandise_gross, line_taxable_base, line_tax_amount,
  line_exempt_amount, available_stock_snapshot, stock_observed_at,
  stock_status, validation_status, cost_floor_validated, cost_validated_at
)
select 'a5400000-0000-4000-8000-000000000001', id, product_sales_version,
  sku, name, brand, 'retail', retail_price, retail_price, 1, tax_category,
  case when tax_category = 'standard' then 0.15 else 0 end,
  retail_price,
  case when tax_category = 'standard' then round(retail_price / 1.15, 2) else 0 end,
  case when tax_category = 'standard' then retail_price - round(retail_price / 1.15, 2) else 0 end,
  case when tax_category = 'exempt' then retail_price else 0 end,
  available_stock, now(), 'available', 'valid', true, now()
from public.products
where id in ('a5300000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000002');

insert into pos5_state
select 'cash_result', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000001',
  'a5500000-0000-4000-8000-000000000001', 1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',250)
);

select is((select value->>'status' from pos5_state where key = 'cash_result'), 'confirmed', 'cash sale confirms');
select is((select (value->>'total')::numeric from pos5_state where key = 'cash_result'), 215::numeric, 'server total is authoritative');
select is((select (value->>'change_due')::numeric from pos5_state where key = 'cash_result'), 35::numeric, 'server calculates cash change');
select is((select count(*)::integer from public.orders where pos_draft_id = 'a5400000-0000-4000-8000-000000000001'), 1, 'one order per draft');
select is((select count(*)::integer from public.invoices i join public.orders o on o.id = i.order_id where o.pos_draft_id = 'a5400000-0000-4000-8000-000000000001'), 1, 'one fiscal invoice is created');
select is((select count(*)::integer from public.payments p join public.orders o on o.id = p.order_id where o.pos_draft_id = 'a5400000-0000-4000-8000-000000000001' and p.payment_status = 'approved'), 1, 'approved payment is created');
select is((select count(*)::integer from public.accounts_receivable r join public.orders o on o.id = r.order_id where o.pos_draft_id = 'a5400000-0000-4000-8000-000000000001'), 0, 'paid sale has no receivable');
select is((select stock from public.products where id = 'a5300000-0000-4000-8000-000000000001'), 9, 'taxable stock decrements once');
select is((select stock from public.products where id = 'a5300000-0000-4000-8000-000000000002'), 9, 'exempt stock decrements once');
select is((select count(*)::integer from public.inventory_movements where reference_type = 'orders' and reference_id = ((select value->>'order_id' from pos5_state where key = 'cash_result')::uuid)), 2, 'one inventory movement per tracked line');
select ok(exists(select 1 from public.invoice_items where invoice_id = ((select value->>'invoice_id' from pos5_state where key = 'cash_result')::uuid) and tax_category_snapshot = 'standard' and tax_amount_snapshot = 15), 'taxable line snapshot reaches invoice');
select ok(exists(select 1 from public.invoice_items where invoice_id = ((select value->>'invoice_id' from pos5_state where key = 'cash_result')::uuid) and tax_category_snapshot = 'exempt' and exempt_amount_snapshot = 100), 'exempt line snapshot reaches invoice');

insert into pos5_state
select 'cash_replay', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000001',
  'a5500000-0000-4000-8000-000000000001', 1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',250)
);
select is((select (value->>'replayed')::boolean from pos5_state where key = 'cash_replay'), true, 'same request replays');
select is((select value->>'order_id' from pos5_state where key = 'cash_replay'), (select value->>'order_id' from pos5_state where key = 'cash_result'), 'replay returns same order');
select is((select count(*)::integer from public.invoices i join public.orders o on o.id = i.order_id where o.pos_draft_id = 'a5400000-0000-4000-8000-000000000001'), 1, 'replay does not consume another correlativo');

select pg_temp.pos5_single_line_draft(
  'a5400000-0000-4000-8000-000000000005',
  'a5200000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000002'
);
update public.pos_sale_drafts
set shipping_fee = 0.10, cod_fee = 0.20, additional_charge = 0.30,
    additional_charge_description = 'Cargo adicional de prueba',
    other_charge = 0.40, other_charge_description = 'Otro cargo de prueba',
    grand_total = 101.00
where id = 'a5400000-0000-4000-8000-000000000005';
insert into pos5_state
select 'charged_result', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000005',
  'a5500000-0000-4000-8000-000000000050', 1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',101.25)
);
select is((select (value->>'total')::numeric from pos5_state where key='charged_result'), 101.00::numeric, 'authoritative total includes all four decimal charges');
select ok(exists(
  select 1 from public.orders where id=((select value->>'order_id' from pos5_state where key='charged_result')::uuid)
    and shipping_fee=0.10 and shipping_total=0.10 and cash_on_delivery_fee=0.20
), 'order persists canonical delivery and COD charge columns');
select is((
  select coalesce(sum((fee->>'amount')::numeric),0) from public.orders order_row,
    lateral jsonb_array_elements(order_row.additional_fees) fee
  where order_row.id=((select value->>'order_id' from pos5_state where key='charged_result')::uuid)
), 0.70::numeric, 'order persists additional and other charge amounts exactly once');
select is((
  select jsonb_array_length(additional_fees) from public.orders
  where id=((select value->>'order_id' from pos5_state where key='charged_result')::uuid)
), 2, 'positive additional charges remain two labeled invoice rows');
select ok(exists(
  select 1 from public.invoices where id=((select value->>'invoice_id' from pos5_state where key='charged_result')::uuid)
    and shipping_fee=0.10 and cash_on_delivery_fee=0.20 and total=101.00
), 'issued invoice snapshots charges and final total');
select ok(exists(
  select 1 from public.payments where id=((select value->>'payment_id' from pos5_state where key='charged_result')::uuid)
    and amount=101.00 and payment_status='approved'
), 'cash payment equals charged grand total');
select is((
  select difference from public.order_financial_audit
  where id=((select value->>'order_id' from pos5_state where key='charged_result')::uuid)
), 0.00::numeric, 'canonical order financial audit balances with charges');
select ok(exists(
  select 1 from public.orders where id=((select value->>'order_id' from pos5_state where key='charged_result')::uuid)
    and source='pos' and channel='store'
), 'charged sale remains a canonical POS order');
select is((select stock from public.products where id='a5300000-0000-4000-8000-000000000002'), 8, 'charges do not change inventory quantity semantics');
select is((
  select count(*)::integer from public.inventory_movements
  where reference_id=((select value->>'order_id' from pos5_state where key='charged_result')::uuid)
), 1, 'charged sale creates one movement for one tracked line');
insert into pos5_state
select 'charged_replay', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000005',
  'a5500000-0000-4000-8000-000000000050', 1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',101.25)
);
select is((select (value->>'replayed')::boolean from pos5_state where key='charged_replay'), true, 'charged confirmation replay is idempotent');
select is((select count(*)::integer from public.orders where pos_draft_id='a5400000-0000-4000-8000-000000000005'), 1, 'charged replay keeps one order');
select is((select count(*)::integer from public.invoices i join public.orders o on o.id=i.order_id where o.pos_draft_id='a5400000-0000-4000-8000-000000000005'), 1, 'charged replay keeps one invoice');
select is((select count(*)::integer from public.payments p join public.orders o on o.id=p.order_id where o.pos_draft_id='a5400000-0000-4000-8000-000000000005'), 1, 'charged replay keeps one payment');
select is((select stock from public.products where id='a5300000-0000-4000-8000-000000000002'), 8, 'charged replay never decrements inventory twice');
select is((
  select jsonb_array_length(additional_fees) from public.orders
  where id=((select value->>'order_id' from pos5_state where key='cash_result')::uuid)
), 0, 'zero charges create no invoice fee rows');

select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000001','a5500000-0000-4000-8000-000000000001',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','cash','amount_tendered',251))$$,
  'PT409', 'POS_REQUEST_KEY_CONFLICT', 'same request key rejects a changed payload'
);
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000001','a5500000-0000-4000-8000-000000000099',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','card','verified',true))$$,
  'PT409', 'POS_DRAFT_ALREADY_CONFIRMED', 'confirmed draft rejects a different payload'
);

select ok(not has_function_privilege('anon', 'public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)', 'execute'), 'anonymous cannot execute confirmation');
select ok(not has_function_privilege('authenticated', 'public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)', 'execute'), 'authenticated cannot bypass customer eligibility');
select ok(has_function_privilege('authenticated', 'public.confirm_selectable_pos_sale_v1(uuid,uuid,bigint,date,jsonb)', 'execute'), 'authenticated may invoke guarded RPC');
select ok(not has_table_privilege('authenticated', 'public.pos_sale_confirmation_context', 'select'), 'authenticated cannot inspect internal confirmation context');
select is((select count(*)::integer from public.pos_sale_confirmation_context), 0, 'transactional confirmation context is removed');

select is(
  (public.recover_pos_sale_confirmation_v1('a5400000-0000-4000-8000-000000000001')->>'replayed')::boolean,
  true,
  'confirmed sale can be recovered after a lost response'
);
select is(
  (public.confirm_selectable_pos_sale_v1(
    'a5400000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000002', 1,
    (now() at time zone 'America/Tegucigalpa')::date,
    jsonb_build_object('method','cash','amount_tendered',250)
  )->>'order_id'),
  (select value->>'order_id' from pos5_state where key = 'cash_result'),
  'same confirmed payload with a new key recovers the existing sale'
);

select pg_temp.pos5_single_line_draft(
  'a5400000-0000-4000-8000-000000000002',
  'a5200000-0000-4000-8000-000000000002',
  'a5300000-0000-4000-8000-000000000003'
);
insert into pos5_state
select 'credit_result', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000002',
  'a5500000-0000-4000-8000-000000000010', 1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','commercial_credit')
);
select is((select value->>'payment_method' from pos5_state where key = 'credit_result'), 'commercial_credit', 'commercial credit sale confirms');
select is((select count(*)::integer from public.payments where order_id = ((select value->>'order_id' from pos5_state where key = 'credit_result')::uuid)), 0, 'credit sale creates no fictitious payment');
select is((select count(*)::integer from public.accounts_receivable where order_id = ((select value->>'order_id' from pos5_state where key = 'credit_result')::uuid) and original_amount = 230 and balance_due = 230), 1, 'credit sale creates one full receivable');
select is((select count(*)::integer from public.inventory_movements where reference_id = ((select value->>'order_id' from pos5_state where key = 'credit_result')::uuid)), 0, 'service creates no inventory movement');
select is((select stock from public.products where id = 'a5300000-0000-4000-8000-000000000003'), 0, 'service stock remains unchanged');
select is((select invoice_id::text from public.accounts_receivable where order_id = ((select value->>'order_id' from pos5_state where key = 'credit_result')::uuid)), (select value->>'invoice_id' from pos5_state where key = 'credit_result'), 'receivable links to the fiscal invoice');

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000003','a5200000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000003','a5500000-0000-4000-8000-000000000020',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','cash','amount_tendered',114.99))$$,
  '22023', 'POS_AMOUNT_TENDERED_INSUFFICIENT', 'cash below total is rejected'
);
select is((select count(*)::integer from public.orders where pos_draft_id = 'a5400000-0000-4000-8000-000000000003'), 0, 'insufficient cash leaves no order');

select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000003','a5500000-0000-4000-8000-000000000021',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','bank_transfer','verified',true))$$,
  '22023', 'POS_TRANSFER_REFERENCE_REQUIRED', 'verified transfer still requires a reference'
);
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000003','a5500000-0000-4000-8000-000000000022',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','card','verified',false))$$,
  '22023', 'POS_CARD_CONFIGURATION_INVALID', 'unverified generic card is rejected'
);
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000003','a5500000-0000-4000-8000-000000000023',1,(now() at time zone 'America/Tegucigalpa')::date + 1,jsonb_build_object('method','cash','amount_tendered',115))$$,
  '22023', 'POS_FISCAL_DATE_INVALID', 'future Honduras invoice date is rejected'
);

update public.products set retail_price = 116 where id = 'a5300000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000003','a5500000-0000-4000-8000-000000000024',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','cash','amount_tendered',116))$$,
  'PT409', 'POS_PRICE_CHANGED', 'price version change blocks confirmation'
);
select is((select count(*)::integer from public.orders where pos_draft_id = 'a5400000-0000-4000-8000-000000000003'), 0, 'price conflict leaves no economic rows');

insert into public.roles(name, description, permissions)
values ('contadora', 'POS denied fixture', jsonb_build_array('pos:access','pos:confirm_sale'))
on conflict (name) do update set permissions = excluded.permissions;
update public.users set role_id = (select id from public.roles where name = 'contadora')
where id = 'a5100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000003','a5500000-0000-4000-8000-000000000025',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','cash','amount_tendered',116))$$,
  '42501', 'POS_PERMISSION_DENIED', 'non-authorized role cannot confirm even with permission text'
);
update public.users set role_id = (select id from public.roles where name = 'admin')
where id = 'a5100000-0000-4000-8000-000000000001';

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000004','a5200000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000002');
insert into pos5_state values ('fiscal_before', jsonb_build_object('number', (select current_invoice_number from public.fiscal_settings where id = true)));
create or replace function pg_temp.pos5_fail_confirmation()
returns trigger language plpgsql as $$ begin
  if new.status = 'confirmed' then raise exception 'POS5_FORCED_ROLLBACK'; end if;
  return new;
end $$;
create trigger pos5_forced_rollback before update on public.pos_sale_drafts
for each row execute function pg_temp.pos5_fail_confirmation();
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000004','a5500000-0000-4000-8000-000000000030',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','cash','amount_tendered',100))$$,
  'P0001', 'POS5_FORCED_ROLLBACK', 'late failure rolls back the whole economic transaction'
);
drop trigger pos5_forced_rollback on public.pos_sale_drafts;
select is((select count(*)::integer from public.orders where pos_draft_id = 'a5400000-0000-4000-8000-000000000004'), 0, 'late failure leaves no order, invoice, payment or movement');
select is((select current_invoice_number from public.fiscal_settings where id = true), (select value->>'number' from pos5_state where key = 'fiscal_before'), 'late failure does not consume the fiscal correlativo');

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000006','a5200000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000003');
update public.pos_sale_drafts set shipping_fee=0.10,cod_fee=0.20,additional_charge=0.30,additional_charge_description='Cargo adicional de prueba',other_charge=0.40,other_charge_description='Otro cargo de prueba',grand_total=231 where id='a5400000-0000-4000-8000-000000000006';
insert into pos5_state select 'transfer_charged', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000006','a5500000-0000-4000-8000-000000000060',1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','bank_transfer','verified',true,'reference','POS5-TRANSFER')
);
select is((select value->>'payment_method' from pos5_state where key='transfer_charged'),'bank_transfer','verified transfer confirms with charges');
select is((select amount from public.payments where id=((select value->>'payment_id' from pos5_state where key='transfer_charged')::uuid)),231::numeric,'transfer payment includes all charges');

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000007','a5200000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000003');
update public.pos_sale_drafts set shipping_fee=0.10,cod_fee=0.20,additional_charge=0.30,additional_charge_description='Cargo adicional de prueba',other_charge=0.40,other_charge_description='Otro cargo de prueba',grand_total=231 where id='a5400000-0000-4000-8000-000000000007';
insert into pos5_state select 'card_charged', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000007','a5500000-0000-4000-8000-000000000070',1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','card','verified',true,'reference','POS5-CARD')
);
select is((select value->>'payment_method' from pos5_state where key='card_charged'),'card','verified card confirms with charges');
select is((select amount from public.payments where id=((select value->>'payment_id' from pos5_state where key='card_charged')::uuid)),231::numeric,'card payment includes all charges');

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000008','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
update public.pos_sale_drafts set shipping_fee=0.10,cod_fee=0.20,additional_charge=0.30,additional_charge_description='Cargo adicional de prueba',other_charge=0.40,other_charge_description='Otro cargo de prueba',grand_total=231 where id='a5400000-0000-4000-8000-000000000008';
insert into pos5_state select 'credit_charged', public.confirm_selectable_pos_sale_v1(
  'a5400000-0000-4000-8000-000000000008','a5500000-0000-4000-8000-000000000080',1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','commercial_credit')
);
select is((select value->>'payment_method' from pos5_state where key='credit_charged'),'commercial_credit','commercial credit confirms with charges');
select is((select original_amount from public.accounts_receivable where id=((select value->>'receivable_id' from pos5_state where key='credit_charged')::uuid)),231::numeric,'receivable includes all charges');

-- Overdue commercial-credit guard and one-sale authorization V1.
update public.customer_credit_accounts
set credit_limit = 10000
where customer_id = 'a5200000-0000-4000-8000-000000000002';
insert into public.accounts_receivable(
  id, customer_id, historical_invoice_number, original_amount, balance_due,
  due_date, status
) values (
  'a5800000-0000-4000-8000-000000000001',
  'a5200000-0000-4000-8000-000000000002', 'POS5-OVERDUE', 1600, 1600,
  (now() at time zone 'America/Tegucigalpa')::date - 1, 'open'
);

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000090','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000090','a5500000-0000-4000-8000-000000000090',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit'))$$,
  'PT409', 'POS_CREDIT_OVERDUE', 'legacy selectable confirmation cannot bypass overdue guard'
);
select is((select count(*)::integer from public.orders where pos_draft_id='a5400000-0000-4000-8000-000000000090'),0,'overdue rejection creates no order');
select throws_ok(
  $$select public.confirm_pos_sale_v1('a5400000-0000-4000-8000-000000000090','a5500000-0000-4000-8000-000000000091',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit'))$$,
  'PT409', 'POS_CREDIT_OVERDUE', 'legacy core confirmation cannot bypass overdue guard'
);
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000090','a5500000-0000-4000-8000-000000000092',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Autorizacion local controlada'))$$,
  '42501', 'POS_CREDIT_OVERRIDE_DISABLED', 'override is rejected while feature flag is off'
);
select is((select count(*)::integer from public.orders where pos_draft_id='a5400000-0000-4000-8000-000000000090'),0,'disabled override creates no economic rows');

select is((select enabled from public.set_pos_credit_overdue_override_v1(true,'Habilitacion local transaccional')),true,'authorized role enables local feature flag');
insert into pos5_state
select 'overdue_override_result', public.confirm_pos_sale_with_charge_descriptions_v1(
  'a5400000-0000-4000-8000-000000000090','a5500000-0000-4000-8000-000000000093',1,
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','commercial_credit','overdue_override_reason','Cliente confirma pago el viernes')
);
select is((select value->>'payment_method' from pos5_state where key='overdue_override_result'),'commercial_credit','authorized overdue sale confirms');
select is((select count(*)::integer from public.orders where pos_draft_id='a5400000-0000-4000-8000-000000000090'),1,'authorized overdue sale creates exactly one order');
select is((select count(*)::integer from public.accounts_receivable where order_id=((select value->>'order_id' from pos5_state where key='overdue_override_result')::uuid)),1,'authorized overdue sale creates exactly one receivable');
select is((select count(*)::integer from public.invoices where id=((select value->>'invoice_id' from pos5_state where key='overdue_override_result')::uuid)),1,'authorized overdue sale creates exactly one invoice');
select is((select count(*)::integer from public.payments where order_id=((select value->>'order_id' from pos5_state where key='overdue_override_result')::uuid)),0,'authorized credit sale creates no fictitious payment');
select is((select count(*)::integer from public.audit_logs where table_name='pos_sale_drafts' and record_id='a5400000-0000-4000-8000-000000000090' and action='pos.credit_overdue_override_authorized'),1,'authorization writes exactly one immutable audit event');
select is((select new_data->>'reason' from public.audit_logs where record_id='a5400000-0000-4000-8000-000000000090' and action='pos.credit_overdue_override_authorized'),'Cliente confirma pago el viernes','audit stores the required reason snapshot');
select is((select new_data->>'scope' from public.audit_logs where record_id='a5400000-0000-4000-8000-000000000090' and action='pos.credit_overdue_override_authorized'),'single_sale','audit limits authorization scope to one sale');
select is((select due_date from public.accounts_receivable where order_id=((select value->>'order_id' from pos5_state where key='overdue_override_result')::uuid)),(now() at time zone 'America/Tegucigalpa')::date + 30,'new receivable preserves configured credit terms');
select is((select due_date from public.accounts_receivable where id='a5800000-0000-4000-8000-000000000001'),(now() at time zone 'America/Tegucigalpa')::date - 1,'override does not alter historic due date');

select is(
  (public.confirm_pos_sale_with_charge_descriptions_v1(
    'a5400000-0000-4000-8000-000000000090','a5500000-0000-4000-8000-000000000093',1,
    (now() at time zone 'America/Tegucigalpa')::date,
    jsonb_build_object('method','commercial_credit','overdue_override_reason','Cliente confirma pago el viernes')
  )->>'order_id'),
  (select value->>'order_id' from pos5_state where key='overdue_override_result'),
  'same request and reason replays the original authorized sale'
);
select is((select count(*)::integer from public.audit_logs where record_id='a5400000-0000-4000-8000-000000000090' and action='pos.credit_overdue_override_authorized'),1,'replay does not duplicate authorization audit');
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000090','a5500000-0000-4000-8000-000000000093',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Motivo distinto para la misma llave'))$$,
  'PT409', 'POS_REQUEST_KEY_CONFLICT', 'changed reason conflicts with the same idempotency key'
);
select is((select count(*)::integer from public.pos_credit_overdue_override_context),0,'override transaction context is always removed');

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000094','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.confirm_selectable_pos_sale_v1('a5400000-0000-4000-8000-000000000094','a5500000-0000-4000-8000-000000000094',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit'))$$,
  'PT409', 'POS_CREDIT_OVERDUE', 'authorization does not leak to the next sale'
);

insert into public.roles(name, description, permissions)
select role_name, 'POS overdue override role fixture', jsonb_build_array(
  'pos:access','pos:confirm_sale','customers:read_commercial','customers:read_credit'
)
from unnest(array['technical_owner','business_owner','vendedor','bodega','soporte','cliente']) role_name
on conflict (name) do update set permissions=excluded.permissions;

update public.users set role_id=(select id from public.roles where name='technical_owner') where id='a5100000-0000-4000-8000-000000000001';
select is((select override_allowed from public.get_pos_credit_overdue_override_capability_v1()),true,'technical_owner receives override capability');
select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000095','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
select lives_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000095','a5500000-0000-4000-8000-000000000095',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Autorizacion del propietario tecnico'))$$,
  'technical_owner can authorize one overdue sale'
);

update public.users set role_id=(select id from public.roles where name='business_owner') where id='a5100000-0000-4000-8000-000000000001';
select is((select override_allowed from public.get_pos_credit_overdue_override_capability_v1()),true,'business_owner receives override capability');
select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000096','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
select lives_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000096','a5500000-0000-4000-8000-000000000096',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Autorizacion del propietario comercial'))$$,
  'business_owner can authorize one overdue sale'
);

update public.users set role_id=(select id from public.roles where name='admin') where id='a5100000-0000-4000-8000-000000000001';
select is((select override_allowed from public.get_pos_credit_overdue_override_capability_v1()),true,'admin receives override capability');

update public.customer_credit_accounts
set credit_limit=(select open_balance + 100 from public._get_customer_commercial_credit_state_v2('a5200000-0000-4000-8000-000000000002'))
where customer_id='a5200000-0000-4000-8000-000000000002';
select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000097','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000097','a5500000-0000-4000-8000-000000000097',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','No debe superar el limite comercial'))$$,
  'PT409', 'POS_CREDIT_INSUFFICIENT', 'override never bypasses credit limit'
);
update public.customer_credit_accounts set credit_limit=10000,is_credit_enabled=false where customer_id='a5200000-0000-4000-8000-000000000002';
select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000098','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000098','a5500000-0000-4000-8000-000000000098',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','No debe habilitar una cuenta desactivada'))$$,
  '22023', 'POS_CREDIT_DISABLED', 'override never bypasses disabled credit account'
);
update public.customer_credit_accounts set is_credit_enabled=true where customer_id='a5200000-0000-4000-8000-000000000002';
select is((select count(*)::integer from public.orders where pos_draft_id in ('a5400000-0000-4000-8000-000000000097','a5400000-0000-4000-8000-000000000098')),0,'failed limit and account checks leave no order');

select pg_temp.pos5_single_line_draft('a5400000-0000-4000-8000-000000000099','a5200000-0000-4000-8000-000000000002','a5300000-0000-4000-8000-000000000003');
update public.users set role_id=(select id from public.roles where name='contadora') where id='a5100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000099','a5500000-0000-4000-8000-000000000110',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Rol no autorizado para la excepcion'))$$,
  '42501', 'POS_CREDIT_OVERRIDE_FORBIDDEN', 'contadora cannot authorize overdue credit'
);
update public.users set role_id=(select id from public.roles where name='vendedor') where id='a5100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000099','a5500000-0000-4000-8000-000000000111',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Rol no autorizado para la excepcion'))$$,
  '42501', 'POS_CREDIT_OVERRIDE_FORBIDDEN', 'vendedor cannot authorize overdue credit'
);
update public.users set role_id=(select id from public.roles where name='bodega') where id='a5100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000099','a5500000-0000-4000-8000-000000000112',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Rol no autorizado para la excepcion'))$$,
  '42501', 'POS_CREDIT_OVERRIDE_FORBIDDEN', 'bodega cannot authorize overdue credit'
);
update public.users set role_id=(select id from public.roles where name='soporte') where id='a5100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000099','a5500000-0000-4000-8000-000000000113',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Rol no autorizado para la excepcion'))$$,
  '42501', 'POS_CREDIT_OVERRIDE_FORBIDDEN', 'soporte cannot authorize overdue credit'
);
update public.users set role_id=(select id from public.roles where name='cliente') where id='a5100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.confirm_pos_sale_with_charge_descriptions_v1('a5400000-0000-4000-8000-000000000099','a5500000-0000-4000-8000-000000000114',1,(now() at time zone 'America/Tegucigalpa')::date,jsonb_build_object('method','commercial_credit','overdue_override_reason','Rol no autorizado para la excepcion'))$$,
  '42501', 'POS_CREDIT_OVERRIDE_FORBIDDEN', 'cliente cannot authorize overdue credit'
);
update public.users set role_id=(select id from public.roles where name='admin') where id='a5100000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.orders where pos_draft_id='a5400000-0000-4000-8000-000000000099'),0,'denied roles create no economic rows');
select is((select enabled from public.set_pos_credit_overdue_override_v1(false,'Prueba local de kill switch apagado')),false,'kill switch can turn override off without disabling overdue guard');
select is((select enabled from public.set_pos_credit_overdue_override_v1(true,'Restauracion local del estado habilitado')),true,'kill switch can return override to on');

select * from finish();
rollback;
\echo 'POS Stage 5 atomic confirmation: OK'
