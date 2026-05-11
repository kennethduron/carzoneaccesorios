alter table public.invoices
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists customer_email text,
  add column if not exists customer_address text;

update public.invoices
set
  customer_name = coalesce(invoices.customer_name, orders.customer_name),
  customer_phone = coalesce(invoices.customer_phone, orders.phone),
  customer_email = coalesce(invoices.customer_email, orders.email),
  customer_address = coalesce(invoices.customer_address, orders.delivery_address)
from public.orders
where orders.id = invoices.order_id;

drop function if exists public.create_checkout_order(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text
);

create or replace function public.create_checkout_order(
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_rtn text,
  delivery_address text,
  requested_price_mode public.order_price_mode,
  requested_payment_method public.payment_method,
  bank_reference_number text,
  order_items jsonb,
  wholesale_code text default null,
  wholesale_code_id uuid default null,
  transfer_receipt_url text default null
)
returns table (
  order_id uuid,
  order_number text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  linked_customer_id uuid;
  linked_wholesale_code_id uuid;
  wholesale_minimum_order numeric(12, 2) := 0;
  normalized_customer_name text := trim(coalesce(customer_name, ''));
  normalized_customer_email text := nullif(trim(coalesce(customer_email, '')), '');
  normalized_customer_phone text := trim(coalesce(customer_phone, ''));
  normalized_customer_rtn text := nullif(trim(coalesce(customer_rtn, '')), '');
  normalized_delivery_address text := trim(coalesce(delivery_address, ''));
  normalized_bank_reference text := nullif(trim(coalesce(bank_reference_number, '')), '');
  normalized_transfer_receipt_url text := nullif(trim(coalesce(transfer_receipt_url, '')), '');
  tax_rate numeric(5, 4) := 0.1500;
  subtotal_amount numeric(12, 2) := 0;
  tax_amount numeric(12, 2) := 0;
  total_amount numeric(12, 2) := 0;
  new_order_id uuid := gen_random_uuid();
  new_order_number text;
  expected_item_count integer := 0;
  locked_item_count integer := 0;
  stock_update_count integer := 0;
  item_record record;
  wholesale_record record;
  payment_notice text;
begin
  if normalized_customer_name = '' then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_customer_phone = '' then
    raise exception 'El telefono del cliente es obligatorio.';
  end if;

  if normalized_delivery_address = '' then
    raise exception 'La direccion de entrega es obligatoria.';
  end if;

  if requested_payment_method = 'bank_transfer' and normalized_bank_reference is null then
    raise exception 'Debes ingresar el numero de referencia de la transferencia.';
  end if;

  if order_items is null or jsonb_typeof(order_items) <> 'array' or jsonb_array_length(order_items) = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  create temporary table if not exists checkout_items_temp (
    product_id uuid primary key,
    quantity integer not null check (quantity > 0)
  ) on commit drop;

  truncate table checkout_items_temp;

  insert into checkout_items_temp (product_id, quantity)
  select
    raw_items.product_id::uuid,
    sum(raw_items.quantity)::integer
  from jsonb_to_recordset(order_items) as raw_items(product_id text, quantity numeric)
  where raw_items.product_id is not null
    and raw_items.quantity is not null
    and raw_items.quantity > 0
  group by raw_items.product_id::uuid;

  select count(*) into expected_item_count from checkout_items_temp;

  if expected_item_count = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  if requested_price_mode = 'wholesale' then
    if nullif(trim(coalesce(wholesale_code, '')), '') is null or wholesale_code_id is null then
      raise exception 'Debes validar un codigo mayorista antes de comprar con precio mayorista.';
    end if;

    select
      wc.id,
      wc.customer_id,
      wc.minimum_order
    into wholesale_record
    from public.wholesale_codes wc
    join public.customers c on c.id = wc.customer_id
    where wc.code = upper(trim(wholesale_code))
      and wc.id = wholesale_code_id
      and wc.active = true
      and wc.status = 'active'
      and (wc.starts_at is null or wc.starts_at <= now())
      and (wc.expires_at is null or wc.expires_at >= now())
      and (wc.max_uses is null or wc.used_count < wc.max_uses)
      and c.active = true
      and c.is_wholesale = true
    limit 1
    for update of wc;

    if not found then
      raise exception 'Codigo mayorista invalido, inactivo, vencido, sin usos disponibles o sin cliente mayorista valido.';
    end if;

    linked_wholesale_code_id := wholesale_record.id;
    linked_customer_id := wholesale_record.customer_id;
    wholesale_minimum_order := coalesce(wholesale_record.minimum_order, 0);
  end if;

  if current_user_id is not null and linked_customer_id is null then
    select customers.id
    into linked_customer_id
    from public.customers
    where customers.user_id = current_user_id
    order by customers.created_at desc
    limit 1;
  end if;

  if linked_customer_id is null then
    select customers.id
    into linked_customer_id
    from public.customers
    where (normalized_customer_email is not null and lower(customers.email) = lower(normalized_customer_email))
       or customers.phone = normalized_customer_phone
       or (normalized_customer_rtn is not null and customers.tax_id = normalized_customer_rtn)
    order by customers.created_at desc
    limit 1;
  end if;

  if linked_customer_id is null then
    insert into public.customers (
      user_id,
      contact_name,
      email,
      phone,
      tax_id,
      address,
      is_wholesale,
      active,
      notes
    )
    values (
      current_user_id,
      normalized_customer_name,
      normalized_customer_email,
      normalized_customer_phone,
      normalized_customer_rtn,
      normalized_delivery_address,
      requested_price_mode = 'wholesale',
      true,
      'Cliente creado automaticamente desde checkout invitado'
    )
    returning id into linked_customer_id;
  else
    update public.customers
    set
      contact_name = normalized_customer_name,
      email = coalesce(normalized_customer_email, customers.email),
      phone = normalized_customer_phone,
      tax_id = coalesce(normalized_customer_rtn, customers.tax_id),
      address = normalized_delivery_address,
      is_wholesale = customers.is_wholesale or requested_price_mode = 'wholesale',
      active = true,
      updated_at = now()
    where customers.id = linked_customer_id;
  end if;

  select coalesce(company_settings.tax_rate, 0.1500)
  into tax_rate
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  tax_rate := coalesce(tax_rate, 0.1500);

  select count(*)
  into locked_item_count
  from checkout_items_temp checkout_items
  join public.products on products.id = checkout_items.product_id
  where products.active = true
    and products.status = 'active';

  if locked_item_count <> expected_item_count then
    raise exception 'Uno de los productos ya no esta disponible.';
  end if;

  for item_record in
    select
      products.id,
      products.sku,
      products.name,
      products.stock,
      products.retail_price,
      products.wholesale_price,
      checkout_items.quantity
    from checkout_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    where products.active = true
      and products.status = 'active'
    order by products.id
    for update of products
  loop
    if item_record.quantity > item_record.stock then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    subtotal_amount := subtotal_amount + round(
      (
        case
          when requested_price_mode = 'wholesale' then item_record.wholesale_price
          else item_record.retail_price
        end
      ) * item_record.quantity,
      2
    );
  end loop;

  if requested_price_mode = 'wholesale' and subtotal_amount < wholesale_minimum_order then
    raise exception 'El codigo mayorista requiere un pedido minimo de %.', wholesale_minimum_order;
  end if;

  if linked_wholesale_code_id is not null then
    update public.wholesale_codes
    set
      used_count = used_count + 1,
      last_used_at = now(),
      updated_at = now()
    where wholesale_codes.id = linked_wholesale_code_id;
  end if;

  tax_amount := round(subtotal_amount * tax_rate, 2);
  total_amount := round(subtotal_amount + tax_amount, 2);
  new_order_number := 'CZ-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-' || upper(substr(encode(gen_random_bytes(3), 'hex'), 1, 6));

  insert into public.orders (
    id,
    order_number,
    user_id,
    customer_id,
    wholesale_code_id,
    customer_name,
    email,
    phone,
    customer_phone,
    delivery_address,
    payment_method,
    price_mode,
    subtotal,
    tax,
    shipping_total,
    total,
    status
  )
  values (
    new_order_id,
    new_order_number,
    current_user_id,
    linked_customer_id,
    linked_wholesale_code_id,
    normalized_customer_name,
    normalized_customer_email,
    normalized_customer_phone,
    normalized_customer_phone,
    normalized_delivery_address,
    requested_payment_method,
    requested_price_mode,
    subtotal_amount,
    tax_amount,
    0,
    total_amount,
    'pending'
  );

  for item_record in
    select
      products.id,
      products.sku,
      products.name,
      products.stock,
      products.retail_price,
      products.wholesale_price,
      checkout_items.quantity
    from checkout_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    order by products.id
  loop
    insert into public.order_items (
      order_id,
      product_id,
      sku,
      product_name,
      quantity,
      applied_price_mode,
      unit_price,
      line_total,
      retail_price_snapshot,
      wholesale_price_snapshot
    )
    values (
      new_order_id,
      item_record.id,
      item_record.sku,
      item_record.name,
      item_record.quantity,
      requested_price_mode,
      round(
        case
          when requested_price_mode = 'wholesale' then item_record.wholesale_price
          else item_record.retail_price
        end,
        2
      ),
      round(
        (
          case
            when requested_price_mode = 'wholesale' then item_record.wholesale_price
            else item_record.retail_price
          end
        ) * item_record.quantity,
        2
      ),
      round(item_record.retail_price, 2),
      round(item_record.wholesale_price, 2)
    );

    update public.products
    set
      stock = item_record.stock - item_record.quantity,
      updated_at = now()
    where products.id = item_record.id
      and products.stock >= item_record.quantity;

    get diagnostics stock_update_count = row_count;

    if stock_update_count <> 1 then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    insert into public.inventory_movements (
      product_id,
      user_id,
      movement_type,
      quantity,
      stock_before,
      stock_after,
      reference_type,
      reference_id,
      notes
    )
    values (
      item_record.id,
      current_user_id,
      'sale',
      -item_record.quantity,
      item_record.stock,
      item_record.stock - item_record.quantity,
      'orders',
      new_order_id,
      'Salida automatica por checkout'
    );
  end loop;

  insert into public.payments (
    order_id,
    customer_id,
    method,
    payment_method,
    status,
    payment_status,
    amount,
    reference,
    bank_reference_number,
    transfer_receipt_url,
    provider
  )
  values (
    new_order_id,
    linked_customer_id,
    requested_payment_method,
    requested_payment_method,
    'pending',
    'pending',
    total_amount,
    case when requested_payment_method = 'bank_transfer' then normalized_bank_reference else null end,
    case when requested_payment_method = 'bank_transfer' then normalized_bank_reference else null end,
    case when requested_payment_method = 'bank_transfer' then normalized_transfer_receipt_url else null end,
    case when requested_payment_method = 'card' then 'pending_gateway' else null end
  );

  payment_notice := case
    when requested_payment_method in ('bank_transfer', 'cash') then 'Pedido pendiente de confirmacion de pago.'
    else 'Pedido recibido. Pendiente de confirmacion de pasarela.'
  end;

  insert into public.crm_followups (
    customer_id,
    order_id,
    title,
    interaction_type,
    next_action,
    due_at,
    priority,
    phone,
    notes,
    estimated_value,
    status
  )
  values (
    linked_customer_id,
    new_order_id,
    'Nuevo pedido recibido - ' || new_order_number,
    'prospecto',
    'Abrir pedido y confirmar pago',
    now(),
    'alta',
    normalized_customer_phone,
    'Nuevo pedido recibido' || chr(10) ||
    'Cliente: ' || normalized_customer_name || chr(10) ||
    'Telefono: ' || normalized_customer_phone || chr(10) ||
    'Metodo de pago: ' || requested_payment_method::text || chr(10) ||
    'Total: ' || total_amount::text || chr(10) ||
    'Estado del pago: pending' || chr(10) ||
    payment_notice,
    total_amount,
    'pending'
  );

  insert into public.crm_notes (
    customer_id,
    order_id,
    user_id,
    note
  )
  values (
    linked_customer_id,
    new_order_id,
    current_user_id,
    'Nuevo pedido recibido' || chr(10) ||
    'Cliente: ' || normalized_customer_name || chr(10) ||
    'Telefono: ' || normalized_customer_phone || chr(10) ||
    'Metodo de pago: ' || requested_payment_method::text || chr(10) ||
    'Total: ' || total_amount::text || chr(10) ||
    'Estado del pago: pending' || chr(10) ||
    payment_notice
  );

  order_id := new_order_id;
  order_number := new_order_number;
  return next;
end;
$$;

grant execute on function public.create_checkout_order(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text
) to anon, authenticated;

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
    orders.email,
    orders.phone,
    orders.delivery_address,
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

create or replace function public.update_invoice_customer_data(
  target_invoice_id uuid,
  corrected_customer_name text,
  corrected_customer_rtn text,
  corrected_customer_phone text,
  corrected_customer_address text
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
  normalized_customer_address text := nullif(trim(coalesce(corrected_customer_address, '')), '');
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
    customer_address = normalized_customer_address,
    updated_at = now()
  where invoices.id = target_invoice_id;

  insert into public.audit_logs (
    user_id,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    current_user_id,
    'invoices',
    target_invoice_id,
    'fiscal.invoice.customer_data_corrected',
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'customer_name', invoice_record.customer_name,
      'customer_rtn', invoice_record.customer_rtn,
      'customer_phone', invoice_record.customer_phone,
      'customer_address', invoice_record.customer_address
    ),
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'customer_name', normalized_customer_name,
      'customer_rtn', normalized_customer_rtn,
      'customer_phone', normalized_customer_phone,
      'customer_address', normalized_customer_address
    )
  );
end;
$$;

grant execute on function public.update_invoice_customer_data(uuid, text, text, text, text) to authenticated;
