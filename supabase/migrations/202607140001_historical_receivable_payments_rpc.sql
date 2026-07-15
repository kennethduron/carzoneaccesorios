create or replace function public.register_credit_receivable_payment(
  target_receivable_id uuid,
  payment_amount numeric,
  received_payment_method text,
  payment_reference text default null,
  payment_received_at timestamptz default now(),
  payment_note text default null,
  payment_receipt_url text default null,
  payment_receipt_public_id text default null,
  request_key text default null
)
returns table (
  payment_id uuid,
  receivable_status text,
  balance_due numeric,
  total_paid numeric,
  queued_email_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  receivable_row record;
  existing_payment public.accounts_receivable_payments%rowtype;
  saved_payment public.accounts_receivable_payments%rowtype;
  normalized_amount numeric(12, 2) := round(coalesce(payment_amount, 0), 2);
  normalized_method text;
  normalized_reference text := nullif(left(trim(coalesce(payment_reference, '')), 200), '');
  normalized_note text := nullif(left(trim(coalesce(payment_note, '')), 1000), '');
  normalized_receipt_url text := nullif(left(trim(coalesce(payment_receipt_url, '')), 1000), '');
  normalized_receipt_public_id text := nullif(left(trim(coalesce(payment_receipt_public_id, '')), 300), '');
  normalized_request_key text := nullif(left(trim(coalesce(request_key, '')), 200), '');
  normalized_received_at timestamptz := coalesce(payment_received_at, now());
  paid_total numeric(12, 2);
  remaining_balance numeric(12, 2);
  next_status text;
  notification_id uuid;
  receivable_kind text;
  receivable_label text;
begin
  select r.name
    into actor_role_name
    from public.users u
    left join public.roles r on r.id = u.role_id
    where u.id = actor_id;

  if actor_role_name not in ('technical_owner', 'business_owner', 'admin') then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_permission_denied',
      actor_id,
      jsonb_build_object('attempted_action', 'register_payment', 'role', actor_role_name)
    );
    raise exception 'No tienes permiso para registrar abonos de credito comercial.';
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
    raise exception 'Selecciona el metodo de pago del abono.';
  end if;

  if normalized_method = 'cash' then
    normalized_reference := null;
  end if;

  if normalized_amount <= 0 then
    raise exception 'El abono debe ser mayor que cero.';
  end if;

  if normalized_request_key is not null then
    select *
      into existing_payment
      from public.accounts_receivable_payments
      where idempotency_key = normalized_request_key
      limit 1;

    if existing_payment.id is not null then
      select coalesce(sum(amount), 0)
        into paid_total
        from public.accounts_receivable_payments
        where receivable_id = existing_payment.receivable_id
          and voided_at is null;

      select ar.status, ar.balance_due
        into receivable_status, balance_due
        from public.accounts_receivable ar
        where ar.id = existing_payment.receivable_id;

      payment_id := existing_payment.id;
      total_paid := paid_total;
      queued_email_id := null;
      return next;
      return;
    end if;
  end if;

  select
      ar.id,
      ar.customer_id,
      ar.order_id,
      ar.invoice_id,
      ar.historical_invoice_number,
      ar.imported_from_batch_id,
      ar.imported_from_row_id,
      ar.original_amount,
      ar.balance_due,
      ar.due_date,
      ar.status,
      ar.paid_at,
      ar.payment_received_method,
      ar.payment_received_reference,
      ar.payment_recorded_by,
      ar.created_at,
      ar.updated_at,
      c.user_id as customer_user_id,
      c.email as customer_email,
      c.contact_name as customer_contact_name,
      c.business_name as customer_business_name,
      o.order_number,
      i.status as invoice_status
    into receivable_row
    from public.accounts_receivable ar
    join public.customers c on c.id = ar.customer_id
    left join public.orders o on o.id = ar.order_id
    left join public.invoices i on i.id = ar.invoice_id
    where ar.id = target_receivable_id
    for update of ar;

  if receivable_row.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  receivable_kind := case when receivable_row.order_id is null then 'historical' else 'normal' end;
  receivable_label := coalesce(
    nullif(receivable_row.order_number, ''),
    nullif(receivable_row.historical_invoice_number, ''),
    'CxC ' || left(receivable_row.id::text, 8)
  );

  if receivable_row.status = 'paid' then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_paid_denied',
      actor_id,
      jsonb_build_object('attempted_amount', normalized_amount, 'receivable_kind', receivable_kind)
    );
    raise exception 'Esta cuenta por cobrar ya esta pagada.';
  end if;

  if receivable_row.status = 'cancelled' then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_cancelled_denied',
      actor_id,
      jsonb_build_object('attempted_amount', normalized_amount, 'receivable_kind', receivable_kind)
    );
    raise exception 'Esta cuenta por cobrar esta cancelada.';
  end if;

  if receivable_row.invoice_status in ('anulada', 'cancelled') then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_void_invoice_denied',
      actor_id,
      jsonb_build_object('invoice_id', receivable_row.invoice_id, 'invoice_status', receivable_row.invoice_status, 'receivable_kind', receivable_kind)
    );
    raise exception 'Esta cuenta por cobrar tiene factura anulada y no acepta abonos.';
  end if;

  if normalized_amount > receivable_row.balance_due then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.overpayment_denied',
      actor_id,
      jsonb_build_object(
        'attempted_amount', normalized_amount,
        'balance_due', receivable_row.balance_due,
        'order_id', receivable_row.order_id,
        'receivable_kind', receivable_kind
      )
    );
    raise exception 'El abono no puede ser mayor que el saldo pendiente de esta cuenta por cobrar.';
  end if;

  begin
    insert into public.accounts_receivable_payments (
      receivable_id,
      customer_id,
      order_id,
      amount,
      payment_method,
      reference,
      received_at,
      note,
      receipt_url,
      receipt_public_id,
      recorded_by,
      idempotency_key
    )
    values (
      receivable_row.id,
      receivable_row.customer_id,
      receivable_row.order_id,
      normalized_amount,
      normalized_method,
      normalized_reference,
      normalized_received_at,
      normalized_note,
      normalized_receipt_url,
      normalized_receipt_public_id,
      actor_id,
      normalized_request_key
    )
    returning * into saved_payment;
  exception
    when unique_violation then
      if normalized_request_key is null then
        raise;
      end if;

      select *
        into saved_payment
        from public.accounts_receivable_payments
        where idempotency_key = normalized_request_key
        limit 1;

      if saved_payment.id is null then
        raise;
      end if;

      select round(coalesce(sum(amount), 0), 2)
        into paid_total
        from public.accounts_receivable_payments
        where receivable_id = saved_payment.receivable_id
          and voided_at is null;

      select ar.status, ar.balance_due
        into receivable_status, balance_due
        from public.accounts_receivable ar
        where ar.id = saved_payment.receivable_id;

      payment_id := saved_payment.id;
      total_paid := paid_total;
      queued_email_id := null;
      return next;
      return;
  end;

  select round(coalesce(sum(amount), 0), 2)
    into paid_total
    from public.accounts_receivable_payments
    where receivable_id = receivable_row.id
      and voided_at is null;

  remaining_balance := greatest(round(receivable_row.original_amount - paid_total, 2), 0);
  next_status := case
    when remaining_balance = 0 then 'paid'
    when receivable_row.due_date < current_date then 'overdue'
    else 'partial'
  end;

  update public.accounts_receivable
    set balance_due = remaining_balance,
        status = next_status,
        paid_at = case when remaining_balance = 0 then now() else null end,
        overdue_at = case
          when next_status = 'overdue' then coalesce(overdue_at, now())
          when next_status in ('partial', 'paid') then overdue_at
          else overdue_at
        end,
        payment_received_method = normalized_method,
        payment_received_reference = normalized_reference,
        payment_recorded_by = actor_id,
        updated_at = now()
    where id = receivable_row.id;

  if remaining_balance = 0 then
    if receivable_row.order_id is not null then
      update public.payments
        set payment_status = 'approved',
            status = 'approved',
            paid_at = now(),
            bank_reference_number = case when normalized_method = 'bank_transfer' then normalized_reference else bank_reference_number end,
            reference = case when normalized_method in ('bank_transfer', 'card') then normalized_reference else reference end,
            updated_at = now()
        where order_id = receivable_row.order_id
          and payment_method = 'commercial_credit';
    end if;

    update public.email_queue
      set status = 'cancelled',
          updated_at = now()
      where related_module = 'pagos'
        and related_id = receivable_row.id
        and status in ('pending', 'retrying')
        and template_key in (
          'commercial_credit.reminder_7_days',
          'commercial_credit.reminder_3_days',
          'commercial_credit.reminder_1_day',
          'commercial_credit.overdue'
        );
  end if;

  if receivable_row.customer_user_id is not null then
    insert into public.internal_notifications (
      event_type,
      notification_type,
      module,
      user_id,
      customer_id,
      order_id,
      title,
      message,
      severity,
      audience_roles,
      read_state,
      status,
      metadata,
      dedupe_key
    )
    values (
      case when remaining_balance = 0 then 'customer.commercial_credit.paid_complete' else 'customer.commercial_credit.payment_registered:' || saved_payment.id::text end,
      case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
      'pagos',
      receivable_row.customer_user_id,
      receivable_row.customer_id,
      receivable_row.order_id,
      case when remaining_balance = 0 then 'Credito pagado completamente' else 'Abono registrado' end,
      case
        when remaining_balance = 0 then 'Tu credito comercial fue pagado completamente.'
        else 'Hemos registrado un abono a tu credito comercial.'
      end,
      'info',
      array[]::text[],
      'unread',
      'open',
      jsonb_build_object(
        'receivable_id', receivable_row.id,
        'payment_id', saved_payment.id,
        'order_number', receivable_row.order_number,
        'receivable_label', receivable_label,
        'receivable_kind', receivable_kind,
        'amount', normalized_amount,
        'balance_due', remaining_balance,
        'action_path', '/cuenta'
      ),
      'credit-payment:' || saved_payment.id::text
    );
  end if;

  insert into public.internal_notifications (
    event_type,
    notification_type,
    module,
    customer_id,
    order_id,
    title,
    message,
    severity,
    audience_roles,
    read_state,
    status,
    metadata,
    dedupe_key
  )
  values (
    case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered:' || saved_payment.id::text end,
    case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
    'pagos',
    receivable_row.customer_id,
    receivable_row.order_id,
    case when remaining_balance = 0 then 'Credito comercial pagado' else 'Abono de credito registrado' end,
    receivable_label || ': abono L ' || normalized_amount::text || ', saldo L ' || remaining_balance::text || '.',
    case when remaining_balance = 0 then 'info' else 'warning' end,
    array['technical_owner','business_owner','admin']::text[],
    'unread',
    'open',
    jsonb_build_object(
      'receivable_id', receivable_row.id,
      'payment_id', saved_payment.id,
      'order_number', receivable_row.order_number,
      'receivable_label', receivable_label,
      'receivable_kind', receivable_kind,
      'amount', normalized_amount,
      'balance_due', remaining_balance
    ),
    'credit-payment-internal:' || saved_payment.id::text
  )
  returning id into notification_id;

  if coalesce(receivable_row.customer_email, '') like '%@%' then
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
      lower(trim(receivable_row.customer_email)),
      coalesce(nullif(receivable_row.customer_business_name, ''), nullif(receivable_row.customer_contact_name, ''), receivable_row.customer_email),
      case when remaining_balance = 0 then 'Tu credito ha sido pagado completamente' else 'Hemos registrado tu abono' end,
      case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
      jsonb_build_object(
        'title', case when remaining_balance = 0 then 'Tu credito ha sido pagado completamente' else 'Hemos registrado tu abono' end,
        'message', case
          when remaining_balance = 0 then 'El saldo de esta cuenta por cobrar quedo pagado completamente.'
          else 'Registramos tu abono para esta cuenta por cobrar.'
        end,
        'customer_name', coalesce(nullif(receivable_row.customer_business_name, ''), nullif(receivable_row.customer_contact_name, ''), 'Cliente'),
        'order_number', receivable_row.order_number,
        'receivable_label', receivable_label,
        'receivable_kind', receivable_kind,
        'amount', normalized_amount,
        'balance_due', remaining_balance,
        'received_at', normalized_received_at,
        'payment_method', case
          when normalized_method = 'bank_transfer' then 'Transferencia bancaria'
          when normalized_method = 'card' then 'Tarjeta'
          else 'Efectivo'
        end,
        'reference', normalized_reference,
        'action_label', 'Ver mi cuenta',
        'action_path', '/cuenta'
      ),
      'pending',
      now(),
      'credit.payment:' || saved_payment.id::text,
      'pagos',
      receivable_row.id,
      2
    )
    returning id into queued_email_id;
  else
    queued_email_id := null;
  end if;

  insert into public.audit_logs (table_name, record_id, action, user_id, old_data, new_data)
  values (
    'accounts_receivable_payments',
    saved_payment.id,
    'commercial_credit.payment_registered',
    actor_id,
    null,
    to_jsonb(saved_payment)
  ), (
    'accounts_receivable',
    receivable_row.id,
    case when next_status = 'paid' then 'commercial_credit.receivable_paid' else 'commercial_credit.receivable_partial' end,
    actor_id,
    jsonb_build_object(
      'status', receivable_row.status,
      'balance_due', receivable_row.balance_due,
      'paid_at', receivable_row.paid_at
    ),
    jsonb_build_object(
      'status', next_status,
      'balance_due', remaining_balance,
      'total_paid', paid_total,
      'payment_id', saved_payment.id,
      'paid_at', case when remaining_balance = 0 then now() else null end,
      'receivable_kind', receivable_kind,
      'customer_id', receivable_row.customer_id,
      'order_id', receivable_row.order_id,
      'historical_invoice_number', receivable_row.historical_invoice_number,
      'payment_method', normalized_method,
      'reference', normalized_reference,
      'source', 'admin_accounts_receivable'
    )
  );

  payment_id := saved_payment.id;
  receivable_status := next_status;
  balance_due := remaining_balance;
  total_paid := paid_total;
  return next;
end;
$$;

grant execute on function public.register_credit_receivable_payment(uuid, numeric, text, text, timestamptz, text, text, text, text) to authenticated;
