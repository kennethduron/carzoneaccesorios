-- Keep public contact submissions traceable and transactional.

alter table public.company_settings
  add column if not exists notify_general_contact boolean not null default true;

create or replace function public.pick_public_form_assignee(role_names text[])
returns uuid
language sql
security definer
set search_path = public
as $$
  select users.id
  from public.users
  join public.roles on roles.id = users.role_id
  where users.active = true
    and roles.name = any(role_names)
  order by array_position(role_names, roles.name), users.created_at asc
  limit 1;
$$;

create or replace function public.safe_public_form_ip(raw_ip text)
returns inet
language plpgsql
immutable
as $$
begin
  return nullif(trim(coalesce(raw_ip, '')), '')::inet;
exception
  when invalid_text_representation then
    return null;
end;
$$;

create or replace function public.append_public_form_note(previous_note text, next_note text)
returns text
language sql
immutable
as $$
  select concat_ws(E'\n\n', nullif(trim(coalesce(previous_note, '')), ''), nullif(trim(coalesce(next_note, '')), ''));
$$;

create or replace function public.submit_public_general_contact(
  p_contact_name text,
  p_email text,
  p_phone text,
  p_message text,
  p_ip_address text default null,
  p_user_agent text default null
)
returns table (
  customer_id uuid,
  followup_id uuid,
  assigned_user_id uuid,
  due_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_name text := left(nullif(trim(coalesce(p_contact_name, '')), ''), 180);
  safe_email text := left(lower(nullif(trim(coalesce(p_email, '')), '')), 180);
  safe_phone text := left(nullif(trim(coalesce(p_phone, '')), ''), 40);
  safe_message text := left(nullif(trim(coalesce(p_message, '')), ''), 1200);
  local_phone text;
  possible_phones text[];
  note_text text;
  target_customer_id uuid;
  target_followup_id uuid;
  target_assignee_id uuid;
  target_due_at timestamptz := now() + interval '24 hours';
begin
  if safe_name is null or safe_email is null or safe_phone is null or safe_message is null then
    raise exception 'Completa los campos requeridos.';
  end if;

  local_phone := regexp_replace(safe_phone, '^\+?504', '');
  possible_phones := array[safe_phone, local_phone, '504' || local_phone, '+504' || local_phone];
  note_text := concat_ws(
    E'\n',
    '[CONTACTO_GENERAL]',
    'Origen: contacto_general',
    'Fecha: ' || now()::text,
    'Correo: ' || safe_email,
    'Mensaje: ' || safe_message
  );

  select customers.id
  into target_customer_id
  from public.customers
  where lower(coalesce(customers.email, '')) = safe_email
  order by customers.created_at asc
  limit 1;

  if target_customer_id is null then
    select customers.id
    into target_customer_id
    from public.customers
    where customers.phone = any(possible_phones)
    order by customers.created_at asc
    limit 1;
  end if;

  if target_customer_id is null then
    insert into public.customers (
      contact_name,
      email,
      phone,
      notes,
      lead_status,
      source,
      estimated_value,
      monthly_amount,
      is_wholesale,
      status,
      active
    )
    values (
      safe_name,
      safe_email,
      safe_phone,
      note_text,
      'prospecto',
      'contacto_general',
      0,
      0,
      false,
      'active',
      true
    )
    returning id into target_customer_id;
  else
    update public.customers
    set
      contact_name = safe_name,
      email = safe_email,
      phone = safe_phone,
      notes = public.append_public_form_note(customers.notes, note_text),
      source = coalesce(customers.source, 'contacto_general'),
      updated_at = now()
    where customers.id = target_customer_id;
  end if;

  target_assignee_id := public.pick_public_form_assignee(array['business_owner', 'admin', 'vendedor', 'soporte', 'technical_owner']);

  insert into public.crm_followups (
    customer_id,
    assigned_user_id,
    title,
    interaction_type,
    next_action,
    due_at,
    priority,
    phone,
    notes,
    estimated_value,
    monthly_amount,
    status
  )
  values (
    target_customer_id,
    target_assignee_id,
    'Contacto general desde la web',
    'contacto_general',
    'Responder consulta del cliente.',
    target_due_at,
    'media',
    safe_phone,
    note_text,
    0,
    0,
    'pending'
  )
  returning id into target_followup_id;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    new_data,
    ip_address,
    user_agent
  )
  values (
    null,
    'public',
    'crm_followups',
    target_followup_id,
    'public_form.contact_general.submitted',
    jsonb_build_object(
      'customer_id', target_customer_id,
      'followup_id', target_followup_id,
      'email', safe_email,
      'phone', safe_phone,
      'origin', 'contacto_general',
      'result', 'success'
    ),
    public.safe_public_form_ip(p_ip_address),
    left(nullif(trim(coalesce(p_user_agent, '')), ''), 500)
  );

  return query select target_customer_id, target_followup_id, target_assignee_id, target_due_at;
end;
$$;

