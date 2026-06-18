create table if not exists public.accounts_receivable_payments (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null references public.accounts_receivable(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  payment_method text not null check (payment_method in ('bank_transfer', 'card', 'cash')),
  reference text check (reference is null or char_length(reference) <= 200),
  received_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 1000),
  receipt_url text check (receipt_url is null or char_length(receipt_url) <= 1000),
  receipt_public_id text check (receipt_public_id is null or char_length(receipt_public_id) <= 300),
  recorded_by uuid references public.users(id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references public.users(id) on delete set null,
  void_reason text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  constraint accounts_receivable_payments_void_reason_required check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and nullif(trim(void_reason), '') is not null)
  )
);

create index if not exists accounts_receivable_payments_receivable_created_idx
  on public.accounts_receivable_payments(receivable_id, created_at desc);

create index if not exists accounts_receivable_payments_customer_received_idx
  on public.accounts_receivable_payments(customer_id, received_at desc);

create index if not exists accounts_receivable_payments_order_idx
  on public.accounts_receivable_payments(order_id);

create unique index if not exists accounts_receivable_payments_idempotency_idx
  on public.accounts_receivable_payments(idempotency_key)
  where idempotency_key is not null;

alter table public.accounts_receivable_payments enable row level security;

drop policy if exists accounts_receivable_payments_select on public.accounts_receivable_payments;
create policy accounts_receivable_payments_select
  on public.accounts_receivable_payments for select
  using (
    public.has_permission('receivables:read')
    or public.has_permission('credit:manage')
    or exists (
      select 1
      from public.customers
      join public.customer_credit_accounts
        on customer_credit_accounts.customer_id = customers.id
      where customers.id = accounts_receivable_payments.customer_id
        and customers.user_id = auth.uid()
        and customer_credit_accounts.is_credit_enabled = true
        and customer_credit_accounts.status = 'active'
    )
  );

grant select on public.accounts_receivable_payments to authenticated;
grant select, insert, update, delete on public.accounts_receivable_payments to service_role;

alter table public.accounts_receivable
  drop constraint if exists accounts_receivable_no_partial_payments;

alter table public.accounts_receivable
  drop constraint if exists accounts_receivable_status_check;

alter table public.accounts_receivable
  add constraint accounts_receivable_status_check
  check (status in ('open', 'partial', 'paid', 'overdue', 'cancelled'));

alter table public.accounts_receivable
  add constraint accounts_receivable_balance_status_consistency
  check (
    (status = 'paid' and balance_due = 0 and paid_at is not null)
    or (status = 'cancelled' and balance_due = 0)
    or (status = 'open' and balance_due = original_amount and paid_at is null)
    or (status = 'partial' and balance_due > 0 and balance_due < original_amount and paid_at is null)
    or (status = 'overdue' and balance_due > 0 and paid_at is null)
  );

alter table public.accounts_receivable
  drop constraint if exists accounts_receivable_paid_payment_method_required;

alter table public.accounts_receivable
  add constraint accounts_receivable_paid_payment_method_required
  check (status <> 'paid' or payment_received_method is not null);

insert into public.accounts_receivable_payments (
  receivable_id,
  customer_id,
  order_id,
  amount,
  payment_method,
  reference,
  received_at,
  note,
  recorded_by,
  idempotency_key
)
select
  ar.id,
  ar.customer_id,
  ar.order_id,
  ar.original_amount,
  coalesce(ar.payment_received_method, 'bank_transfer'),
  ar.payment_received_reference,
  coalesce(ar.paid_at, ar.updated_at, ar.created_at),
  'Pago registrado antes de habilitar abonos parciales.',
  ar.payment_recorded_by,
  'legacy-paid:' || ar.id::text
from public.accounts_receivable ar
where ar.status = 'paid'
  and not exists (
    select 1
    from public.accounts_receivable_payments arp
    where arp.receivable_id = ar.id
      and arp.voided_at is null
  );

insert into public.notification_preferences (
  notification_type,
  module,
  label,
  internal_enabled,
  email_enabled,
  push_enabled,
  destination_roles,
  technical_only
)
values
  ('commercial_credit.payment_registered', 'pagos', 'Abono de credito registrado', true, false, false, array['technical_owner','business_owner','admin'], false),
  ('commercial_credit.paid_complete', 'pagos', 'Credito comercial pagado completamente', true, false, false, array['technical_owner','business_owner','admin'], false)
