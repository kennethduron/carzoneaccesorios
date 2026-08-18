\set ON_ERROR_STOP on

set session_replication_role = replica;

insert into public.roles (id, name, permissions)
values (
  '10000000-0000-0000-0000-000000000001',
  'technical_owner',
  '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb
)
on conflict (name) do update set permissions = excluded.permissions;

insert into public.users (id, role_id, active)
values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', true)
on conflict (id) do update set role_id = excluded.role_id, active = true;

insert into public.roles (id, name, permissions) values
  ('11000000-0000-0000-0000-000000000001', 'business_owner', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb),
  ('12000000-0000-0000-0000-000000000001', 'admin', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb),
  ('13000000-0000-0000-0000-000000000001', 'vendedor', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb),
  ('14000000-0000-0000-0000-000000000001', 'bodega', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb),
  ('15000000-0000-0000-0000-000000000001', 'contadora', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb),
  ('16000000-0000-0000-0000-000000000001', 'soporte', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb),
  ('17000000-0000-0000-0000-000000000001', 'cliente', '["invoices:manage","invoices:read","orders:manage","inventory:manage","credit:manage","accounting:manage","audit:read"]'::jsonb)
on conflict (name) do update set permissions = excluded.permissions;

insert into public.users (id, role_id, active) values
  ('11000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', true),
  ('12000000-0000-0000-0000-000000000002', '12000000-0000-0000-0000-000000000001', true),
  ('13000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', true),
  ('14000000-0000-0000-0000-000000000002', '14000000-0000-0000-0000-000000000001', true),
  ('15000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-000000000001', true),
  ('16000000-0000-0000-0000-000000000002', '16000000-0000-0000-0000-000000000001', true),
  ('17000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001', true)
on conflict (id) do update set role_id = excluded.role_id, active = true;

insert into public.customers (id, contact_name, business_name, phone, address)
values (
  '10000000-0000-0000-0000-000000000003',
  'Synthetic customer', 'Synthetic customer', '99990000', 'Local only'
)
on conflict (id) do nothing;

create or replace function pg_temp.seed_credit_sale(
  p_order uuid,
  p_invoice uuid,
  p_product uuid,
  p_item uuid,
  p_movement uuid,
  p_receivable uuid,
  p_suffix text,
  p_quantity integer,
  p_stock_after integer
)
returns void
language plpgsql
as $$
declare
  sale_event uuid := gen_random_uuid();
  cogs_event uuid := gen_random_uuid();
  sale_journal uuid := gen_random_uuid();
  cogs_journal uuid := gen_random_uuid();
