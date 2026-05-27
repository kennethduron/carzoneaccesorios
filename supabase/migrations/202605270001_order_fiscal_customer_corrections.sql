alter table public.orders
  add column if not exists fiscal_customer_name text,
  add column if not exists fiscal_customer_rtn text,
  add column if not exists fiscal_customer_phone text,
  add column if not exists fiscal_customer_email text,
  add column if not exists fiscal_customer_address text;

update public.orders
set
  fiscal_customer_name = coalesce(nullif(trim(orders.fiscal_customer_name), ''), orders.customer_name),
  fiscal_customer_rtn = coalesce(nullif(regexp_replace(coalesce(orders.fiscal_customer_rtn, ''), '[\s-]', '', 'g'), ''), customers.tax_id),
  fiscal_customer_phone = coalesce(nullif(trim(orders.fiscal_customer_phone), ''), orders.customer_phone, orders.phone),
  fiscal_customer_email = coalesce(nullif(lower(trim(orders.fiscal_customer_email)), ''), lower(nullif(trim(orders.email), ''))),
  fiscal_customer_address = coalesce(nullif(trim(orders.fiscal_customer_address), ''), orders.delivery_address)
from public.customers
where customers.id = orders.customer_id;

update public.orders
set
  fiscal_customer_name = coalesce(nullif(trim(fiscal_customer_name), ''), customer_name),
  fiscal_customer_phone = coalesce(nullif(trim(fiscal_customer_phone), ''), customer_phone, phone),
  fiscal_customer_email = coalesce(nullif(lower(trim(fiscal_customer_email)), ''), lower(nullif(trim(email), ''))),
  fiscal_customer_address = coalesce(nullif(trim(fiscal_customer_address), ''), delivery_address)
where fiscal_customer_name is null
   or fiscal_customer_phone is null
   or fiscal_customer_email is null
   or fiscal_customer_address is null;

comment on column public.orders.fiscal_customer_name is 'Nombre o razon social fiscal corregida para factura.';
comment on column public.orders.fiscal_customer_rtn is 'RTN fiscal corregido para factura; 14 digitos cuando aplica.';
comment on column public.orders.fiscal_customer_phone is 'Telefono fiscal corregido para factura.';
comment on column public.orders.fiscal_customer_email is 'Correo fiscal corregido para factura.';
comment on column public.orders.fiscal_customer_address is 'Direccion fiscal corregida para factura; no altera direccion logistica.';

create or replace function public.apply_order_fiscal_customer_snapshot_to_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_record record;
begin
  if new.order_id is null then
    return new;
  end if;

  select
    orders.customer_name,
    orders.phone,
    orders.email,
    orders.delivery_address,
    orders.fiscal_customer_name,
    orders.fiscal_customer_rtn,
    orders.fiscal_customer_phone,
    orders.fiscal_customer_email,
    orders.fiscal_customer_address,
    customers.tax_id
  into order_record
  from public.orders
  left join public.customers on customers.id = orders.customer_id
  where orders.id = new.order_id;

  if not found then
    return new;
  end if;

  new.customer_name := coalesce(nullif(trim(order_record.fiscal_customer_name), ''), new.customer_name, order_record.customer_name);
  new.customer_rtn := coalesce(
    nullif(regexp_replace(trim(coalesce(order_record.fiscal_customer_rtn, '')), '[\s-]', '', 'g'), ''),
    new.customer_rtn,
    order_record.tax_id
  );
  new.customer_phone := coalesce(nullif(trim(order_record.fiscal_customer_phone), ''), new.customer_phone, order_record.phone);
  new.customer_email := coalesce(lower(nullif(trim(order_record.fiscal_customer_email), '')), new.customer_email, lower(nullif(trim(order_record.email), '')));
  new.customer_address := coalesce(nullif(trim(order_record.fiscal_customer_address), ''), new.customer_address, order_record.delivery_address);

  return new;
end;
$$;

drop trigger if exists apply_order_fiscal_customer_snapshot_to_invoice_on_insert on public.invoices;

