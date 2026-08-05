\set ON_ERROR_STOP on

begin;

select plan(20);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'ca100000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'sale-cod-fee@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    full_name = 'SALE-COD-FEE-LOCAL-ONLY',
    email = 'sale-cod-fee@example.test',
    active = true
where id = 'ca100000-0000-4000-8000-000000000001';

insert into public.company_settings (id)
values ('ca100000-0000-4000-8000-000000000002');

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, created_by
) values
  ('ca200000-0000-4000-8000-000000000001', '1101001', 'CAJA GENERAL', 'asset', 'debit', 'ca100000-0000-4000-8000-000000000001'),
  ('ca200000-0000-4000-8000-000000000002', '1103001', 'INVENTARIO GENERAL', 'asset', 'debit', 'ca100000-0000-4000-8000-000000000001'),
  ('ca200000-0000-4000-8000-000000000003', '2101002', 'IMPUESTO 15%', 'liability', 'credit', 'ca100000-0000-4000-8000-000000000001'),
  ('ca200000-0000-4000-8000-000000000004', '4101001', 'VENTAS', 'revenue', 'credit', 'ca100000-0000-4000-8000-000000000001'),
  ('ca200000-0000-4000-8000-000000000005', '4101002', 'VENTAS POR CONTRAENTREGA', 'revenue', 'credit', 'ca100000-0000-4000-8000-000000000001'),
  ('ca200000-0000-4000-8000-000000000006', '5101001', 'COSTO DE VENTAS', 'cost', 'debit', 'ca100000-0000-4000-8000-000000000001');

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active, effective_from, created_by
) values
  ('payment_method', 'cash', 'ca200000-0000-4000-8000-000000000001', 1, true, date '2026-01-01', 'ca100000-0000-4000-8000-000000000001'),
  ('inventory', 'inventory_asset', 'ca200000-0000-4000-8000-000000000002', 1, true, date '2026-01-01', 'ca100000-0000-4000-8000-000000000001'),
  ('tax', 'tax_payable', 'ca200000-0000-4000-8000-000000000003', 1, true, date '2026-01-01', 'ca100000-0000-4000-8000-000000000001'),
  ('revenue', 'sales_revenue', 'ca200000-0000-4000-8000-000000000004', 1, true, date '2026-01-01', 'ca100000-0000-4000-8000-000000000001'),
  ('inventory', 'cost_of_goods_sold', 'ca200000-0000-4000-8000-000000000006', 1, true, date '2026-01-01', 'ca100000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.configure_sale_cod_fee_mapping_v1(),
  public.configure_sale_cod_fee_mapping_v1(),
  'COD mapping configuration is idempotent'
);

select ok(
  exists (
    select 1
    from public.accounting_mappings mapping
    join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'revenue'
      and mapping.source_key = 'sale_cod_fee'
      and mapping.is_active
      and mapping.effective_from = date '2026-07-16'
      and account.code = '4101002'
      and account.name = 'VENTAS POR CONTRAENTREGA'
  ),
  'COD mapping resolves to active account 4101002'
);

select is(
  (select count(*) from public.accounting_mapping_authorization_audit)::bigint,
  1::bigint,
  'mapping authorization audit is append-only and emitted once'
);

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = (
      ((now() at time zone 'America/Tegucigalpa')::date::timestamp)
      at time zone 'America/Tegucigalpa'
    ) - interval '1 second',
    updated_by = 'ca100000-0000-4000-8000-000000000001'
where key in ('sales_draft_v2', 'cogs_draft_v2');

insert into public.products (
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, retail_price, wholesale_price, cost_price, status, active
) values (
  'ca300000-0000-4000-8000-000000000001',
  (select id from public.categories order by created_at limit 1),
  'SALE-COD-FEE-LOCAL-ONLY', 'COD-LOCAL', 'sale-cod-fee-local-only',
  'SALE-COD-FEE-LOCAL-ONLY', 'Fixture', 'Fixture local COD',
  3, 1000, 1000, 575, 'active', true
);

