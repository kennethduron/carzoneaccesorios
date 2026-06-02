-- Advanced smart notification preferences, order email opt-in and FCM token readiness.

alter table public.orders
  add column if not exists email_updates_opt_in boolean not null default false,
  add column if not exists email_updates_preference_source text not null default 'checkout'
    check (email_updates_preference_source in ('checkout', 'admin', 'system')),
  add column if not exists email_updates_updated_at timestamptz not null default now();

create index if not exists orders_email_updates_opt_in_idx
  on public.orders(email_updates_opt_in, created_at desc);

alter table public.notification_preferences
  add column if not exists frequency text not null default 'immediate'
    check (frequency in ('immediate', 'hourly', 'daily', 'weekly', 'manual')),
  add column if not exists reminder_window_hours integer not null default 24
    check (reminder_window_hours >= 0),
  add column if not exists email_required boolean not null default false;

create table if not exists public.notification_user_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  notification_type text not null,
  internal_enabled boolean,
  email_enabled boolean,
  push_enabled boolean,
  frequency text not null default 'immediate'
    check (frequency in ('immediate', 'hourly', 'daily', 'weekly', 'manual')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, notification_type)
);

create index if not exists notification_user_preferences_user_idx
  on public.notification_user_preferences(user_id, notification_type);

alter table public.notification_user_preferences enable row level security;

drop policy if exists "Users can read own notification preferences" on public.notification_user_preferences;
create policy "Users can read own notification preferences"
  on public.notification_user_preferences for select
  using (user_id = auth.uid() or public.has_permission('technical:tools'));

drop policy if exists "Users can manage own notification preferences" on public.notification_user_preferences;
create policy "Users can manage own notification preferences"
  on public.notification_user_preferences for all
  using (user_id = auth.uid() or public.has_permission('technical:tools'))
  with check (user_id = auth.uid() or public.has_permission('technical:tools'));

grant select, insert, update, delete on public.notification_user_preferences to authenticated;
grant select, insert, update, delete on public.notification_user_preferences to service_role;

create table if not exists public.fcm_device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token text not null unique,
  platform text not null default 'web'
    check (platform in ('web', 'android', 'ios', 'unknown')),
  user_agent text,
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  invalidated_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fcm_device_tokens_user_enabled_idx
  on public.fcm_device_tokens(user_id, enabled, last_seen_at desc);

alter table public.fcm_device_tokens enable row level security;

drop policy if exists "Users can manage own FCM tokens" on public.fcm_device_tokens;
create policy "Users can manage own FCM tokens"
  on public.fcm_device_tokens for all
  using (user_id = auth.uid() or public.has_permission('technical:tools'))
  with check (user_id = auth.uid() or public.has_permission('technical:tools'));

grant select, insert, update, delete on public.fcm_device_tokens to authenticated;
grant select, insert, update, delete on public.fcm_device_tokens to service_role;

update public.notification_preferences
set destination_roles = array['technical_owner','business_owner','admin'],
    email_enabled = true,
    email_required = false,
    updated_at = now()
where notification_type = 'order.created';

update public.notification_preferences
set email_enabled = false,
    updated_at = now()
where notification_type in (
  'reservation.expired_review_required',
  'reservation.expiring_soon',
  'reservation.extended',
  'reservation.released',
  'inventory.low_stock'
);

update public.notification_preferences
set email_enabled = true,
    updated_at = now()
where notification_type in (
  'crm.followup_overdue',
  'crm.task_overdue',
  'inventory.out_of_stock',
  'payment.transfer_review',
  'payment.overdue',
  'order.delivered_unpaid',
  'system.critical_error',
  'system.backup_failed',
  'system.cron_failed',
  'system.email_failed'
);

insert into public.notification_preferences (
  notification_type,
  module,
  label,
  internal_enabled,
  email_enabled,
  push_enabled,
  destination_roles,
  technical_only,
  frequency,
  reminder_window_hours,
  email_required
)
values
  ('inventory.critical_low_stock', 'inventario', 'Stock bajo critico', true, true, false, array['business_owner','admin','bodega'], false, 'immediate', 24, false),
  ('customer.order_status_update', 'pedidos', 'Actualizaciones de pedido al cliente', false, true, false, array[]::text[], false, 'immediate', 0, true),
  ('customer.order_cancelled', 'pedidos', 'Cancelacion de pedido al cliente', false, true, false, array[]::text[], false, 'immediate', 0, true)
on conflict (notification_type) do update
set module = excluded.module,
    label = excluded.label,
    internal_enabled = excluded.internal_enabled,
    email_enabled = excluded.email_enabled,
    push_enabled = excluded.push_enabled,
    destination_roles = excluded.destination_roles,
    technical_only = excluded.technical_only,
    frequency = excluded.frequency,
    reminder_window_hours = excluded.reminder_window_hours,
    email_required = excluded.email_required,
    updated_at = now();