create trigger apply_order_fiscal_customer_snapshot_to_invoice_on_insert
before insert on public.invoices
for each row
execute function public.apply_order_fiscal_customer_snapshot_to_invoice();

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
  order_record public.orders%rowtype;
  customer_record public.customers%rowtype;
  target_customer_id uuid;
  normalized_customer_name text := nullif(trim(coalesce(corrected_customer_name, '')), '');
  normalized_customer_rtn text := nullif(regexp_replace(trim(coalesce(corrected_customer_rtn, '')), '[\s-]', '', 'g'), '');
  normalized_customer_phone text := nullif(trim(coalesce(corrected_customer_phone, '')), '');
  normalized_customer_email text := lower(nullif(trim(coalesce(corrected_customer_email, '')), ''));
  normalized_customer_address text := nullif(trim(coalesce(corrected_customer_address, '')), '');
  normalized_reason text := nullif(trim(coalesce(correction_reason, '')), '');
begin
  if not public.has_permission('invoices:correct') then
    raise exception 'No tienes permiso para corregir datos fiscales del cliente.';
  end if;

  if target_invoice_id is null then
    raise exception 'Selecciona una factura para corregir.';
  end if;

  if normalized_customer_name is null then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_customer_rtn is not null and normalized_customer_rtn !~ '^[0-9]{14}$' then
    raise exception 'El RTN debe contener 14 digitos.';
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

  if invoice_record.status in ('anulada', 'cancelled') then
    raise exception 'No se pueden corregir datos de una factura anulada.';
  end if;

  select *
  into order_record
  from public.orders
  where orders.id = invoice_record.order_id
  for update;

  target_customer_id := coalesce(invoice_record.customer_id, order_record.customer_id);

  if target_customer_id is not null then
    select *
    into customer_record
    from public.customers
    where customers.id = target_customer_id
    for update;
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

  if order_record.id is not null then
    update public.orders
    set
      fiscal_customer_name = normalized_customer_name,
      fiscal_customer_rtn = normalized_customer_rtn,
      fiscal_customer_phone = normalized_customer_phone,
      fiscal_customer_email = normalized_customer_email,
      fiscal_customer_address = normalized_customer_address,
      updated_at = now()
    where orders.id = order_record.id;
  end if;

  if target_customer_id is not null then
    update public.customers
    set
      contact_name = normalized_customer_name,
      tax_id = normalized_customer_rtn,
      phone = coalesce(normalized_customer_phone, customers.phone),
      email = coalesce(normalized_customer_email, customers.email),
      address = coalesce(normalized_customer_address, customers.address),
      updated_at = now()
    where customers.id = target_customer_id;
  end if;

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
      'order_id', invoice_record.order_id,
      'customer_id', target_customer_id,
      'customer_name', invoice_record.customer_name,
      'customer_rtn', invoice_record.customer_rtn,
      'customer_phone', invoice_record.customer_phone,
      'customer_email', invoice_record.customer_email,
      'customer_address', invoice_record.customer_address,
      'order_snapshot', case when order_record.id is null then null else jsonb_build_object(
        'fiscal_customer_name', order_record.fiscal_customer_name,
        'fiscal_customer_rtn', order_record.fiscal_customer_rtn,
        'fiscal_customer_phone', order_record.fiscal_customer_phone,
        'fiscal_customer_email', order_record.fiscal_customer_email,
        'fiscal_customer_address', order_record.fiscal_customer_address
      ) end,
      'customer_profile', case when customer_record.id is null then null else jsonb_build_object(
        'contact_name', customer_record.contact_name,
        'tax_id', customer_record.tax_id,
        'phone', customer_record.phone,
        'email', customer_record.email,
        'address', customer_record.address,
        'user_id', customer_record.user_id
      ) end
    ),
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'order_id', invoice_record.order_id,
      'customer_id', target_customer_id,
      'customer_name', normalized_customer_name,
      'customer_rtn', normalized_customer_rtn,
      'customer_phone', normalized_customer_phone,
      'customer_email', normalized_customer_email,
      'customer_address', normalized_customer_address,
      'correction_reason', normalized_reason,
      'guest_isolation', 'customer_id preserved; no account lookup by email',
      'unchanged_fields', jsonb_build_array('invoice_number', 'cai', 'issued_at', 'order_id', 'fiscal_range', 'subtotal', 'tax', 'total', 'products')
    )
  );
end;
$$;

grant execute on function public.update_invoice_customer_data(uuid, text, text, text, text, text, text) to authenticated;

