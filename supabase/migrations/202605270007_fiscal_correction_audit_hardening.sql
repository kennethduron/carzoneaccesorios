drop function if exists public.update_invoice_customer_data(uuid, text, text, text, text, text, text);
drop function if exists public.update_invoice_customer_data(uuid, text, text, text, text, text, text, text, text);
drop function if exists public.correct_order_fiscal_customer_data(uuid, text, text, text, text, text, text);
drop function if exists public.correct_order_fiscal_customer_data(uuid, text, text, text, text, text, text, text, text);
drop function if exists public.get_fiscal_correction_history(uuid, uuid);

create or replace function public.fiscal_correction_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_actor_role(), '') in ('technical_owner', 'admin', 'business_owner', 'contadora')
    or public.has_permission('invoices:correct')
$$;

create or replace function public.fiscal_changed_fields(previous_values jsonb, next_values jsonb)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(key order by key), array[]::text[])
  from (
    select key
    from jsonb_object_keys(coalesce(previous_values, '{}'::jsonb) || coalesce(next_values, '{}'::jsonb)) as keys(key)
    where previous_values ->> key is distinct from next_values ->> key
  ) changed;
$$;

create function public.update_invoice_customer_data(
  target_invoice_id uuid,
  corrected_customer_name text,
  corrected_customer_rtn text,
  corrected_customer_phone text,
  corrected_customer_email text,
  corrected_customer_address text,
  correction_reason text,
  actor_ip text default null,
  actor_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
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
  previous_values jsonb;
  next_values jsonb;
  changed_fields text[];
  normalized_actor_ip inet := null;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not public.fiscal_correction_allowed() then
    raise exception 'No tienes permiso para corregir datos fiscales.';
  end if;

  if target_invoice_id is null then
    raise exception 'Selecciona una factura para corregir.';
  end if;

  if normalized_customer_name is null then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_customer_rtn is not null and normalized_customer_rtn !~ '^[0-9]{14}$' then
    raise exception 'El RTN debe contener 14 dígitos.';
  end if;

  if normalized_reason is null or length(normalized_reason) < 10 then
    raise exception 'El motivo de corrección es obligatorio y debe tener al menos 10 caracteres.';
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

  previous_values := jsonb_build_object(
    'customer_name', invoice_record.customer_name,
    'customer_rtn', invoice_record.customer_rtn,
    'customer_phone', invoice_record.customer_phone,
    'customer_email', invoice_record.customer_email,
    'customer_address', invoice_record.customer_address
  );

  next_values := jsonb_build_object(
    'customer_name', normalized_customer_name,
    'customer_rtn', normalized_customer_rtn,
    'customer_phone', normalized_customer_phone,
    'customer_email', normalized_customer_email,
    'customer_address', normalized_customer_address
  );

  changed_fields := public.fiscal_changed_fields(previous_values, next_values);

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

  if nullif(trim(coalesce(actor_ip, '')), '') is not null then
    normalized_actor_ip := split_part(actor_ip, ',', 1)::inet;
  end if;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data,
    ip_address,
    user_agent
  )
  values (
    current_user_id,
    actor_role_name,
    'invoices',
    target_invoice_id,
    'fiscal.invoice.customer_data_corrected',
    jsonb_build_object(
      'before', previous_values,
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'order_id', invoice_record.order_id,
      'order_number', order_record.order_number,
      'customer_id', target_customer_id,
      'fields_modified', changed_fields,
      'reason', normalized_reason,
      'protected_fields_preserved', jsonb_build_object(
        'invoice_number', invoice_record.invoice_number,
        'cai', invoice_record.cai,
        'issued_at', invoice_record.issued_at,
        'order_number', order_record.order_number,
        'subtotal', invoice_record.subtotal,
        'tax', invoice_record.tax,
        'total', invoice_record.total,
        'price_mode', invoice_record.price_mode
      )
    ),
    jsonb_build_object(
      'after', next_values,
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'order_id', invoice_record.order_id,
      'order_number', order_record.order_number,
      'customer_id', target_customer_id,
      'fields_modified', changed_fields,
      'reason', normalized_reason,
      'note', 'Solo se corrigieron datos fiscales del cliente; numero fiscal, CAI, fecha, productos, ISV y totales se conservan.'
    ),
    normalized_actor_ip,
    nullif(trim(coalesce(actor_user_agent, '')), '')
  );
end;
$$;

