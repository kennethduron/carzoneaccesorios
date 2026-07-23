-- POS phase 2B: one deterministic monetary contract for checkout and future
-- internal sales. Current catalog prices include ISV. Delivery, cash-on-delivery,
-- minimum-order and additional charges keep their established non-taxable
-- treatment and remain separate from merchandise thresholds.
--
-- Logical rollback: revoke the new RPCs, restore the previous checkout_v2
-- definition from the preceding migrations, drop the validation trigger and
-- helper functions, then drop the nullable calculation_version columns. No
-- existing row is rewritten by this migration.

alter table public.orders
  add column if not exists calculation_version integer;

alter table public.invoices
  add column if not exists calculation_version integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_calculation_version_check'
  ) then
    alter table public.orders
      add constraint orders_calculation_version_check
      check (calculation_version is null or calculation_version > 0) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_calculation_version_check'
  ) then
    alter table public.invoices
      add constraint invoices_calculation_version_check
      check (calculation_version is null or calculation_version > 0) not valid;
  end if;
end;
$$;

alter table public.orders validate constraint orders_calculation_version_check;
alter table public.invoices validate constraint invoices_calculation_version_check;

comment on column public.orders.calculation_version is
  'Version of the canonical monetary calculation. Null identifies legacy rows; checkout unified by phase 2B uses version 1.';
comment on column public.invoices.calculation_version is
  'Invoice snapshot of the order monetary calculation version. Null identifies a legacy invoice.';