create or replace function public.correct_order_fiscal_customer_data(
  target_order_id uuid,
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
  order_record public.orders%rowtype;
  invoice_record public.invoices%rowtype;
  customer_record public.customers%rowtype;
  normalized_customer_name text := nullif(trim(coalesce(corrected_customer_name, '')), '');
  normalized_customer_rtn text := nullif(regexp_replace(trim(coalesce(corrected_customer_rtn, '')), '[\s-]', '', 'g'), '');
  normalized_customer_phone text := nullif(trim(coalesce(corrected_customer_phone, '')), '');
  normalized_customer_email text := lower(nullif(trim(coalesce(corrected_customer_email, '')), ''));
  normalized_customer_address text := nullif(trim(coalesce(corrected_customer_address, '')), '');
  normalized_reason text := nullif(trim(coalesce(correction_reason, '')), '');
begin
  if not public.has_permission('invoices:correct') then
    raise exception 'No tienes permiso para corregir datos fiscales del cliente.';
  end if;

  if target_order_id is null then
    raise exception 'Selecciona un pedido para corregir.';
  end if;

  if normalized_customer_name is null then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_customer_rtn is not null and normalized_customer_rtn !~ '^[0-9]{14}$' then
    raise exception 'El RTN debe contener 14 digitos.';
  end if;

  if normalized_reason is null or length(normalized_reason) < 8 then
    raise exception 'El motivo de correccion es obligatorio.';
  end if;

  select *
  into order_record
  from public.orders
  where orders.id = target_order_id
  for update;

  if order_record.id is null then
    raise exception 'No se encontro el pedido.';
  end if;

  select *
  into invoice_record
  from public.invoices
  where invoices.order_id = target_order_id
  order by invoices.created_at desc
  limit 1
  for update;

  if invoice_record.id is not null then
    perform public.update_invoice_customer_data(
      invoice_record.id,
      normalized_customer_name,
      normalized_customer_rtn,
      normalized_customer_phone,
      normalized_customer_email,
      normalized_customer_address,
      normalized_reason
    );
    return;
  end if;

  if order_record.customer_id is not null then
    select *
    into customer_record
    from public.customers
    where customers.id = order_record.customer_id
    for update;
  end if;

  update public.orders
  set
    fiscal_customer_name = normalized_customer_name,
    fiscal_customer_rtn = normalized_customer_rtn,
    fiscal_customer_phone = normalized_customer_phone,
    fiscal_customer_email = normalized_customer_email,
    fiscal_customer_address = normalized_customer_address,
    updated_at = now()
  where orders.id = target_order_id;

  if order_record.customer_id is not null then
    update public.customers
    set
      contact_name = normalized_customer_name,
      tax_id = normalized_customer_rtn,
      phone = coalesce(normalized_customer_phone, customers.phone),
      email = coalesce(normalized_customer_email, customers.email),
      address = coalesce(normalized_customer_address, customers.address),
      updated_at = now()
    where customers.id = order_record.customer_id;
  end if;

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
    'orders',
    target_order_id,
    'fiscal.order.customer_data_corrected',
    jsonb_build_object(
      'order_id', order_record.id,
      'order_number', order_record.order_number,
      'invoice_id', null,
      'invoice_number', null,
      'customer_id', order_record.customer_id,
      'fiscal_customer_name', order_record.fiscal_customer_name,
      'fiscal_customer_rtn', order_record.fiscal_customer_rtn,
      'fiscal_customer_phone', order_record.fiscal_customer_phone,
      'fiscal_customer_email', order_record.fiscal_customer_email,
      'fiscal_customer_address', order_record.fiscal_customer_address,
      'customer_profile', case when customer_record.id is null then null else jsonb_build_object(
        'contact_name', customer_record.contact_name,
        'tax_id', customer_record.tax_id,
        'phone', customer_record.phone,
        'email', customer_record.email,
        'address', customer_record.address,
        'user_id', customer_record.user_id
      ) end
    ),
    jsonb_build_object(
      'order_id', order_record.id,
      'order_number', order_record.order_number,
      'invoice_id', null,
      'invoice_number', null,
      'customer_id', order_record.customer_id,
      'fiscal_customer_name', normalized_customer_name,
      'fiscal_customer_rtn', normalized_customer_rtn,
      'fiscal_customer_phone', normalized_customer_phone,
      'fiscal_customer_email', normalized_customer_email,
      'fiscal_customer_address', normalized_customer_address,
      'correction_reason', normalized_reason,
      'guest_isolation', 'customer_id preserved; no account lookup by email',
      'unchanged_fields', jsonb_build_array('order_number', 'products', 'quantities', 'prices', 'subtotal', 'tax', 'total', 'tracking_code')
    )
  );
end;
$$;

grant execute on function public.correct_order_fiscal_customer_data(uuid, text, text, text, text, text, text) to authenticated;
