create or replace function public.fiscal_invoice_number_value(raw_value text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select nullif(regexp_replace(coalesce(raw_value, ''), '\D', '', 'g'), '')::numeric;
$$;

create or replace function public.increment_fiscal_invoice_number(raw_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  matched_digits text;
  matched_position integer;
  next_digits text;
begin
  select matches[1]
  into matched_digits
  from regexp_matches(raw_value, '([0-9]+)', 'g') with ordinality as matched(matches, ordinal)
  order by matched.ordinal desc
  limit 1;

  if matched_digits is null then
    return raw_value;
  end if;

  matched_position := length(raw_value) - strpos(reverse(raw_value), reverse(matched_digits)) - length(matched_digits) + 2;
  next_digits := lpad((matched_digits::numeric + 1)::text, length(matched_digits), '0');

  return substring(raw_value from 1 for matched_position - 1)
    || next_digits
    || substring(raw_value from matched_position + length(matched_digits));
end;
$$;

create or replace function public.generate_fiscal_invoice_from_order(target_order_id uuid)
returns table (
  invoice_id uuid,
  invoice_number text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  fiscal_record public.fiscal_settings%rowtype;
  order_record record;
  new_invoice_id uuid := gen_random_uuid();
  v_current_invoice_number text;
  v_next_invoice_number text;
  current_number_value numeric;
  range_start_value numeric;
  range_end_value numeric;
  inserted_invoice_item_count integer := 0;
begin
  if not (
    public.has_permission('invoices:create')
    or public.has_permission('invoices:manage')
  ) then
    raise exception 'No tienes permiso para generar facturas fiscales.';
  end if;

  if target_order_id is null then
    raise exception 'Selecciona un pedido para generar la factura.';
  end if;

  select *
  into fiscal_record
  from public.fiscal_settings
  where id = true
  for update;

  if fiscal_record.id is null then
    raise exception 'Error fiscal: configura los datos fiscales antes de generar facturas.';
  end if;

  v_current_invoice_number := trim(coalesce(fiscal_record.current_invoice_number, ''));
  current_number_value := public.fiscal_invoice_number_value(v_current_invoice_number);
  range_start_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_start);
  range_end_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_end);

  if trim(coalesce(fiscal_record.cai, '')) = '' then
    raise exception 'Error fiscal: configura un CAI autorizado antes de generar facturas.';
  end if;

  if v_current_invoice_number = ''
    or trim(coalesce(fiscal_record.invoice_range_start, '')) = ''
    or trim(coalesce(fiscal_record.invoice_range_end, '')) = ''
    or current_number_value is null
    or range_start_value is null
    or range_end_value is null
  then
    raise exception 'Error fiscal: configura el numero actual y el rango autorizado antes de generar facturas.';
  end if;

  if range_start_value > range_end_value then
    raise exception 'Error fiscal: el rango inicial no puede ser mayor que el rango final autorizado.';
  end if;

  if current_number_value < range_start_value or current_number_value > range_end_value then
    raise exception 'Error fiscal: el numero actual esta fuera del rango autorizado.';
  end if;

  if fiscal_record.emission_deadline is null then
    raise exception 'Error fiscal: configura la fecha limite de emision del CAI.';
  end if;

  if fiscal_record.emission_deadline < current_date then
    raise exception 'Error fiscal: la fecha limite de emision del CAI esta vencida.';
  end if;

  if exists (
    select 1
    from public.invoices
    where invoices.invoice_number = v_current_invoice_number
  ) then
    raise exception 'Error fiscal: el numero de factura % ya existe.', v_current_invoice_number;
  end if;

  if exists (
    select 1
    from public.invoices
    where invoices.order_id = target_order_id
  ) then
    raise exception 'Error fiscal: este pedido ya tiene factura.';
  end if;

  select
    orders.id,
    orders.order_number,
    orders.customer_id,
    orders.customer_name,
    orders.payment_method,
    orders.price_mode,
    orders.subtotal,
    orders.tax,
    orders.total,
    customers.tax_id as customer_rtn
  into order_record
  from public.orders
  left join public.customers on customers.id = orders.customer_id
  where orders.id = target_order_id
  for update of orders;

  if order_record.id is null then
    raise exception 'No se encontro el pedido.';
  end if;

  if not exists (
    select 1
    from public.order_items
    where order_items.order_id = target_order_id
  ) then
    raise exception 'El pedido no tiene productos para facturar.';
  end if;

  insert into public.invoices (
    id,
    order_id,
    customer_id,
    invoice_number,
    rtn,
    cai,
    customer_rtn,
    status,
    price_mode,
    subtotal,
    tax,
    total,
    issued_at,
    due_at,
    company_legal_name,
    company_rtn,
    company_address,
    company_phone,
    company_email,
    company_logo_url,
    fiscal_range_start,
    fiscal_range_end
  )
  values (
    new_invoice_id,
    order_record.id,
    order_record.customer_id,
    v_current_invoice_number,
    fiscal_record.rtn,
    fiscal_record.cai,
    order_record.customer_rtn,
    'emitida',
    order_record.price_mode,
    order_record.subtotal,
    order_record.tax,
    order_record.total,
    now(),
    fiscal_record.emission_deadline,
    fiscal_record.legal_name,
    fiscal_record.rtn,
    fiscal_record.fiscal_address,
    fiscal_record.phone,
    fiscal_record.email,
    fiscal_record.logo_url,
    fiscal_record.invoice_range_start,
    fiscal_record.invoice_range_end
  );

  insert into public.invoice_items (
    invoice_id,
    order_item_id,
    product_id,
    sku,
    product_name,
    quantity,
    unit_price,
    line_total,
    retail_price_snapshot,
    wholesale_price_snapshot
  )
  select
    new_invoice_id,
    order_items.id,
    order_items.product_id,
    order_items.sku,
    order_items.product_name,
    order_items.quantity,
    order_items.unit_price,
    order_items.line_total,
    order_items.retail_price_snapshot,
    order_items.wholesale_price_snapshot
  from public.order_items
  where order_items.order_id = target_order_id;

  get diagnostics inserted_invoice_item_count = row_count;

  if inserted_invoice_item_count = 0 then
    raise exception 'El pedido no tiene productos para facturar.';
  end if;

  v_next_invoice_number := public.increment_fiscal_invoice_number(v_current_invoice_number);

  update public.fiscal_settings
  set
    current_invoice_number = v_next_invoice_number,
    updated_at = now()
  where id = true
    and public.fiscal_settings.current_invoice_number = v_current_invoice_number;

  if not found then
    raise exception 'Error fiscal: el correlativo fiscal cambio antes de finalizar.';
  end if;

  insert into public.audit_logs (
    user_id,
    table_name,
    record_id,
    action,
    new_data
  )
  values (
    current_user_id,
    'invoices',
    new_invoice_id,
    'fiscal.invoice.created',
    jsonb_build_object(
      'invoice_id', new_invoice_id,
      'invoice_number', v_current_invoice_number,
      'order_id', order_record.id,
      'order_number', order_record.order_number,
      'customer_id', order_record.customer_id,
      'customer_name', order_record.customer_name,
      'customer_rtn', order_record.customer_rtn,
      'cai', fiscal_record.cai,
      'company_rtn', fiscal_record.rtn,
      'fiscal_range_start', fiscal_record.invoice_range_start,
      'fiscal_range_end', fiscal_record.invoice_range_end,
      'previous_invoice_number', v_current_invoice_number,
      'next_invoice_number', v_next_invoice_number,
      'subtotal', order_record.subtotal,
      'tax', order_record.tax,
      'total', order_record.total,
      'price_mode', order_record.price_mode,
      'payment_method', order_record.payment_method,
      'item_count', inserted_invoice_item_count
    )
  );

  invoice_id := new_invoice_id;
  invoice_number := v_current_invoice_number;
  return next;
end;
$$;

grant execute on function public.generate_fiscal_invoice_from_order(uuid) to authenticated;