create or replace function public.calculate_sale_financials_v1(
  resolved_lines jsonb,
  included_tax_rate numeric,
  global_discount numeric default 0,
  delivery_charge numeric default 0,
  cash_on_delivery_charge numeric default 0,
  minimum_order_charge numeric default 0,
  additional_charges jsonb default '[]'::jsonb,
  wholesale_minimum numeric default 10000,
  free_delivery_threshold numeric default 3000,
  suggested_delivery_charge numeric default 120,
  delivery_mode text default 'home_delivery',
  customer_type text default 'retail',
  currency_code text default 'HNL'
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  line_record record;
  line_gross numeric(14, 2);
  line_discount numeric(14, 2);
  merchandise_gross numeric(14, 2) := 0;
  line_discounts numeric(14, 2) := 0;
  normalized_global_discount numeric(14, 2) := round(coalesce(global_discount, 0), 2);
  discount_total numeric(14, 2);
  merchandise_final numeric(14, 2);
  merchandise_taxable_base numeric(14, 2);
  merchandise_tax numeric(14, 2);
  normalized_delivery numeric(14, 2) := round(coalesce(delivery_charge, 0), 2);
  normalized_cash_on_delivery numeric(14, 2) := round(coalesce(cash_on_delivery_charge, 0), 2);
  normalized_minimum_order numeric(14, 2) := round(coalesce(minimum_order_charge, 0), 2);
  normalized_additional numeric(14, 2) := 0;
  normalized_wholesale_minimum numeric(14, 2) := round(coalesce(wholesale_minimum, 10000), 2);
  normalized_delivery_threshold numeric(14, 2) := round(coalesce(free_delivery_threshold, 3000), 2);
  normalized_suggested_delivery numeric(14, 2) := round(coalesce(suggested_delivery_charge, 120), 2);
  suggested_delivery numeric(14, 2);
  total_final numeric(14, 2);
  warnings jsonb := '[]'::jsonb;
begin
  if upper(trim(coalesce(currency_code, ''))) <> 'HNL' then
    raise exception using errcode = '22023', message = 'La moneda del calculo debe ser HNL.';
  end if;

  if included_tax_rate is null or included_tax_rate < 0 or included_tax_rate > 1 then
    raise exception using errcode = '22023', message = 'La tasa fiscal incluida no es valida.';
  end if;

  if resolved_lines is null
    or jsonb_typeof(resolved_lines) <> 'array'
    or jsonb_array_length(resolved_lines) = 0 then
    raise exception using errcode = '22023', message = 'El calculo requiere al menos una linea valida.';
  end if;

  if additional_charges is null or jsonb_typeof(additional_charges) <> 'array' then
    raise exception using errcode = '22023', message = 'Los cargos adicionales no tienen un formato valido.';
  end if;

  if normalized_global_discount < 0
    or normalized_delivery < 0
    or normalized_cash_on_delivery < 0
    or normalized_minimum_order < 0
    or normalized_wholesale_minimum < 0
    or normalized_delivery_threshold < 0
    or normalized_suggested_delivery < 0 then
    raise exception using errcode = '22023', message = 'Los importes monetarios no pueden ser negativos.';
  end if;

  if delivery_mode not in ('store_immediate', 'home_delivery', 'cash_on_delivery', 'shipping', 'pickup') then
    raise exception using errcode = '22023', message = 'La modalidad de entrega no es valida.';
  end if;

  if customer_type not in ('retail', 'wholesale_candidate', 'wholesale_existing', 'wholesale') then
    raise exception using errcode = '22023', message = 'El tipo comercial del cliente no es valido.';
  end if;

  for line_record in
    select
      line.value,
      nullif(line.value->>'quantity', '')::numeric as quantity,
      nullif(line.value->>'unit_price', '')::numeric as unit_price,
      coalesce(nullif(line.value->>'discount_amount', '')::numeric, 0) as discount_amount
    from jsonb_array_elements(resolved_lines) as line(value)
  loop
    if jsonb_typeof(line_record.value) <> 'object'
      or line_record.quantity is null
      or line_record.quantity <= 0
      or trunc(line_record.quantity) <> line_record.quantity then
      raise exception using errcode = '22023', message = 'Todas las cantidades deben ser enteros mayores que cero.';
    end if;

    if line_record.unit_price is null or line_record.unit_price < 0 then
      raise exception using errcode = '22023', message = 'Todos los precios unitarios deben ser validos y no negativos.';
    end if;

    line_gross := round(line_record.quantity * line_record.unit_price, 2);
    line_discount := round(line_record.discount_amount, 2);

    if line_discount < 0 or line_discount > line_gross then
      raise exception using errcode = '22023', message = 'El descuento de una linea no puede superar su importe.';
    end if;

    merchandise_gross := round(merchandise_gross + line_gross, 2);
    line_discounts := round(line_discounts + line_discount, 2);
  end loop;

  select coalesce(sum(round(
    case
      when charge.value ? 'amount' then (charge.value->>'amount')::numeric
      when charge.value ? 'total' then (charge.value->>'total')::numeric
      else 0
    end,
    2
  )), 0)
  into normalized_additional
  from jsonb_array_elements(additional_charges) as charge(value);

  if exists (
    select 1
    from jsonb_array_elements(additional_charges) as charge(value)
    where jsonb_typeof(charge.value) <> 'object'
      or (
        charge.value ? 'amount'
        and (charge.value->>'amount')::numeric < 0
      )
      or (
        not (charge.value ? 'amount')
        and charge.value ? 'total'
        and (charge.value->>'total')::numeric < 0
      )
  ) then
    raise exception using errcode = '22023', message = 'Los cargos adicionales no pueden ser negativos.';
  end if;

  normalized_additional := round(coalesce(normalized_additional, 0), 2);
  discount_total := round(line_discounts + normalized_global_discount, 2);

  if discount_total > merchandise_gross then
    raise exception using errcode = '22023', message = 'Los descuentos no pueden producir mercaderia negativa.';
  end if;

  merchandise_final := round(merchandise_gross - discount_total, 2);
  merchandise_taxable_base := case
    when merchandise_final <= 0 or included_tax_rate = 0 then merchandise_final
    else round(merchandise_final / (1 + included_tax_rate), 2)
  end;
  merchandise_tax := round(merchandise_final - merchandise_taxable_base, 2);
  suggested_delivery := case
    when merchandise_final < normalized_delivery_threshold then normalized_suggested_delivery
    else 0
  end;
  total_final := round(
    merchandise_final
    + normalized_delivery
    + normalized_cash_on_delivery
    + normalized_minimum_order
    + normalized_additional,
    2
  );

  if normalized_delivery <> suggested_delivery then
    warnings := warnings || jsonb_build_array('delivery_charge_differs_from_suggestion');
  end if;

  if normalized_cash_on_delivery > 0 and delivery_mode <> 'cash_on_delivery' then
    warnings := warnings || jsonb_build_array('cash_on_delivery_charge_without_matching_delivery_mode');
  end if;

  return jsonb_build_object(
    'calculation_version', 1,
    'currency', 'HNL',
    'tax_rate', included_tax_rate,
    'merchandise_gross_subtotal', merchandise_gross,
    'line_discount_total', line_discounts,
    'global_discount_total', normalized_global_discount,
    'discount_total', discount_total,
    'merchandise_final', merchandise_final,
    'merchandise_taxable_base', merchandise_taxable_base,
    'merchandise_included_tax', merchandise_tax,
    'delivery_charge', normalized_delivery,
    'delivery_taxable_base', 0,
    'delivery_included_tax', 0,
    'cash_on_delivery_charge', normalized_cash_on_delivery,
    'cash_on_delivery_taxable_base', 0,
    'cash_on_delivery_included_tax', 0,
    'minimum_order_charge', normalized_minimum_order,
    'additional_charges_total', normalized_additional,
    'fiscal_subtotal', merchandise_taxable_base,
    'included_tax_total', merchandise_tax,
    'total_final', total_final,
    'wholesale_minimum_base', merchandise_final,
    'meets_wholesale_minimum', merchandise_final >= normalized_wholesale_minimum,
    'delivery_rule_base', merchandise_final,
    'suggested_delivery_charge', suggested_delivery,
    'warnings', warnings
  );
end;
$$;

revoke all on function public.calculate_sale_financials_v1(
  jsonb, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, numeric, numeric, text, text, text
) from public, anon, authenticated;
grant execute on function public.calculate_sale_financials_v1(
  jsonb, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, numeric, numeric, text, text, text
) to service_role;

comment on function public.calculate_sale_financials_v1(
  jsonb, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, numeric, numeric, text, text, text
) is
  'Canonical v1 HNL calculator. Prices include ISV; base=round(gross/(1+rate),2), ISV=round(gross-base,2). Discounts precede thresholds. Logistics remain outside the taxable base.';

create or replace function public.recalculate_checkout_order_financials_v1(
  target_order_id uuid,
  cash_on_delivery_override numeric default null,
  delivery_override numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_order public.orders%rowtype;
  configured_tax_rate numeric(5, 4) := 0.15;
  configured_wholesale_minimum numeric(14, 2) := 10000;
  configured_delivery_threshold numeric(14, 2) := 3000;
  configured_suggested_delivery numeric(14, 2) := 120;
  resolved_lines jsonb;
  persisted_items_total numeric(14, 2);
  result jsonb;
  applied_delivery numeric(14, 2);
  applied_cash_on_delivery numeric(14, 2);
begin
  if target_order_id is null then
    raise exception using errcode = '22023', message = 'Selecciona un pedido para calcular sus importes.';
  end if;

  select orders.*
  into saved_order
  from public.orders
  where orders.id = target_order_id
  for update;

  if saved_order.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el pedido para calcular sus importes.';
  end if;

  select
    coalesce(company_settings.tax_rate, 0.15),
    coalesce(company_settings.first_wholesale_minimum, 10000),
    coalesce(company_settings.free_shipping_threshold, 3000),
    coalesce(company_settings.standard_shipping_fee, 120)
  into configured_tax_rate, configured_wholesale_minimum, configured_delivery_threshold, configured_suggested_delivery
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;


  select
    jsonb_agg(
      jsonb_build_object(
        'quantity', order_items.quantity,
        'unit_price', order_items.unit_price,
        'discount_amount', 0
      )
      order by order_items.id
    ),
    round(coalesce(sum(order_items.line_total), 0), 2)
  into resolved_lines, persisted_items_total
  from public.order_items
  where order_items.order_id = target_order_id;

  if resolved_lines is null then
    raise exception using errcode = '22023', message = 'El pedido no tiene lineas para calcular.';
  end if;

  applied_delivery := round(coalesce(delivery_override, saved_order.shipping_fee, saved_order.shipping_total, 0), 2);
  applied_cash_on_delivery := round(coalesce(cash_on_delivery_override, saved_order.cash_on_delivery_fee, 0), 2);

  result := public.calculate_sale_financials_v1(
    resolved_lines,
    configured_tax_rate,
    coalesce(saved_order.discount_total, 0),
    applied_delivery,
    applied_cash_on_delivery,
    coalesce(saved_order.small_order_fee, 0),
    coalesce(saved_order.additional_fees, '[]'::jsonb),
    configured_wholesale_minimum,
    configured_delivery_threshold,
    configured_suggested_delivery,
    case when saved_order.payment_timing = 'on_delivery' then 'cash_on_delivery' else 'home_delivery' end,
    case when saved_order.price_mode = 'wholesale' then 'wholesale' else 'retail' end,
    'HNL'
  );

  if round((result->>'merchandise_gross_subtotal')::numeric, 2) <> persisted_items_total then
    raise exception using errcode = '22023', message = 'Las lineas persistidas no coinciden con el calculo monetario canonico.';
  end if;

  update public.orders
  set subtotal = (result->>'fiscal_subtotal')::numeric,
      tax = (result->>'included_tax_total')::numeric,
      shipping_fee = (result->>'delivery_charge')::numeric,
      shipping_total = (result->>'delivery_charge')::numeric,
      cash_on_delivery_fee = (result->>'cash_on_delivery_charge')::numeric,
      total = (result->>'total_final')::numeric,
      calculation_version = 1,
      updated_at = now()
  where orders.id = target_order_id;

  update public.payments
  set amount = (result->>'total_final')::numeric,
      updated_at = now()
  where payments.order_id = target_order_id;

  update public.invoices
  set subtotal = (result->>'fiscal_subtotal')::numeric,
      tax = (result->>'included_tax_total')::numeric,
      shipping_fee = (result->>'delivery_charge')::numeric,
      cash_on_delivery_fee = (result->>'cash_on_delivery_charge')::numeric,
      small_order_fee = (result->>'minimum_order_charge')::numeric,
      discount_total = (result->>'discount_total')::numeric,
      additional_fees = coalesce(saved_order.additional_fees, '[]'::jsonb),
      total = (result->>'total_final')::numeric,
      calculation_version = 1,
      updated_at = now()
  where invoices.order_id = target_order_id
    and invoices.status = 'draft';

  update public.accounts_receivable receivable
  set original_amount = (result->>'total_final')::numeric,
      balance_due = (result->>'total_final')::numeric,
      updated_at = now()
  where receivable.order_id = target_order_id
    and receivable.status in ('open', 'overdue')
    and not exists (
      select 1
      from public.accounts_receivable_payments payment
      where payment.receivable_id = receivable.id
        and payment.voided_at is null
    );

  return result;
end;
$$;

revoke all on function public.recalculate_checkout_order_financials_v1(uuid, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.recalculate_checkout_order_financials_v1(uuid, numeric, numeric)
  to service_role;

comment on function public.recalculate_checkout_order_financials_v1(uuid, numeric, numeric) is
  'Private transaction helper that recalculates and persists order, payment, draft invoice and untouched receivable snapshots from the canonical v1 result.';

-- Inject the canonical persistence step into the active checkout wrapper. The
-- wrapper and every nested call share one PostgreSQL transaction; any fiscal
-- exception therefore rolls back customer, order, items, payment, reservation,
-- receivable, email and audit writes together.
do $$
declare
  function_definition text;
  marker text := $marker$
  where invoices.order_id = created_order.order_id
    and invoices.status = 'draft';

  if requested_payment_method = 'commercial_credit' then
$marker$;
  injected text := $injected$
  where invoices.order_id = created_order.order_id
    and invoices.status = 'draft';

  select (
    public.recalculate_checkout_order_financials_v1(
      created_order.order_id,
      case when normalized_payment_timing = 'on_delivery' then 0 else recalculated_cod end,
      null
    )->>'total_final'
  )::numeric
  into recalculated_total;

  if requested_payment_method = 'commercial_credit' then
$injected$;
begin
  select pg_get_functiondef(
    'public.create_checkout_order_v2(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  -- Historical checkout definitions may preserve CRLF line endings depending
  -- on the client that originally applied the migration. Normalize the stored
  -- definition and both replacement payloads before matching so deployment is independent of line endings.
  function_definition := replace(function_definition, chr(13) || chr(10), chr(10));
  marker := replace(marker, chr(13) || chr(10), chr(10));
  injected := replace(injected, chr(13) || chr(10), chr(10));

  if function_definition like '%recalculate_checkout_order_financials_v1(%' then
    return;
  end if;

  if function_definition not like '%' || marker || '%' then
    raise exception 'Could not locate the checkout_v2 fiscal insertion point.';
  end if;

  execute replace(function_definition, marker, injected);
end;
$$;

-- The identity-safe legacy wrapper remains available to the security-definer
-- checkout_v2 implementation and service maintenance only. Browser roles must
-- enter through checkout_v2 so the canonical fiscal step cannot be bypassed.
revoke all on function public.create_checkout_order(
  text, text, text, text, text, public.order_price_mode, public.payment_method,
  text, jsonb, text, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_checkout_order(
  text, text, text, text, text, public.order_price_mode, public.payment_method,
  text, jsonb, text, uuid, text, text, text, text, text
) to service_role;

create or replace function public.validate_invoice_monetary_snapshot_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_order public.orders%rowtype;
begin
  select orders.*
  into source_order
  from public.orders
  where orders.id = new.order_id;

  if source_order.id is null or source_order.calculation_version is null then
    return new;
  end if;

  new.calculation_version := source_order.calculation_version;

  if round(new.subtotal, 2) <> round(source_order.subtotal, 2)
    or round(new.tax, 2) <> round(source_order.tax, 2)
    or round(coalesce(new.shipping_fee, 0), 2) <> round(coalesce(source_order.shipping_fee, source_order.shipping_total, 0), 2)
    or round(coalesce(new.cash_on_delivery_fee, 0), 2) <> round(coalesce(source_order.cash_on_delivery_fee, 0), 2)
    or round(coalesce(new.small_order_fee, 0), 2) <> round(coalesce(source_order.small_order_fee, 0), 2)
    or round(coalesce(new.discount_total, 0), 2) <> round(coalesce(source_order.discount_total, 0), 2)
    or coalesce(new.additional_fees, '[]'::jsonb) <> coalesce(source_order.additional_fees, '[]'::jsonb)
    or round(new.total, 2) <> round(source_order.total, 2) then
    raise exception using errcode = '22023', message = 'La factura no coincide con el snapshot monetario definitivo del pedido.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_invoice_monetary_snapshot_v1_on_insert on public.invoices;
create trigger validate_invoice_monetary_snapshot_v1_on_insert
before insert on public.invoices
for each row
execute function public.validate_invoice_monetary_snapshot_v1();

comment on function public.validate_invoice_monetary_snapshot_v1() is
  'Versioned invoices must copy the definitive order snapshot exactly. Legacy null-version rows remain readable and unchanged.';

create or replace function public.update_checkout_cash_on_delivery_fee_v1(
  target_order_id uuid,
  requested_fee numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  saved_order public.orders%rowtype;
  normalized_fee numeric(14, 2) := round(coalesce(requested_fee, -1), 2);
  result jsonb;
begin
  if actor_id is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin')
    or not (
      public.has_permission('orders:manage')
      or public.has_permission('payments:manage')
      or public.has_permission('crm:manage')
      or public.has_permission('commercial_settings:manage')
    ) then
    raise exception using errcode = '42501', message = 'No tienes permiso para modificar el cargo contra entrega.';
  end if;

  if normalized_fee < 0 then
    raise exception using errcode = '22023', message = 'Ingresa un cargo contra entrega valido.';
  end if;

  select orders.*
  into saved_order
  from public.orders
  where orders.id = target_order_id
  for update;

  if saved_order.id is null then
    raise exception using errcode = 'P0002', message = 'Pedido no encontrado.';
  end if;

  if saved_order.payment_timing <> 'on_delivery' then
    raise exception using errcode = '22023', message = 'Este pedido no usa pago contra entrega.';
  end if;

  if saved_order.status::text in ('cancelado', 'cancelled') then
    raise exception using errcode = '22023', message = 'No se puede modificar el cargo de un pedido cancelado.';
  end if;

  if exists (
    select 1
    from public.invoices
    where invoices.order_id = target_order_id
      and invoices.invoice_number is not null
      and invoices.status::text not in ('anulada', 'cancelled', 'draft')
  ) then
    raise exception using errcode = '22023', message = 'El cargo no puede modificarse porque la factura fiscal ya fue emitida.';
  end if;

  result := public.recalculate_checkout_order_financials_v1(target_order_id, normalized_fee, null);

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role,
    'orders',
    target_order_id,
    'order.cash_on_delivery_fee_updated',
    jsonb_build_object(
      'order_number', saved_order.order_number,
      'cash_on_delivery_fee', saved_order.cash_on_delivery_fee,
      'total', saved_order.total,
      'calculation_version', saved_order.calculation_version
    ),
    jsonb_build_object(
      'order_number', saved_order.order_number,
      'cash_on_delivery_fee', normalized_fee,
      'total', (result->>'total_final')::numeric,
      'calculation_version', 1
    )
  );

  return result;
end;
$$;

revoke all on function public.update_checkout_cash_on_delivery_fee_v1(uuid, numeric)
  from public, anon;
grant execute on function public.update_checkout_cash_on_delivery_fee_v1(uuid, numeric)
  to authenticated;

comment on function public.update_checkout_cash_on_delivery_fee_v1(uuid, numeric) is
  'Authorized atomic update of the current checkout cash-on-delivery charge using the canonical v1 calculator.';