create function public.correct_order_fiscal_customer_data(
  target_order_id uuid,
  corrected_customer_name text,
  corrected_customer_rtn text,
  corrected_customer_phone text,
  corrected_customer_email text,
  corrected_customer_address text,
  correction_reason text,
  actor_ip text default null,
  actor_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  order_record public.orders%rowtype;
  invoice_record public.invoices%rowtype;
  customer_record public.customers%rowtype;
  normalized_customer_name text := nullif(trim(coalesce(corrected_customer_name, '')), '');
  normalized_customer_rtn text := nullif(regexp_replace(trim(coalesce(corrected_customer_rtn, '')), '[\s-]', '', 'g'), '');
  normalized_customer_phone text := nullif(trim(coalesce(corrected_customer_phone, '')), '');
  normalized_customer_email text := lower(nullif(trim(coalesce(corrected_customer_email, '')), ''));
  normalized_customer_address text := nullif(trim(coalesce(corrected_customer_address, '')), '');
  normalized_reason text := nullif(trim(coalesce(correction_reason, '')), '');
  previous_values jsonb;
  next_values jsonb;
  changed_fields text[];
  normalized_actor_ip inet := null;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not public.fiscal_correction_allowed() then
    raise exception 'No tienes permiso para corregir datos fiscales.';
  end if;

  if target_order_id is null then
    raise exception 'Selecciona un pedido para corregir.';
  end if;

  if normalized_customer_name is null then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_customer_rtn is not null and normalized_customer_rtn !~ '^[0-9]{14}$' then
    raise exception 'El RTN debe contener 14 dígitos.';
  end if;

  if normalized_reason is null or length(normalized_reason) < 10 then
    raise exception 'El motivo de corrección es obligatorio y debe tener al menos 10 caracteres.';
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
      normalized_reason,
      actor_ip,
      actor_user_agent
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

  previous_values := jsonb_build_object(
    'customer_name', order_record.fiscal_customer_name,
    'customer_rtn', order_record.fiscal_customer_rtn,
    'customer_phone', order_record.fiscal_customer_phone,
    'customer_email', order_record.fiscal_customer_email,
    'customer_address', order_record.fiscal_customer_address
  );

  next_values := jsonb_build_object(
    'customer_name', normalized_customer_name,
    'customer_rtn', normalized_customer_rtn,
    'customer_phone', normalized_customer_phone,
    'customer_email', normalized_customer_email,
    'customer_address', normalized_customer_address
  );

  changed_fields := public.fiscal_changed_fields(previous_values, next_values);

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

  if nullif(trim(coalesce(actor_ip, '')), '') is not null then
    normalized_actor_ip := split_part(actor_ip, ',', 1)::inet;
  end if;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data,
    ip_address,
    user_agent
  )
  values (
    current_user_id,
    actor_role_name,
    'orders',
    target_order_id,
    'fiscal.order.customer_data_corrected',
    jsonb_build_object(
      'before', previous_values,
      'order_id', order_record.id,
      'order_number', order_record.order_number,
      'customer_id', order_record.customer_id,
      'fields_modified', changed_fields,
      'reason', normalized_reason,
      'protected_fields_preserved', jsonb_build_object(
        'order_number', order_record.order_number,
        'payment_method', order_record.payment_method,
        'status', order_record.status,
        'order_reservation_status', order_record.order_reservation_status,
        'subtotal', order_record.subtotal,
        'tax', order_record.tax,
        'total', order_record.total
      )
    ),
    jsonb_build_object(
      'after', next_values,
      'order_id', order_record.id,
      'order_number', order_record.order_number,
      'customer_id', order_record.customer_id,
      'fields_modified', changed_fields,
      'reason', normalized_reason,
      'note', 'Solo se corrigieron datos fiscales del cliente; numero de pedido, productos, pagos, inventario, ISV y totales se conservan.'
    ),
    normalized_actor_ip,
    nullif(trim(coalesce(actor_user_agent, '')), '')
  );
end;
$$;

create function public.get_fiscal_correction_history(
  target_order_id uuid default null,
  target_invoice_id uuid default null
)
returns table (
  id uuid,
  created_at timestamptz,
  user_id uuid,
  user_label text,
  actor_role text,
  table_name text,
  record_id uuid,
  action text,
  order_id uuid,
  invoice_id uuid,
  fields_modified text[],
  old_values jsonb,
  new_values jsonb,
  correction_reason text,
  ip_address text,
  user_agent text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    audit_logs.id,
    audit_logs.created_at,
    audit_logs.user_id,
    coalesce(users.full_name, users.email, audit_logs.user_id::text) as user_label,
    audit_logs.actor_role,
    audit_logs.table_name,
    audit_logs.record_id,
    audit_logs.action,
    nullif(coalesce(audit_logs.new_data ->> 'order_id', audit_logs.old_data ->> 'order_id'), '')::uuid as order_id,
    nullif(coalesce(audit_logs.new_data ->> 'invoice_id', audit_logs.old_data ->> 'invoice_id'), '')::uuid as invoice_id,
    coalesce(
      array(select jsonb_array_elements_text(coalesce(audit_logs.new_data -> 'fields_modified', audit_logs.old_data -> 'fields_modified', '[]'::jsonb))),
      array[]::text[]
    ) as fields_modified,
    coalesce(audit_logs.old_data -> 'before', audit_logs.old_data) as old_values,
    coalesce(audit_logs.new_data -> 'after', audit_logs.new_data) as new_values,
    coalesce(audit_logs.new_data ->> 'reason', audit_logs.old_data ->> 'reason') as correction_reason,
    audit_logs.ip_address::text as ip_address,
    audit_logs.user_agent
  from public.audit_logs
  left join public.users on users.id = audit_logs.user_id
  where (public.fiscal_correction_allowed() or public.has_permission('audit:read'))
    and audit_logs.action in ('fiscal.invoice.customer_data_corrected', 'fiscal.order.customer_data_corrected')
    and (
      target_order_id is null
      or audit_logs.record_id = target_order_id
      or nullif(coalesce(audit_logs.new_data ->> 'order_id', audit_logs.old_data ->> 'order_id'), '')::uuid = target_order_id
    )
    and (
      target_invoice_id is null
      or audit_logs.record_id = target_invoice_id
      or nullif(coalesce(audit_logs.new_data ->> 'invoice_id', audit_logs.old_data ->> 'invoice_id'), '')::uuid = target_invoice_id
    )
  order by audit_logs.created_at desc;
$$;

grant execute on function public.fiscal_correction_allowed() to authenticated;
grant execute on function public.fiscal_changed_fields(jsonb, jsonb) to authenticated, service_role;
grant execute on function public.update_invoice_customer_data(uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.correct_order_fiscal_customer_data(uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.get_fiscal_correction_history(uuid, uuid) to authenticated, service_role;
