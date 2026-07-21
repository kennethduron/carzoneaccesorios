-- Secure, audited customer identity editing and portal-account eligibility.
-- Existing customer relationships and historical snapshots remain unchanged.

update public.roles
set permissions = coalesce(permissions, '[]'::jsonb) || '["customers:update_identity"]'::jsonb
where name in ('technical_owner', 'business_owner', 'admin')
  and not (coalesce(permissions, '[]'::jsonb) ? 'customers:update_identity');

create or replace function public.update_customer_identity_manual(
  p_customer_id uuid,
  p_business_name text,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_tax_id text,
  p_city text,
  p_expected_updated_at timestamptz,
  p_actor_ip text default null,
  p_actor_user_agent text default null
)
returns table (
  ok boolean,
  status text,
  message text,
  field_name text,
  customer_id uuid,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  customer_row public.customers%rowtype;
  normalized_business_name text := nullif(trim(coalesce(p_business_name, '')), '');
  normalized_contact_name text := nullif(trim(coalesce(p_contact_name, '')), '');
  normalized_email text := lower(nullif(trim(coalesce(p_email, '')), ''));
  raw_phone text := nullif(trim(coalesce(p_phone, '')), '');
  phone_compact text;
  phone_digits text;
  normalized_phone text;
  normalized_tax_id text := nullif(trim(coalesce(p_tax_id, '')), '');
  normalized_city text := nullif(trim(coalesce(p_city, '')), '');
  old_values jsonb := '{}'::jsonb;
  new_values jsonb := '{}'::jsonb;
  changed_fields text[] := array[]::text[];
  saved_updated_at timestamptz;
begin
  if actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin')
    or not public.has_permission('customers:update_identity')
  then
    if actor_id is not null then
      perform public.write_audit_log(
        'customers', p_customer_id, 'customer.identity.update_denied', null,
        jsonb_build_object('source', 'admin_customer_profile', 'reason', 'permission_denied'),
        p_actor_ip, p_actor_user_agent
      );
    end if;
    return query select false, 'permission_denied'::text,
      'No tienes permiso para editar la identidad comercial del cliente.'::text,
      null::text, p_customer_id, null::timestamptz;
    return;
  end if;

  if normalized_contact_name is null then
    return query select false, 'validation_error'::text, 'El nombre de contacto es obligatorio.'::text,
      'contact_name'::text, p_customer_id, null::timestamptz;
    return;
  end if;
  if char_length(normalized_contact_name) > 180 then
    return query select false, 'validation_error'::text,
      'El nombre de contacto no puede superar 180 caracteres.'::text,
      'contact_name'::text, p_customer_id, null::timestamptz;
    return;
  end if;
  if normalized_business_name is not null and char_length(normalized_business_name) > 180 then
    return query select false, 'validation_error'::text,
      'El nombre comercial no puede superar 180 caracteres.'::text,
      'business_name'::text, p_customer_id, null::timestamptz;
    return;
  end if;
  if normalized_email is not null and (
    char_length(normalized_email) > 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    return query select false, 'validation_error'::text, 'Ingresa un correo comercial valido.'::text,
      'email'::text, p_customer_id, null::timestamptz;
    return;
  end if;

  if raw_phone is not null then
    if raw_phone !~ '^[0-9+()[:space:]-]+$' then
      return query select false, 'validation_error'::text,
        'Ingresa un numero de telefono valido de Honduras.'::text,
        'phone'::text, p_customer_id, null::timestamptz;
      return;
    end if;
    phone_compact := regexp_replace(raw_phone, '[^0-9+]', '', 'g');
    phone_digits := case
      when phone_compact like '+504%' then substring(phone_compact from 5)
      when phone_compact like '504%' then substring(phone_compact from 4)
      else phone_compact
    end;
    if phone_digits !~ '^[2389][0-9]{7}$' or phone_digits = '00000000' then
      return query select false, 'validation_error'::text,
        'Ingresa un numero de telefono valido de Honduras.'::text,
        'phone'::text, p_customer_id, null::timestamptz;
      return;
    end if;
    normalized_phone := '+504' || phone_digits;
  end if;

  if normalized_tax_id is not null and char_length(normalized_tax_id) > 80 then
    return query select false, 'validation_error'::text, 'El RTN no puede superar 80 caracteres.'::text,
      'tax_id'::text, p_customer_id, null::timestamptz;
    return;
  end if;
  if normalized_city is not null and char_length(normalized_city) > 180 then
    return query select false, 'validation_error'::text, 'La ciudad no puede superar 180 caracteres.'::text,
      'city'::text, p_customer_id, null::timestamptz;
    return;
  end if;

  select * into customer_row
  from public.customers
  where id = p_customer_id
  for update;

  if customer_row.id is null then
    return query select false, 'customer_not_found'::text, 'El cliente no existe.'::text,
      null::text, p_customer_id, null::timestamptz;
    return;
  end if;

  if p_expected_updated_at is null or customer_row.updated_at is distinct from p_expected_updated_at then
    perform public.write_audit_log(
      'customers', p_customer_id, 'customer.identity.update_conflict',
      jsonb_build_object('updated_at', customer_row.updated_at),
      jsonb_build_object('expected_updated_at', p_expected_updated_at, 'source', 'admin_customer_profile'),
      p_actor_ip, p_actor_user_agent
    );
    return query select false, 'stale_record'::text,
      'El cliente cambio desde que abriste el formulario. Actualiza el perfil e intenta nuevamente.'::text,
      null::text, p_customer_id, customer_row.updated_at;
    return;
  end if;

  if customer_row.business_name is distinct from normalized_business_name then
    old_values := old_values || jsonb_build_object('business_name', customer_row.business_name);
    new_values := new_values || jsonb_build_object('business_name', normalized_business_name);
    changed_fields := array_append(changed_fields, 'business_name');
  end if;
  if customer_row.contact_name is distinct from normalized_contact_name then
    old_values := old_values || jsonb_build_object('contact_name', customer_row.contact_name);
    new_values := new_values || jsonb_build_object('contact_name', normalized_contact_name);
    changed_fields := array_append(changed_fields, 'contact_name');
  end if;
  if customer_row.email is distinct from normalized_email then
    old_values := old_values || jsonb_build_object('email', customer_row.email);
    new_values := new_values || jsonb_build_object('email', normalized_email);
    changed_fields := array_append(changed_fields, 'email');
  end if;
  if customer_row.phone is distinct from normalized_phone then
    old_values := old_values || jsonb_build_object('phone', customer_row.phone);
    new_values := new_values || jsonb_build_object('phone', normalized_phone);
    changed_fields := array_append(changed_fields, 'phone');
  end if;
  if customer_row.tax_id is distinct from normalized_tax_id then
    old_values := old_values || jsonb_build_object('tax_id', customer_row.tax_id);
    new_values := new_values || jsonb_build_object('tax_id', normalized_tax_id);
    changed_fields := array_append(changed_fields, 'tax_id');
  end if;
  if customer_row.city is distinct from normalized_city then
    old_values := old_values || jsonb_build_object('city', customer_row.city);
    new_values := new_values || jsonb_build_object('city', normalized_city);
    changed_fields := array_append(changed_fields, 'city');
  end if;

  if cardinality(changed_fields) = 0 then
    return query select true, 'unchanged'::text, 'No hay cambios para guardar.'::text,
      null::text, p_customer_id, customer_row.updated_at;
    return;
  end if;

  update public.customers
  set business_name = normalized_business_name,
      contact_name = normalized_contact_name,
      email = normalized_email,
      phone = normalized_phone,
      tax_id = normalized_tax_id,
      city = normalized_city,
      updated_at = clock_timestamp()
  where id = p_customer_id
  returning public.customers.updated_at into saved_updated_at;

  perform public.write_audit_log(
    'customers', p_customer_id, 'customer.identity.updated', old_values,
    new_values || jsonb_build_object(
      'changed_fields', to_jsonb(changed_fields),
      'source', 'admin_customer_profile'
    ),
    p_actor_ip, p_actor_user_agent
  );

  return query select true, 'updated'::text,
    'Informacion comercial actualizada correctamente.'::text,
    null::text, p_customer_id, saved_updated_at;
end;
$$;

revoke all on function public.update_customer_identity_manual(
  uuid, text, text, text, text, text, text, timestamptz, text, text
) from public;
revoke all on function public.update_customer_identity_manual(
  uuid, text, text, text, text, text, text, timestamptz, text, text
) from anon;
grant execute on function public.update_customer_identity_manual(
  uuid, text, text, text, text, text, text, timestamptz, text, text
) to authenticated;

create or replace function public.link_customer_portal_account_manual(
  p_customer_id uuid,
  p_user_id uuid,
  p_reason text,
  p_confirmed boolean default false
)
returns table (ok boolean, status text, message text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  customer_row public.customers%rowtype;
  user_row public.users%rowtype;
  portal_role_name text;
  conflicting_customer_id uuid;
begin
  if actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('customers:link_portal_account')
  then
    if actor_id is not null then
      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
      values (
        actor_id, actor_role_name, 'customers', p_customer_id,
        'customer_portal_link.permission_denied',
        jsonb_build_object('confirmed', coalesce(p_confirmed, false), 'portal_user_id', p_user_id)
      );
    end if;
    return query select false, 'permission_denied'::text,
      'No tienes permiso para vincular cuentas del portal.'::text;
    return;
  end if;

  if not coalesce(p_confirmed, false) then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id, actor_role_name, 'customers', p_customer_id,
      'customer_portal_link.confirmation_required',
      jsonb_build_object('confirmed', false, 'portal_user_id', p_user_id)
    );
    return query select false, 'confirmation_required'::text,
      'Debes confirmar explicitamente la vinculacion.'::text;
    return;
  end if;

  if normalized_reason is null or char_length(normalized_reason) < 10 then
    return query select false, 'reason_required'::text,
      'Escribe un motivo de al menos 10 caracteres.'::text;
    return;
  end if;
  if char_length(normalized_reason) > 500 then
    return query select false, 'reason_too_long'::text,
      'El motivo no puede exceder 500 caracteres.'::text;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('customer-portal-link-user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('customer-portal-link-customer:' || p_customer_id::text, 0));

  select * into customer_row
  from public.customers
  where id = p_customer_id
  for update;

  if customer_row.id is null then
    return query select false, 'customer_not_found'::text,
      'El cliente comercial no existe.'::text;
    return;
  end if;
  if not coalesce(customer_row.active, false) or customer_row.status in ('inactive', 'disabled') then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id, actor_role_name, 'customers', p_customer_id,
      'customer_portal_link.inactive_customer',
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );
    return query select false, 'inactive_customer'::text,
      'El cliente comercial no esta activo.'::text;
    return;
  end if;

  select * into user_row
  from public.users
  where id = p_user_id
  for update;

  select name into portal_role_name
  from public.roles
  where id = user_row.role_id;

  if user_row.id is null or not coalesce(user_row.active, false)
    or not exists (select 1 from auth.users where id = p_user_id)
  then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id, actor_role_name, 'customers', p_customer_id,
      'customer_portal_link.invalid_portal_account',
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );
    return query select false, 'invalid_portal_account'::text,
      'La cuenta del portal no existe o no esta activa.'::text;
    return;
  end if;

  if portal_role_name is distinct from 'cliente' then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id, actor_role_name, 'customers', p_customer_id,
      'customer_portal_link.invalid_portal_role',
      jsonb_build_object(
        'portal_user_id', p_user_id,
        'portal_role', portal_role_name,
        'reason', normalized_reason
      )
    );
    return query select false, 'invalid_portal_role'::text,
      'Solo puede vincularse una cuenta del portal con rol cliente.'::text;
    return;
  end if;

  if customer_row.user_id = p_user_id then
    return query select true, 'already_linked'::text,
      'El cliente ya esta vinculado a esa cuenta del portal.'::text;
    return;
  end if;
  if customer_row.user_id is not null then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
    values (
      actor_id, actor_role_name, 'customers', p_customer_id,
      'customer_portal_link.customer_conflict',
      jsonb_build_object('linked', true),
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );
    return query select false, 'customer_conflict'::text,
      'El cliente ya esta vinculado a otra cuenta del portal.'::text;
    return;
  end if;

  select id into conflicting_customer_id
  from public.customers
  where user_id = p_user_id and id <> p_customer_id
  limit 1
  for update;

  if conflicting_customer_id is not null then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id, actor_role_name, 'customers', p_customer_id,
      'customer_portal_link.portal_account_conflict',
      jsonb_build_object('portal_user_id', p_user_id, 'reason', normalized_reason)
    );
    return query select false, 'portal_account_conflict'::text,
      'La cuenta del portal ya esta vinculada a otro cliente.'::text;
    return;
  end if;

  update public.customers
  set user_id = p_user_id
  where id = p_customer_id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id, actor_role_name, 'customers', p_customer_id,
    'customer_portal_link.linked_manual',
    jsonb_build_object('linked', false),
    jsonb_build_object(
      'linked', true,
      'portal_user_id', p_user_id,
      'reason', normalized_reason,
      'source', 'manual_admin_action'
    )
  );

  return query select true, 'linked'::text,
    'Cuenta del portal vinculada correctamente.'::text;
end;
$$;

revoke all on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) from public;
revoke all on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) from anon;
grant execute on function public.link_customer_portal_account_manual(uuid, uuid, text, boolean) to authenticated;
