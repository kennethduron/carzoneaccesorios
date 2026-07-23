\set ON_ERROR_STOP on
\echo 'Running POS_FISCAL_TEST_ canonical fiscal and checkout integration checks'

begin;

do $$
declare
  result jsonb;
begin
  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 1000, 'discount_amount', 0)),
    0.15, 0, 120, 0, 0, '[]'::jsonb, 10000, 3000, 120,
    'home_delivery', 'retail', 'HNL'
  );
  if (result->>'fiscal_subtotal')::numeric <> 869.57
    or (result->>'included_tax_total')::numeric <> 130.43
    or (result->>'total_final')::numeric <> 1120.00
    or (result->>'suggested_delivery_charge')::numeric <> 120.00 then
    raise exception 'Minorista sin descuento no coincide: %', result;
  end if;

  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 3100, 'discount_amount', 0)),
    0.15, 200, 120, 0, 0, '[]'::jsonb, 10000, 3000, 120,
    'home_delivery', 'retail', 'HNL'
  );
  if (result->>'merchandise_final')::numeric <> 2900.00
    or (result->>'fiscal_subtotal')::numeric <> 2521.74
    or (result->>'included_tax_total')::numeric <> 378.26
    or (result->>'suggested_delivery_charge')::numeric <> 120.00
    or (result->>'total_final')::numeric <> 3020.00 then
    raise exception 'Minorista con descuento no coincide: %', result;
  end if;

  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 10500, 'discount_amount', 0)),
    0.15, 700, 120, 0, 0, '[]'::jsonb, 10000, 3000, 120,
    'home_delivery', 'wholesale_candidate', 'HNL'
  );
  if (result->>'wholesale_minimum_base')::numeric <> 9800.00
    or (result->>'meets_wholesale_minimum')::boolean then
    raise exception 'El descuento o los cargos alteraron incorrectamente el minimo mayorista: %', result;
  end if;

  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 10000, 'discount_amount', 0)),
    0.15, 0, 120, 0, 0, '[]'::jsonb, 10000, 3000, 120,
    'home_delivery', 'wholesale_candidate', 'HNL'
  );
  if not (result->>'meets_wholesale_minimum')::boolean
    or (result->>'wholesale_minimum_base')::numeric <> 10000.00 then
    raise exception 'El limite mayorista exacto no fue aceptado: %', result;
  end if;

  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 1000, 'discount_amount', 0)),
    0.15, 0, 0, 50, 0, '[]'::jsonb, 10000, 3000, 120,
    'cash_on_delivery', 'retail', 'HNL'
  );
  if (result->>'delivery_taxable_base')::numeric <> 0
    or (result->>'delivery_included_tax')::numeric <> 0
    or (result->>'cash_on_delivery_taxable_base')::numeric <> 0
    or (result->>'cash_on_delivery_included_tax')::numeric <> 0
    or (result->>'total_final')::numeric <> 1050.00 then
    raise exception 'Tratamiento de contraentrega no coincide: %', result;
  end if;

  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 1000, 'discount_amount', 0)),
    0.15, 0, 120, 50, 0, '[]'::jsonb, 10000, 3000, 120,
    'cash_on_delivery', 'retail', 'HNL'
  );
  if (result->>'total_final')::numeric <> 1170.00
    or (result->>'delivery_rule_base')::numeric <> 1000.00 then
    raise exception 'Entrega y contraentrega no se separaron correctamente: %', result;
  end if;

  result := public.calculate_sale_financials_v1(
    jsonb_build_array(jsonb_build_object('quantity', 3, 'unit_price', 0.33, 'discount_amount', 0)),
    0.15, 0, 120, 0, 0, '[]'::jsonb, 10000, 3000, 120,
    'home_delivery', 'retail', 'HNL'
  );
  if (result->>'merchandise_final')::numeric <> 0.99
    or (result->>'fiscal_subtotal')::numeric <> 0.86
    or (result->>'included_tax_total')::numeric <> 0.13
    or round((result->>'fiscal_subtotal')::numeric + (result->>'included_tax_total')::numeric, 2) <> 0.99 then
    raise exception 'Redondeo fraccional no reconcilia: %', result;
  end if;

  begin
    perform public.calculate_sale_financials_v1(
      jsonb_build_array(jsonb_build_object('quantity', 0, 'unit_price', 100, 'discount_amount', 0)),
      0.15
    );
    raise exception 'Cantidad cero fue aceptada';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform public.calculate_sale_financials_v1(
      jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price', 100, 'discount_amount', 101)),
      0.15
    );
    raise exception 'Descuento mayor que la linea fue aceptado';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

do $$
declare
  product_id uuid;
  checkout_result record;
  saved_order record;
  saved_payment record;
  saved_invoice record;
  reservation_count integer;
