\set ON_ERROR_STOP on

begin;

select plan(1);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '81000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'accounting-v2@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set
  role_id = (select id from public.roles where name = 'technical_owner'),
  full_name = 'Accounting V2 contract',
  email = 'accounting-v2@example.test',
  active = true
where id = '81000000-0000-4000-8000-000000000001';

select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.company_settings (id)
values ('81000000-0000-4000-8000-000000000002');

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, created_by
) values
  ('82000000-0000-4000-8000-000000000001', 'V2-1101', 'Caja V2', 'asset', 'debit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000002', 'V2-1102', 'Banco V2', 'asset', 'debit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000003', 'V2-1103', 'Inventario V2', 'asset', 'debit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000004', 'V2-1201', 'Clientes V2', 'asset', 'debit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000005', 'V2-2101', 'Proveedores V2', 'liability', 'credit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000006', 'V2-2102', 'ISV V2', 'liability', 'credit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000007', 'V2-4101', 'Ventas V2', 'revenue', 'credit', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000008', 'V2-5101', 'Costo V2', 'cost', 'debit', '81000000-0000-4000-8000-000000000001');

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active, created_by
) values
  ('payment_method', 'cash', '82000000-0000-4000-8000-000000000001', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('payment_method', 'bank_transfer', '82000000-0000-4000-8000-000000000002', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('receivable', 'accounts_receivable', '82000000-0000-4000-8000-000000000004', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('default_account', 'accounts_payable', '82000000-0000-4000-8000-000000000005', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_cash', '82000000-0000-4000-8000-000000000001', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_bank', '82000000-0000-4000-8000-000000000002', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_card', '82000000-0000-4000-8000-000000000005', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('revenue', 'sales_revenue', '82000000-0000-4000-8000-000000000007', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('tax', 'tax_payable', '82000000-0000-4000-8000-000000000006', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('inventory', 'inventory_asset', '82000000-0000-4000-8000-000000000003', 1, true, '81000000-0000-4000-8000-000000000001'),
  ('inventory', 'cost_of_goods_sold', '82000000-0000-4000-8000-000000000008', 1, true, '81000000-0000-4000-8000-000000000001');

-- Disabled does not enqueue, shadow records only an observation, and enabled
-- creates one real outbox despite replaying the same fact.
select public.route_accounting_fact_v2(
  'sales_draft_v2', 'sales.recognized', 'order',
  '83000000-0000-4000-8000-000000000001', 'sale_recognized',
  'disabled_contract', now(), '81000000-0000-4000-8000-000000000001'
);

do $$
begin
  if exists (
    select 1 from public.accounting_outbox_v2
    where source_id = '83000000-0000-4000-8000-000000000001'
  ) then raise exception 'Disabled created a real outbox.'; end if;
end;
$$;

update public.accounting_feature_flags
set state = 'shadow',
    cutover_at = now() - interval '1 minute',
    updated_by = '81000000-0000-4000-8000-000000000001'
where key = 'sales_draft_v2';

select public.route_accounting_fact_v2(
  'sales_draft_v2', 'sales.recognized', 'order',
  '83000000-0000-4000-8000-000000000001', 'sale_recognized',
  'shadow_contract', now(), '81000000-0000-4000-8000-000000000001'
);

do $$
begin
  if (select count(*) from public.accounting_shadow_observations) <> 1
    or exists (
      select 1 from public.accounting_outbox_v2
      where source_id = '83000000-0000-4000-8000-000000000001'
    )
    or (select validation_status from public.accounting_shadow_observations limit 1) <> 'pending_data'
    or (select validation_code from public.accounting_shadow_observations limit 1) <> 'sale_source_missing'
  then raise exception 'Shadow created an economic row or did not validate the source.'; end if;
end;
$$;

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = (
      (now() at time zone 'America/Tegucigalpa')::date::timestamp
      at time zone 'America/Tegucigalpa'
    ) - interval '1 second',
    updated_by = '81000000-0000-4000-8000-000000000001'
where key in ('sales_draft_v2', 'cogs_draft_v2', 'supplier_payment_draft_v2');

insert into public.products (
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, retail_price, wholesale_price, cost_price, status, active
) values (
  '84000000-0000-4000-8000-000000000001',
  (select id from public.categories order by created_at limit 1),
  'V2-TEST-SKU', 'V2-TEST-OEM', 'v2-product-contract',
  'Producto V2', 'Marca V2', 'Fixture transaccional V2',
  10, 1000, 900, 400, 'active', true
);

insert into public.orders (
  id, order_number, user_id, customer_name, phone, delivery_address,
  payment_method, price_mode, subtotal, tax, shipping_total, total, status
) values (
  '83000000-0000-4000-8000-000000000002',
  'V2-ORDER-001',
  '81000000-0000-4000-8000-000000000001',
  'Cliente fixture V2', '99999999', 'Direccion fixture',
  'bank_transfer', 'retail', 869.57, 130.43, 0, 1000, 'recibido'
);

insert into public.order_items (
  id, order_id, product_id, sku, product_name, quantity,
  applied_price_mode, unit_price, line_total,
  retail_price_snapshot, wholesale_price_snapshot
) values (
  '85000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000001',
  'V2-TEST-SKU', 'Producto V2', 1, 'retail', 1000, 1000, 1000, 900
);

insert into public.payments (
  id, order_id, method, status, amount, reference,
  payment_method, payment_status, bank_reference_number
) values (
  '86000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000002',
  'bank_transfer', 'pending', 1000, 'V2-REF',
  'bank_transfer', 'pending', 'V2-REF'
);

update public.payments
set status = 'approved',
    payment_status = 'approved',
    paid_at = now(),
    confirmed_by = '81000000-0000-4000-8000-000000000001'
where id = '86000000-0000-4000-8000-000000000001';

do $$
begin
  if (select count(*) from public.accounting_outbox_v2 where source_type = 'order' and event_purpose = 'sale_recognized') <> 1 then
    raise exception 'Approved transfer did not create exactly one sale outbox.';
  end if;
  if (select count(*) from public.accounting_outbox_v2 where source_type = 'inventory_movement' and event_purpose = 'inventory_cogs') <> 1 then
    raise exception 'Physical movement did not create exactly one COGS outbox.';
  end if;
end;
$$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  box_id uuid;
  result jsonb;
begin
  for box_id in
    select id from public.accounting_outbox_v2
    where source_type in ('order', 'inventory_movement')
    order by created_at
  loop
    result := public.process_accounting_outbox_v2(box_id, 'sql-contract-worker', false);
    if result->>'outbox_status' <> 'completed' then
      raise exception 'Sale/COGS worker did not complete: %', result;
    end if;
  end loop;
end;
$$;

do $$
begin
  if (select count(*) from public.financial_events where posting_version = 'v2' and journal_entry_id is not null) <> 2 then
    raise exception 'Sale and COGS did not create exactly two independent events/drafts.';
  end if;
  if exists (
    select 1 from public.journal_entries
    where source_type = 'financial_event' and status <> 'borrador'
  ) then raise exception 'A V2 worker published a journal entry.'; end if;
end;
$$;

-- Cancellation after publication keeps the original immutable and produces a
-- separate compensating draft. The related unpublished COGS draft is annulled.
update public.journal_entries entry
set status = 'publicada',
    posted_by = '81000000-0000-4000-8000-000000000001',
    posted_at = now()
from public.financial_events event
where event.journal_entry_id = entry.id
  and event.source_type = 'order'
  and event.event_purpose = 'sale_recognized';

update public.financial_events
set status = 'posted'
where source_type = 'order'
  and event_purpose = 'sale_recognized'
  and posting_version = 'v2';

update public.orders
set status = 'cancelado'
where id = '83000000-0000-4000-8000-000000000002';

do $$
declare
  compensation_box uuid;
  result jsonb;
begin
  select id into strict compensation_box
  from public.accounting_outbox_v2
  where source_type = 'order'
    and source_id = '83000000-0000-4000-8000-000000000002'
    and event_purpose = 'sale_compensation';

  result := public.process_accounting_outbox_v2(
    compensation_box, 'sql-contract-worker', false
  );
  if result->>'outbox_status' <> 'completed'
    or result->>'draft_status' <> 'borrador'
  then raise exception 'Published sale did not create a compensating draft: %', result; end if;

  if not exists (
    select 1
    from public.financial_events event
    join public.journal_entries entry on entry.id = event.journal_entry_id
    where event.source_type = 'order'
      and event.event_purpose = 'sale_recognized'
      and entry.status = 'publicada'
  ) then raise exception 'The published original was modified during cancellation.'; end if;

  if not exists (
    select 1
    from public.accounting_outbox_v2 box
    join public.journal_entries entry on entry.id = box.journal_entry_id
    where box.source_type = 'inventory_movement'
      and box.event_purpose = 'inventory_cogs'
      and box.status = 'cancelled'
      and entry.status = 'anulada'
  ) then raise exception 'The unpublished COGS draft was not annulled.'; end if;
end;
$$;

-- A movement with a zero historical snapshot is held in pending_data and
-- never substitutes the product's current cost.
insert into public.inventory_movements (
  id, product_id, user_id, movement_type, quantity, stock_before, stock_after,
  reference_type, reference_id, notes, unit_cost_snapshot,
  total_cost_snapshot, cost_source, cost_captured_at
) values (
  '87000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'sale', -1, 9, 8, 'orders',
  '83000000-0000-4000-8000-000000000002',
  'Zero cost contract', 0, 0, 'explicit_test_snapshot', now()
);

do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id
  from public.accounting_outbox_v2
  where source_id = '87000000-0000-4000-8000-000000000001';
  result := public.process_accounting_outbox_v2(box_id, 'sql-contract-worker', false);
  if result->>'outbox_status' <> 'pending_data'
    or result->>'reason' <> 'historical_cost_missing'
  then raise exception 'Zero historical cost was not held safely: %', result; end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.suppliers (id, name, is_active, created_by)
values (
  '88000000-0000-4000-8000-000000000001',
  'Proveedor fixture V2',
  true,
  '81000000-0000-4000-8000-000000000001'
);

insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency, created_by
) values (
  '89000000-0000-4000-8000-000000000001',
  '88000000-0000-4000-8000-000000000001',
  1000, 0, 'pending', 'HNL',
  '81000000-0000-4000-8000-000000000001'
);

do $$
declare
  first_result record;
  replay_result record;
begin
  select * into strict first_result
  from public.register_supplier_payment_v2(
    '89000000-0000-4000-8000-000000000001',
    400, 'cash',
    (now() at time zone 'America/Tegucigalpa')::date,
    'Fixture de pago',
    '89000000-0000-4000-8000-000000000002'
  );
  select * into strict replay_result
  from public.register_supplier_payment_v2(
    '89000000-0000-4000-8000-000000000001',
    400, 'cash',
    (now() at time zone 'America/Tegucigalpa')::date,
    'Fixture de pago',
    '89000000-0000-4000-8000-000000000002'
  );
  if first_result.payment_id <> replay_result.payment_id
    or replay_result.idempotent_replay is not true
    or (select count(*) from public.supplier_payments) <> 1
  then raise exception 'Supplier payment replay duplicated the payment.'; end if;

  begin
    perform public.register_supplier_payment_v2(
      '89000000-0000-4000-8000-000000000001',
      401, 'cash',
      (now() at time zone 'America/Tegucigalpa')::date,
      'Payload diferente',
      '89000000-0000-4000-8000-000000000002'
    );
    raise exception 'Different payload reused an idempotency key.';
  exception when unique_violation then null;
  end;
end;
$$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id
  from public.accounting_outbox_v2
  where source_type = 'supplier_payment'
    and event_purpose = 'supplier_payment';
  result := public.process_accounting_outbox_v2(box_id, 'sql-contract-worker', false);
  if result->>'outbox_status' <> 'completed'
    or result->>'draft_status' <> 'borrador'
  then raise exception 'Supplier worker did not create one draft: %', result; end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

do $$
declare
  payment_id uuid;
  result record;
begin
  select id into strict payment_id from public.supplier_payments;
  select * into strict result
  from public.void_supplier_payment_v2(
    payment_id,
    'Anulacion de contrato V2',
    '89000000-0000-4000-8000-000000000003'
  );
  if result.idempotent_replay then
    raise exception 'First void was reported as replay.';
  end if;
  if not exists (
    select 1
    from public.accounting_outbox_v2 box
    join public.journal_entries entry on entry.id = box.journal_entry_id
    where box.source_id = payment_id
      and box.status = 'cancelled'
      and entry.status = 'anulada'
  ) then raise exception 'Void did not annul the unpublished draft.'; end if;

  select * into strict result
  from public.void_supplier_payment_v2(
    payment_id,
    'Anulacion de contrato V2',
    '89000000-0000-4000-8000-000000000003'
  );
  if result.idempotent_replay is not true or result.paid_amount <> 0 then
    raise exception 'Repeated void was not idempotent.';
  end if;
end;
$$;

-- A published supplier-payment entry is never edited. Voiding the payment
-- creates a separate compensating draft whose publication remains manual.
do $$
declare result record;
begin
  select * into strict result
  from public.register_supplier_payment_v2(
    '89000000-0000-4000-8000-000000000001',
    300, 'bank_transfer',
    (now() at time zone 'America/Tegucigalpa')::date,
    'Fixture publicado',
    '89000000-0000-4000-8000-000000000004'
  );
end;
$$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id
  from public.accounting_outbox_v2
  where source_type = 'supplier_payment'
    and status = 'queued'
  order by created_at desc
  limit 1;
  result := public.process_accounting_outbox_v2(box_id, 'sql-contract-worker', false);
  if result->>'outbox_status' <> 'completed' then
    raise exception 'Second supplier draft failed: %', result;
  end if;
end;
$$;

update public.journal_entries entry
set status = 'publicada',
    posted_by = '81000000-0000-4000-8000-000000000001',
    posted_at = now()
from public.accounting_outbox_v2 box
where box.journal_entry_id = entry.id
  and box.source_type = 'supplier_payment'
  and box.status = 'completed'
  and entry.status = 'borrador';
update public.financial_events event
set status = 'posted'
from public.accounting_outbox_v2 box
where box.financial_event_id = event.id
  and box.source_type = 'supplier_payment'
  and box.status = 'completed'
  and exists (select 1 from public.journal_entries entry where entry.id = box.journal_entry_id and entry.status = 'publicada');

select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
do $$
declare
  payment_id uuid;
  result record;
begin
  select id into strict payment_id
  from public.supplier_payments
  where amount = 300 and status = 'paid';
  select * into strict result
  from public.void_supplier_payment_v2(
    payment_id, 'Anulacion de partida publicada',
    '89000000-0000-4000-8000-000000000005'
  );
  if result.compensation_outbox_id is null then
    raise exception 'Published supplier payment did not enqueue compensation.';
  end if;
end;
$$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  box_id uuid;
  result jsonb;
begin
  select id into strict box_id
  from public.accounting_outbox_v2
  where topic = 'accounting.compensation'
    and source_type = 'supplier_payment';
  result := public.process_accounting_outbox_v2(box_id, 'sql-contract-worker', false);
  if result->>'outbox_status' <> 'completed'
    or result->>'draft_status' <> 'borrador'
  then raise exception 'Supplier compensation draft failed: %', result; end if;
  if not exists (
    select 1
    from public.accounting_outbox_v2 original_box
    join public.journal_entries original_entry on original_entry.id = original_box.journal_entry_id
    where original_box.source_type = 'supplier_payment'
      and original_box.event_purpose = 'supplier_payment'
      and original_entry.status = 'publicada'
  ) then raise exception 'Published supplier original was modified.'; end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

-- Grants stay least-privilege: authenticated can read with RLS but cannot
-- mutate either the outbox or shadow observations directly.
do $$
begin
  if has_table_privilege('authenticated', 'public.accounting_outbox_v2', 'insert')
    or has_table_privilege('authenticated', 'public.accounting_outbox_v2', 'update')
    or has_table_privilege('authenticated', 'public.accounting_outbox_v2', 'delete')
  then raise exception 'Authenticated retained direct outbox writes.'; end if;
  if not has_table_privilege('authenticated', 'public.accounting_outbox_v2', 'select') then
    raise exception 'Authorized RLS reads are unavailable.';
  end if;
end;
$$;

select pass('Accounting automation V2 transactional contract');
select * from finish();

rollback;

\echo 'Accounting automation V2 transactional contract: OK'
