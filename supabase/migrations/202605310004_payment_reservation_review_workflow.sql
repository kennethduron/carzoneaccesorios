-- Separate logistics, payment and inventory-reservation review without
-- weakening the transactional checkout stock lock already in production.

alter table public.orders
  add column if not exists payment_timing text not null default 'before_delivery'
    check (payment_timing in ('before_delivery', 'on_delivery')),
  add column if not exists reservation_review_required boolean not null default false,
  add column if not exists reservation_review_detected_at timestamptz,
  add column if not exists reservation_reviewed_at timestamptz,
  add column if not exists reservation_reviewed_by uuid references public.users(id) on delete set null,
  add column if not exists reservation_review_reason text;

alter table public.payments
  add column if not exists payment_timing text not null default 'before_delivery'
    check (payment_timing in ('before_delivery', 'on_delivery')),
  add column if not exists confirmed_by uuid references public.users(id) on delete set null,
  add column if not exists rejected_by uuid references public.users(id) on delete set null,
  add column if not exists rejection_reason text;

alter table public.payments
  drop constraint if exists payments_bank_reference_required_for_transfer;

alter table public.payments
  add constraint payments_bank_reference_required_for_transfer
  check (
    payment_method <> 'bank_transfer'
    or payment_timing = 'on_delivery'
    or trim(coalesce(bank_reference_number, '')) ~ '^[[:alnum:] -]{4,80}$'
  ) not valid;

alter table public.inventory_reservations
  add column if not exists review_required boolean not null default false,
  add column if not exists review_detected_at timestamptz,
  add column if not exists extended_at timestamptz,
  add column if not exists extended_by uuid references public.users(id) on delete set null,
  add column if not exists extension_reason text;

grant select, insert, update, delete on public.inventory_reservations to service_role;

alter table public.technical_alert_settings
  add column if not exists service_account_email text not null default 'carzonetech@gmail.com';

update public.technical_alert_settings
set service_account_email = 'carzonetech@gmail.com',
    updated_at = now()
where id = true;

update public.company_settings
set stock_reservations_enabled = true,
    updated_at = now();

create table if not exists public.internal_notifications (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  order_id uuid references public.orders(id) on delete cascade,
  title text not null,
  message text not null,
  severity text not null default 'warning'
    check (severity in ('info', 'warning', 'error', 'critical')),
  audience_roles text[] not null default array[]::text[],
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'resolved', 'ignored')),
  metadata jsonb not null default '{}'::jsonb,
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'failed', 'skipped')),
  email_attempts integer not null default 0 check (email_attempts >= 0),
  email_error text,
  emailed_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists internal_notifications_open_order_event_idx
  on public.internal_notifications(event_type, order_id)
  where status in ('open', 'reviewing');

create index if not exists internal_notifications_status_created_idx
  on public.internal_notifications(status, created_at desc);

alter table public.internal_notifications enable row level security;

drop policy if exists "Authorized staff can read internal notifications" on public.internal_notifications;
create policy "Authorized staff can read internal notifications"
  on public.internal_notifications for select
  using (
    public.has_permission('notifications:read')
    or public.has_permission('notifications:manage')
    or public.has_permission('system:monitoring')
  );

drop policy if exists "Authorized staff can manage internal notifications" on public.internal_notifications;
create policy "Authorized staff can manage internal notifications"
  on public.internal_notifications for update
  using (public.has_permission('notifications:manage'))
  with check (public.has_permission('notifications:manage'));

grant select, update on public.internal_notifications to authenticated;
grant select, insert, update, delete on public.internal_notifications to service_role;

drop policy if exists "Admins can manage company settings" on public.company_settings;
create policy "Authorized staff can manage company settings"
  on public.company_settings for all
  using (
    public.has_permission('settings:manage')
    or public.has_permission('commercial_settings:manage')
  )
  with check (
    public.has_permission('settings:manage')
    or public.has_permission('commercial_settings:manage')
  );

create table if not exists public.order_internal_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  actor_role text,
  note text not null check (char_length(trim(note)) >= 3),
  created_at timestamptz not null default now()
);