insert into public.orders (
  id, order_number, user_id, customer_name, phone, delivery_address,
  payment_method, payment_timing, price_mode, subtotal, tax,
  shipping_total, cash_on_delivery_fee, total, status,
  requested_invoice_date, source, channel
) values (
  'ca400000-0000-4000-8000-000000000001',
  'SALE-COD-FEE-LOCAL-ONLY',
  'ca100000-0000-4000-8000-000000000001',
  'Fixture COD', '99999999', 'Direccion fixture',
  'cash', 'on_delivery', 'retail', 2608.70, 391.30,
  0, 2.00, 3002.00, 'entregado', date '2026-07-16',
  'web', 'website'
);

insert into public.order_items (
  id, order_id, product_id, sku, product_name, quantity,
  applied_price_mode, unit_price, line_total,
  retail_price_snapshot, wholesale_price_snapshot,
  unit_cost_snapshot, total_cost_snapshot
) values (
  'ca500000-0000-4000-8000-000000000001',
  'ca400000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  'SALE-COD-FEE-LOCAL-ONLY', 'SALE-COD-FEE-LOCAL-ONLY', 3,
  'retail', 1000, 3000, 1000, 1000, 575, 1725
);

insert into public.payments (
  id, order_id, method, status, amount, payment_method, payment_status
) values (
  'ca600000-0000-4000-8000-000000000001',
  'ca400000-0000-4000-8000-000000000001',
  'cash', 'pending', 3002, 'cash', 'pending'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"ca100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

update public.payments
set status = 'approved', payment_status = 'approved', paid_at = now(),
    confirmed_by = 'ca100000-0000-4000-8000-000000000001'
where id = 'ca600000-0000-4000-8000-000000000001';

select is(
  (
    select count(*) from public.accounting_outbox_v2
    where source_type = 'order'
      and source_id = 'ca400000-0000-4000-8000-000000000001'
      and event_purpose = 'sale_recognized'
  )::bigint,
  1::bigint,
  'COD sale routes to exactly one V2 outbox'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.process_accounting_outbox_v2(
    (select id from public.accounting_outbox_v2 where source_type = 'order' and source_id = 'ca400000-0000-4000-8000-000000000001'),
    'sale-cod-fee-local-worker', false
  )->>'outbox_status',
  'completed',
  'COD sale V2 outbox creates a draft'
);

select is(
  (
    select count(*) from public.journal_entries entry
    join public.financial_events event on event.journal_entry_id = entry.id
    where event.source_type = 'order'
      and event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and event.posting_version = 'v2'
  )::bigint,
  1::bigint,
  'COD sale creates exactly one journal draft'
);

select is(
  (
    select entry.entry_date from public.journal_entries entry
    join public.financial_events event on event.journal_entry_id = entry.id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and event.posting_version = 'v2'
  ),
  date '2026-07-16',
  'COD draft preserves the retroactive fiscal date'
);

select is(
  (
    select count(*) from public.journal_entry_lines line
    join public.journal_entries entry on entry.id = line.journal_entry_id
    join public.financial_events event on event.journal_entry_id = entry.id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
  )::bigint,
  4::bigint,
  'COD draft has cash, merchandise, tax, and COD lines only'
);

select ok(
  exists (
    select 1 from public.journal_entry_lines line
    join public.accounting_accounts account on account.id = line.account_id
    join public.financial_events event on event.journal_entry_id = line.journal_entry_id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and account.code = '1101001' and line.debit = 3002 and line.credit = 0
  ),
  'cash line debits CAJA GENERAL for L 3,002.00'
);

select ok(
  exists (
    select 1 from public.journal_entry_lines line
    join public.accounting_accounts account on account.id = line.account_id
    join public.financial_events event on event.journal_entry_id = line.journal_entry_id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and account.code = '4101001' and line.credit = 2608.70 and line.debit = 0
  ),
  'merchandise credits VENTAS for L 2,608.70'
);

select ok(
  exists (
    select 1 from public.journal_entry_lines line
    join public.accounting_accounts account on account.id = line.account_id
    join public.financial_events event on event.journal_entry_id = line.journal_entry_id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and account.code = '2101002' and line.credit = 391.30 and line.debit = 0
  ),
  'tax credits IMPUESTO 15% for L 391.30'
);

select ok(
  exists (
    select 1 from public.journal_entry_lines line
    join public.accounting_accounts account on account.id = line.account_id
    join public.financial_events event on event.journal_entry_id = line.journal_entry_id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and account.code = '4101002' and line.credit = 2 and line.debit = 0
  ),
  'non-taxable COD charge credits account 4101002 for L 2.00'
);

select ok(
  exists (
    select 1 from public.journal_entries entry
    join public.financial_events event on event.journal_entry_id = entry.id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and entry.status = 'borrador'
      and (select sum(debit) from public.journal_entry_lines where journal_entry_id = entry.id) = 3002
      and (select sum(credit) from public.journal_entry_lines where journal_entry_id = entry.id) = 3002
  ),
  'COD draft is balanced and remains unpublished'
);

do $retries$
declare
  target_box uuid;
  attempt integer;
begin
  select id into strict target_box from public.accounting_outbox_v2
  where source_type = 'order' and source_id = 'ca400000-0000-4000-8000-000000000001';
  for attempt in 1..5 loop
    perform public.process_accounting_outbox_v2(target_box, 'sale-cod-fee-replay-' || attempt, true);
  end loop;
end;
$retries$;

select is(
  (
    select count(*) from public.journal_entries entry
    join public.financial_events event on event.journal_entry_id = entry.id
    where event.source_id = 'ca400000-0000-4000-8000-000000000001'
      and event.posting_version = 'v2'
  )::bigint,
  1::bigint,
  'five retries return the existing COD draft without duplication'
);

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version,
  status, occurred_at, accounting_date, source_snapshot, validation_errors
) values (
  'ca700000-0000-4000-8000-000000000001', 'order',
  'ca400000-0000-4000-8000-000000000001', 'sale_revenue', 'v1',
  'ready', now(), date '2026-07-16', '{}'::jsonb, '[]'::jsonb
);