begin
  insert into public.products (
    id, sku, slug, name, brand, stock, reserved_stock,
    retail_price, wholesale_price, cost_price, tracks_inventory
  ) values (
    p_product, 'SYN-' || p_suffix, 'syn-' || lower(p_suffix),
    'Synthetic ' || p_suffix, 'TEST', p_stock_after, 0,
    115, 100, 50, true
  );

  insert into public.orders (
    id, order_number, customer_id, customer_name, phone, customer_phone,
    delivery_address, payment_method, price_mode, subtotal, tax, total,
    status, tracking_status, order_reservation_status, source, channel, created_by
  ) values (
    p_order, 'SYN-ORDER-' || p_suffix,
    '10000000-0000-0000-0000-000000000003', 'Synthetic customer',
    '99990000', '99990000', 'Local only', 'commercial_credit', 'retail',
    p_quantity * 100, p_quantity * 15, p_quantity * 115,
    'entregado', 'entregado', 'not_required', 'pos', 'store',
    '10000000-0000-0000-0000-000000000002'
  );

  insert into public.order_items (
    id, order_id, product_id, sku, product_name, quantity,
    applied_price_mode, unit_price, line_total,
    retail_price_snapshot, wholesale_price_snapshot,
    unit_cost_snapshot, total_cost_snapshot, cost_source,
    cost_captured_at, tracks_inventory_snapshot
  ) values (
    p_item, p_order, p_product, 'SYN-' || p_suffix,
    'Synthetic ' || p_suffix, p_quantity, 'retail', 115,
    p_quantity * 115, 115, 100, 50, p_quantity * 50,
    'synthetic_local_test', now(), true
  );

  insert into public.invoices (
    id, order_id, customer_id, invoice_number, status, price_mode,
    subtotal, tax, total, issued_at
  ) values (
    p_invoice, p_order, '10000000-0000-0000-0000-000000000003',
    'SYN-INVOICE-' || p_suffix, 'emitida', 'retail',
    p_quantity * 100, p_quantity * 15, p_quantity * 115, now()
  );

  insert into public.inventory_movements (
    id, product_id, user_id, movement_type, quantity,
    stock_before, stock_after, reference_type, reference_id,
    order_item_id, unit_cost_snapshot, total_cost_snapshot,
    cost_source, cost_captured_at, reserved_before, reserved_after,
    available_before, available_after, effective_date, notes
  ) values (
    p_movement, p_product, '10000000-0000-0000-0000-000000000002',
    'sale', -p_quantity, p_stock_after + p_quantity, p_stock_after,
    'orders', p_order, p_item, 50, p_quantity * 50,
    'synthetic_local_test', now(), 0, 0,
    p_stock_after + p_quantity, p_stock_after, current_date,
    'Synthetic sale deduction'
  );

  insert into public.accounts_receivable (
    id, customer_id, order_id, invoice_id, original_amount,
    balance_due, due_date, status
  ) values (
    p_receivable, '10000000-0000-0000-0000-000000000003',
    p_order, p_invoice, p_quantity * 115, p_quantity * 115,
    current_date + 30, 'open'
  );

  insert into public.financial_events (
    id, source_type, source_id, event_purpose, posting_version,
    status, occurred_at
  ) values
    (sale_event, 'order', p_order::text, 'sale_recognized', 'v2', 'draft_created', now()),
    (cogs_event, 'inventory_movement', p_movement::text, 'inventory_cogs', 'v2', 'draft_created', now());

  insert into public.journal_entries (
    id, entry_number, entry_date, description, status, created_by
  ) values
    (sale_journal, 'SYN-SALE-' || p_suffix, current_date, 'Synthetic sale', 'borrador', '10000000-0000-0000-0000-000000000002'),
    (cogs_journal, 'SYN-COGS-' || p_suffix, current_date, 'Synthetic COGS', 'borrador', '10000000-0000-0000-0000-000000000002');

  update public.financial_events set journal_entry_id = sale_journal where id = sale_event;
  update public.financial_events set journal_entry_id = cogs_journal where id = cogs_event;

  insert into public.accounting_outbox_v2 (
    feature_key, topic, source_type, source_id, event_purpose,
    posting_version, scenario, idempotency_key, occurred_at, cutover_at,
    status, actor_id, financial_event_id, journal_entry_id
  ) values
    ('sales_draft_v2', 'sales.recognized', 'order', p_order,
      'sale_recognized', 'v2', 'synthetic', 'syn:sale:' || p_order,
      now(), now(), 'completed', '10000000-0000-0000-0000-000000000002',
      sale_event, sale_journal),
    ('cogs_draft_v2', 'inventory.cogs', 'inventory_movement', p_movement,
      'inventory_cogs', 'v2', 'synthetic', 'syn:cogs:' || p_movement,
      now(), now(), 'completed', '10000000-0000-0000-0000-000000000002',
      cogs_event, cogs_journal);
end;
$$;

-- Baseline: stock 4 -> 3, then full annulment restores exactly 4.
select pg_temp.seed_credit_sale(
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000006',
  'BASE', 1, 3
);

-- Quantity > 1.
select pg_temp.seed_credit_sale(
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000006',
  'QTY3', 3, 7
);

-- Multiline base plus second tracked product and unrelated product.
select pg_temp.seed_credit_sale(
  '40000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000003',
  '40000000-0000-0000-0000-000000000004',
  '40000000-0000-0000-0000-000000000005',
  '40000000-0000-0000-0000-000000000006',
  'MULTIA', 2, 8
);
insert into public.products (
  id, sku, slug, name, brand, stock, reserved_stock,
  retail_price, wholesale_price, cost_price, tracks_inventory
) values
  ('40000000-0000-0000-0000-000000000007', 'SYN-MULTIB', 'syn-multib', 'Synthetic MULTIB', 'TEST', 4, 0, 115, 100, 50, true),
  ('40000000-0000-0000-0000-000000000011', 'SYN-UNRELATED', 'syn-unrelated', 'Synthetic unrelated', 'TEST', 9, 0, 115, 100, 50, true);