create or replace function public.get_public_order_tracking(raw_tracking_code text)
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
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_tracking_code text := upper(trim(coalesce(raw_tracking_code, '')));
begin
  if normalized_tracking_code = '' then
    return;
  end if;

  return query
  with matched_order as (
    select
      o.id,
      o.order_number,
      o.tracking_code,
      o.tracking_status,
      o.status,
      o.public_tracking_enabled,
      o.created_at,
      o.payment_method,
      o.total,
      o.customer_name,
      o.phone,
      coalesce(o.order_reservation_status, '') as order_reservation_status,
      p.payment_status,
      p.status as payment_fallback_status,
      p.has_transfer_receipt,
      p.has_bank_reference,
      (
        lower(o.status::text) in ('cancelado', 'cancelled', 'cerrado', 'closed', 'finalizado', 'finalized')
        or (
          lower(o.status::text) in ('entregado', 'delivered')
          and lower(coalesce(p.payment_status::text, p.status::text, 'pending')) in ('approved', 'confirmed', 'paid')
        )
        or lower(coalesce(p.payment_status::text, p.status::text, 'pending')) = 'rejected'
        or lower(coalesce(o.order_reservation_status, '')) in ('released', 'canceled', 'liberado', 'cancelado')
      ) as is_finalized_for_public_tracking
    from public.orders o
    left join lateral (
      select
        payments.payment_status,
        payments.status,
        (payments.transfer_receipt_public_id is not null or payments.transfer_receipt_url is not null) as has_transfer_receipt,
        (nullif(trim(coalesce(payments.bank_reference_number, payments.reference, '')), '') is not null) as has_bank_reference
      from public.payments
      where payments.order_id = o.id
      order by payments.created_at desc
      limit 1
    ) p on true
    where upper(o.tracking_code) = normalized_tracking_code
    order by o.created_at desc
    limit 1
  ),
  active_public_order as (
    select *
    from matched_order
    where public_tracking_enabled = true
      and is_finalized_for_public_tracking = false
  ),
  active_public_payload as (
    select
      'active'::text as lookup_status,
      o.order_number,
      o.tracking_code,
      coalesce(o.tracking_status, o.status::text) as tracking_status,
      o.status::text as order_status,
      coalesce(o.payment_status::text, o.payment_fallback_status::text, 'pending') as payment_status,
      coalesce(o.has_transfer_receipt, false) as has_transfer_receipt,
      coalesce(o.has_bank_reference, false) as has_bank_reference,
      o.created_at,
      o.payment_method::text as payment_method,
      o.total,
      trim(split_part(o.customer_name, ' ', 1)) || case when strpos(o.customer_name, ' ') > 0 then ' ' || left(split_part(o.customer_name, ' ', 2), 1) || '.' else '' end as customer_name_masked,
      right(regexp_replace(o.phone, '\D', '', 'g'), 4) as phone_last4,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'sku', oi.sku,
            'product_name', oi.product_name,
            'quantity', oi.quantity,
            'unit_price', oi.unit_price,
            'line_total', oi.line_total
          )
          order by oi.created_at asc
        ) filter (where oi.id is not null),
        '[]'::jsonb
      ) as items
    from active_public_order o
    left join public.order_items oi on oi.order_id = o.id
    group by
      o.id,
      o.order_number,
      o.tracking_code,
      o.tracking_status,
      o.status,
      o.payment_status,
      o.payment_fallback_status,
      o.has_transfer_receipt,
      o.has_bank_reference,
      o.created_at,
      o.payment_method,
      o.total,
      o.customer_name,
      o.phone
  ),
  finalized_payload as (
    select
      'finalized'::text as lookup_status,
      null::text as order_number,
      null::text as tracking_code,
      null::text as tracking_status,
      null::text as order_status,
      null::text as payment_status,
      null::boolean as has_transfer_receipt,
      null::boolean as has_bank_reference,
      null::timestamptz as created_at,
      null::text as payment_method,
      null::numeric as total,
      null::text as customer_name_masked,
      null::text as phone_last4,
      '[]'::jsonb as items
    from matched_order
    where is_finalized_for_public_tracking = true
  )
  select *
  from active_public_payload
  union all
  select *
  from finalized_payload
  limit 1;
end;
$$;

grant execute on function public.get_public_order_tracking(text) to anon, authenticated, service_role;

insert into public.audit_logs (actor_role, table_name, action, new_data)
values (
  'system_migration',
  'notification_preferences',
  'smart_notifications_phase_seeded',
  jsonb_build_object(
    'resend_active_provider', true,
    'user_preferences', true,
    'fcm_device_tokens', true,
    'order_email_updates_opt_in', true,
    'public_tracking_finalized_rule', 'cancelled_or_closed_or_delivered_paid'
  )
);
