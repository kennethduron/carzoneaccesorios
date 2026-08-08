-- Atomic POS confirmation with optional, non-taxable charges.
-- No economic record is created until all fiscal, payment, stock and accounting
-- validations pass in this single transaction.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function public.confirm_pos_sale_v1(
  p_draft_id uuid,
  p_request_key uuid,
  p_expected_draft_version bigint,
  p_invoice_date date,
  p_payment_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  draft_record public.pos_sale_drafts%rowtype;
  existing_request public.pos_sale_drafts%rowtype;
  customer_record public.customers%rowtype;
  credit_record public.customer_credit_accounts%rowtype;
  pricing_record record;
  product_record public.products%rowtype;
  line_record public.pos_sale_draft_items%rowtype;
  fiscal_result record;
  payment_method_value public.payment_method;
  payment_reference text;
  transfer_verified boolean := false;
  amount_tendered_value numeric(14,2);
  change_due_value numeric(14,2);
  open_credit numeric(14,2) := 0;
  tax_rate numeric := 0.15;
  base_price numeric(12,2);
  calculation_lines jsonb;
  calculated jsonb;
  payload_hash text;
  result jsonb;
  new_order_id uuid := gen_random_uuid();
  new_payment_id uuid;
  new_receivable_id uuid;
  new_order_number text;
  effective_accounting_at timestamptz;
  today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
  accounting_status_value text := 'not_routed';
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  actor_role := public.current_actor_role();
  if actor_role not in ('technical_owner','business_owner','admin')
    or not public.pos_permission_allowed('pos:confirm_sale') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  if p_draft_id is null or p_request_key is null or p_expected_draft_version is null
    or p_invoice_date is null or p_payment_payload is null
    or jsonb_typeof(p_payment_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'POS_CONFIRMATION_INVALID';
  end if;
  if p_invoice_date > today_hn then
    raise exception using errcode = '22023', message = 'POS_FISCAL_DATE_INVALID';
  end if;

  payload_hash := encode(digest(convert_to(jsonb_build_object(
    'draft_id', p_draft_id,
    'expected_draft_version', p_expected_draft_version,
    'invoice_date', p_invoice_date,
    'payment', p_payment_payload
  )::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('pos:draft:' || p_draft_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('pos:request:' || p_request_key::text, 0));
  select * into draft_record from public.pos_sale_drafts where id = p_draft_id for update;
  if draft_record.id is null then
    raise exception using errcode = 'P0002', message = 'POS_DRAFT_NOT_FOUND';
  end if;
  if draft_record.status = 'confirmed' then
    if draft_record.confirmation_payload_hash = payload_hash then
      return draft_record.confirmation_result || jsonb_build_object('replayed', true);
    end if;
    if draft_record.confirmation_request_key = p_request_key then
      raise exception using errcode = 'PT409', message = 'POS_REQUEST_KEY_CONFLICT';
    end if;
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_ALREADY_CONFIRMED';
  end if;
  if draft_record.status = 'abandoned' then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CANCELLED';
  end if;
  if draft_record.status <> 'active' or draft_record.expires_at <= now() then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_EXPIRED';
  end if;
  if draft_record.version <> p_expected_draft_version then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CHANGED';
  end if;
  if draft_record.owner_user_id <> actor_id
    and not public.pos_permission_allowed('pos:drafts:edit_any') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  select * into existing_request from public.pos_sale_drafts
  where confirmation_request_key = p_request_key and id <> p_draft_id;
  if existing_request.id is not null then
    raise exception using errcode = 'PT409', message = 'POS_REQUEST_KEY_CONFLICT';
  end if;

  select * into customer_record from public.customers
  where id = draft_record.customer_id for update;
  if customer_record.id is null or not customer_record.active
    or customer_record.status <> 'active' or customer_record.merged_into_customer_id is not null then
    raise exception using errcode = 'PT409', message = 'POS_CUSTOMER_INVALID';
  end if;
  if customer_record.commercial_version <> draft_record.customer_commercial_version then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CHANGED';
  end if;
  select * into pricing_record
  from public.resolve_customer_pricing_mode_v1(customer_record.id);
  if pricing_record.pricing_mode is distinct from draft_record.pricing_mode_snapshot
    or pricing_record.commercial_version is distinct from draft_record.customer_commercial_version then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CHANGED';
  end if;

  if not exists (select 1 from public.pos_sale_draft_items where draft_id = p_draft_id) then
    raise exception using errcode = '22023', message = 'POS_DRAFT_EMPTY';
  end if;
  perform products.id
  from public.products products
  join public.pos_sale_draft_items items on items.product_id = products.id
  where items.draft_id = p_draft_id
  order by products.id for update of products;

  select coalesce(settings.tax_rate, 0.15) into tax_rate
  from public.company_settings settings order by settings.created_at limit 1;
  if tax_rate is null or tax_rate < 0 or tax_rate > 1 then
    raise exception using errcode = '22023', message = 'POS_TAX_CONFIGURATION_INVALID';
  end if;

  calculation_lines := '[]'::jsonb;
  for line_record in
    select * from public.pos_sale_draft_items
    where draft_id = p_draft_id order by product_id
  loop
    select * into product_record from public.products where id = line_record.product_id;
    if product_record.id is null or not product_record.active or product_record.status <> 'active' then
      raise exception using errcode = 'PT409', message = 'POS_PRODUCT_INACTIVE';
    end if;
    if product_record.product_sales_version <> line_record.product_sales_version
      or product_record.tax_category <> line_record.tax_category_snapshot
      or product_record.tracks_inventory <> line_record.tracks_inventory_snapshot then
      raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
    end if;
    base_price := case
      when pricing_record.pricing_mode = 'wholesale'
        and line_record.quantity >= product_record.wholesale_min_quantity
        then round(product_record.wholesale_price, 2)
      else round(product_record.retail_price, 2)
    end;
    if line_record.base_unit_price <> base_price then
      raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
    end if;
    if line_record.price_overridden then
      if line_record.price_overridden_by is null
        or nullif(trim(line_record.price_override_reason), '') is null
        or char_length(trim(line_record.price_override_reason)) not between 5 and 500
        or product_record.cost_price <= 0
        or line_record.final_unit_price < product_record.cost_price then
        raise exception using errcode = '42501', message = 'POS_MANUAL_PRICE_DENIED';
      end if;
    elsif line_record.final_unit_price <> base_price then
      raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
    end if;
    if product_record.tracks_inventory
      and line_record.quantity > product_record.stock - coalesce(product_record.reserved_stock, 0) then
      raise exception using errcode = 'PT409', message = 'POS_INSUFFICIENT_STOCK';
    end if;
    calculation_lines := calculation_lines || jsonb_build_array(jsonb_build_object(
      'product_id', product_record.id,
      'quantity', line_record.quantity,
      'unit_price', line_record.final_unit_price,
      'tax_category', product_record.tax_category
    ));
  end loop;

  calculated := public.calculate_pos_draft_financials_v2(
    calculation_lines, tax_rate, draft_record.shipping_fee, draft_record.cod_fee,
    round(draft_record.additional_charge + draft_record.other_charge, 2), 'HNL'
  );
  if (calculated->>'merchandise_total')::numeric <> draft_record.merchandise_gross
    or (calculated->>'taxable_gross')::numeric <> draft_record.taxable_gross
    or (calculated->>'exempt_total')::numeric <> draft_record.exempt_gross
    or (calculated->>'taxable_base')::numeric <> draft_record.taxable_base
    or (calculated->>'tax_total')::numeric <> draft_record.tax_amount
    or (calculated->>'shipping_fee')::numeric <> draft_record.shipping_fee
    or (calculated->>'cod_fee')::numeric <> draft_record.cod_fee
    or (calculated->>'other_charge')::numeric
      <> round(draft_record.additional_charge + draft_record.other_charge, 2)
    or (calculated->>'total')::numeric <> draft_record.grand_total then
    raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
  end if;
  if draft_record.grand_total <= 0 then
    raise exception using errcode = '22023', message = 'POS_CONFIRMATION_INVALID';
  end if;

  begin
    payment_method_value := nullif(trim(p_payment_payload->>'method'), '')::public.payment_method;
  exception when others then
    raise exception using errcode = '22023', message = 'POS_PAYMENT_METHOD_INVALID';
  end;
  if payment_method_value::text not in ('cash','bank_transfer','card','commercial_credit') then
    raise exception using errcode = '22023', message = 'POS_PAYMENT_METHOD_INVALID';
  end if;
  payment_reference := nullif(trim(coalesce(p_payment_payload->>'reference', '')), '');
  if payment_reference is not null and char_length(payment_reference) > 200 then
    raise exception using errcode = '22023', message = 'POS_PAYMENT_REFERENCE_INVALID';
  end if;
  transfer_verified := coalesce((p_payment_payload->>'verified')::boolean, false);
  effective_accounting_at := p_invoice_date::timestamp at time zone 'America/Tegucigalpa';

  if draft_record.shipping_fee > 0 and public.resolve_accounting_mapping_v2(
    'revenue', 'sale_shipping_fee', p_invoice_date
  ) is null then
    raise exception using errcode = '22023', message = 'POS_SHIPPING_MAPPING_INVALID';
  end if;
  if draft_record.cod_fee > 0 and public.resolve_accounting_mapping_v2(
    'revenue', 'sale_cod_fee', p_invoice_date
  ) is null then
    raise exception using errcode = '22023', message = 'POS_COD_MAPPING_INVALID';
  end if;
  if (draft_record.additional_charge > 0 or draft_record.other_charge > 0)
    and public.resolve_accounting_mapping_v2(
      'revenue', 'sale_other_charge', p_invoice_date
    ) is null then
    raise exception using errcode = '22023', message = 'POS_OTHER_CHARGE_MAPPING_INVALID';
  end if;

  if payment_method_value = 'cash' then
    begin
      amount_tendered_value := round((p_payment_payload->>'amount_tendered')::numeric, 2);
    exception when others then
      raise exception using errcode = '22023', message = 'POS_AMOUNT_TENDERED_INSUFFICIENT';
    end;
    if amount_tendered_value < draft_record.grand_total
      or amount_tendered_value > 999999999999.99 then
      raise exception using errcode = '22023', message = 'POS_AMOUNT_TENDERED_INSUFFICIENT';
    end if;
    change_due_value := round(amount_tendered_value - draft_record.grand_total, 2);
  elsif payment_method_value = 'bank_transfer' then
    if not transfer_verified or payment_reference is null then
      raise exception using errcode = '22023', message = 'POS_TRANSFER_REFERENCE_REQUIRED';
    end if;
  elsif payment_method_value = 'card' then
    if not transfer_verified or public.resolve_accounting_mapping_v2(
      'payment_method', 'card', p_invoice_date
    ) is null then
      raise exception using errcode = '22023', message = 'POS_CARD_CONFIGURATION_INVALID';
    end if;
  else
    select * into credit_record from public.customer_credit_accounts
    where customer_id = customer_record.id for update;
    if credit_record.id is null or not credit_record.is_credit_enabled then
      raise exception using errcode = '22023', message = 'POS_CREDIT_DISABLED';
    end if;
    if credit_record.status <> 'active' then
      raise exception using errcode = '22023', message = 'POS_CREDIT_SUSPENDED';
    end if;
    perform receivable.id from public.accounts_receivable receivable
    where receivable.customer_id = customer_record.id
      and receivable.status in ('open','partial','overdue')
    order by receivable.id for update;
    select coalesce(sum(balance_due), 0) into open_credit
    from public.accounts_receivable
    where customer_id = customer_record.id and status in ('open','partial','overdue');
    if round(open_credit + draft_record.grand_total, 2) > credit_record.credit_limit then
      raise exception using errcode = 'PT409', message = 'POS_CREDIT_INSUFFICIENT';
    end if;
  end if;

  insert into public.pos_sale_confirmation_context (
    backend_pid, transaction_id, actor_id, draft_id, request_key
  ) values (pg_backend_pid(), txid_current(), actor_id, p_draft_id, p_request_key);

  new_order_number := 'CZ-POS-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')
    || '-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 6));
  insert into public.orders (
    id, order_number, user_id, customer_id, customer_name, email, phone,
    customer_phone, delivery_address, delivery_country, delivery_country_code,
    delivery_mode, payment_method, payment_timing, price_mode, subtotal, tax,
    shipping_total, shipping_fee, cash_on_delivery_fee, small_order_fee,
    discount_total, additional_fees, total, status, tracking_status,
    public_tracking_enabled, order_reservation_status, email_updates_opt_in,
    email_updates_preference_source, email_updates_updated_at,
    fiscal_customer_name, fiscal_customer_rtn, fiscal_customer_phone,
    fiscal_customer_email, fiscal_customer_address, source, channel, created_by,
    calculation_version, requested_invoice_date, commercial_terms_version,
    pos_draft_id, authorized_by, confirmed_by, authorized_at, confirmed_at
  ) values (
    new_order_id, new_order_number, customer_record.user_id, customer_record.id,
    coalesce(nullif(trim(customer_record.business_name), ''), customer_record.contact_name),
    customer_record.email, coalesce(nullif(trim(customer_record.phone), ''), 'N/D'),
    coalesce(nullif(trim(customer_record.phone), ''), 'N/D'),
    coalesce(nullif(trim(draft_record.delivery_address), ''),
      nullif(trim(customer_record.address), ''), 'Retiro en tienda'),
    'Honduras', 'HN',
    case when draft_record.delivery_mode = 'store_immediate'
      then 'store_pickup' else 'car_zone' end,
    payment_method_value, 'before_delivery',
    draft_record.pricing_mode_snapshot::public.order_price_mode,
    round(draft_record.taxable_base + draft_record.exempt_gross, 2),
    draft_record.tax_amount,
    draft_record.shipping_fee, draft_record.shipping_fee, draft_record.cod_fee,
    0, 0,
    (case when draft_record.additional_charge > 0 then
      jsonb_build_array(jsonb_build_object(
        'label', 'Cargo adicional', 'amount', draft_record.additional_charge
      )) else '[]'::jsonb end)
    ||
    (case when draft_record.other_charge > 0 then
      jsonb_build_array(jsonb_build_object(
        'label', 'Otro cargo', 'amount', draft_record.other_charge
      )) else '[]'::jsonb end),
    draft_record.grand_total, 'confirmado', 'confirmado', false, 'not_required',
    false, 'admin', now(),
    coalesce(nullif(trim(customer_record.business_name), ''), customer_record.contact_name),
    customer_record.tax_id, customer_record.phone, customer_record.email,
    customer_record.address, 'pos', 'store', actor_id, 2, p_invoice_date,
    customer_record.commercial_version, p_draft_id, actor_id, actor_id, now(), now()
  );

  insert into public.order_items (
    order_id, product_id, sku, product_name, quantity, applied_price_mode,
    unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot,
    unit_cost_snapshot, total_cost_snapshot, cost_source, cost_captured_at,
    tax_category_snapshot, tax_rate_snapshot, taxable_base_snapshot,
    tax_amount_snapshot, exempt_amount_snapshot, price_override_reason,
    price_overridden_by, tracks_inventory_snapshot
  )
  select new_order_id, item.product_id, item.sku_snapshot, item.product_name_snapshot,
    item.quantity, item.pricing_source::public.order_price_mode,
    item.final_unit_price, item.line_merchandise_gross,
    product.retail_price, product.wholesale_price, product.cost_price,
    round(product.cost_price * item.quantity, 2), 'product_cost_price_at_pos_confirmation', now(),
    item.tax_category_snapshot, item.tax_rate_snapshot, item.line_taxable_base,
    item.line_tax_amount, item.line_exempt_amount, item.price_override_reason,
    item.price_overridden_by, item.tracks_inventory_snapshot
  from public.pos_sale_draft_items item
  join public.products product on product.id = item.product_id
  where item.draft_id = p_draft_id order by item.product_id;

  if payment_method_value = 'commercial_credit' then
    insert into public.accounts_receivable (
      customer_id, order_id, original_amount, balance_due, due_date, status
    ) values (
      customer_record.id, new_order_id, draft_record.grand_total,
      draft_record.grand_total, p_invoice_date + credit_record.terms_days, 'open'
    ) returning id into new_receivable_id;
    perform public.apply_order_sale_inventory(new_order_id, actor_id);
    perform public.route_accounting_fact_v2(
      'sales_draft_v2', 'sales.recognized', 'order', new_order_id,
      'sale_recognized', 'commercial_credit_on_delivery',
      effective_accounting_at, actor_id
    );
  else
    new_payment_id := gen_random_uuid();
    insert into public.payments (
      id, order_id, customer_id, method, payment_method, status, payment_status,
      amount, payment_timing, reference, bank_reference_number, provider,
      paid_at, confirmed_by
    ) values (
      new_payment_id, new_order_id, customer_record.id, payment_method_value,
      payment_method_value, 'approved', 'approved', draft_record.grand_total,
      'before_delivery', payment_reference,
      case when payment_method_value = 'bank_transfer' then payment_reference else null end,
      'pos_manual_verified', effective_accounting_at, actor_id
    );
  end if;

  select * into fiscal_result
  from public.generate_fiscal_invoice_from_order(new_order_id);

  select coalesce(string_agg(distinct status, ',' order by status), 'not_routed')
  into accounting_status_value
  from public.accounting_outbox_v2
  where (source_type = 'order' and source_id = new_order_id)
     or (source_type = 'inventory_movement' and source_id in (
       select id from public.inventory_movements
       where reference_type = 'orders' and reference_id = new_order_id
     ));

  result := jsonb_build_object(
    'status', 'confirmed', 'replayed', false,
    'draft_id', p_draft_id, 'order_id', new_order_id,
    'order_number', new_order_number, 'invoice_id', fiscal_result.invoice_id,
    'invoice_number', fiscal_result.invoice_number, 'payment_id', new_payment_id,
    'receivable_id', new_receivable_id, 'total', draft_record.grand_total,
    'payment_method', payment_method_value, 'amount_tendered', amount_tendered_value,
    'change_due', change_due_value, 'invoice_date', p_invoice_date,
    'charges', jsonb_build_object(
      'shipping_fee', draft_record.shipping_fee,
      'cash_on_delivery_fee', draft_record.cod_fee,
      'additional_charge', draft_record.additional_charge,
      'other_charge', draft_record.other_charge
    ),
    'receipt_reference', 'POS-' || new_order_number,
    'accounting_status', accounting_status_value
  );

  update public.pos_sale_drafts
  set status = 'confirmed', version = version + 1,
      confirmation_request_key = p_request_key,
      confirmation_payload_hash = payload_hash,
      confirmed_at = now(), confirmed_by = actor_id,
      order_id = new_order_id, invoice_id = fiscal_result.invoice_id,
      payment_id = new_payment_id, receivable_id = new_receivable_id,
      confirmed_invoice_date = p_invoice_date,
      confirmed_payment_method = payment_method_value,
      amount_tendered = amount_tendered_value, change_due = change_due_value,
      confirmation_result = result, updated_at = now(), last_saved_by = actor_id
  where id = p_draft_id and status = 'active';
  if not found then
    raise exception using errcode = 'PT409', message = 'POS_CONFIRMATION_CONFLICT';
  end if;

  perform public.write_audit_log(
    'pos_sale_drafts', p_draft_id, 'pos.sale.confirmed',
    jsonb_build_object('status', draft_record.status, 'version', draft_record.version),
    jsonb_build_object(
      'status', 'confirmed', 'version', draft_record.version + 1,
      'request_key', p_request_key, 'order_id', new_order_id,
      'invoice_id', fiscal_result.invoice_id, 'payment_id', new_payment_id,
      'receivable_id', new_receivable_id, 'payment_method', payment_method_value,
      'invoice_date', p_invoice_date,
      'shipping_fee', draft_record.shipping_fee,
      'cash_on_delivery_fee', draft_record.cod_fee,
      'additional_charge', draft_record.additional_charge,
      'other_charge', draft_record.other_charge,
      'grand_total', draft_record.grand_total,
      'actor_id', actor_id, 'actor_role', actor_role
    )
  );
  delete from public.pos_sale_confirmation_context
  where backend_pid = pg_backend_pid() and transaction_id = txid_current()
    and draft_id = p_draft_id;
  return result;
end;
$$;

revoke all on function public.confirm_pos_sale_v1(uuid, uuid, bigint, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.confirm_pos_sale_v1(uuid, uuid, bigint, date, jsonb)
  to service_role;

commit;
