-- Allow the service-only V2 idempotency wrapper to invoke the canonical
-- fiscal transaction without impersonating a human. Authenticated behavior and
-- all fiscal locks, validations, audit, invoice and correlativo writes remain unchanged.
create or replace function public.generate_fiscal_invoice_from_order(target_order_id uuid)
returns table (invoice_id uuid, invoice_number text)
language plpgsql
security definer
set search_path = public, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
  fiscal_record public.fiscal_settings%rowtype;
  order_record public.orders%rowtype;
  payment_record record;
  effective_invoice_date date;
  new_invoice_id uuid := gen_random_uuid();
  v_current_invoice_number text;
  v_next_invoice_number text;
  current_number_value numeric;
  range_start_value numeric;
  range_end_value numeric;
  inserted_invoice_item_count integer := 0;
begin
  if not service_call and not (public.has_permission('invoices:create') or public.has_permission('invoices:manage')) then
    raise exception using errcode = '42501', message = 'No tienes permiso para generar facturas fiscales.';
  end if;
  if target_order_id is null then
    raise exception using errcode = '22023', message = 'Selecciona un pedido para generar la factura.';
  end if;

  select orders.* into order_record
  from public.orders where orders.id = target_order_id for update;
  if order_record.id is null then raise exception 'No se encontro el pedido.'; end if;
  if order_record.status::text not in (
    'confirmed', 'confirmado', 'paid', 'preparacion', 'preparing', 'empacado',
    'enviado', 'shipped', 'en_ruta', 'entregado', 'delivered'
  ) then
    raise exception 'No se puede emitir factura porque el pedido aun no esta confirmado.';
  end if;
  if exists (select 1 from public.invoices where order_id = target_order_id) then
    raise exception 'Error fiscal: este pedido ya tiene factura.';
  end if;

  select payments.id,
         coalesce(payments.payment_status::text, payments.status::text) payment_status,
         payments.payment_method, payments.bank_reference_number, payments.paid_at
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;
  if payment_record.id is null then raise exception 'No se encontro el registro de pago del pedido.'; end if;
  if order_record.payment_method::text <> 'commercial_credit'
    and payment_record.payment_status not in ('approved', 'confirmed', 'paid') then
    raise exception 'No se puede emitir factura porque el pago aun no ha sido confirmado.';
  end if;

  select * into fiscal_record from public.fiscal_settings where id = true for update;
  if fiscal_record.id is null then raise exception 'Error fiscal: configura los datos fiscales antes de generar facturas.'; end if;
  effective_invoice_date := coalesce(order_record.requested_invoice_date, today_hn);

  if effective_invoice_date > today_hn then raise exception 'La fecha de factura no puede ser futura en Honduras.'; end if;
  if fiscal_record.cai_authorization_date is null then raise exception 'Error fiscal: configura la fecha de autorizacion del CAI.'; end if;
  if fiscal_record.emission_deadline is null then raise exception 'Error fiscal: configura la fecha limite de emision del CAI.'; end if;
  if effective_invoice_date < fiscal_record.cai_authorization_date
    or effective_invoice_date > fiscal_record.emission_deadline then
    raise exception 'La fecha de factura esta fuera de la vigencia fiscal configurada.';
  end if;
  if public.is_date_in_closed_accounting_period(effective_invoice_date) then
    raise exception 'La fecha de factura pertenece a un periodo contable cerrado.';
  end if;
  if fiscal_record.emission_deadline < today_hn then
    raise exception 'Error fiscal: la fecha limite de emision del CAI esta vencida.';
  end if;
  if trim(coalesce(fiscal_record.cai, '')) = '' then
    raise exception 'Error fiscal: configura un CAI autorizado antes de generar facturas.';
  end if;
  if order_record.calculation_version is distinct from 1 then
    raise exception 'El pedido no tiene un snapshot monetario canonico confirmado.';
  end if;
  if not exists (select 1 from public.order_items where order_id = target_order_id) then
    raise exception 'El pedido no tiene productos para facturar.';
  end if;
  if exists (
    select 1 from public.order_items
    where order_id = target_order_id
      and (
        unit_price <= 0
        or (unit_cost_snapshot is not null and unit_cost_snapshot > 0 and unit_price < unit_cost_snapshot)
        or line_total <> round(unit_price * quantity, 2)
      )
  ) then
    raise exception 'Las lineas del pedido no tienen precios, costos o snapshots validos para facturar.';
  end if;

  v_current_invoice_number := trim(coalesce(fiscal_record.current_invoice_number, ''));
  current_number_value := public.fiscal_invoice_number_value(v_current_invoice_number);
  range_start_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_start);
  range_end_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_end);
  if v_current_invoice_number = ''
    or current_number_value is null or range_start_value is null or range_end_value is null then
    raise exception 'Error fiscal: configura el numero actual y el rango autorizado antes de generar facturas.';
  end if;
  if range_start_value > range_end_value then raise exception 'Error fiscal: el rango fiscal configurado no es valido.'; end if;
  if current_number_value < range_start_value or current_number_value > range_end_value then
    raise exception 'Error fiscal: el numero actual esta fuera del rango autorizado.';
  end if;
  if exists (select 1 from public.invoices existing_invoice where existing_invoice.invoice_number = v_current_invoice_number) then
    raise exception 'Error fiscal: el numero de factura % ya existe.', v_current_invoice_number;
  end if;

  insert into public.invoices (
    id, order_id, customer_id, invoice_number, rtn, cai, cai_authorization_date,
    invoice_date, customer_rtn, customer_name, customer_phone, customer_email,
    customer_address, status, price_mode, subtotal, tax, shipping_fee,
    cash_on_delivery_fee, small_order_fee, discount_total, additional_fees,
    total, calculation_version, issued_at, due_at, company_legal_name, company_rtn,
    company_address, company_phone, company_email, company_logo_url,
    fiscal_range_start, fiscal_range_end
  )
  values (
    new_invoice_id, order_record.id, order_record.customer_id, v_current_invoice_number,
    fiscal_record.rtn, fiscal_record.cai, fiscal_record.cai_authorization_date,
    effective_invoice_date, order_record.fiscal_customer_rtn,
    coalesce(order_record.fiscal_customer_name, order_record.customer_name),
    coalesce(order_record.fiscal_customer_phone, order_record.customer_phone, order_record.phone),
    coalesce(order_record.fiscal_customer_email, order_record.email),
    coalesce(order_record.fiscal_customer_address, order_record.delivery_address),
    'emitida', order_record.price_mode, order_record.subtotal, order_record.tax,
    coalesce(order_record.shipping_fee, order_record.shipping_total, 0),
    coalesce(order_record.cash_on_delivery_fee, 0), coalesce(order_record.small_order_fee, 0),
    coalesce(order_record.discount_total, 0), coalesce(order_record.additional_fees, '[]'::jsonb),
    order_record.total, order_record.calculation_version, now(), fiscal_record.emission_deadline,
    fiscal_record.legal_name, fiscal_record.rtn, fiscal_record.fiscal_address,
    fiscal_record.phone, fiscal_record.email, fiscal_record.logo_url,
    fiscal_record.invoice_range_start, fiscal_record.invoice_range_end
  );

  insert into public.invoice_items (
    invoice_id, order_item_id, product_id, sku, product_name, quantity,
    unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot
  )
  select new_invoice_id, id, product_id, sku, product_name, quantity,
         unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot
  from public.order_items where order_id = target_order_id order by id;
  get diagnostics inserted_invoice_item_count = row_count;

  update public.accounts_receivable receivable
  set invoice_id = new_invoice_id, updated_at = now()
  where receivable.order_id = target_order_id and receivable.invoice_id is null;

  v_next_invoice_number := public.increment_fiscal_invoice_number(v_current_invoice_number);
  update public.fiscal_settings
  set current_invoice_number = v_next_invoice_number, updated_at = now()
  where id = true and current_invoice_number = v_current_invoice_number;
  if not found then raise exception 'Error fiscal: el correlativo fiscal cambio antes de finalizar.'; end if;

  perform public.write_audit_log(
    'invoices', new_invoice_id, 'fiscal.invoice.created', null,
    jsonb_build_object(
      'invoice_id', new_invoice_id, 'invoice_number', v_current_invoice_number,
      'order_id', order_record.id, 'order_number', order_record.order_number,
      'invoice_date', effective_invoice_date, 'issued_at', now(),
      'cai_authorization_date', fiscal_record.cai_authorization_date,
      'emission_deadline', fiscal_record.emission_deadline,
      'previous_invoice_number', v_current_invoice_number,
      'next_invoice_number', v_next_invoice_number,
      'subtotal', order_record.subtotal, 'tax', order_record.tax,
      'shipping_fee', coalesce(order_record.shipping_fee, order_record.shipping_total, 0),
      'total', order_record.total, 'item_count', inserted_invoice_item_count
    )
  );

  invoice_id := new_invoice_id;
  invoice_number := v_current_invoice_number;
  return next;
end;
$$;

revoke all on function public.generate_fiscal_invoice_from_order(uuid)
  from public, anon, authenticated;
grant execute on function public.generate_fiscal_invoice_from_order(uuid)
  to service_role;