create index if not exists order_internal_notes_order_created_idx
  on public.order_internal_notes(order_id, created_at desc);

alter table public.order_internal_notes enable row level security;

drop policy if exists "Authorized staff can read order notes" on public.order_internal_notes;
create policy "Authorized staff can read order notes"
  on public.order_internal_notes for select
  using (
    public.has_permission('orders:read')
    or public.has_permission('orders:manage')
    or public.has_permission('reservations:review')
  );

grant select on public.order_internal_notes to authenticated;
grant select, insert, update, delete on public.order_internal_notes to service_role;

-- Add the explicit operational permissions while preserving older permission
-- keys during the transition.
update public.roles
set permissions = permissions || '["payments:confirm","payments:reject","orders:cancel","orders:extend_reservation","reservations:review","notifications:read","notifications:manage"]'::jsonb,
    updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = permissions || '["payments:confirm","payments:reject","reservations:review","notifications:read"]'::jsonb,
    updated_at = now()
where name = 'contadora';

update public.roles
set permissions = permissions || '["reservations:review","notifications:read"]'::jsonb,
    updated_at = now()
where name = 'bodega';

create or replace function public.check_expired_inventory_reservations(max_orders integer default 100)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  order_record record;
  detected_orders integer := 0;
begin
  for order_record in
    select
      orders.id,
      orders.order_number,
      orders.customer_name,
      orders.payment_method::text as payment_method,
      orders.payment_timing,
      orders.status::text as order_status,
      coalesce(payments.payment_status::text, payments.status::text, 'pending') as payment_status,
      min(inventory_reservations.expires_at) as expired_at
    from public.orders
    join public.inventory_reservations
      on inventory_reservations.order_id = orders.id
     and inventory_reservations.status = 'reserved'
     and inventory_reservations.expires_at <= now()
    left join lateral (
      select payments.payment_status, payments.status
      from public.payments
      where payments.order_id = orders.id
      order by payments.created_at desc
      limit 1
    ) payments on true
    where orders.status::text not in ('cancelado', 'cancelled')
      and orders.reservation_review_required = false
      and coalesce(payments.payment_status::text, payments.status::text, 'pending') not in ('approved', 'confirmed', 'paid')
    group by
      orders.id,
      orders.order_number,
      orders.customer_name,
      orders.payment_method,
      orders.payment_timing,
      orders.status,
      payments.payment_status,
      payments.status
    order by min(inventory_reservations.expires_at), orders.id
    limit greatest(coalesce(max_orders, 100), 1)
  loop
    update public.orders
    set reservation_review_required = true,
        reservation_review_detected_at = coalesce(reservation_review_detected_at, now()),
        updated_at = now()
    where id = order_record.id;

    update public.inventory_reservations
    set review_required = true,
        review_detected_at = coalesce(review_detected_at, now()),
        updated_at = now()
    where order_id = order_record.id
      and status = 'reserved'
      and expires_at <= now();

    insert into public.internal_notifications (
      event_type,
      order_id,
      title,
      message,
      severity,
      audience_roles,
      metadata
    )
    values (
      'reservation.expired_review_required',
      order_record.id,
      'Reserva vencida: requiere revision',
      'El pedido ' || order_record.order_number || ' tiene una reserva vencida. Revisa pago y avance operativo antes de liberar stock.',
      case when order_record.order_status in ('enviado', 'en_ruta', 'entregado', 'shipped', 'delivered') then 'critical' else 'warning' end,
      array['technical_owner', 'business_owner', 'admin', 'contadora', 'bodega'],
      jsonb_build_object(
        'order_number', order_record.order_number,
        'customer_name', order_record.customer_name,
        'payment_method', order_record.payment_method,
        'payment_timing', order_record.payment_timing,
        'order_status', order_record.order_status,
        'payment_status', order_record.payment_status,
        'expired_at', order_record.expired_at,
        'suggested_actions', jsonb_build_array('confirm_payment', 'extend_reservation', 'cancel_and_release', 'add_note')
      )
    )
    on conflict do nothing;

    insert into public.audit_logs (table_name, record_id, action, new_data)
    values (
      'inventory_reservations',
      order_record.id,
      'inventory.reservation.review_required',
      jsonb_build_object(
        'result', 'alert_created',
        'order_number', order_record.order_number,
        'order_status', order_record.order_status,
        'payment_status', order_record.payment_status,
        'expired_at', order_record.expired_at,
        'automatic_release', false
      )
    );

    detected_orders := detected_orders + 1;
  end loop;

  perform public.cleanup_old_rate_limits(24);
  return detected_orders;
