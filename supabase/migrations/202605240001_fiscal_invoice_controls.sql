alter table public.invoices
  add column if not exists cancelled_by uuid references public.users(id) on delete set null,
  add column if not exists cancellation_reason text;

create index if not exists invoices_cancelled_by_idx
  on public.invoices(cancelled_by)
  where cancelled_by is not null;

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
  payment_record record;
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

  select
    orders.id,
    orders.order_number,
    orders.customer_id,
    orders.customer_name,
    orders.email,
    orders.phone,
    orders.delivery_address,
    orders.payment_method,
    orders.price_mode,
    orders.subtotal,
    orders.tax,
    orders.total,
    orders.status,
    customers.tax_id as customer_rtn
  into order_record
  from public.orders
  left join public.customers on customers.id = orders.customer_id
  where orders.id = target_order_id
  for update of orders;

  if order_record.id is null then
    raise exception 'No se encontro el pedido.';
  end if;

  if order_record.status::text not in (
    'confirmed',
    'confirmado',
    'paid',
    'preparacion',
    'preparing',
    'empacado',
    'enviado',
    'shipped',
    'en_ruta',
    'entregado',
    'delivered'
  ) then
    raise exception 'No se puede emitir factura porque el pago aún no ha sido confirmado.';
  end if;

  select
    payments.id,
    coalesce(payments.payment_status::text, payments.status::text) as payment_status,
    payments.payment_method,
    payments.bank_reference_number,
    payments.paid_at
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;

  if payment_record.id is null
    or payment_record.payment_status not in ('approved', 'confirmed', 'paid')
  then
    raise exception 'No se puede emitir factura porque el pago aún no ha sido confirmado.';
  end if;

  if order_record.payment_method = 'bank_transfer'
    and payment_record.payment_status not in ('approved', 'confirmed', 'paid')
  then
    raise exception 'No se puede emitir factura porque el pago aún no ha sido confirmado.';
  end if;

  if order_record.payment_method = 'card'
    and payment_record.payment_status not in ('approved', 'confirmed', 'paid')
  then
    raise exception 'No se puede emitir factura porque el pago aún no ha sido confirmado.';
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
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
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
    order_record.customer_name,
    order_record.phone,
    order_record.email,
    order_record.delivery_address,
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
      'emission_deadline', fiscal_record.emission_deadline,
      'previous_invoice_number', v_current_invoice_number,
      'next_invoice_number', v_next_invoice_number,
      'subtotal', order_record.subtotal,
      'tax', order_record.tax,
      'total', order_record.total,
      'price_mode', order_record.price_mode,
      'payment_method', order_record.payment_method,
      'payment_status', payment_record.payment_status,
      'item_count', inserted_invoice_item_count
    )
  );

  invoice_id := new_invoice_id;
  invoice_number := v_current_invoice_number;
  return next;
end;
$$;

grant execute on function public.generate_fiscal_invoice_from_order(uuid) to authenticated;

create or replace function public.cancel_fiscal_invoice(
  target_invoice_id uuid,
  cancellation_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invoice_record public.invoices%rowtype;
  normalized_reason text := nullif(trim(coalesce(cancellation_reason, '')), '');
  cancelled_timestamp timestamptz := now();
begin
  if not public.has_permission('invoices:manage') then
    raise exception 'No tienes permiso para anular facturas fiscales.';
  end if;

  if target_invoice_id is null then
    raise exception 'Selecciona una factura para anular.';
  end if;

  if normalized_reason is null or length(normalized_reason) < 8 then
    raise exception 'El motivo de anulacion es obligatorio.';
  end if;

  select *
  into invoice_record
  from public.invoices
  where invoices.id = target_invoice_id
  for update;

  if invoice_record.id is null then
    raise exception 'No se encontro la factura.';
  end if;

  if invoice_record.status::text in ('anulada', 'cancelled') then
    raise exception 'La factura ya esta anulada.';
  end if;

  if invoice_record.status::text not in ('emitida', 'issued', 'paid') then
    raise exception 'Esta factura no esta en un estado permitido para anulacion.';
  end if;

  update public.invoices
  set
    status = 'anulada',
    cancelled_at = cancelled_timestamp,
    cancelled_by = auth.uid(),
    cancellation_reason = normalized_reason,
    updated_at = cancelled_timestamp
  where invoices.id = target_invoice_id;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    auth.uid(),
    public.current_actor_role(),
    'invoices',
    target_invoice_id,
    'fiscal.invoice.cancelled',
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'order_id', invoice_record.order_id,
      'status', invoice_record.status,
      'cancelled_at', invoice_record.cancelled_at,
      'cancelled_by', invoice_record.cancelled_by,
      'cancellation_reason', invoice_record.cancellation_reason,
      'total', invoice_record.total,
      'tax', invoice_record.tax,
      'cai', invoice_record.cai,
      'rtn', invoice_record.rtn
    ),
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'order_id', invoice_record.order_id,
      'status', 'anulada',
      'cancelled_at', cancelled_timestamp,
      'cancelled_by', auth.uid(),
      'cancellation_reason', normalized_reason,
      'changes', jsonb_build_object(
        'status', jsonb_build_object('from', invoice_record.status, 'to', 'anulada'),
        'cancelled_at', jsonb_build_object('from', invoice_record.cancelled_at, 'to', cancelled_timestamp),
        'cancellation_reason', jsonb_build_object('from', invoice_record.cancellation_reason, 'to', normalized_reason)
      )
    )
  );
