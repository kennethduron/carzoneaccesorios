create or replace function public.set_customer_commercial_credit_authorized(
  target_customer_id uuid,
  credit_enabled boolean,
  target_credit_limit numeric,
  target_terms_days integer,
  target_status text default 'active',
  internal_notes text default null
)
returns table (
  credit_account_id uuid,
  is_credit_enabled boolean,
  credit_limit numeric,
  terms_days integer,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  previous_row public.customer_credit_accounts%rowtype;
  saved_row public.customer_credit_accounts%rowtype;
  customer_record record;
  normalized_status text := coalesce(nullif(trim(target_status), ''), 'active');
  normalized_limit numeric := round(coalesce(target_credit_limit, 0), 2);
  normalized_terms integer := coalesce(target_terms_days, 30);
  action_name text := 'commercial_credit.updated';
  activation_notice boolean := false;
  notification_id uuid;
  queued_email_id uuid;
begin
  select r.name
    into actor_role_name
    from public.users u
    left join public.roles r on r.id = u.role_id
    where u.id = actor_id;

  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
     or not public.has_permission('credit:manage') then
    raise exception 'No tienes permiso para modificar credito comercial.';
  end if;

  if normalized_status not in ('active', 'suspended') then
    raise exception 'Estado de credito invalido.';
  end if;

  if normalized_limit < 0 then
    raise exception 'El limite de credito no puede ser negativo.';
  end if;

  if credit_enabled and normalized_status = 'active' and normalized_limit <= 0 then
    raise exception 'El limite de credito debe ser mayor a cero.';
  end if;

  if normalized_terms < 1 or normalized_terms > 365 then
    raise exception 'El plazo de credito debe estar entre 1 y 365 dias.';
  end if;

  select id, user_id, email, contact_name, business_name
    into customer_record
    from public.customers
    where id = target_customer_id
    limit 1;

  if customer_record.id is null then
    raise exception 'Cliente no encontrado.';
  end if;

  select *
    into previous_row
    from public.customer_credit_accounts
    where customer_id = target_customer_id
    for update;

  insert into public.customer_credit_accounts (
    customer_id,
    is_credit_enabled,
    credit_limit,
    terms_days,
    status,
    activated_at,
    activated_by,
    suspended_at,
    suspended_by,
    notes,
    updated_at
  )
  values (
    target_customer_id,
    credit_enabled,
    normalized_limit,
    normalized_terms,
    case when credit_enabled then normalized_status else 'suspended' end,
    case when credit_enabled then now() else null end,
    case when credit_enabled then actor_id else null end,
    case when credit_enabled then null else now() end,
    case when credit_enabled then null else actor_id end,
    nullif(trim(coalesce(internal_notes, '')), ''),
    now()
  )
  on conflict (customer_id) do update
  set is_credit_enabled = excluded.is_credit_enabled,
      credit_limit = excluded.credit_limit,
      terms_days = excluded.terms_days,
      status = excluded.status,
      activated_at = case
        when excluded.is_credit_enabled
             and (public.customer_credit_accounts.activated_at is null or public.customer_credit_accounts.is_credit_enabled = false)
        then now()
        else public.customer_credit_accounts.activated_at
      end,
      activated_by = case
        when excluded.is_credit_enabled
             and (public.customer_credit_accounts.activated_by is null or public.customer_credit_accounts.is_credit_enabled = false)
        then actor_id
        else public.customer_credit_accounts.activated_by
      end,
      suspended_at = case
        when excluded.is_credit_enabled = false or excluded.status = 'suspended' then now()
        when excluded.status = 'active' then null
        else public.customer_credit_accounts.suspended_at
      end,
      suspended_by = case
        when excluded.is_credit_enabled = false or excluded.status = 'suspended' then actor_id
        when excluded.status = 'active' then null
        else public.customer_credit_accounts.suspended_by
      end,
      notes = excluded.notes,
      updated_at = now()
  returning * into saved_row;

  if previous_row.id is null and saved_row.is_credit_enabled then
    action_name := 'commercial_credit.activated';
  elsif previous_row.is_credit_enabled = false and saved_row.is_credit_enabled then
    action_name := 'commercial_credit.activated';
  elsif previous_row.is_credit_enabled = true and saved_row.is_credit_enabled = false then
    action_name := 'commercial_credit.deactivated';
  elsif previous_row.status = 'suspended' and saved_row.status = 'active' and saved_row.is_credit_enabled then
    action_name := 'commercial_credit.reactivated';
  elsif previous_row.status <> saved_row.status and saved_row.status = 'suspended' then
    action_name := 'commercial_credit.suspended';
  end if;

  activation_notice :=
    saved_row.is_credit_enabled
    and saved_row.status = 'active'
    and (
      previous_row.id is null
      or previous_row.is_credit_enabled = false
      or previous_row.status = 'suspended'
    );

  insert into public.audit_logs (
    table_name,
    record_id,
    action,
    user_id,
    old_data,
    new_data
  )
  values (
    'customer_credit_accounts',
    saved_row.id,
    action_name,
    actor_id,
    to_jsonb(previous_row),
    jsonb_build_object(
      'customer_id', saved_row.customer_id,
      'is_credit_enabled', saved_row.is_credit_enabled,
      'credit_limit', saved_row.credit_limit,
      'terms_days', saved_row.terms_days,
      'status', saved_row.status
    )
  );

  if activation_notice then
    if customer_record.user_id is not null then
      insert into public.internal_notifications (
        event_type,
        notification_type,
        module,
        user_id,
        customer_id,
        title,
        message,
        severity,
        audience_roles,
        read_state,
        status,
        metadata
      )
      values (
        'commercial_credit.enabled',
        'commercial_credit.enabled',
        'pagos',
        customer_record.user_id,
        target_customer_id,
        'Crédito comercial habilitado',
        'Crédito comercial habilitado. Ahora puedes realizar compras a crédito según las condiciones asignadas.',
        'info',
        array[]::text[],
        'unread',
        'open',
        jsonb_build_object(
          'credit_limit', saved_row.credit_limit,
          'terms_days', saved_row.terms_days,
          'action_path', '/cuenta'
        )
      )
      returning id into notification_id;

      insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
      values (
        'internal_notifications',
        notification_id,
        'commercial_credit.visual_notification_created',
        actor_id,
        jsonb_build_object(
          'customer_id', target_customer_id,
          'notification_type', 'commercial_credit.enabled'
        )
      );
    end if;

    if coalesce(customer_record.email, '') like '%@%' then
      insert into public.email_queue (
        to_email,
        to_name,
        subject,
        template_key,
        payload,
        status,
        scheduled_at,
        idempotency_key,
        related_module,
        related_id,
        priority
      )
      values (
        lower(trim(customer_record.email)),
        coalesce(nullif(customer_record.business_name, ''), nullif(customer_record.contact_name, ''), customer_record.email),
        'Tu crédito comercial ha sido habilitado',
        'commercial_credit.enabled',
        jsonb_build_object(
          'title', 'Tu crédito comercial ha sido habilitado',
          'message', 'Car Zone Accesorios habilitó crédito comercial para tu cuenta. Ahora podrás comprar usando la opción Crédito Comercial; cada compra tendrá una fecha límite de pago.',
          'customer_name', coalesce(nullif(customer_record.business_name, ''), nullif(customer_record.contact_name, ''), 'Cliente'),
          'credit_limit', saved_row.credit_limit,
          'terms_days', saved_row.terms_days,
          'action_label', 'Ver mi cuenta',
          'action_path', '/cuenta'
        ),
        'pending',
        now(),
        'credit.enabled:' || target_customer_id::text,
        'pagos',
        saved_row.id,
        3
      )
      on conflict (idempotency_key) where idempotency_key is not null do nothing
      returning id into queued_email_id;

      if queued_email_id is not null then
        insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
        values (
          'email_queue',
          queued_email_id,
          'commercial_credit.enabled_email_queued',
          actor_id,
          jsonb_build_object(
            'customer_id', target_customer_id,
            'idempotency_key', 'credit.enabled:' || target_customer_id::text
          )
        );
      end if;
    end if;
  end if;

  credit_account_id := saved_row.id;
  is_credit_enabled := saved_row.is_credit_enabled;
  credit_limit := saved_row.credit_limit;
  terms_days := saved_row.terms_days;
  status := saved_row.status;
  return next;
end;
$$;

create or replace function public.mark_credit_receivable_paid_authorized(
  target_receivable_id uuid,
  received_payment_method text,
  payment_reference text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  receivable_row public.accounts_receivable%rowtype;
  normalized_method text;
  normalized_reference text := nullif(left(trim(coalesce(payment_reference, '')), 200), '');
begin
  select r.name
    into actor_role_name
    from public.users u
    left join public.roles r on r.id = u.role_id
    where u.id = actor_id;

  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
     or not public.has_permission('credit:mark_paid') then
    raise exception 'No tienes permiso para marcar credito como pagado.';
  end if;

  normalized_method := case lower(trim(coalesce(received_payment_method, '')))
    when 'bank_transfer' then 'bank_transfer'
    when 'transferencia bancaria' then 'bank_transfer'
    when 'transferencia' then 'bank_transfer'
    when 'card' then 'card'
    when 'tarjeta' then 'card'
    when 'cash' then 'cash'
    when 'efectivo' then 'cash'
    else null
  end;

  if normalized_method is null then
    raise exception 'Selecciona el metodo con el que pago el cliente.';
  end if;

  if normalized_method = 'cash' then
    normalized_reference := null;
  end if;

  select *
    into receivable_row
    from public.accounts_receivable
    where id = target_receivable_id
    for update;

  if receivable_row.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  if receivable_row.status = 'paid' then
    raise exception 'Esta cuenta por cobrar ya esta pagada.';
  end if;

  update public.accounts_receivable
    set status = 'paid',
        balance_due = 0,
        paid_at = now(),
        payment_received_method = normalized_method,
        payment_received_reference = normalized_reference,
        payment_recorded_by = actor_id,
        updated_at = now()
    where id = target_receivable_id;

  update public.payments
    set payment_status = 'approved',
        status = 'approved',
        paid_at = now(),
        bank_reference_number = case when normalized_method = 'bank_transfer' then normalized_reference else bank_reference_number end,
        reference = case when normalized_method in ('bank_transfer', 'card') then normalized_reference else reference end,
        updated_at = now()
    where order_id = receivable_row.order_id
      and payment_method = 'commercial_credit';

  update public.email_queue
    set status = 'cancelled',
        updated_at = now()
    where related_module = 'pagos'
      and related_id = target_receivable_id
      and status in ('pending', 'retrying')
      and template_key in (
        'commercial_credit.reminder_7_days',
        'commercial_credit.reminder_3_days',
        'commercial_credit.reminder_1_day',
        'commercial_credit.overdue'
      );

  insert into public.audit_logs (
    table_name,
    record_id,
    action,
    user_id,
    old_data,
    new_data
  )
  values (
    'accounts_receivable',
    target_receivable_id,
    'commercial_credit.payment_method_recorded',
    actor_id,
    jsonb_build_object(
      'payment_received_method', receivable_row.payment_received_method,
      'payment_received_reference', receivable_row.payment_received_reference
    ),
    jsonb_build_object(
      'payment_received_method', normalized_method,
      'payment_received_reference', normalized_reference,
      'payment_recorded_by', actor_id
    )
  ), (
    'accounts_receivable',
    target_receivable_id,
    'commercial_credit.receivable_paid',
    actor_id,
    to_jsonb(receivable_row),
    jsonb_build_object(
      'status', 'paid',
      'balance_due', 0,
      'paid_at', now(),
      'order_id', receivable_row.order_id,
      'payment_received_method', normalized_method
    )
  );

  return true;
end;
$$;

create or replace function public.mark_credit_receivable_paid(
  target_receivable_id uuid,
  received_payment_method text,
  payment_reference text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  current_status text;
begin
  select r.name
    into actor_role_name
    from public.users u
    left join public.roles r on r.id = u.role_id
    where u.id = actor_id;

  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
     or not public.has_permission('credit:mark_paid') then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.permission_denied',
      actor_id,
      jsonb_build_object(
        'attempted_action', 'mark_paid',
        'role', actor_role_name
      )
    );
    return false;
  end if;

  select status
    into current_status
    from public.accounts_receivable
    where id = target_receivable_id;

  if current_status = 'paid' then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.paid_edit_denied',
      actor_id,
      jsonb_build_object('attempted_action', 'mark_paid_again')
    );
    return false;
  end if;

  return public.mark_credit_receivable_paid_authorized(target_receivable_id, received_payment_method, payment_reference);
end;
$$;

revoke execute on function public.mark_credit_receivable_paid_authorized(uuid, text, text) from anon, authenticated;
grant execute on function public.mark_credit_receivable_paid(uuid, text, text) to authenticated;
