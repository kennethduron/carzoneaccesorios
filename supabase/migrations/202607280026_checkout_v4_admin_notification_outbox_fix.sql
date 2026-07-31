-- Fix the Checkout V4 administrative notification outbox role-variable ambiguity.
-- Delivery remains asynchronous: this migration never calls an email provider.

create or replace function public.checkout_v4_enqueue_admin_notifications_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders%rowtype;
  notification_roles text[] := array['business_owner', 'admin']::text[];
  internal_enabled boolean := true;
  email_enabled boolean := true;
  recipient record;
begin
  if new.status <> 'committed' or old.status = 'committed' or new.order_id is null then
    return new;
  end if;

  select *
  into order_row
  from public.orders
  where id = new.order_id;

  if order_row.id is null then
    return new;
  end if;

  select
    coalesce(p.destination_roles, notification_roles),
    coalesce(p.internal_enabled, true),
    coalesce(p.email_enabled, false)
  into notification_roles, internal_enabled, email_enabled
  from public.notification_preferences p
  where p.notification_type = 'order.created';

  notification_roles := coalesce(notification_roles, array['business_owner', 'admin']::text[]);
  internal_enabled := coalesce(internal_enabled, true);
  email_enabled := coalesce(email_enabled, false);

  if internal_enabled then
    insert into public.internal_notifications(
      event_type,
      notification_type,
      module,
      order_id,
      title,
      message,
      severity,
      audience_roles,
      status,
      read_state,
      metadata,
      email_status,
      dedupe_key,
      updated_at
    )
    values (
      'order.created',
      'order.created',
      'pedidos',
      order_row.id,
      'Nuevo pedido recibido',
      'El pedido ' || order_row.order_number || ' fue creado y requiere revision operativa.',
      'info',
      notification_roles,
      'open',
      'unread',
      jsonb_build_object(
        'order_number', order_row.order_number,
        'tracking_code', order_row.tracking_code,
        'payment_method', order_row.payment_method,
        'total', order_row.total,
        'action_path', '/admin/pedidos?task=new_orders',
        'checkout_version', 4
      ),
      case when email_enabled then 'pending' else 'skipped' end,
      'checkout-v4:order.created:' || order_row.id::text,
      now()
    )
    on conflict do nothing;
  end if;

  if email_enabled then
    for recipient in
      select distinct on (lower(trim(u.email)))
        u.id,
        trim(u.email) as email,
        u.full_name
      from public.users u
      join public.roles r on r.id = u.role_id
      left join public.notification_user_preferences up
        on up.user_id = u.id
       and up.notification_type = 'order.created'
      where u.active
        and u.email is not null
        and trim(u.email) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        and r.name = any(notification_roles)
        and coalesce(up.email_enabled, true)
        and coalesce(up.frequency, 'immediate') <> 'manual'
      order by lower(trim(u.email)), u.id
    loop
      insert into public.email_queue(
        to_email,
        to_name,
        subject,
        template_key,
        payload,
        status,
        scheduled_at,
        related_module,
        related_id,
        priority,
        max_attempts,
        idempotency_key
      )
      values (
        recipient.email,
        recipient.full_name,
        'Nuevo pedido recibido - Car Zone Accesorios',
        'order.created',
        jsonb_build_object(
          'title', 'Nuevo pedido recibido',
          'message', 'El pedido ' || order_row.order_number || ' fue creado.',
          'order_number', order_row.order_number,
          'tracking_code', order_row.tracking_code,
          'payment_method', order_row.payment_method,
          'total', order_row.total,
          'action_path', '/admin/pedidos?task=new_orders',
          'action_label', 'Ver pedido',
          'checkout_version', 4
        ),
        'pending',
        now(),
        'pedidos',
        order_row.id,
        3,
        4,
        'checkout-v4:admin-order-created:' || order_row.id::text || ':' ||
          public.checkout_hash_text_v1(lower(recipient.email))
      )
      on conflict (idempotency_key) where idempotency_key is not null do nothing;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists checkout_v4_enqueue_admin_notifications_trigger
  on public.checkout_requests_v4;

create trigger checkout_v4_enqueue_admin_notifications_trigger
after update of status on public.checkout_requests_v4
for each row
when (new.status = 'committed' and old.status is distinct from new.status)
execute function public.checkout_v4_enqueue_admin_notifications_v1();

revoke all on function public.checkout_v4_enqueue_admin_notifications_v1() from public, anon, authenticated;
grant execute on function public.checkout_v4_enqueue_admin_notifications_v1() to service_role;

comment on function public.checkout_v4_enqueue_admin_notifications_v1() is
  'Queues configured Checkout V4 admin notifications exactly once without contacting the email provider.';
