\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.order_terms_failpoint()
returns trigger
language plpgsql
as $$
begin
  if current_setting('order_terms.test_failpoint', true) = tg_table_name then
    raise exception 'ORDER_TERMS_FAILPOINT_%', upper(tg_table_name);
  end if;
  return new;
end;
$$;

create trigger order_terms_test_fail_orders before update on public.orders
for each row execute function pg_temp.order_terms_failpoint();
create trigger order_terms_test_fail_payments before update on public.payments
for each row execute function pg_temp.order_terms_failpoint();
create trigger order_terms_test_fail_audit before insert on public.audit_logs
for each row execute function pg_temp.order_terms_failpoint();
create trigger order_terms_test_fail_invoice_items before insert on public.invoice_items
for each row execute function pg_temp.order_terms_failpoint();

do $$
<<fixture>>
declare
  admin_id uuid := '95200000-0000-4000-8000-000000000001';
  accountant_id uuid := '95200000-0000-4000-8000-000000000002';
  product_id uuid := '95200000-0000-4000-8000-000000000003';
  order_id uuid;
  item_id uuid;
  result jsonb;
  replay jsonb;
  generated record;
  invoice_row public.invoices%rowtype;
  order_row public.orders%rowtype;
begin
  insert into public.roles (name, description, permissions) values
    (
      'admin', 'ORDER_TERMS_ADMIN',
      '["sales:set_invoice_date","sales:override_price","sales:override_delivery","invoices:create"]'::jsonb
    ),
    (
      'contadora', 'ORDER_TERMS_ACCOUNTANT',
      '["invoices:create","invoices:read","reports:read"]'::jsonb
    )
  on conflict (name) do update set permissions = excluded.permissions;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values
  ('00000000-0000-0000-0000-000000000000', admin_id, 'authenticated', 'authenticated',
   'order_terms_admin@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', accountant_id, 'authenticated', 'authenticated',
   'order_terms_accountant@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
  update public.users set role_id = (select id from public.roles where name = 'admin') where id = admin_id;
  update public.users set role_id = (select id from public.roles where name = 'contadora') where id = accountant_id;

  insert into public.products (
    id, sku, internal_code, slug, name, brand, description, stock, low_stock_threshold,
    min_stock, retail_price, wholesale_price, wholesale_min_quantity, cost_price, status, active,
    category_id
  ) values (
    product_id, 'ORDER-TERMS-SKU', 'ORDER-TERMS-CODE', 'order-terms-product',
    'ORDER_TERMS_PRODUCT', 'TEST', 'Rollback fixture', 20, 2, 2, 1000, 900, 1, 500, 'active', true,
    (select id from public.categories where slug = 'exterior' limit 1)
  );

  insert into public.company_settings (
    id, company_name, currency, tax_rate, invoice_prefix, order_prefix,
    free_shipping_threshold, standard_shipping_fee, first_wholesale_minimum
  ) values (
    '95200000-0000-4000-8000-000000000004', 'ORDER_TERMS_COMPANY', 'HNL', 0.15,
    'TEST-F', 'TEST', 3000, 120, 10000
  );

  update public.fiscal_settings
  set legal_name = 'ORDER_TERMS_LEGAL', rtn = '08011999123456', cai = 'ORDER-TERMS-LOCAL-CAI',
      cai_authorization_date = (now() at time zone 'America/Tegucigalpa')::date - 60,
      invoice_range_start = '000-001-01-00000001', invoice_range_end = '000-001-01-00000999',
      current_invoice_number = '000-001-01-00000001',
      emission_deadline = (now() at time zone 'America/Tegucigalpa')::date + 60,
      fiscal_address = 'Tegucigalpa', phone = '99990000', email = 'terms@example.invalid'
  where id = true;

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  select created.order_id into order_id
  from public.create_checkout_order_v2(
    'ORDER_TERMS_CUSTOMER', 'order_terms_customer@example.invalid', '99990001', null,
    'Tegucigalpa', 'retail', 'bank_transfer', 'ORDER-TERMS-PENDING',
    jsonb_build_array(jsonb_build_object('product_id', product_id, 'quantity', 2)),
    null, null, null, 'Honduras', 'HN', 'Francisco Morazan', 'Tegucigalpa', 'before_delivery'
  ) created;
  select item.id into item_id from public.order_items item where item.order_id = fixture.order_id;
  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  if public.current_actor_role() is distinct from 'admin' then
    raise exception 'Fixture actor role mismatch: role=%, uid=%, users=%',
      public.current_actor_role(), auth.uid(),
      (select jsonb_agg(to_jsonb(u)) from public.users u where u.id = admin_id);
  end if;
  if not public.has_permission('sales:set_invoice_date') then
    raise exception 'Fixture permission mismatch: %', (select permissions from public.roles where name = 'admin');
  end if;

  -- No explicit period row is allowed.
  result := public.adjust_sale_terms_v1(
    order_id, (now() at time zone 'America/Tegucigalpa')::date - 3,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850.00)),
    80.00, 'external_company', 'ORDER_TERMS_CARRIER', null, null, 0,
    '95200000-0000-4000-8000-000000000010'
  );
  replay := public.adjust_sale_terms_v1(
    order_id, (now() at time zone 'America/Tegucigalpa')::date - 3,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850.00)),
    80.00, 'external_company', 'ORDER_TERMS_CARRIER', null, null, 0,
    '95200000-0000-4000-8000-000000000010'
  );
  select * into order_row from public.orders where id = fixture.order_id;
  if result <> replay or order_row.commercial_terms_version <> 1
    or order_row.shipping_fee <> 80 or order_row.shipping_fee_suggested <> 120
    or (select unit_price from public.order_items where id = fixture.item_id) <> 850
    or (select amount from public.payments where public.payments.order_id = fixture.order_id) <> order_row.total then
    raise exception 'Initial/replay snapshot mismatch: %', result;
  end if;

  -- Explicit delivery vectors all use the same authoritative nonnegative path.
  for result in
    select jsonb_build_object('fee', fee, 'mode', mode, 'provider', provider)
    from (values
      (0.00::numeric, 'store_pickup'::text, null::text),
      (100.00::numeric, 'car_zone'::text, null::text),
      (150.00::numeric, 'external_company'::text, 'ORDER_TERMS_CARRIER_150'::text),
      (200.00::numeric, 'customer_arranged'::text, null::text),
      (80.25::numeric, 'other'::text, null::text)
    ) vectors(fee, mode, provider)
  loop
    begin
      perform public.adjust_sale_terms_v1(
        order_id, current_date - 3,
        jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
        (result->>'fee')::numeric, result->>'mode', result->>'provider', '', '', 1,
        gen_random_uuid());
      if (select shipping_fee from public.orders where id = fixture.order_id)
          <> (result->>'fee')::numeric
        or (select delivery_mode from public.orders where id = fixture.order_id)
          is distinct from result->>'mode' then
        raise exception 'DELIVERY_VECTOR_MISMATCH_%', result;
      end if;
      raise exception 'ROLLBACK_DELIVERY_VECTOR';
    exception when others then
      if sqlerrm <> 'ROLLBACK_DELIVERY_VECTOR' then raise; end if;
    end;
  end loop;

  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      -0.01, null, null, null, null, 1, gen_random_uuid());
    raise exception 'EXPECTED_NEGATIVE_DELIVERY';
  exception when others then
    if sqlerrm = 'EXPECTED_NEGATIVE_DELIVERY' or sqlerrm not ilike '%cargo de entrega no negativo%' then raise; end if;
  end;

  -- Explicit price vectors: cost, one cent over cost, increase and unchanged.
  for result in
    select jsonb_build_object('price', price)
    from (values (500.00::numeric), (500.01::numeric), (1250.00::numeric), (850.00::numeric)) vectors(price)
  loop
    begin
      perform public.adjust_sale_terms_v1(
        order_id, current_date - 3,
        jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', (result->>'price')::numeric)),
        80, 'external_company', 'ORDER_TERMS_CARRIER', '', '', 1, gen_random_uuid());
      if (select unit_price from public.order_items where id = fixture.item_id)
          <> (result->>'price')::numeric then
        raise exception 'PRICE_VECTOR_MISMATCH_%', result;
      end if;
      raise exception 'ROLLBACK_PRICE_VECTOR';
    exception when others then
      if sqlerrm <> 'ROLLBACK_PRICE_VECTOR' then raise; end if;
    end;
  end loop;

  begin
    update public.order_items set unit_cost_snapshot = 0 where id = fixture.item_id;
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 840)),
      80, null, null, null, null, 1, gen_random_uuid());
    raise exception 'EXPECTED_ZERO_COST';
  exception when others then
    if sqlerrm = 'EXPECTED_ZERO_COST' or sqlerrm not ilike '%costo valido%' then raise; end if;
  end;
  begin
    update public.order_items set unit_cost_snapshot = null where id = fixture.item_id;
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 840)),
      80, null, null, null, null, 1, gen_random_uuid());
    raise exception 'EXPECTED_NULL_COST';
  exception when others then
    if sqlerrm = 'EXPECTED_NULL_COST' or sqlerrm not ilike '%costo valido%' then raise; end if;
  end;

  -- Controlled failpoints prove rollback after line writes, after order writes,
  -- and before audit persistence. The same version remains reusable each time.
  foreach result in array array[
    jsonb_build_object('table', 'orders'),
    jsonb_build_object('table', 'payments'),
    jsonb_build_object('table', 'audit_logs')
  ]
  loop
    perform set_config('order_terms.test_failpoint', result->>'table', true);
    begin
      perform public.adjust_sale_terms_v1(
        order_id, current_date - 3,
        jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 900)),
        150, 'car_zone', null, 'FAILPOINT_PRICE', 'FAILPOINT_DELIVERY', 1, gen_random_uuid());
      raise exception 'EXPECTED_FAILPOINT_%', result->>'table';
    exception when others then
      if sqlerrm not ilike 'ORDER_TERMS_FAILPOINT_%' then raise; end if;
    end;
    perform set_config('order_terms.test_failpoint', '', true);
    select * into order_row from public.orders where id = fixture.order_id;
    if order_row.commercial_terms_version <> 1 or order_row.shipping_fee <> 80
      or (select unit_price from public.order_items where id = fixture.item_id) <> 850
      or (select payment.amount from public.payments payment where payment.order_id = fixture.order_id) <> order_row.total
      or exists (
        select 1 from public.audit_logs
        where record_id = fixture.order_id
          and new_data->>'price_reason' = 'FAILPOINT_PRICE'
      ) then
      raise exception 'FAILPOINT_LEFT_PARTIAL_STATE_%', result;
    end if;
  end loop;

  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      81, null, null, null, null, 0, '95200000-0000-4000-8000-000000000010');
    raise exception 'EXPECTED_IDEMPOTENCY';
  exception when others then
    if sqlerrm = 'EXPECTED_IDEMPOTENCY' or sqlerrm not ilike '%datos diferentes%' then raise; end if;
  end;
  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 499.99)),
      80, null, null, null, null, 1, '95200000-0000-4000-8000-000000000011');
    raise exception 'EXPECTED_COST';
  exception when others then
    if sqlerrm = 'EXPECTED_COST' or sqlerrm not ilike '%inferior al costo%' then raise; end if;
  end;
  begin
    perform public.adjust_sale_terms_v1(
      order_id, (now() at time zone 'America/Tegucigalpa')::date + 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, null, null, null, null, 1, '95200000-0000-4000-8000-000000000012');
    raise exception 'EXPECTED_FUTURE';
  exception when others then
    if sqlerrm = 'EXPECTED_FUTURE' or sqlerrm not ilike '%futura%' then raise; end if;
  end;

  insert into public.accounting_periods (
    id, name, start_date, end_date, status, period_type, fiscal_year, created_by
  ) values (
    '95200000-0000-4000-8000-000000000020', 'ORDER_TERMS_OPEN', current_date - 2,
    current_date - 1, 'open', 'custom', extract(year from current_date)::integer, admin_id
  );
  result := public.adjust_sale_terms_v1(
    order_id, current_date - 2,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
    80, 'external_company', 'ORDER_TERMS_CARRIER', null, null, 1,
    '95200000-0000-4000-8000-000000000013');
  update public.accounting_periods set status = 'closed', closed_at = now(), closed_by = admin_id
  where id = '95200000-0000-4000-8000-000000000020';
  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, null, null, null, null, 2, '95200000-0000-4000-8000-000000000014');
    raise exception 'EXPECTED_CLOSED';
  exception when others then
    if sqlerrm = 'EXPECTED_CLOSED' or sqlerrm not ilike '%periodo contable cerrado%' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub', accountant_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', accountant_id, 'role', 'authenticated')::text, true);
  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, null, null, null, null, 2, '95200000-0000-4000-8000-000000000015');
    raise exception 'EXPECTED_ACCOUNTANT';
  exception when others then
    if sqlerrm = 'EXPECTED_ACCOUNTANT' or sqlerrm not ilike '%permiso%' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.payments set payment_status = 'approved', status = 'approved', paid_at = now()
  where public.payments.order_id = fixture.order_id;
  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 3,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      100, null, null, null, null, 2, '95200000-0000-4000-8000-000000000016');
    raise exception 'EXPECTED_PAYMENT';
  exception when others then
    if sqlerrm = 'EXPECTED_PAYMENT' or sqlerrm not ilike '%no pueden cambiarse%' then raise; end if;
  end;

  -- Date-only changes remain legal after payment and inventory progress.
  result := public.adjust_sale_terms_v1(
    order_id, current_date - 4,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
    80, 'external_company', 'ORDER_TERMS_CARRIER', null, null, 2,
    '95200000-0000-4000-8000-000000000017');
  update public.orders set status = 'confirmado' where id = fixture.order_id;
  result := public.adjust_sale_terms_v1(
    order_id, current_date - 5,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
    80, 'external_company', 'ORDER_TERMS_CARRIER', null, null, 3,
    '95200000-0000-4000-8000-000000000018');

  -- A fiscal failure after invoice insert must roll back invoice, items and correlativo.
  perform set_config('order_terms.test_failpoint', 'invoice_items', true);
  begin
    perform public.generate_fiscal_invoice_from_order(order_id);
    raise exception 'EXPECTED_FISCAL_FAILPOINT';
  exception when others then
    if sqlerrm not ilike 'ORDER_TERMS_FAILPOINT_INVOICE_ITEMS%' then raise; end if;
  end;
  perform set_config('order_terms.test_failpoint', '', true);
  if exists (select 1 from public.invoices invoice where invoice.order_id = fixture.order_id)
    or (select current_invoice_number from public.fiscal_settings where id = true)
      <> '000-001-01-00000001' then
    raise exception 'FISCAL_FAILPOINT_LEFT_PARTIAL_STATE';
  end if;

  select * into generated from public.generate_fiscal_invoice_from_order(order_id);
  select * into invoice_row from public.invoices where id = generated.invoice_id;
  select * into order_row from public.orders where id = fixture.order_id;
  if invoice_row.invoice_date <> current_date - 5 or invoice_row.issued_at is null
    or invoice_row.total <> order_row.total or invoice_row.shipping_fee <> order_row.shipping_fee
    or (select current_invoice_number from public.fiscal_settings where id = true) <> '000-001-01-00000002' then
    raise exception 'Invoice snapshot mismatch: %', to_jsonb(invoice_row);
  end if;
  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 6,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, null, null, null, null, 4, '95200000-0000-4000-8000-000000000019');
    raise exception 'EXPECTED_IMMUTABLE';
  exception when others then
    if sqlerrm = 'EXPECTED_IMMUTABLE' or sqlerrm not ilike '%despues de generar la factura%' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '95200000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"95200000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    update public.order_items set unit_price = unit_price + 1
    where order_id = (select id from public.orders where email = 'order_terms_customer@example.invalid');
    raise exception 'DIRECT_WRITE_WAS_ALLOWED';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;

do $$
begin
  if exists (select 1 from auth.users where email like 'order_terms_%@example.invalid')
    or exists (select 1 from public.orders where email = 'order_terms_customer@example.invalid')
    or exists (select 1 from public.products where sku = 'ORDER-TERMS-SKU') then
    raise exception 'ORDER_TERMS fixtures remained after rollback.';
  end if;
end;
$$;
\echo 'ORDER_TERMS local transaction, permissions, dates, price, delivery, idempotency, invoice and zero-residue checks passed.'