insert into public.order_items (
  id, order_id, product_id, sku, product_name, quantity,
  applied_price_mode, unit_price, line_total,
  retail_price_snapshot, wholesale_price_snapshot,
  unit_cost_snapshot, total_cost_snapshot, cost_source,
  cost_captured_at, tracks_inventory_snapshot
) values (
  '40000000-0000-0000-0000-000000000008',
  '40000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000007',
  'SYN-MULTIB', 'Synthetic MULTIB', 1, 'retail', 115, 115,
  115, 100, 50, 50, 'synthetic_local_test', now(), true
);
insert into public.inventory_movements (
  id, product_id, user_id, movement_type, quantity, stock_before, stock_after,
  reference_type, reference_id, order_item_id, unit_cost_snapshot,
  total_cost_snapshot, cost_source, cost_captured_at, reserved_before,
  reserved_after, available_before, available_after, effective_date, notes
) values (
  '40000000-0000-0000-0000-000000000009',
  '40000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000002', 'sale', -1, 5, 4,
  'orders', '40000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000008', 50, 50,
  'synthetic_local_test', now(), 0, 0, 5, 4, current_date,
  'Synthetic second sale deduction'
);
-- The second movement's COGS chain is intentionally absent: no accounting fact means no compensation is required.

-- Paid and partial-payment safety fixtures.
select pg_temp.seed_credit_sale(
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002',
  '50000000-0000-0000-0000-000000000003',
  '50000000-0000-0000-0000-000000000004',
  '50000000-0000-0000-0000-000000000005',
  '50000000-0000-0000-0000-000000000006',
  'PAID', 1, 3
);
insert into public.payments (
  id, order_id, customer_id, method, payment_method, status, payment_status,
  amount, paid_at
) values (
  '50000000-0000-0000-0000-000000000007',
  '50000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003',
  'cash', 'cash', 'approved', 'approved', 115, now()
);

select pg_temp.seed_credit_sale(
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000003',
  '60000000-0000-0000-0000-000000000004',
  '60000000-0000-0000-0000-000000000005',
  '60000000-0000-0000-0000-000000000006',
  'PARTIAL', 1, 3
);
update public.accounts_receivable
set status = 'partial', balance_due = 50
where id = '60000000-0000-0000-0000-000000000006';
insert into public.accounts_receivable_payments (
  id, receivable_id, customer_id, order_id, amount,
  payment_method, recorded_by
) values (
  '60000000-0000-0000-0000-000000000007',
  '60000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000003',
  '60000000-0000-0000-0000-000000000001', 65, 'cash',
  '10000000-0000-0000-0000-000000000002'
);

-- Atomic rollback fixture.
select pg_temp.seed_credit_sale(
  '70000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000002',
  '70000000-0000-0000-0000-000000000003',
  '70000000-0000-0000-0000-000000000004',
  '70000000-0000-0000-0000-000000000005',
  '70000000-0000-0000-0000-000000000006',
  'ROLLBACK', 1, 3
);

-- Concurrency fixture is committed before the two external sessions race.
select pg_temp.seed_credit_sale(
  '80000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000002',
  '80000000-0000-0000-0000-000000000003',
  '80000000-0000-0000-0000-000000000004',
  '80000000-0000-0000-0000-000000000005',
  '80000000-0000-0000-0000-000000000006',
  'CONCURRENT', 1, 3
);

-- A reversed sale must not block a later, independent normal sale.
select pg_temp.seed_credit_sale(
  '90000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000002',
  '90000000-0000-0000-0000-000000000003',
  '90000000-0000-0000-0000-000000000004',
  '90000000-0000-0000-0000-000000000005',
  '90000000-0000-0000-0000-000000000006',
  'REINVOICE', 1, 3
);

-- Already-fiscally-annulled incident recovery uses the same authority with exact expectations.
select pg_temp.seed_credit_sale(
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000005',
  'a0000000-0000-0000-0000-000000000006',
  'RECOVERY', 1, 3
);
update public.invoices
set status='anulada', cancellation_reason='equivocacion en codigo facturado',
  cancelled_at=now(), cancelled_by='10000000-0000-0000-0000-000000000002'