select ok(
  exists (
    select 1 from public.financial_events
    where id = 'ca700000-0000-4000-8000-000000000001'
      and status = 'skipped' and journal_entry_id is null
      and validation_errors @> '["SUPERSEDED_BY_CANONICAL_V2_EVENT"]'::jsonb
  ),
  'V1 scanner event is converted to a skipped control when V2 exists'
);

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version,
  status, occurred_at, accounting_date, source_snapshot, validation_errors
) select
  'ca700000-0000-4000-8000-000000000002', 'inventory_movement', movement.id::text,
  'inventory_cogs', 'v1', 'ready', now(), date '2026-07-16', '{}'::jsonb, '[]'::jsonb
from public.inventory_movements movement
where movement.reference_type = 'orders'
  and movement.reference_id = 'ca400000-0000-4000-8000-000000000001'
limit 1;

select ok(
  exists (
    select 1 from public.financial_events
    where id = 'ca700000-0000-4000-8000-000000000002'
      and status = 'skipped' and journal_entry_id is null
      and validation_errors @> '["SUPERSEDED_BY_CANONICAL_V2_EVENT"]'::jsonb
  ),
  'V1 COGS scanner event is skipped when the V2 COGS chain exists'
);

select throws_ok(
  $$insert into public.journal_entries (
      entry_number, entry_date, description, status, source_type, source_id, created_by
    ) values (
      'SALE-COD-FEE-V1-DUPLICATE', date '2026-07-16', 'blocked', 'borrador',
      'financial_event', 'ca700000-0000-4000-8000-000000000001',
      'ca100000-0000-4000-8000-000000000001'
    )$$,
  '23514',
  'LEGACY_V1_JOURNAL_BLOCKED_BY_CANONICAL_V2_EVENT',
  'database guard rejects a V1 journal covered by V2'
);

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version,
  status, occurred_at, accounting_date, source_snapshot, validation_errors
) values (
  'ca700000-0000-4000-8000-000000000003', 'order',
  'ca400000-0000-4000-8000-000000000099', 'sale_revenue', 'v1',
  'ready', timestamp with time zone '2026-07-01 12:00:00+00',
  date '2026-07-01', '{}'::jsonb, '[]'::jsonb
);

select is(
  (select status from public.financial_events where id = 'ca700000-0000-4000-8000-000000000003'),
  'ready',
  'a legitimate V1-only historical fact is not blocked'
);

select throws_ok(
  $$update public.accounting_mapping_authorization_audit set approved_by = 'changed'$$,
  '55000',
  'ACCOUNTING_MAPPING_AUTHORIZATION_AUDIT_IMMUTABLE',
  'mapping approval audit cannot be modified'
);

select is(
  (select count(*) from public.accounting_outbox)::bigint,
  0::bigint,
  'no V1 outbox is created for sale or COGS'
);

select * from finish();
rollback;