end;
$$;

grant execute on function public.check_expired_inventory_reservations(integer) to service_role;

-- Preserve the old RPC for compatibility, but it is now detection-only.
create or replace function public.expire_inventory_reservations(max_orders integer default 100)
returns integer
language sql
security definer
set search_path = public
as $$
  select public.check_expired_inventory_reservations(max_orders);
$$;

grant execute on function public.expire_inventory_reservations(integer) to service_role;

create or replace function public.extend_order_reservation(
  target_order_id uuid,
  extension_minutes integer,
  extension_reason text
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  next_expiration timestamptz;
  old_expiration timestamptz;
begin
  if actor_id is null or not (
    public.has_permission('orders:extend_reservation')
    or public.has_permission('orders:manage')
  ) then
    raise exception 'Solo usuarios autorizados pueden extender reservas.';
  end if;

  if extension_minutes not in (720, 1440, 2880) then
    raise exception 'Selecciona una extension de 12, 24 o 48 horas.';
  end if;

  if char_length(trim(coalesce(extend_order_reservation.extension_reason, ''))) < 4 then
    raise exception 'Ingresa un motivo para extender la reserva.';
  end if;

  select roles.name
  into actor_role
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = actor_id and users.active = true;

  select reservation_expires_at
  into old_expiration
  from public.orders
  where id = target_order_id
    and status::text not in ('cancelado', 'cancelled')
    and order_reservation_status = 'reserved'
  for update;

  if old_expiration is null then
    raise exception 'La reserva no esta activa.';
  end if;

  next_expiration := greatest(now(), old_expiration) + make_interval(mins => extension_minutes);

  update public.inventory_reservations
  set expires_at = next_expiration,
      review_required = false,
      extended_at = now(),
      extended_by = actor_id,
      extension_reason = left(trim(extend_order_reservation.extension_reason), 500),
      updated_at = now()
  where order_id = target_order_id
    and status = 'reserved';

  update public.orders
  set reservation_expires_at = next_expiration,
      reservation_review_required = false,
      reservation_reviewed_at = now(),
      reservation_reviewed_by = actor_id,
      reservation_review_reason = left(trim(extend_order_reservation.extension_reason), 500),
      updated_at = now()
  where id = target_order_id;

  update public.internal_notifications
  set status = 'resolved',
      resolved_at = now(),
      resolved_by = actor_id,
      updated_at = now()
  where order_id = target_order_id
    and event_type = 'reservation.expired_review_required'
    and status in ('open', 'reviewing');

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role,
    'inventory_reservations',
    target_order_id,
    'inventory.reservation.extended',
    jsonb_build_object('reservation_expires_at', old_expiration),
    jsonb_build_object('reservation_expires_at', next_expiration, 'minutes', extension_minutes, 'reason', left(trim(extend_order_reservation.extension_reason), 500))
  );

  return next_expiration;
end;
$$;

grant execute on function public.extend_order_reservation(uuid, integer, text) to authenticated;