create or replace function public.submit_public_wholesale_request(
  p_business_name text,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_city text,
  p_tax_id text default null,
  p_comment text default null,
  p_ip_address text default null,
  p_user_agent text default null
)
returns table (
  customer_id uuid,
  followup_id uuid,
  assigned_user_id uuid,
  due_at timestamptz,
  outcome text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_business_name text := left(nullif(trim(coalesce(p_business_name, '')), ''), 180);
  safe_contact_name text := left(nullif(trim(coalesce(p_contact_name, '')), ''), 180);
  safe_email text := left(lower(nullif(trim(coalesce(p_email, '')), '')), 180);
  safe_phone text := left(nullif(trim(coalesce(p_phone, '')), ''), 40);
  safe_city text := left(nullif(trim(coalesce(p_city, '')), ''), 180);
  safe_tax_id text := left(nullif(trim(coalesce(p_tax_id, '')), ''), 80);
  safe_comment text := left(nullif(trim(coalesce(p_comment, '')), ''), 600);
  local_phone text;
  possible_phones text[];
  note_text text;
  target_customer public.customers%rowtype;
  target_followup_id uuid;
  target_assignee_id uuid;
  target_due_at timestamptz := now() + interval '24 hours';
  current_wholesale_status text;
  next_outcome text;
  audit_action text;
begin
  if safe_business_name is null or safe_contact_name is null or safe_email is null or safe_phone is null or safe_city is null then
    raise exception 'Completa los campos requeridos.';
  end if;

  local_phone := regexp_replace(safe_phone, '^\+?504', '');
  possible_phones := array[safe_phone, local_phone, '504' || local_phone, '+504' || local_phone];
  note_text := concat_ws(
    E'\n',
    '[SOLICITUD_MAYOREO]',
    'Origen: formulario_publico',
    'Fecha: ' || now()::text,
    'Ciudad: ' || safe_city,
    case when safe_tax_id is not null then 'RTN: ' || safe_tax_id end,
    case when safe_comment is not null then 'Comentario: ' || safe_comment end
  );

  select customers.*
  into target_customer
  from public.customers
  where lower(coalesce(customers.email, '')) = safe_email
  order by customers.created_at asc
  limit 1;

  if target_customer.id is null then
    select customers.*
    into target_customer
    from public.customers
    where customers.phone = any(possible_phones)
    order by customers.created_at asc
    limit 1;
  end if;

  if target_customer.id is not null then
    current_wholesale_status := coalesce(
      nullif(target_customer.wholesale_status, 'none'),
      case
        when target_customer.is_wholesale and target_customer.active and target_customer.status = 'active' then 'approved'
        when target_customer.is_wholesale and (not target_customer.active or target_customer.status = 'disabled') then 'suspended'
        when target_customer.status = 'pending_account' or coalesce(target_customer.notes, '') like '%[SOLICITUD_MAYOREO]%' then 'pending'
        else 'none'
      end
    );
  else
    current_wholesale_status := 'none';
  end if;

  if current_wholesale_status in ('approved', 'suspended') then
    audit_action := 'public_form.wholesale.overwrite_blocked';

    insert into public.audit_logs (
      user_id,
      actor_role,
      table_name,
      record_id,
      action,
      new_data,
      ip_address,
      user_agent
    )
    values (
      null,
      'public',
      'customers',
      target_customer.id,
      audit_action,
      jsonb_build_object(
        'customer_id', target_customer.id,
        'email', safe_email,
        'phone', safe_phone,
        'origin', 'formulario_publico',
        'result', 'blocked',
        'protected_wholesale_status', current_wholesale_status
      ),
      public.safe_public_form_ip(p_ip_address),
      left(nullif(trim(coalesce(p_user_agent, '')), ''), 500)
    );

    return query select target_customer.id, null::uuid, null::uuid, null::timestamptz, current_wholesale_status;
    return;
  end if;

  if target_customer.id is null then
    insert into public.customers (
      business_name,
      company_name,
      contact_name,
      email,
      phone,
      tax_id,
      city,
      notes,
      lead_status,
      source,
      estimated_value,
      monthly_amount,
      is_wholesale,
      wholesale_status,
      wholesale_requested_at,
      wholesale_request_source,
      wholesale_approved_notice_seen,
      status,
      active
    )
    values (
      safe_business_name,
      safe_business_name,
      safe_contact_name,
      safe_email,
      safe_phone,
      safe_tax_id,
      safe_city,
      note_text,
      'prospecto',
      'solicitud_mayorista',
      0,
      0,
      false,
      'pending',
      now(),
      'formulario_publico',
      false,
      'pending_account',
      true
    )
    returning * into target_customer;

    next_outcome := 'created';
  elsif current_wholesale_status = 'pending' then
    update public.customers
    set
      business_name = safe_business_name,
      company_name = safe_business_name,
      contact_name = safe_contact_name,
      email = safe_email,
      phone = safe_phone,
      tax_id = safe_tax_id,
      city = safe_city,
      notes = public.append_public_form_note(customers.notes, note_text),
      source = coalesce(customers.source, 'solicitud_mayorista'),
      updated_at = now()
    where customers.id = target_customer.id
    returning * into target_customer;

    next_outcome := 'pending';
  elsif current_wholesale_status = 'rejected' then
    update public.customers
    set
      business_name = safe_business_name,
      company_name = safe_business_name,
      contact_name = safe_contact_name,
      email = safe_email,
      phone = safe_phone,
      tax_id = safe_tax_id,
      city = safe_city,
      notes = public.append_public_form_note(customers.notes, note_text),
      source = coalesce(customers.source, 'solicitud_mayorista'),
      updated_at = now()
    where customers.id = target_customer.id
    returning * into target_customer;

    next_outcome := 'rejected_review';
  else
    update public.customers
    set
      business_name = safe_business_name,
      company_name = safe_business_name,
      contact_name = safe_contact_name,
      email = safe_email,
      phone = safe_phone,
      tax_id = safe_tax_id,
      city = safe_city,
      notes = public.append_public_form_note(customers.notes, note_text),
      source = coalesce(customers.source, 'solicitud_mayorista'),
      lead_status = 'prospecto',
      is_wholesale = false,
      wholesale_status = 'pending',
      wholesale_requested_at = now(),
      wholesale_request_source = 'formulario_publico',
      wholesale_approved_notice_seen = false,
      status = case when customers.user_id is null then 'pending_account' else 'active' end,
      active = true,
      updated_at = now()
    where customers.id = target_customer.id
    returning * into target_customer;

    next_outcome := 'created';
  end if;

  target_assignee_id := public.pick_public_form_assignee(array['business_owner', 'admin', 'technical_owner']);

  select crm_followups.id
  into target_followup_id
  from public.crm_followups
  where crm_followups.customer_id = target_customer.id
    and crm_followups.interaction_type = 'solicitud_mayorista'
    and crm_followups.status = 'pending'
  order by crm_followups.created_at asc
  limit 1;

  if target_followup_id is null then
    insert into public.crm_followups (
      customer_id,
      assigned_user_id,
      title,
      interaction_type,
      next_action,
      due_at,
      priority,
      phone,
      notes,
      estimated_value,
      monthly_amount,
      status
    )
    values (
      target_customer.id,
      target_assignee_id,
      case when next_outcome = 'rejected_review' then 'Revisar caso mayorista rechazado' else 'Solicitud de cuenta mayorista' end,
      'solicitud_mayorista',
      case
        when next_outcome = 'rejected_review' then 'Revisar manualmente el caso rechazado y contactar al cliente.'
        else 'Revisar solicitud, validar datos y aprobar si corresponde.'
      end,
      target_due_at,
      'alta',
      safe_phone,
      note_text,
      0,
      0,
      'pending'
    )
    returning id into target_followup_id;
  else
    update public.crm_followups
    set
      assigned_user_id = coalesce(crm_followups.assigned_user_id, target_assignee_id),
      due_at = coalesce(crm_followups.due_at, target_due_at),
      phone = safe_phone,
      notes = public.append_public_form_note(crm_followups.notes, note_text),
      updated_at = now()
    where crm_followups.id = target_followup_id
    returning crm_followups.assigned_user_id, crm_followups.due_at
    into target_assignee_id, target_due_at;
  end if;

  audit_action := case
    when next_outcome = 'created' then 'public_form.wholesale.submitted'
    when next_outcome = 'pending' then 'public_form.wholesale.duplicate_pending'
    else 'public_form.wholesale.overwrite_blocked'
  end;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    new_data,
    ip_address,
    user_agent
  )
  values (
    null,
    'public',
    'customers',
    target_customer.id,
    audit_action,
    jsonb_build_object(
      'customer_id', target_customer.id,
      'followup_id', target_followup_id,
      'email', safe_email,
      'phone', safe_phone,
      'origin', 'formulario_publico',
      'result', next_outcome,
      'protected_wholesale_status', current_wholesale_status
    ),
    public.safe_public_form_ip(p_ip_address),
    left(nullif(trim(coalesce(p_user_agent, '')), ''), 500)
  );

  return query select target_customer.id, target_followup_id, target_assignee_id, target_due_at, next_outcome;
end;
$$;

revoke all on function public.pick_public_form_assignee(text[]) from public;
revoke all on function public.safe_public_form_ip(text) from public;
revoke all on function public.append_public_form_note(text, text) from public;
revoke all on function public.submit_public_general_contact(text, text, text, text, text, text) from public;
revoke all on function public.submit_public_wholesale_request(text, text, text, text, text, text, text, text, text) from public;

grant execute on function public.submit_public_general_contact(text, text, text, text, text, text) to service_role;
grant execute on function public.submit_public_wholesale_request(text, text, text, text, text, text, text, text, text) to service_role;