begin
  select products.id
  into product_id
  from public.products
  where products.active = true
    and products.status = 'active'
    and products.retail_price = 1850
  order by products.created_at
  limit 1;

  if product_id is null then
    raise exception 'El seed local no contiene el producto fiscal controlado';
  end if;

  select * into checkout_result
  from public.create_checkout_order_v2(
    'POS_FISCAL_TEST_GUEST',
    'pos_fiscal_test_guest@example.invalid',
    '99990001',
    null,
    'POS_FISCAL_TEST_ADDRESS',
    'retail',
    'bank_transfer',
    'POS-FISCAL-REF-1',
    jsonb_build_array(jsonb_build_object('product_id', product_id, 'quantity', 1)),
    null, null, null, 'Honduras', 'HN', 'Francisco Morazan', 'Tegucigalpa', 'before_delivery'
  );

  select orders.* into saved_order
  from public.orders where orders.id = checkout_result.order_id;
  select payments.* into saved_payment
  from public.payments where payments.order_id = checkout_result.order_id;
  select invoices.* into saved_invoice
  from public.invoices where invoices.order_id = checkout_result.order_id;
  select count(*) into reservation_count
  from public.inventory_reservations
  where inventory_reservations.order_id = checkout_result.order_id
    and inventory_reservations.status = 'reserved';

  if saved_order.calculation_version <> 1
    or saved_order.subtotal <> 1608.70
    or saved_order.tax <> 241.30
    or saved_order.shipping_fee <> 120.00
    or saved_order.cash_on_delivery_fee <> 0
    or saved_order.total <> 1970.00
    or saved_payment.amount <> saved_order.total
    or reservation_count <> 1 then
    raise exception 'Checkout invitado no coincide atomicamente: order %, payment %, reservations %', to_jsonb(saved_order), to_jsonb(saved_payment), reservation_count;
  end if;
  if saved_invoice.id is not null then
    raise exception 'Un pago pendiente creo una factura antes de aprobacion: %', to_jsonb(saved_invoice);
  end if;


  select * into checkout_result
  from public.create_checkout_order_v2(
    'POS_FISCAL_TEST_COD',
    'pos_fiscal_test_cod@example.invalid',
    '99990002',
    null,
    'POS_FISCAL_TEST_ADDRESS',
    'retail',
    'cash',
    null,
    jsonb_build_array(jsonb_build_object('product_id', product_id, 'quantity', 1)),
    null, null, null, 'Honduras', 'HN', 'Francisco Morazan', 'Tegucigalpa', 'on_delivery'
  );

  select orders.* into saved_order
  from public.orders where orders.id = checkout_result.order_id;

  if saved_order.cash_on_delivery_fee <> 0
    or saved_order.total <> 1970.00
    or saved_order.calculation_version <> 1 then
    raise exception 'Checkout contraentrega no quedo pendiente y canonico: %', to_jsonb(saved_order);
  end if;
end;
$$;

do $$
declare
  admin_user_id uuid := '93000000-0000-4000-8000-000000000001';
  target_order_id uuid;
  generated_invoice record;
  saved_order record;
  saved_invoice record;
  saved_payment record;
  current_number_after text;
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', admin_user_id,
    'authenticated', 'authenticated', 'pos_fiscal_test_admin@example.invalid', '', now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    jsonb_build_object('full_name', 'POS_FISCAL_TEST_ADMIN'), now(), now()
  );

  update public.users
  set role_id = (select id from public.roles where name = 'admin'), active = true
  where id = admin_user_id;

  perform set_config('request.jwt.claim.sub', admin_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_user_id, 'role', 'authenticated')::text, true);

  select orders.id into target_order_id
  from public.orders
  where orders.email = 'pos_fiscal_test_cod@example.invalid';

  perform public.update_checkout_cash_on_delivery_fee_v1(target_order_id, 50.00);

  select orders.* into saved_order from public.orders where id = target_order_id;
  select payments.* into saved_payment from public.payments where order_id = target_order_id;

  if saved_order.cash_on_delivery_fee <> 50.00
    or saved_order.total <> 2020.00
    or saved_payment.amount <> saved_order.total
    or saved_order.calculation_version <> 1
    or not exists (
      select 1
      from public.audit_logs
      where record_id = target_order_id
        and action = 'order.cash_on_delivery_fee_updated'
        and (new_data->>'cash_on_delivery_fee')::numeric = 50.00
        and (new_data->>'total')::numeric = 2020.00
    ) then
    raise exception 'La actualizacion atomica de contraentrega no reconcilio pedido, pago y auditoria: order %, payment %',
      to_jsonb(saved_order), to_jsonb(saved_payment);
  end if;

  select orders.id into target_order_id
  from public.orders
  where orders.email = 'pos_fiscal_test_guest@example.invalid';

  begin
    perform * from public.generate_fiscal_invoice_from_order(target_order_id);
    raise exception 'Un pedido o pago pendiente emitio factura';
  exception when others then
    if sqlerrm = 'Un pedido o pago pendiente emitio factura' then raise; end if;
  end;

  update public.orders
  set status = 'confirmado', updated_at = now()
  where id = target_order_id;

  update public.payments
  set status = 'approved', payment_status = 'approved', paid_at = now(), updated_at = now()
  where order_id = target_order_id;

  update public.fiscal_settings
  set legal_name = 'POS_FISCAL_TEST_LEGAL',
      rtn = '08011999123456',
      cai = 'POS-FISCAL-TEST-CAI',
      cai_authorization_date = current_date - 1,
      invoice_range_start = '000-001-01-00000001',
      invoice_range_end = '000-001-01-00000999',
      current_invoice_number = '000-001-01-00000001',
      emission_deadline = current_date + 30,
      fiscal_address = 'POS_FISCAL_TEST_ADDRESS',
      phone = '99990000',
      email = 'pos_fiscal_test_fiscal@example.invalid',
      updated_at = now()
  where id = true;

  select * into generated_invoice
  from public.generate_fiscal_invoice_from_order(target_order_id);

  select orders.* into saved_order from public.orders where id = target_order_id;
  select payments.* into saved_payment from public.payments where order_id = target_order_id;
  select invoices.* into saved_invoice from public.invoices where id = generated_invoice.invoice_id;
  select current_invoice_number into current_number_after from public.fiscal_settings where id = true;

  if saved_invoice.subtotal <> saved_order.subtotal
    or saved_invoice.tax <> saved_order.tax
    or saved_invoice.shipping_fee <> saved_order.shipping_fee
    or saved_invoice.cash_on_delivery_fee <> saved_order.cash_on_delivery_fee
    or saved_invoice.total <> saved_order.total
    or saved_invoice.total <> saved_payment.amount
    or saved_invoice.calculation_version <> 1
    or (select count(*) from public.invoice_items where invoice_id = saved_invoice.id) <> 1
    or current_number_after <> '000-001-01-00000002' then
    raise exception 'Pedido, pago y factura no coinciden: order %, payment %, invoice %, next %',
      to_jsonb(saved_order), to_jsonb(saved_payment), to_jsonb(saved_invoice), current_number_after;
  end if;

  begin
    perform * from public.generate_fiscal_invoice_from_order(target_order_id);
    raise exception 'El reintento emitio una segunda factura';
  exception when others then
    if sqlerrm = 'El reintento emitio una segunda factura' then raise; end if;
  end;

  if (select count(*) from public.invoices where order_id = target_order_id) <> 1
    or (select current_invoice_number from public.fiscal_settings where id = true) <> '000-001-01-00000002' then
    raise exception 'El reintento duplico factura o correlativo';
  end if;