on conflict (notification_type) do update
set module = excluded.module,
    label = excluded.label,
    internal_enabled = excluded.internal_enabled,
    destination_roles = excluded.destination_roles,
    updated_at = now();

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
    join public.orders o on o.id = ar.order_id
    left join public.invoices i on i.id = ar.invoice_id
    where ar.id = target_receivable_id
    for update of ar;

  if receivable_row.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  if receivable_row.status = 'paid' then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_paid_denied',
      actor_id,
      jsonb_build_object('attempted_amount', normalized_amount)
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
      jsonb_build_object('attempted_amount', normalized_amount)
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
      jsonb_build_object('invoice_id', receivable_row.invoice_id, 'invoice_status', receivable_row.invoice_status)
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
        'order_id', receivable_row.order_id
      )
    );
    raise exception 'El abono no puede ser mayor que el saldo pendiente de este pedido.';
  end if;

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
      case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
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
    case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
    case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
    'pagos',
    receivable_row.customer_id,
    receivable_row.order_id,
    case when remaining_balance = 0 then 'Credito comercial pagado' else 'Abono de credito registrado' end,
    'Pedido ' || coalesce(receivable_row.order_number, receivable_row.order_id::text) || ': abono L ' || normalized_amount::text || ', saldo L ' || remaining_balance::text || '.',
    case when remaining_balance = 0 then 'info' else 'warning' end,
    array['technical_owner','business_owner','admin']::text[],
    'unread',
    'open',
    jsonb_build_object(
      'receivable_id', receivable_row.id,
      'payment_id', saved_payment.id,
      'order_number', receivable_row.order_number,
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
          when remaining_balance = 0 then 'El saldo de este pedido a credito quedo pagado completamente.'
          else 'Registramos tu abono para este pedido a credito comercial.'
        end,
        'customer_name', coalesce(nullif(receivable_row.customer_business_name, ''), nullif(receivable_row.customer_contact_name, ''), 'Cliente'),
        'order_number', receivable_row.order_number,
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
      'paid_at', case when remaining_balance = 0 then now() else null end
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
  receivable_row record;
  result_row record;
begin
  select id, balance_due
    into receivable_row
    from public.accounts_receivable
    where id = target_receivable_id
    for update;

  if receivable_row.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  if receivable_row.balance_due <= 0 then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.paid_edit_denied',
      auth.uid(),
      jsonb_build_object('attempted_action', 'mark_paid_without_balance')
    );
    raise exception 'Esta cuenta por cobrar ya esta pagada.';
  end if;

  for result_row in
    select *
    from public.register_credit_receivable_payment(
      target_receivable_id,
      receivable_row.balance_due,
      received_payment_method,
      payment_reference,
      now(),
      'Marcado como pagado desde accion rapida.',
      null,
      null,
      'mark-paid:' || target_receivable_id::text || ':' || extract(epoch from now())::text
    )
  loop
    return true;
  end loop;

  return false;
end;
$$;

create or replace function public.mark_credit_receivable_paid(target_receivable_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
begin
  insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
  values (
    'accounts_receivable',
    target_receivable_id,
    'commercial_credit.payment_method_required',
    actor_id,
    jsonb_build_object('attempted_action', 'mark_paid_without_method')
  );
  return false;
end;
$$;

grant execute on function public.mark_credit_receivable_paid(uuid, text, text) to authenticated;
grant execute on function public.mark_credit_receivable_paid(uuid) to authenticated;

create or replace function public.mark_overdue_accounts_receivable(max_rows integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer := 0;
  item record;
begin
  for item in
    select *
    from public.accounts_receivable
    where status in ('open', 'partial')
      and balance_due > 0
      and due_date < current_date
    order by due_date asc
    limit greatest(coalesce(max_rows, 200), 1)
    for update
  loop
    update public.accounts_receivable
    set status = 'overdue',
        overdue_at = coalesce(overdue_at, now()),
        updated_at = now()
    where id = item.id;

    insert into public.audit_logs (actor_role, table_name, record_id, action, old_data, new_data)
    values (
      public.current_actor_role(),
      'accounts_receivable',
      item.id,
      'commercial_credit.overdue',
      to_jsonb(item),
      jsonb_build_object('status', 'overdue', 'overdue_at', now(), 'due_date', item.due_date)
    );

    updated_count := updated_count + 1;
  end loop;

  return updated_count;
end;
$$;

grant execute on function public.mark_overdue_accounts_receivable(integer) to authenticated, service_role;

create or replace function public.cancel_receivable_for_cancelled_credit_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  receivable_record public.accounts_receivable%rowtype;
begin
  if new.payment_method = 'commercial_credit'
     and new.status::text in ('cancelado', 'cancelled')
     and coalesce(old.status::text, '') not in ('cancelado', 'cancelled') then
    select *
    into receivable_record
    from public.accounts_receivable
    where order_id = new.id
      and status in ('open', 'partial', 'overdue')
    for update;

    if receivable_record.id is not null then
      update public.email_queue
      set status = 'cancelled',
          updated_at = now()
      where related_id = receivable_record.id
        and template_key like 'commercial_credit.%'
        and status in ('pending', 'retrying');

      update public.accounts_receivable
      set status = 'cancelled',
          balance_due = 0,
          updated_at = now()
      where id = receivable_record.id;

      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
      values (
        auth.uid(),
        public.current_actor_role(),
        'accounts_receivable',
        receivable_record.id,
        'commercial_credit.receivable_cancelled_with_order',
        to_jsonb(receivable_record),
        jsonb_build_object('order_id', new.id, 'order_status', new.status, 'status', 'cancelled')
      );
    end if;
  end if;

  return new;
end;
$$;

do $$
declare
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order_v2(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  patched_definition := replace(
    function_definition,
    'status in (''open'', ''overdue'')',
    'status in (''open'', ''partial'', ''overdue'')'
  );

  if patched_definition = function_definition then
    raise exception 'Could not patch create_checkout_order_v2 open credit balance statuses.';
  end if;

  execute patched_definition;
end;
$$;