end;
$$;

grant execute on function public.cancel_fiscal_invoice(uuid, text) to authenticated;

drop function if exists public.update_invoice_customer_data(uuid, text, text, text, text);

create or replace function public.update_invoice_customer_data(
  target_invoice_id uuid,
  corrected_customer_name text,
  corrected_customer_rtn text,
  corrected_customer_phone text,
  corrected_customer_email text,
  corrected_customer_address text,
  correction_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  invoice_record public.invoices%rowtype;
  normalized_customer_name text := nullif(trim(coalesce(corrected_customer_name, '')), '');
  normalized_customer_rtn text := nullif(trim(coalesce(corrected_customer_rtn, '')), '');
  normalized_customer_phone text := nullif(trim(coalesce(corrected_customer_phone, '')), '');
  normalized_customer_email text := lower(nullif(trim(coalesce(corrected_customer_email, '')), ''));
  normalized_customer_address text := nullif(trim(coalesce(corrected_customer_address, '')), '');
  normalized_reason text := nullif(trim(coalesce(correction_reason, '')), '');
begin
  if not (
    public.has_permission('invoices:create')
    or public.has_permission('invoices:manage')
  ) then
    raise exception 'No tienes permiso para corregir datos fiscales del cliente.';
  end if;

  if target_invoice_id is null then
    raise exception 'Selecciona una factura para corregir.';
  end if;

  if normalized_customer_name is null then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_reason is null or length(normalized_reason) < 8 then
    raise exception 'El motivo de correccion es obligatorio.';
  end if;

  select *
  into invoice_record
  from public.invoices
  where invoices.id = target_invoice_id
  for update;

  if invoice_record.id is null then
    raise exception 'No se encontro la factura.';
  end if;

  update public.invoices
  set
    customer_name = normalized_customer_name,
    customer_rtn = normalized_customer_rtn,
    customer_phone = normalized_customer_phone,
    customer_email = normalized_customer_email,
    customer_address = normalized_customer_address,
    updated_at = now()
  where invoices.id = target_invoice_id;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    current_user_id,
    public.current_actor_role(),
    'invoices',
    target_invoice_id,
    'fiscal.invoice.customer_data_corrected',
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'customer_name', invoice_record.customer_name,
      'customer_rtn', invoice_record.customer_rtn,
      'customer_phone', invoice_record.customer_phone,
      'customer_email', invoice_record.customer_email,
      'customer_address', invoice_record.customer_address
    ),
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'customer_name', normalized_customer_name,
      'customer_rtn', normalized_customer_rtn,
      'customer_phone', normalized_customer_phone,
      'customer_email', normalized_customer_email,
      'customer_address', normalized_customer_address,
      'correction_reason', normalized_reason,
      'unchanged_fields', jsonb_build_array('invoice_number', 'cai', 'fiscal_range', 'subtotal', 'tax', 'total', 'products')
    )
  );
end;
$$;

grant execute on function public.update_invoice_customer_data(uuid, text, text, text, text, text, text) to authenticated;