end;
$$;

create or replace function pg_temp.reject_canonical_checkout_update()
returns trigger
language plpgsql
as $$
begin
  if new.calculation_version = 1 then
    raise exception 'POS_FISCAL_TEST_FORCED_FAILURE';
  end if;
  return new;
end;
$$;

create trigger pos_fiscal_test_force_failure
before update of calculation_version on public.orders
for each row
execute function pg_temp.reject_canonical_checkout_update();

do $$
declare
  product_id uuid;
  before_count integer;
  after_count integer;
begin
  select id into product_id
  from public.products
  where active = true and status = 'active'
  order by created_at
  limit 1;

  select count(*) into before_count
  from public.orders
  where email = 'pos_fiscal_test_failure@example.invalid';

  begin
    perform *
    from public.create_checkout_order_v2(
      'POS_FISCAL_TEST_FAILURE',
      'pos_fiscal_test_failure@example.invalid',
      '99990003', null, 'POS_FISCAL_TEST_ADDRESS',
      'retail', 'bank_transfer', 'POS-FISCAL-FAIL',
      jsonb_build_array(jsonb_build_object('product_id', product_id, 'quantity', 1)),
      null, null, null, 'Honduras', 'HN', 'Francisco Morazan', 'Tegucigalpa', 'before_delivery'
    );
    raise exception 'El fallo fiscal forzado no aborto el checkout';
  exception when others then
    if sqlerrm not like '%POS_FISCAL_TEST_FORCED_FAILURE%' then
      raise;
    end if;
  end;

  select count(*) into after_count
  from public.orders
  where email = 'pos_fiscal_test_failure@example.invalid';

  if before_count <> after_count
    or exists (select 1 from public.customers where email = 'pos_fiscal_test_failure@example.invalid')
    or exists (select 1 from public.payments where order_id in (select id from public.orders where email = 'pos_fiscal_test_failure@example.invalid'))
    or exists (select 1 from public.inventory_reservations where order_id in (select id from public.orders where email = 'pos_fiscal_test_failure@example.invalid')) then
    raise exception 'El fallo fiscal dejo residuos parciales';
  end if;
end;
$$;

drop trigger pos_fiscal_test_force_failure on public.orders;

rollback;

do $$
begin
  if exists (select 1 from public.orders where customer_name like 'POS_FISCAL_TEST_%')
    or exists (select 1 from public.customers where contact_name like 'POS_FISCAL_TEST_%')
    or exists (select 1 from auth.users where email like 'pos_fiscal_test_%@example.invalid') then
    raise exception 'Quedaron fixtures POS_FISCAL_TEST_ despues del rollback';
  end if;
end;
$$;

\echo 'POS_FISCAL_TEST_ canonical fiscal and checkout integration checks passed; residue is zero.'
