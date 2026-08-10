\set ON_ERROR_STOP on

begin;
set local timezone = 'America/Tegucigalpa';
select no_plan();

select has_table('public', 'purchase_feature_flags', 'purchase feature flags table exists');
select has_column('public', 'purchases', 'payment_condition', 'purchase payment condition snapshot exists');
select has_column('public', 'purchases', 'confirmation_request_key', 'purchase confirmation idempotency key exists');
select has_column('public', 'accounts_payable', 'automation_source', 'payable automation source exists');
select has_function('public', 'confirm_purchase_with_payable_v1', array['uuid','text','date','numeric','text','date','text','uuid'], 'atomic confirmation RPC exists');
select has_function('public', 'cancel_purchase_with_payable_v1', array['uuid','uuid'], 'coordinated cancellation RPC exists');
select ok(to_regclass('public.accounts_payable_active_purchase_v1_uidx') is not null, 'one active payable per purchase is enforced');
select is(public.purchase_ap_automation_enabled_v1(), false, 'feature is installed disabled');
select ok(not has_table_privilege('authenticated', 'public.purchase_feature_flags', 'update'), 'authenticated cannot mutate flag table directly');
select ok(not has_table_privilege('authenticated', 'public.purchases', 'insert'), 'authenticated cannot insert purchases directly');
select ok((select relrowsecurity from pg_class where oid = 'public.accounts_payable'::regclass), 'payables remain protected by RLS for the manual module');

insert into public.roles(name, description, permissions) values
  ('technical_owner', 'Purchase AP automation local owner', '["purchases:manage","payables:manage"]'),
  ('business_owner', 'Purchase AP automation local business owner', '["purchases:manage","payables:manage"]'),
  ('admin', 'Purchase AP automation local admin', '["purchases:manage","payables:manage"]'),
  ('contadora', 'Purchase AP automation local accountant', '["purchases:manage","payables:manage"]'),
  ('bodega', 'Purchase AP automation local warehouse', '[]'),
  ('vendedor', 'Purchase AP automation local seller', '[]'),
  ('soporte', 'Purchase AP automation local support', '[]'),
  ('cliente', 'Purchase AP automation local customer', '[]')
