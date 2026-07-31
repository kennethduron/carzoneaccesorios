\set ON_ERROR_STOP on
begin;

do $$
<<fixture>>
declare
  admin_id uuid := '95300000-0000-4000-8000-000000000001';
  accountant_id uuid := '95300000-0000-4000-8000-000000000002';
  product_id uuid := '95300000-0000-4000-8000-000000000003';
  order_id uuid;
  item_id uuid;
  request_key uuid := '95300000-0000-4000-8000-000000000010';
  preview jsonb;
  result jsonb;
  replay jsonb;
begin
  insert into public.roles (name, description, permissions) values
    ('admin', 'ORDER_PRICE_CONFIRM_ADMIN',
      '["sales:set_invoice_date","sales:override_price","sales:override_delivery","invoices:create"]'::jsonb),
    ('contadora', 'ORDER_PRICE_CONFIRM_ACCOUNTANT', '["invoices:read","reports:read"]'::jsonb)
  on conflict (name) do update set permissions = excluded.permissions;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values
  ('00000000-0000-0000-0000-000000000000', admin_id, 'authenticated', 'authenticated',
   'order_price_confirm_admin@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', accountant_id, 'authenticated', 'authenticated',
   'order_price_confirm_accountant@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
  update public.users set role_id = (select id from public.roles where name = 'admin') where id = admin_id;
  update public.users set role_id = (select id from public.roles where name = 'contadora') where id = accountant_id;

  insert into public.products (
    id, sku, internal_code, slug, name, brand, description, stock, low_stock_threshold,
    min_stock, retail_price, wholesale_price, wholesale_min_quantity, cost_price, status, active,
    category_id
  ) values (
    product_id, 'ORDER-PRICE-CONFIRM-SKU', 'ORDER-PRICE-CONFIRM-CODE', 'order-price-confirm-product',
    'ORDER_PRICE_CONFIRM_PRODUCT', 'TEST', 'Rollback fixture', 20, 2, 2, 1000, 900, 1, 500, 'active', true,
    (select id from public.categories where slug = 'exterior' limit 1)
  );

  insert into public.company_settings (
    id, company_name, currency, tax_rate, invoice_prefix, order_prefix,
    free_shipping_threshold, standard_shipping_fee, first_wholesale_minimum
  ) values (
    '95300000-0000-4000-8000-000000000004', 'ORDER_PRICE_CONFIRM_COMPANY', 'HNL', 0.15,
    'TEST-F', 'TEST', 3000, 120, 10000
  );
  update public.fiscal_settings
  set legal_name = 'ORDER_PRICE_CONFIRM_LEGAL', rtn = '08011999123456', cai = 'ORDER-PRICE-CONFIRM-CAI',
      cai_authorization_date = current_date - 60,
      invoice_range_start = '000-001-01-00000001', invoice_range_end = '000-001-01-00000999',
      current_invoice_number = '000-001-01-00000001', emission_deadline = current_date + 60,
      fiscal_address = 'Tegucigalpa', phone = '99990000', email = 'price-confirm@example.invalid'
  where id = true;

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  select created.order_id into order_id
  from public.create_checkout_order_v2(
    'ORDER_PRICE_CONFIRM_CUSTOMER', 'order_price_confirm_customer@example.invalid', '99990002', null,
    'Tegucigalpa', 'retail', 'bank_transfer', 'ORDER-PRICE-CONFIRM-PENDING',
    jsonb_build_array(jsonb_build_object('product_id', product_id, 'quantity', 2)),
    null, null, null, 'Honduras', 'HN', 'Francisco Morazan', 'Tegucigalpa', 'before_delivery'
  ) created;
  select item.id into item_id from public.order_items item where item.order_id = fixture.order_id;

  update public.order_price_feature_flags
  set enabled = true, updated_by = admin_id, updated_at = now()
  where key = 'order_price_confirmation_modal_v1';

  begin
    perform public.adjust_sale_terms_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, 'car_zone', null, null, null, 0, gen_random_uuid());
    raise exception 'EXPECTED_CONFIRMATION_REQUIRED';
  exception when others then
    if sqlerrm = 'EXPECTED_CONFIRMATION_REQUIRED' or sqlerrm <> 'ORDER_PRICE_CONFIRMATION_REQUIRED' then raise; end if;
  end;

  preview := public.preview_order_price_adjustment_v1(
    order_id, current_date - 1,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
    80, 'car_zone', null, 0, request_key
  );
  if jsonb_array_length(preview->'lines') <> 1
    or preview->'lines'->0->>'sku' <> 'ORDER-PRICE-CONFIRM-SKU'
    or (preview->'lines'->0->>'previous_unit_price')::numeric <> 1000
    or (preview->'lines'->0->>'final_unit_price')::numeric <> 850
    or (preview->'lines'->0->>'unit_difference')::numeric <> -150
    or (preview->'lines'->0->>'total_difference')::numeric <> -300
    or (preview->'lines'->0->>'unit_cost')::numeric <> 500
    or (preview->'lines'->0->>'resulting_unit_margin')::numeric <> 350
    or (preview->'next_financials'->>'merchandise_final')::numeric <> 1700
    or (preview->'next_financials'->>'fiscal_subtotal')::numeric <> 1478.26
    or (preview->'next_financials'->>'included_tax_total')::numeric <> 221.74
    or (preview->'next_financials'->>'total_final')::numeric <> 1780 then
    raise exception 'PREVIEW_MISMATCH_%', preview;
  end if;

  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 499.99)),
      80, 'car_zone', null, 0, gen_random_uuid());
    raise exception 'EXPECTED_BELOW_COST';
  exception when others then
    if sqlerrm = 'EXPECTED_BELOW_COST' or sqlerrm <> 'ORDER_PRICE_BELOW_COST' then raise; end if;
  end;
  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850.001)),
      80, 'car_zone', null, 0, gen_random_uuid());
    raise exception 'EXPECTED_DECIMALS';
  exception when others then
    if sqlerrm = 'EXPECTED_DECIMALS' or sqlerrm <> 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED' then raise; end if;
  end;
  begin
    perform public.confirm_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, 'car_zone', null, null, 0, gen_random_uuid(), '<b>html</b>');
    raise exception 'EXPECTED_NOTE';
  exception when others then
    if sqlerrm = 'EXPECTED_NOTE' or sqlerrm <> 'ORDER_PRICE_NOTE_INVALID' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub', accountant_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', accountant_id, 'role', 'authenticated')::text, true);
  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, 'car_zone', null, 0, gen_random_uuid());
    raise exception 'EXPECTED_UNAUTHORIZED';
  exception when others then
    if sqlerrm = 'EXPECTED_UNAUTHORIZED' or sqlerrm <> 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub', admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  result := public.confirm_order_price_adjustment_v1(
    order_id, current_date - 1,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
    80, 'car_zone', null, null, 0, request_key, 'Precio acordado'
  );
  replay := public.confirm_order_price_adjustment_v1(
    order_id, current_date - 1,
    jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
    80, 'car_zone', null, null, 0, request_key, 'Precio acordado'
  );
  if result <> replay
    or (result->>'commercial_terms_version')::integer <> 1
    or (select unit_price from public.order_items where id = fixture.item_id) <> 850
    or (select count(*) from public.audit_logs where record_id = fixture.order_id and action = 'sale.price_override.confirmed') <> 1
    or (select new_data->>'method' from public.audit_logs where record_id = fixture.order_id and action = 'sale.price_override.confirmed') <> 'confirmation_modal'
    or (select new_data->>'note' from public.audit_logs where record_id = fixture.order_id and action = 'sale.price_override.confirmed') <> 'Precio acordado'
    or (select new_data->>'confirmed' from public.audit_logs where record_id = fixture.order_id and action = 'sale.price_override.confirmed') <> 'true' then
    raise exception 'CONFIRMATION_OR_REPLAY_MISMATCH_%_%', result, replay;
  end if;

  begin
    perform public.confirm_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 850)),
      80, 'car_zone', null, null, 0, request_key, 'Nota diferente');
    raise exception 'EXPECTED_REPLAY_CONFLICT';
  exception when others then
    if sqlerrm = 'EXPECTED_REPLAY_CONFLICT' or sqlerrm not ilike '%datos diferentes%' then raise; end if;
  end;
  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 900)),
      80, 'car_zone', null, 0, gen_random_uuid());
    raise exception 'EXPECTED_VERSION_CONFLICT';
  exception when others then
    if sqlerrm = 'EXPECTED_VERSION_CONFLICT' or sqlerrm <> 'ORDER_PRICE_VERSION_CONFLICT' then raise; end if;
  end;

  update public.payments set payment_status = 'approved', status = 'approved', paid_at = now()
  where public.payments.order_id = fixture.order_id;
  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 900)),
      80, 'car_zone', null, 1, gen_random_uuid());
    raise exception 'EXPECTED_PAYMENT_LOCK';
  exception when others then
    if sqlerrm = 'EXPECTED_PAYMENT_LOCK' or sqlerrm <> 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED' then raise; end if;
  end;

  update public.orders set status = 'entregado' where id = fixture.order_id;
  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 900)),
      80, 'car_zone', null, 1, gen_random_uuid());
    raise exception 'EXPECTED_DELIVERED_LOCK';
  exception when others then
    if sqlerrm = 'EXPECTED_DELIVERED_LOCK' or sqlerrm <> 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED' then raise; end if;
  end;
  update public.orders set status = 'confirmado' where id = fixture.order_id;

  perform public.generate_fiscal_invoice_from_order(order_id);
  begin
    perform public.preview_order_price_adjustment_v1(
      order_id, current_date - 1,
      jsonb_build_array(jsonb_build_object('order_item_id', item_id, 'final_unit_price', 900)),
      80, 'car_zone', null, 1, gen_random_uuid());
    raise exception 'EXPECTED_INVOICE_LOCK';
  exception when others then
    if sqlerrm = 'EXPECTED_INVOICE_LOCK' or sqlerrm <> 'ORDER_ALREADY_INVOICED' then raise; end if;
  end;
end;
$$;

rollback;

do $$
begin
  if exists (select 1 from auth.users where email like 'order_price_confirm_%@example.invalid')
    or exists (select 1 from public.orders where email = 'order_price_confirm_customer@example.invalid')
    or exists (select 1 from public.products where sku = 'ORDER-PRICE-CONFIRM-SKU')
    or exists (select 1 from public.order_price_feature_flags where enabled) then
    raise exception 'ORDER_PRICE_CONFIRM fixtures remained after rollback.';
  end if;
end;
$$;
\echo 'ORDER_PRICE_CONFIRMATION local preview, permission, lock, idempotency, audit and zero-residue checks passed.'
