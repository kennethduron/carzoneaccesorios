update public.roles
set
  permissions = (
    select jsonb_agg(distinct permission_key)
    from jsonb_array_elements_text(permissions || '["invoices:correct"]'::jsonb) as permissions_expanded(permission_key)
  ),
  updated_at = now()
where name in ('admin', 'business_owner', 'contadora', 'technical_owner');

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
  normalized_customer_rtn text := nullif(regexp_replace(trim(coalesce(corrected_customer_rtn, '')), '[\s-]', '', 'g'), '');
  normalized_customer_phone text := nullif(trim(coalesce(corrected_customer_phone, '')), '');
  normalized_customer_email text := lower(nullif(trim(coalesce(corrected_customer_email, '')), ''));
  normalized_customer_address text := nullif(trim(coalesce(corrected_customer_address, '')), '');
  normalized_reason text := nullif(trim(coalesce(correction_reason, '')), '');
begin
  if not (
    public.has_permission('invoices:correct')
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

  if normalized_customer_rtn is not null and normalized_customer_rtn !~ '^[0-9]{14}$' then
    raise exception 'El RTN debe tener 14 digitos. Puedes dejarlo vacio si corresponde.';
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
    raise exception 'No se puede corregir una factura anulada.';
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
      'unchanged_fields', jsonb_build_array('invoice_number', 'cai', 'issued_at', 'order_id', 'fiscal_range', 'subtotal', 'tax', 'total', 'products')
    )
  );
end;
$$;

grant execute on function public.update_invoice_customer_data(uuid, text, text, text, text, text, text) to authenticated;