create or replace function public.add_order_internal_note(target_order_id uuid, note_text text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  created_note_id uuid;
begin
  if actor_id is null or not (
    public.has_permission('orders:manage')
    or public.has_permission('reservations:review')
  ) then
    raise exception 'Solo usuarios autorizados pueden agregar notas internas.';
  end if;

  if char_length(trim(coalesce(note_text, ''))) < 3 then
    raise exception 'Ingresa una nota interna.';
  end if;

  select roles.name
  into actor_role
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = actor_id and users.active = true;

  if not exists (select 1 from public.orders where id = target_order_id) then
    raise exception 'Pedido no encontrado.';
  end if;

  insert into public.order_internal_notes (order_id, user_id, actor_role, note)
  values (target_order_id, actor_id, actor_role, left(trim(note_text), 1000))
  returning id into created_note_id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
  values (
    actor_id,
    actor_role,
    'orders',
    target_order_id,
    'order.internal_note.added',
    jsonb_build_object('note_id', created_note_id)
  );

  return created_note_id;
end;
$$;

grant execute on function public.add_order_internal_note(uuid, text) to authenticated;

create or replace function public.confirm_manual_order_payment(target_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  order_record record;
  payment_record record;
begin
  if actor_id is null or not (
    public.has_permission('payments:confirm')
    or public.has_permission('payments:manage')
  ) then
    raise exception 'Solo usuarios autorizados pueden confirmar pagos.';
  end if;

  select orders.id, orders.order_number, orders.status::text as status, orders.payment_method::text as payment_method, orders.payment_timing
  into order_record
  from public.orders
  where orders.id = target_order_id
  for update;

  if order_record.id is null then raise exception 'Pedido no encontrado.'; end if;
  if order_record.status in ('cancelado', 'cancelled') then raise exception 'No se puede confirmar el pago de un pedido cancelado.'; end if;
  if order_record.payment_method = 'card' then raise exception 'Los pagos con tarjeta solo se confirman mediante pasarela o webhook autorizado.'; end if;
  if order_record.payment_timing = 'on_delivery' and order_record.status not in ('entregado', 'delivered') then
    raise exception 'El pago al recibir solo se confirma cuando el pedido fue entregado.';
  end if;

  select payments.id, coalesce(payments.payment_status::text, payments.status::text, 'pending') as status
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;

  if payment_record.id is null then raise exception 'No hay pago registrado para este pedido.'; end if;
  if payment_record.status in ('approved', 'confirmed', 'paid') then raise exception 'El pago ya fue confirmado.'; end if;
  if payment_record.status = 'rejected' then raise exception 'No se puede confirmar un pago rechazado.'; end if;

  select roles.name
  into actor_role
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = actor_id and users.active = true;

  update public.payments
  set payment_status = 'approved',
      status = 'approved',
      paid_at = now(),
      confirmed_by = actor_id,
      updated_at = now()
  where id = payment_record.id;

  update public.orders
  set reservation_review_required = false,
      reservation_reviewed_at = case when reservation_review_required then now() else reservation_reviewed_at end,
      reservation_reviewed_by = case when reservation_review_required then actor_id else reservation_reviewed_by end,
      reservation_review_reason = case when reservation_review_required then 'Pago confirmado manualmente' else reservation_review_reason end,
      updated_at = now()
  where id = target_order_id;

  update public.internal_notifications
  set status = 'resolved', resolved_at = now(), resolved_by = actor_id, updated_at = now()
  where order_id = target_order_id
    and event_type = 'reservation.expired_review_required'
    and status in ('open', 'reviewing');

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role,
    'payments',
    payment_record.id,
    'payment.received.confirmed',
    jsonb_build_object('order_id', target_order_id, 'payment_status', payment_record.status),
    jsonb_build_object('order_id', target_order_id, 'payment_status', 'approved', 'confirmed_at', now())
  );

  return true;
end;
$$;

grant execute on function public.confirm_manual_order_payment(uuid) to authenticated;

create or replace function public.reject_order_payment_and_release(target_order_id uuid, rejection_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  order_record record;
  payment_record record;
begin
  if actor_id is null or not (
    public.has_permission('payments:reject')
    or public.has_permission('payments:manage')
  ) then
    raise exception 'Solo usuarios autorizados pueden rechazar pagos.';
  end if;

  if char_length(trim(coalesce(reject_order_payment_and_release.rejection_reason, ''))) < 4 then
    raise exception 'Ingresa un motivo para rechazar el pago.';
  end if;

  select orders.id, orders.order_number, orders.status::text as status
  into order_record
  from public.orders
  where orders.id = target_order_id
  for update;

  if order_record.id is null then raise exception 'Pedido no encontrado.'; end if;
  if order_record.status in ('entregado', 'delivered') then raise exception 'No puedes rechazar el pago de un pedido entregado sin revision especial.'; end if;

  select payments.id, coalesce(payments.payment_status::text, payments.status::text, 'pending') as status
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;

  if payment_record.id is null then raise exception 'No hay pago registrado para este pedido.'; end if;
  if payment_record.status in ('approved', 'confirmed', 'paid') then raise exception 'No puedes rechazar un pago confirmado.'; end if;

  select roles.name
  into actor_role
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = actor_id and users.active = true;

  update public.payments
  set payment_status = 'rejected',
      status = 'rejected',
      rejected_by = actor_id,
      rejection_reason = left(trim(reject_order_payment_and_release.rejection_reason), 500),
      updated_at = now()
  where id = payment_record.id;

  update public.orders
  set status = 'cancelado',
      tracking_status = 'cancelado',
      reservation_review_required = false,
      reservation_reviewed_at = now(),
      reservation_reviewed_by = actor_id,
      reservation_review_reason = left(trim(reject_order_payment_and_release.rejection_reason), 500),
      updated_at = now()
  where id = target_order_id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role,
    'payments',
    payment_record.id,
    'payment.rejected.reservation_released',
    jsonb_build_object('order_id', target_order_id, 'payment_status', payment_record.status),
    jsonb_build_object('order_id', target_order_id, 'payment_status', 'rejected', 'reason', left(trim(reject_order_payment_and_release.rejection_reason), 500))
  );

  return true;
end;
$$;

grant execute on function public.reject_order_payment_and_release(uuid, text) to authenticated;

create or replace function public.cancel_order_and_release_reservation(target_order_id uuid, cancellation_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  order_record record;
  payment_record record;
begin
  if actor_id is null or not (
    public.has_permission('orders:cancel')
    or public.has_permission('orders:manage')
  ) then
    raise exception 'Solo usuarios autorizados pueden cancelar pedidos.';
  end if;

  if char_length(trim(coalesce(cancellation_reason, ''))) < 8 then
    raise exception 'Ingresa un motivo de cancelacion de al menos 8 caracteres.';
  end if;

  select orders.id, orders.order_number, orders.status::text as status
  into order_record
  from public.orders
  where orders.id = target_order_id
  for update;

  if order_record.id is null then raise exception 'Pedido no encontrado.'; end if;
  if order_record.status in ('entregado', 'delivered') then raise exception 'No puedes cancelar un pedido entregado sin revision especial.'; end if;

  select payments.id, coalesce(payments.payment_status::text, payments.status::text, 'pending') as status
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;

  if payment_record.status in ('approved', 'confirmed', 'paid') then raise exception 'No puedes cancelar un pedido pagado sin revision especial.'; end if;

  select roles.name
  into actor_role
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = actor_id and users.active = true;

  update public.orders
  set status = 'cancelado',
      tracking_status = 'cancelado',
      reservation_review_required = false,
      reservation_reviewed_at = now(),
      reservation_reviewed_by = actor_id,
      reservation_review_reason = left(trim(cancellation_reason), 500),
      updated_at = now()
  where id = target_order_id;

  update public.payments
  set payment_status = 'rejected',
      status = 'rejected',
      rejected_by = actor_id,
      rejection_reason = left(trim(cancellation_reason), 500),
      updated_at = now()
  where id = payment_record.id
    and coalesce(payment_status::text, status::text, 'pending') not in ('approved', 'confirmed', 'paid');

  update public.internal_notifications
  set status = 'resolved', resolved_at = now(), resolved_by = actor_id, updated_at = now()
  where order_id = target_order_id
    and status in ('open', 'reviewing');

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role,
    'orders',
    target_order_id,
    'order.cancelled.reservation_released',
    jsonb_build_object('order_status', order_record.status, 'payment_status', payment_record.status),
    jsonb_build_object('order_status', 'cancelado', 'payment_status', 'rejected', 'reason', left(trim(cancellation_reason), 500))
  );

  return true;
end;
$$;

grant execute on function public.cancel_order_and_release_reservation(uuid, text) to authenticated;

create or replace function public.confirm_card_payment_from_backend(target_order_id uuid, provider_reference text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_record record;
begin
  select payments.id, payments.method::text as method, coalesce(payments.payment_status::text, payments.status::text, 'pending') as status
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;

  if payment_record.id is null then raise exception 'No hay pago registrado para este pedido.'; end if;
  if payment_record.method <> 'card' then raise exception 'Este pedido no corresponde a pago con tarjeta.'; end if;
  if payment_record.status = 'rejected' then raise exception 'No se puede confirmar un pago rechazado.'; end if;

  update public.payments
  set payment_status = 'approved',
      status = 'approved',
      provider = 'bac',
      reference = nullif(trim(coalesce(provider_reference, '')), ''),
      paid_at = now(),
      updated_at = now()
  where id = payment_record.id;

  insert into public.audit_logs (table_name, record_id, action, old_data, new_data)
  values (
    'payments',
    payment_record.id,
    'payment.card.backend_confirmed',
    jsonb_build_object('order_id', target_order_id, 'payment_status', payment_record.status),
    jsonb_build_object('order_id', target_order_id, 'payment_status', 'approved', 'provider', 'bac')
  );

  return true;
end;
$$;

revoke all on function public.confirm_card_payment_from_backend(uuid, text) from public;
revoke all on function public.confirm_card_payment_from_backend(uuid, text) from anon;
revoke all on function public.confirm_card_payment_from_backend(uuid, text) from authenticated;
grant execute on function public.confirm_card_payment_from_backend(uuid, text) to service_role;

-- Wrapper around the proven checkout RPC. This adds payment timing, the
-- configurable reservation deadline and COD fee for transfer-on-delivery.
create or replace function public.create_checkout_order_v2(
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
  transfer_receipt_url text default null,
  delivery_country text default 'Honduras',
  country_code text default 'HN',
  delivery_department text default null,
  delivery_city text default null,
  requested_payment_timing text default null
)
returns table (
  order_id uuid,
  order_number text,
  tracking_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  created_order record;
  normalized_payment_timing text := case
    when requested_payment_method = 'cash' then 'on_delivery'
    when requested_payment_method = 'card' then 'before_delivery'
    when requested_payment_timing = 'on_delivery' then 'on_delivery'
    else 'before_delivery'
  end;
  reference_for_checkout text := bank_reference_number;
  reservation_minutes integer := 2880;
  reservation_deadline timestamptz;
  cod_percentage numeric(6, 2) := 5;
  cod_enabled boolean := true;
  recalculated_cod numeric(12, 2) := 0;
  recalculated_total numeric(12, 2) := 0;
  extra_fees numeric(12, 2) := 0;
begin
  if requested_payment_method = 'bank_transfer'
     and normalized_payment_timing = 'before_delivery'
     and nullif(trim(coalesce(bank_reference_number, '')), '') is null then
    raise exception 'Ingresa el numero de referencia bancaria.';
  end if;

  if requested_payment_method = 'bank_transfer' and normalized_payment_timing = 'on_delivery' then
    reference_for_checkout := 'PENDIENTE CONTRA ENTREGA';
  end if;

  select *
  into created_order
  from public.create_checkout_order(
    customer_name,
    customer_email,
    customer_phone,
    customer_rtn,
    delivery_address,
    requested_price_mode,
    requested_payment_method,
    reference_for_checkout,
    order_items,
    wholesale_code,
    wholesale_code_id,
    transfer_receipt_url,
    delivery_country,
    country_code,
    delivery_department,
    delivery_city
  )
  limit 1;

  select
    coalesce(company_settings.stock_reservation_minutes, 2880),
    coalesce(company_settings.cash_on_delivery_percentage, 5),
    coalesce(company_settings.enable_cash_on_delivery_fee, true)
  into reservation_minutes, cod_percentage, cod_enabled
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  reservation_deadline := now() + make_interval(mins => greatest(coalesce(reservation_minutes, 2880), 15));

  update public.inventory_reservations
  set expires_at = reservation_deadline,
      updated_at = now()
  where inventory_reservations.order_id = created_order.order_id
    and status = 'reserved';

  select coalesce(sum(
    case
      when fee.value ? 'amount' then (fee.value->>'amount')::numeric
      when fee.value ? 'total' then (fee.value->>'total')::numeric
      else 0
    end
  ), 0)
  into extra_fees
  from public.orders
  left join lateral jsonb_array_elements(coalesce(orders.additional_fees, '[]'::jsonb)) as fee(value) on true
  where orders.id = created_order.order_id;

  select case
    when normalized_payment_timing = 'on_delivery' and cod_enabled
      then round(orders.subtotal * (cod_percentage / 100), 2)
    else 0
  end
  into recalculated_cod
  from public.orders
  where orders.id = created_order.order_id;

  update public.orders
  set payment_timing = normalized_payment_timing,
      reservation_expires_at = reservation_deadline,
      cash_on_delivery_fee = recalculated_cod,
      total = round(
        subtotal
        + tax
        + shipping_fee
        + recalculated_cod
        + coalesce(small_order_fee, 0)
        + coalesce(extra_fees, 0)
        - coalesce(discount_total, 0),
        2
      ),
      updated_at = now()
  where orders.id = created_order.order_id
  returning orders.total into recalculated_total;

  update public.payments
  set payment_timing = normalized_payment_timing,
      bank_reference_number = case
        when requested_payment_method = 'bank_transfer' and normalized_payment_timing = 'on_delivery' then null
        else create_checkout_order_v2.bank_reference_number
      end,
      reference = case
        when requested_payment_method = 'bank_transfer' and normalized_payment_timing = 'on_delivery' then null
        else reference
      end,
      amount = recalculated_total,
      updated_at = now()
  where payments.order_id = created_order.order_id;

  update public.invoices
  set cash_on_delivery_fee = recalculated_cod,
      total = recalculated_total,
      updated_at = now()
  where invoices.order_id = created_order.order_id
    and invoices.status = 'draft';

  insert into public.audit_logs (user_id, table_name, record_id, action, new_data)
  values (
    auth.uid(),
    'inventory_reservations',
    created_order.order_id,
    'inventory.reservation.created',
    jsonb_build_object(
      'payment_method', requested_payment_method,
      'payment_timing', normalized_payment_timing,
      'reservation_expires_at', reservation_deadline,
      'automatic_release', false
    )
  );

  order_id := created_order.order_id;
  order_number := created_order.order_number;
  tracking_code := created_order.tracking_code;
  return next;
end;
$$;

grant execute on function public.create_checkout_order_v2(
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
  text,
  text,
  text,
  text,
  text,
  text
) to anon, authenticated, service_role;

create or replace function public.get_public_order_tracking_v2(raw_tracking_code text)
returns table (
  lookup_status text,
  order_number text,
  tracking_code text,
  tracking_status text,
  order_status text,
  payment_status text,
  has_transfer_receipt boolean,
  has_bank_reference boolean,
  created_at timestamptz,
  payment_method text,
  total numeric,
  customer_name_masked text,
  phone_last4 text,
  items jsonb,
  payment_timing text,
  cash_on_delivery_fee numeric
)
language sql
security definer
set search_path = public
as $$
  select
    tracking.lookup_status,
    tracking.order_number,
    tracking.tracking_code,
    tracking.tracking_status,
    tracking.order_status,
    tracking.payment_status,
    tracking.has_transfer_receipt,
    tracking.has_bank_reference,
    tracking.created_at,
    tracking.payment_method,
    tracking.total,
    tracking.customer_name_masked,
    tracking.phone_last4,
    tracking.items,
    orders.payment_timing,
    orders.cash_on_delivery_fee
  from public.get_public_order_tracking(raw_tracking_code) tracking
  left join public.orders
    on orders.tracking_code = tracking.tracking_code;
$$;

grant execute on function public.get_public_order_tracking_v2(text) to anon, authenticated, service_role;