where id='a0000000-0000-0000-0000-000000000002';
insert into public.orders (
  id, order_number, customer_id, customer_name, phone, customer_phone,
  delivery_address, payment_method, price_mode, subtotal, tax, total,
  status, tracking_status, order_reservation_status, source, channel, created_by
) values (
  '90000000-0000-0000-0000-000000000011', 'SYN-ORDER-REINVOICE-NEW',
  '10000000-0000-0000-0000-000000000003', 'Synthetic customer',
  '99990000', '99990000', 'Local only', 'commercial_credit', 'retail',
  100, 15, 115, 'confirmado', 'confirmado', 'not_required', 'pos', 'store',
  '10000000-0000-0000-0000-000000000002'
);
insert into public.order_items (
  id, order_id, product_id, sku, product_name, quantity,
  applied_price_mode, unit_price, line_total, retail_price_snapshot,
  wholesale_price_snapshot, unit_cost_snapshot, total_cost_snapshot,
  cost_source, cost_captured_at, tracks_inventory_snapshot
) values (
  '90000000-0000-0000-0000-000000000012',
  '90000000-0000-0000-0000-000000000011',
  '90000000-0000-0000-0000-000000000003',
  'SYN-REINVOICE', 'Synthetic reinvoice product', 1, 'retail',
  115, 115, 115, 100, 50, 50, 'synthetic_local_test', now(), true
);

set session_replication_role = origin;

-- The recovery gate recognizes exactly the three authorized application roles.
do $$
declare
  actor uuid;
  denied_actor uuid;
  expected jsonb := jsonb_build_object(
    'order_id','ffffffff-0000-0000-0000-000000000001',
    'order_status','entregado',
    'customer_id','10000000-0000-0000-0000-000000000003',
    'product_id','a0000000-0000-0000-0000-000000000003',
    'original_movement_id','a0000000-0000-0000-0000-000000000005',
    'original_movement_count',1,'quantity',1,'current_stock',3,
    'receivable_id','a0000000-0000-0000-0000-000000000006',
    'receivable_balance',115,
    'cancellation_reason','equivocacion en codigo facturado',
    'actor_id','13000000-0000-0000-0000-000000000002',
    'actor_role','technical_owner'
  );
begin
  foreach actor in array array[
    '10000000-0000-0000-0000-000000000002'::uuid,
    '11000000-0000-0000-0000-000000000002'::uuid,
    '12000000-0000-0000-0000-000000000002'::uuid
  ] loop
    perform set_config('request.jwt.claim.sub', actor::text, true);
    begin
      perform public.cancel_sale_invoice_v1(
        'a0000000-0000-0000-0000-000000000002',
        'equivocacion en codigo facturado', true, expected
      );
      raise exception 'AUTHORIZED_RECOVERY_GATE_NOT_REACHED';
    exception when sqlstate 'PT409' then
      if sqlerrm <> 'SALE_REVERSAL_RECOVERY_INVOICE_MISMATCH' then raise; end if;
    end;
  end loop;

  foreach denied_actor in array array[
    '13000000-0000-0000-0000-000000000002'::uuid,
    '14000000-0000-0000-0000-000000000002'::uuid,
    '15000000-0000-0000-0000-000000000002'::uuid,
    '16000000-0000-0000-0000-000000000002'::uuid,
    '17000000-0000-0000-0000-000000000002'::uuid
  ] loop
    perform set_config('request.jwt.claim.sub', denied_actor::text, true);
    begin
      perform public.cancel_sale_invoice_v1(
        'a0000000-0000-0000-0000-000000000002',
        'equivocacion en codigo facturado', true, expected
      );
      raise exception 'UNAUTHORIZED_RECOVERY_WAS_ALLOWED';
    exception when insufficient_privilege then
      if sqlerrm <> 'SALE_REVERSAL_RECOVERY_PERMISSION_DENIED' then raise; end if;
    end;
  end loop;

  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.cancel_sale_invoice_v1(
      'a0000000-0000-0000-0000-000000000002',
      'equivocacion en codigo facturado', true, expected
    );
    raise exception 'UNAUTHENTICATED_RECOVERY_WAS_ALLOWED';
  exception when insufficient_privilege then
    if sqlerrm <> 'SALE_REVERSAL_PERMISSION_DENIED' then raise; end if;
  end;