on conflict(name) do update set permissions = excluded.permissions;

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a9010000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-owner@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-vendor@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-business@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-admin@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-accountant@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-warehouse@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-support@example.test', '', now(), '{}', '{}', now(), now()),
  ('a9010000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'purchase-ap-customer@example.test', '', now(), '{}', '{}', now(), now());

insert into public.users(id, role_id, full_name, email, active) values
  ('a9010000-0000-4000-8000-000000000001', (select id from public.roles where name = 'technical_owner'), 'Purchase AP Owner', 'purchase-ap-owner@example.test', true),
  ('a9010000-0000-4000-8000-000000000002', (select id from public.roles where name = 'vendedor'), 'Purchase AP Vendor', 'purchase-ap-vendor@example.test', true),
  ('a9010000-0000-4000-8000-000000000003', (select id from public.roles where name = 'business_owner'), 'Purchase AP Business', 'purchase-ap-business@example.test', true),
  ('a9010000-0000-4000-8000-000000000004', (select id from public.roles where name = 'admin'), 'Purchase AP Admin', 'purchase-ap-admin@example.test', true),
  ('a9010000-0000-4000-8000-000000000005', (select id from public.roles where name = 'contadora'), 'Purchase AP Accountant', 'purchase-ap-accountant@example.test', true),
  ('a9010000-0000-4000-8000-000000000006', (select id from public.roles where name = 'bodega'), 'Purchase AP Warehouse', 'purchase-ap-warehouse@example.test', true),
  ('a9010000-0000-4000-8000-000000000007', (select id from public.roles where name = 'soporte'), 'Purchase AP Support', 'purchase-ap-support@example.test', true),
  ('a9010000-0000-4000-8000-000000000008', (select id from public.roles where name = 'cliente'), 'Purchase AP Customer', 'purchase-ap-customer@example.test', true)
on conflict(id) do update set role_id = excluded.role_id, active = true;

insert into public.suppliers(id, name, is_active, created_by)
values ('a9000000-0000-4000-8000-000000000001', 'PURCHASE AP AUTOMATION LOCAL ONLY', true, 'a9010000-0000-4000-8000-000000000001');

insert into public.purchases(
  id, supplier_id, purchase_number, purchase_date, status, subtotal, tax_amount,
  discount_amount, shipping_amount, total, currency, notes, created_by
) values
  ('a9100000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'APV1-LEGACY', current_date, 'draft', 100, 0, 0, 0, 100, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000001', 'APV1-CREDIT', current_date, 'draft', 1000, 0, 0, 0, 1000, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000003', 'a9000000-0000-4000-8000-000000000001', 'APV1-PARTIAL', current_date, 'draft', 1200, 0, 0, 0, 1200, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000004', 'a9000000-0000-4000-8000-000000000001', 'APV1-CASH', current_date, 'draft', 800, 0, 0, 0, 800, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000006', 'a9000000-0000-4000-8000-000000000001', 'APV1-INVOICE', current_date, 'draft', 600, 0, 0, 0, 600, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000007', 'a9000000-0000-4000-8000-000000000001', 'APV1-DUPLICATE', current_date, 'draft', 700, 0, 0, 0, 700, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000008', 'a9000000-0000-4000-8000-000000000001', 'APV1-DENIED', current_date, 'draft', 500, 0, 0, 0, 500, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001');

insert into public.purchase_items(id, purchase_id, description, quantity, unit_cost, tax_amount, discount_amount, total_cost)
select gen_random_uuid(), purchase.id, 'LOCAL ONLY ITEM', 1, purchase.total, 0, 0, purchase.total
from public.purchases purchase
where purchase.id in (
  'a9100000-0000-4000-8000-000000000001', 'a9100000-0000-4000-8000-000000000002',
  'a9100000-0000-4000-8000-000000000003', 'a9100000-0000-4000-8000-000000000004',
  'a9100000-0000-4000-8000-000000000006', 'a9100000-0000-4000-8000-000000000007',
  'a9100000-0000-4000-8000-000000000008'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000020')$$,
  '42501', 'PURCHASE_CONFIRM_FORBIDDEN', 'service role cannot invent an actor for financial confirmation'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok(
  $$select * from public.confirm_purchase_locked('a9100000-0000-4000-8000-000000000001')$$,
  'legacy confirmation remains available while feature is disabled'
);
select is((select status from public.purchases where id = 'a9100000-0000-4000-8000-000000000001'), 'confirmed', 'legacy path confirms purchase');
select is((select count(*)::integer from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000001'), 0, 'legacy path creates no payable while feature is disabled');
select throws_ok(
  $$select * from public.cancel_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000001','a9600000-0000-4000-8000-000000000010')$$,
  'PT409', 'PURCHASE_NOT_AUTOMATED', 'V1 cancellation does not reinterpret a legacy purchase'
);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000001')$$,
  'PT409', 'PURCHASE_AP_AUTOMATION_DISABLED', 'V1 path is blocked while feature is disabled'
);

select lives_ok(
  $$select * from public.set_purchase_ap_automation_v1(true, 'Local pgTAP activation for controlled validation')$$,
  'technical owner can activate the feature'
);
select is(public.purchase_ap_automation_enabled_v1(), true, 'feature activation is observable');
select throws_ok(
  $$select * from public.confirm_purchase_locked('a9100000-0000-4000-8000-000000000002')$$,
  'PT409', 'PURCHASE_AP_AUTOMATION_REQUIRED', 'legacy confirmation bypass closes while feature is enabled'
);

select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',null,0,null,null,null,'a9400000-0000-4000-8000-000000000002')$$,
  '22023', 'PURCHASE_DUE_DATE_REQUIRED', 'credit requires a due date'
);
select is((select status from public.purchases where id = 'a9100000-0000-4000-8000-000000000002'), 'draft', 'failed credit validation is atomic');
select is((select count(*)::integer from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002'), 0, 'failed credit validation leaves no payable');

select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000003')$$,
  'credit confirmation succeeds atomically'
);
select is((select payment_condition from public.purchases where id = 'a9100000-0000-4000-8000-000000000002'), 'credit', 'credit condition is snapshotted');
select is((select total_amount from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002'), 1000.00::numeric, 'credit payable preserves canonical total');
select is((select balance from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002'), 1000.00::numeric, 'credit payable starts fully pending');
select is((select status from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002'), 'pending', 'credit payable status is pending');
select is((select automation_source from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002'), 'purchase_confirmation_v1', 'automatic payable origin is explicit');
select is((select count(*)::integer from public.supplier_payments payment join public.accounts_payable payable on payable.id = payment.accounts_payable_id where payable.purchase_id = 'a9100000-0000-4000-8000-000000000002'), 0, 'credit creates no payment');

select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000003')$$,
  'same credit request replays safely'
);
select is((select count(*)::integer from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002'), 1, 'replay creates no duplicate payable');
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',current_date + 31,0,null,null,null,'a9400000-0000-4000-8000-000000000003')$$,
  'PT409', 'PURCHASE_CONFIRMATION_FINGERPRINT_CONFLICT', 'same key with changed payload conflicts'
);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000002','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000004')$$,
  'PT409', 'PURCHASE_ALREADY_CONFIRMED', 'different key cannot reconfirm purchase'
);

select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000003','partial',current_date + 30,1200,'bank_transfer',current_date,'Overpayment local','a9400000-0000-4000-8000-000000000021')$$,
  '22023', 'PURCHASE_PARTIAL_AMOUNT_INVALID', 'partial payment cannot equal the canonical total'
);
select is((select status from public.purchases where id = 'a9100000-0000-4000-8000-000000000003'), 'draft', 'rejected overpayment leaves purchase draft');

select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000003','partial',current_date + 30,300,'bank_transfer',current_date,'Anticipo local','a9400000-0000-4000-8000-000000000005')$$,
  'partial confirmation succeeds atomically'
);
select is((select paid_amount from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000003'), 300.00::numeric, 'partial payment is applied');
select is((select balance from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000003'), 900.00::numeric, 'partial balance is exact');
select is((select status from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000003'), 'partial', 'partial payable status is exact');
select is((select count(*)::integer from public.supplier_payments payment join public.accounts_payable payable on payable.id = payment.accounts_payable_id where payable.purchase_id = 'a9100000-0000-4000-8000-000000000003' and payment.status = 'paid'), 1, 'partial confirmation creates one canonical payment');
select is((select count(*)::integer from public.supplier_payment_allocations_v1 allocation join public.accounts_payable payable on payable.id = allocation.accounts_payable_id where payable.purchase_id = 'a9100000-0000-4000-8000-000000000003' and allocation.application_status = 'applied'), 1, 'partial payment is visible through the canonical allocation surface');
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000003','partial',current_date + 30,300,'bank_transfer',current_date,'Anticipo local','a9400000-0000-4000-8000-000000000005')$$,
  'partial retry is idempotent'
);
select is((select count(*)::integer from public.supplier_payments payment join public.accounts_payable payable on payable.id = payment.accounts_payable_id where payable.purchase_id = 'a9100000-0000-4000-8000-000000000003'), 1, 'partial retry creates no duplicate payment');

select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000004','cash',null,1,'cash',current_date,'Pago total local','a9400000-0000-4000-8000-000000000006')$$,
  'cash confirmation succeeds and ignores client amount'
);
select is((select paid_amount from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000004'), 800.00::numeric, 'cash payment uses server-side purchase total');
select is((select balance from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000004'), 0.00::numeric, 'cash balance is zero');
select is((select status from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000004'), 'paid', 'cash payable is paid');

insert into public.supplier_invoices(
  id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, status,
  subtotal, tax_amount, discount_amount, total, currency, notes, created_by
) values (
  'a9500000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001',
  'a9100000-0000-4000-8000-000000000006', 'APV1-INV-LOCAL', current_date, current_date + 45,
  'received', 600, 0, 0, 600, 'HNL', 'LOCAL ONLY', 'a9010000-0000-4000-8000-000000000001'
);
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000006','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000007')$$,
  'linked supplier invoice confirmation succeeds'
);
select is((select due_date from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000006'), current_date + 45, 'supplier invoice due date has precedence');
select is((select supplier_invoice_id from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000006'), 'a9500000-0000-4000-8000-000000000001'::uuid, 'payable links the active supplier invoice');
select throws_ok(
  $$select * from public.cancel_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000006','a9600000-0000-4000-8000-000000000001')$$,
  'PT409', 'PURCHASE_ACTIVE_SUPPLIER_INVOICE_BLOCKS_CANCEL', 'active supplier invoice blocks coordinated cancellation'
);

select throws_ok(
  $$insert into public.accounts_payable(supplier_id, purchase_id, total_amount, paid_amount, due_date, status, currency, notes, created_by)
    values ('a9000000-0000-4000-8000-000000000001','a9100000-0000-4000-8000-000000000002',1000,0,current_date + 30,'pending','HNL','DUPLICATE LOCAL ONLY','a9010000-0000-4000-8000-000000000001')$$,
  '23505', null, 'database unique guard rejects a second active payable'
);
select lives_ok(
  $$insert into public.accounts_payable(supplier_id, purchase_id, total_amount, paid_amount, due_date, status, currency, notes, created_by)
    values ('a9000000-0000-4000-8000-000000000001',null,50,0,current_date + 15,'pending','HNL','MANUAL LOCAL ONLY','a9010000-0000-4000-8000-000000000001')$$,
  'manual payable without purchase remains supported'
);

select is((select count(*)::integer from public.financial_events where source_type = 'accounts_payable' and source_id = (select id::text from public.accounts_payable where purchase_id = 'a9100000-0000-4000-8000-000000000002') and event_purpose = 'accounts_payable_created'), 1, 'payable accounting intent exists exactly once');
select is((select count(*)::integer from public.financial_events where source_type = 'purchase' and source_id = 'a9100000-0000-4000-8000-000000000002' and event_purpose = 'purchase_confirmed'), 1, 'purchase operational intent exists exactly once');
select is((select count(*)::integer from public.journal_entries), 0, 'confirmation does not publish journals automatically');

insert into public.products(id, category_id, sku, slug, name, brand, stock, reserved_stock, retail_price, wholesale_price, cost_price)
values (
  'a9300000-0000-4000-8000-000000000001', (select id from public.categories order by created_at limit 1),
  'APV1-CANCEL-LOCAL', 'apv1-cancel-local', 'APV1 CANCELLATION LOCAL ONLY', 'Fixture', 10, 0, 200, 180, 100
);
create temp table _apv1_saved_purchase as
select * from public.save_purchase_with_inventory(
  null,
  jsonb_build_object(
    'supplier_id', 'a9000000-0000-4000-8000-000000000001',
    'purchase_number', 'APV1-CANCEL', 'purchase_date', current_date,
    'shipping_amount', 0, 'currency', 'HNL', 'notes', 'LOCAL ONLY'
  ),
  jsonb_build_array(jsonb_build_object(
    'product_id', 'a9300000-0000-4000-8000-000000000001',
    'description', 'APV1 CANCELLATION LOCAL ONLY', 'quantity', 2,
    'unit_cost', 100, 'tax_amount', 0, 'discount_amount', 0
  ))
);
select is((select stock from public.products where id = 'a9300000-0000-4000-8000-000000000001'), 12, 'draft purchase inventory movement is preserved');
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1((select purchase_id from _apv1_saved_purchase),'credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000008')$$,
  'inventory-backed purchase confirms with payable'
);
select is((select stock from public.products where id = 'a9300000-0000-4000-8000-000000000001'), 12, 'confirmation does not duplicate inventory');
select lives_ok(
  $$select * from public.cancel_purchase_with_payable_v1((select purchase_id from _apv1_saved_purchase),'a9600000-0000-4000-8000-000000000002')$$,
  'unpaid automated payable and purchase cancel together'
);
select is((select stock from public.products where id = 'a9300000-0000-4000-8000-000000000001'), 10, 'coordinated cancellation reverses inventory exactly once');
select is((select status from public.accounts_payable where purchase_id = (select purchase_id from _apv1_saved_purchase)), 'cancelled', 'coordinated cancellation cancels payable');
select lives_ok(
  $$select * from public.cancel_purchase_with_payable_v1((select purchase_id from _apv1_saved_purchase),'a9600000-0000-4000-8000-000000000002')$$,
  'cancellation retry is idempotent'
);
select is((select stock from public.products where id = 'a9300000-0000-4000-8000-000000000001'), 10, 'cancellation replay does not reverse inventory twice');
select throws_ok(
  $$select * from public.cancel_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000003','a9600000-0000-4000-8000-000000000003')$$,
  'PT409', 'PURCHASE_PAYMENTS_MUST_BE_VOIDED_FIRST', 'paid partial obligation blocks cancellation'
);
select throws_ok(
  $$select * from public.cancel_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000004','a9600000-0000-4000-8000-000000000004')$$,
  'PT409', 'PURCHASE_PAYMENTS_MUST_BE_VOIDED_FIRST', 'paid cash obligation blocks cancellation'
);

insert into public.purchases(
  id, supplier_id, purchase_number, purchase_date, status, subtotal, tax_amount,
  discount_amount, shipping_amount, total, currency, notes, created_by
) select
  ('a9100000-0000-4000-8000-' || lpad(sequence::text, 12, '0'))::uuid,
  'a9000000-0000-4000-8000-000000000001',
  'APV1-ROLE-' || sequence,
  current_date, 'draft', 100, 0, 0, 0, 100, 'HNL', 'LOCAL ONLY',
  'a9010000-0000-4000-8000-000000000001'
from generate_series(10, 16) sequence;
insert into public.purchase_items(id, purchase_id, description, quantity, unit_cost, tax_amount, discount_amount, total_cost)
select gen_random_uuid(), purchase.id, 'ROLE LOCAL ONLY', 1, 100, 0, 0, 100
from public.purchases purchase where purchase.purchase_number like 'APV1-ROLE-%';

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000010','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000010')$$,
  'business owner can confirm credit purchase with payable'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000011','partial',current_date + 30,25,'cash',current_date,'Admin local','a9400000-0000-4000-8000-000000000011')$$,
  'admin can confirm partial purchase and derived payment'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000005","role":"authenticated"}', true);
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000012','cash',null,0,'cash',current_date,'Accountant local','a9400000-0000-4000-8000-000000000012')$$,
  'accountant can confirm cash purchase and derived full payment'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000006', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000006","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000013','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000013')$$,
  '42501', 'PURCHASE_CONFIRM_FORBIDDEN', 'warehouse role is denied'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000007', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000007","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000014','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000014')$$,
  '42501', 'PURCHASE_CONFIRM_FORBIDDEN', 'support role is denied'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000008', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000008","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000015','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000015')$$,
  '42501', 'PURCHASE_CONFIRM_FORBIDDEN', 'customer role is denied'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1('a9100000-0000-4000-8000-000000000016','credit',current_date + 30,0,null,null,null,'a9400000-0000-4000-8000-000000000016')$$,
  '42501', 'PURCHASE_CONFIRM_FORBIDDEN', 'seller role cannot confirm purchase with payable'
);
select throws_ok(
  $$select * from public.set_purchase_ap_automation_v1(false, 'Restricted local actor must not change feature')$$,
  '42501', 'PURCHASE_AP_FLAG_FORBIDDEN', 'restricted role cannot change feature flag'
);

select set_config('request.jwt.claim.sub', 'a9010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"a9010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$select * from public.set_purchase_ap_automation_v1(false, 'Local pgTAP deactivation after controlled validation')$$,
  'technical owner can deactivate feature'
);
select is(public.purchase_ap_automation_enabled_v1(), false, 'feature returns to disabled state');

select * from finish();
rollback;