end;
$$;

begin;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1(
  '20000000-0000-0000-0000-000000000002', 'Error de codigo sintetico', false, null
);
commit;

do $$
begin
  if (select stock from public.products where id='20000000-0000-0000-0000-000000000003') <> 4 then raise exception 'BASE_STOCK_FAILED'; end if;
  if (select status::text from public.invoices where id='20000000-0000-0000-0000-000000000002') <> 'anulada' then raise exception 'BASE_INVOICE_FAILED'; end if;
  if (select status::text from public.orders where id='20000000-0000-0000-0000-000000000001') <> 'cancelado' then raise exception 'BASE_ORDER_FAILED'; end if;
  if not exists (select 1 from public.accounts_receivable where id='20000000-0000-0000-0000-000000000006' and status='cancelled' and balance_due=0) then raise exception 'BASE_CXC_FAILED'; end if;
  if (select count(*) from public.inventory_movements where reversal_of_movement_id='20000000-0000-0000-0000-000000000005') <> 1 then raise exception 'BASE_REVERSAL_LINK_FAILED'; end if;
  if (select reserved_stock from public.products where id='20000000-0000-0000-0000-000000000003') <> 0 then raise exception 'BASE_RESERVATION_FAILED'; end if;
  if (select count(*) from public.accounting_outbox_v2 where source_id in ('20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000005') and status='cancelled') <> 2 then raise exception 'BASE_ACCOUNTING_FAILED'; end if;
  if (select count(*) from public.journal_entries where entry_number in ('SYN-SALE-BASE','SYN-COGS-BASE') and status='anulada') <> 2 then raise exception 'BASE_JOURNAL_FAILED'; end if;
  if (select count(*) from public.audit_logs where action='sale.invoice.full_commercial_reversal' and record_id in (select id from public.invoice_commercial_reversals where invoice_id='20000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'BASE_AUDIT_FAILED'; end if;
end;
$$;

-- Replay is a no-op and cannot make stock 5.
begin;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1(
  '20000000-0000-0000-0000-000000000002', 'Segundo intento sintetico', false, null
);
commit;
do $$ begin
  if (select stock from public.products where id='20000000-0000-0000-0000-000000000003') <> 4 then raise exception 'REPLAY_STOCK_FAILED'; end if;
  if (select count(*) from public.inventory_movements where reversal_of_movement_id='20000000-0000-0000-0000-000000000005') <> 1 then raise exception 'REPLAY_DUPLICATE_FAILED'; end if;
end $$;

-- Exact recovery mode: no new fiscal cancellation, same commercial reversal transaction.
begin;
select set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1(
  'a0000000-0000-0000-0000-000000000002',
  'equivocacion en codigo facturado',
  true,
  jsonb_build_object(
    'order_id','a0000000-0000-0000-0000-000000000001',
    'order_status','entregado',
    'customer_id','10000000-0000-0000-0000-000000000003',
    'product_id','a0000000-0000-0000-0000-000000000003',
    'original_movement_id','a0000000-0000-0000-0000-000000000005',
    'original_movement_count',1,'quantity',1,'current_stock',3,
    'receivable_id','a0000000-0000-0000-0000-000000000006',
    'receivable_balance',115,
    'cancellation_reason','equivocacion en codigo facturado'
  )
);
commit;
do $$ begin
  if (select stock from public.products where id='a0000000-0000-0000-0000-000000000003') <> 4 then raise exception 'RECOVERY_STOCK_FAILED'; end if;
  if not exists (select 1 from public.invoice_commercial_reversals where invoice_id='a0000000-0000-0000-0000-000000000002' and mode='incident_repair' and actor_id='12000000-0000-0000-0000-000000000002') then raise exception 'RECOVERY_HEADER_FAILED'; end if;
end $$;

-- Replaying the same authorized historical repair cannot create stock 5.
begin;
select set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1(
  'a0000000-0000-0000-0000-000000000002',
  'equivocacion en codigo facturado',
  true,
  jsonb_build_object(
    'order_id','a0000000-0000-0000-0000-000000000001',
    'order_status','entregado',
    'customer_id','10000000-0000-0000-0000-000000000003',
    'product_id','a0000000-0000-0000-0000-000000000003',
    'original_movement_id','a0000000-0000-0000-0000-000000000005',
    'original_movement_count',1,'quantity',1,'current_stock',3,
    'receivable_id','a0000000-0000-0000-0000-000000000006',
    'receivable_balance',115,
    'cancellation_reason','equivocacion en codigo facturado'
  )
);
commit;
do $$ begin
  if (select stock from public.products where id='a0000000-0000-0000-0000-000000000003') <> 4 then raise exception 'RECOVERY_REPLAY_STOCK_FAILED'; end if;
  if (select count(*) from public.inventory_movements where reversal_of_movement_id='a0000000-0000-0000-0000-000000000005') <> 1 then raise exception 'RECOVERY_REPLAY_DUPLICATE_FAILED'; end if;
end $$;

-- Quantity three restores 7 -> 10.
begin;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1('30000000-0000-0000-0000-000000000002', 'Cantidad tres sintetica', false, null);
commit;

-- Multiline restores both products and leaves unrelated inventory unchanged.
begin;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1('40000000-0000-0000-0000-000000000002', 'Multilinea sintetica completa', false, null);
commit;
do $$ begin
  if (select stock from public.products where id='30000000-0000-0000-0000-000000000003') <> 10 then raise exception 'QTY3_FAILED'; end if;
  if (select stock from public.products where id='40000000-0000-0000-0000-000000000003') <> 10 then raise exception 'MULTI_A_FAILED'; end if;
  if (select stock from public.products where id='40000000-0000-0000-0000-000000000007') <> 5 then raise exception 'MULTI_B_FAILED'; end if;
  if (select stock from public.products where id='40000000-0000-0000-0000-000000000011') <> 9 then raise exception 'UNRELATED_FAILED'; end if;
end $$;

-- Paid and partial receivable states fail closed with no mutations.
do $$
begin
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
  begin
    perform public.cancel_sale_invoice_v1('50000000-0000-0000-0000-000000000002', 'Pago completo debe denegarse', false, null);
    raise exception 'PAID_WAS_NOT_DENIED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'SALE_REVERSAL_REQUIRES_PAYMENT_REFUND' then raise; end if;
  end;
  begin
    perform public.cancel_sale_invoice_v1('60000000-0000-0000-0000-000000000002', 'Pago parcial debe denegarse', false, null);
    raise exception 'PARTIAL_WAS_NOT_DENIED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'SALE_REVERSAL_REQUIRES_RECEIVABLE_REFUND' then raise; end if;
  end;
end;
$$;

create or replace function public.synthetic_fail_reversal_stage_v1()
returns trigger language plpgsql as $$
declare payload jsonb := to_jsonb(new); configured_stage text := current_setting('carzone.test_failure_stage',true);
begin
  if configured_stage=TG_ARGV[0] and (
    (configured_stage='product' and payload->>'id'='70000000-0000-0000-0000-000000000003')
    or (configured_stage='movement' and payload->>'reversal_of_movement_id'='70000000-0000-0000-0000-000000000005')
    or (configured_stage='order' and payload->>'id'='70000000-0000-0000-0000-000000000001')
    or (configured_stage='receivable' and payload->>'id'='70000000-0000-0000-0000-000000000006')
    or (configured_stage='accounting' and payload->>'source_id'='70000000-0000-0000-0000-000000000001')
    or (configured_stage='audit' and payload->>'action'='sale.invoice.full_commercial_reversal')
  ) then raise exception 'SYNTHETIC_FAILURE_%',upper(configured_stage); end if;
  return new;
end $$;
create trigger synthetic_fail_product before update on public.products for each row execute function public.synthetic_fail_reversal_stage_v1('product');
create trigger synthetic_fail_movement before insert on public.inventory_movements for each row execute function public.synthetic_fail_reversal_stage_v1('movement');
create trigger synthetic_fail_order before update on public.orders for each row execute function public.synthetic_fail_reversal_stage_v1('order');
create trigger synthetic_fail_receivable before update on public.accounts_receivable for each row execute function public.synthetic_fail_reversal_stage_v1('receivable');
create trigger synthetic_fail_accounting before update on public.accounting_outbox_v2 for each row execute function public.synthetic_fail_reversal_stage_v1('accounting');
create trigger synthetic_fail_audit before insert on public.audit_logs for each row execute function public.synthetic_fail_reversal_stage_v1('audit');

do $$
declare failure_stage text;
begin
  perform set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
  foreach failure_stage in array array['product','movement','order','receivable','accounting','audit'] loop
    perform set_config('carzone.test_failure_stage',failure_stage,true);
    begin
      perform public.cancel_sale_invoice_v1('70000000-0000-0000-0000-000000000002', 'Falla atomica sintetica', false, null);
      raise exception 'ROLLBACK_FAILURE_NOT_RAISED_%',failure_stage;
    exception when others then
      if sqlerrm <> 'SYNTHETIC_FAILURE_'||upper(failure_stage) then raise; end if;
    end;
    perform set_config('carzone.test_failure_stage','',true);
    if (select stock from public.products where id='70000000-0000-0000-0000-000000000003') <> 3 then raise exception 'ROLLBACK_STOCK_FAILED_%',failure_stage; end if;
    if (select status::text from public.invoices where id='70000000-0000-0000-0000-000000000002') <> 'emitida' then raise exception 'ROLLBACK_INVOICE_FAILED_%',failure_stage; end if;
    if (select status::text from public.orders where id='70000000-0000-0000-0000-000000000001') <> 'entregado' then raise exception 'ROLLBACK_ORDER_FAILED_%',failure_stage; end if;
    if not exists (select 1 from public.accounts_receivable where id='70000000-0000-0000-0000-000000000006' and status='open' and balance_due=115) then raise exception 'ROLLBACK_CXC_FAILED_%',failure_stage; end if;
    if exists (select 1 from public.inventory_movements where reversal_of_movement_id='70000000-0000-0000-0000-000000000005') then raise exception 'ROLLBACK_MOVEMENT_FAILED_%',failure_stage; end if;
    if exists (select 1 from public.invoice_commercial_reversals where invoice_id='70000000-0000-0000-0000-000000000002') then raise exception 'ROLLBACK_HEADER_FAILED_%',failure_stage; end if;
    if (select count(*) from public.accounting_outbox_v2 where source_id in ('70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000005') and status='completed') <> 2 then raise exception 'ROLLBACK_ACCOUNTING_FAILED_%',failure_stage; end if;
  end loop;
end $$;
drop trigger synthetic_fail_product on public.products;
drop trigger synthetic_fail_movement on public.inventory_movements;
drop trigger synthetic_fail_order on public.orders;
drop trigger synthetic_fail_receivable on public.accounts_receivable;
drop trigger synthetic_fail_accounting on public.accounting_outbox_v2;
drop trigger synthetic_fail_audit on public.audit_logs;
drop function public.synthetic_fail_reversal_stage_v1();

-- The corrected transaction is created through the ordinary inventory authority.
begin;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select public.cancel_sale_invoice_v1('90000000-0000-0000-0000-000000000002', 'Reversion antes de refacturar', false, null);
select public.apply_order_sale_inventory(
  '90000000-0000-0000-0000-000000000011',
  '10000000-0000-0000-0000-000000000002'
);
commit;
do $$ begin
  if (select stock from public.products where id='90000000-0000-0000-0000-000000000003') <> 3 then raise exception 'REINVOICE_STOCK_FAILED'; end if;
  if (select count(*) from public.inventory_movements where reference_type='orders' and reference_id='90000000-0000-0000-0000-000000000011' and movement_type='sale' and quantity=-1) <> 1 then raise exception 'REINVOICE_MOVEMENT_FAILED'; end if;
end $$;

select jsonb_build_object(
  'baseline', 'PASS',
  'second_annul', 'PASS',
  'quantity_gt_1', 'PASS',
  'multiline', 'PASS',
  'unrelated_product', 'PASS',
  'paid_denied', 'PASS',
  'partial_denied', 'PASS',
  'atomic_rollback', 'PASS'
  , 'reinvoice_flow', 'PASS'
  , 'existing_incident_recovery', 'PASS'
  , 'recovery_role_matrix', 'PASS'
  , 'recovery_replay', 'PASS'
) as synthetic_result;
