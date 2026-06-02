-- Central notification, reminder and email queue architecture.
-- This migration extends the reservation notification work without removing
-- legacy columns that current admin screens still use.

alter table public.internal_notifications
  add column if not exists notification_type text,
  add column if not exists module text not null default 'sistema'
    check (module in ('pedidos', 'pagos', 'reservas', 'CRM', 'inventario', 'mayoristas', 'sistema')),
  add column if not exists user_id uuid references public.users(id) on delete set null,
  add column if not exists role_name text,
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists read_state text not null default 'unread'
    check (read_state in ('unread', 'read', 'archived')),
  add column if not exists read_at timestamptz,
  add column if not exists dedupe_key text;

update public.internal_notifications
set notification_type = coalesce(notification_type, event_type),
    module = case
      when event_type like 'reservation.%' then 'reservas'
      when event_type like 'inventory.%' then 'inventario'
      when event_type like 'payment.%' then 'pagos'
      when event_type like 'order.%' then 'pedidos'
      else module
    end
where notification_type is null
   or module = 'sistema';

alter table public.internal_notifications
  alter column notification_type set default 'system.general';

create unique index if not exists internal_notifications_active_dedupe_idx
  on public.internal_notifications(dedupe_key)
  where dedupe_key is not null
    and status in ('open', 'reviewing')
    and read_state <> 'archived';

create index if not exists internal_notifications_module_read_created_idx
  on public.internal_notifications(module, read_state, created_at desc);

create index if not exists internal_notifications_user_role_created_idx
  on public.internal_notifications(user_id, role_name, created_at desc);

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  notification_type text not null unique,
  module text not null check (module in ('pedidos', 'pagos', 'reservas', 'CRM', 'inventario', 'mayoristas', 'sistema')),
  label text not null,
  internal_enabled boolean not null default true,
  email_enabled boolean not null default false,
  push_enabled boolean not null default false,
  destination_roles text[] not null default array[]::text[],
  technical_only boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_preferences_module_idx
  on public.notification_preferences(module, technical_only, notification_type);

alter table public.notification_preferences enable row level security;

drop policy if exists "Authorized staff can read notification preferences" on public.notification_preferences;
create policy "Authorized staff can read notification preferences"
  on public.notification_preferences for select
  using (
    public.has_permission('notifications:read')
    or public.has_permission('notifications:manage')
    or public.has_permission('commercial_settings:manage')
    or public.has_permission('system:monitoring')
  );

drop policy if exists "Business staff can update operational notification preferences" on public.notification_preferences;
create policy "Business staff can update operational notification preferences"
  on public.notification_preferences for update
  using (
    (
      technical_only = false
      and (
        public.has_permission('notifications:manage')
        or public.has_permission('commercial_settings:manage')
      )
    )
    or public.has_permission('technical:tools')
  )
  with check (
    (
      technical_only = false
      and (
        public.has_permission('notifications:manage')
        or public.has_permission('commercial_settings:manage')
      )
    )
    or public.has_permission('technical:tools')
  );

grant select, update on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.notification_preferences to service_role;

create table if not exists public.email_queue (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  to_name text,
  subject text not null,
  template_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'retrying', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 4 check (max_attempts > 0),
  last_error text,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  related_module text check (related_module in ('pedidos', 'pagos', 'reservas', 'CRM', 'inventario', 'mayoristas', 'sistema')),
  related_id uuid,
  priority integer not null default 5 check (priority between 1 and 10),
  idempotency_key text,
  provider text,
  provider_message_id text
);

create unique index if not exists email_queue_idempotency_key_idx
  on public.email_queue(idempotency_key)
  where idempotency_key is not null;

create index if not exists email_queue_ready_idx
  on public.email_queue(status, scheduled_at, priority, created_at)
  where status in ('pending', 'retrying');

create index if not exists email_queue_related_idx
  on public.email_queue(related_module, related_id, created_at desc);

alter table public.email_queue enable row level security;

drop policy if exists "Technical staff can read email queue" on public.email_queue;
create policy "Technical staff can read email queue"
  on public.email_queue for select
  using (public.has_permission('system:monitoring') or public.has_permission('technical:tools'));

grant select on public.email_queue to authenticated;
grant select, insert, update, delete on public.email_queue to service_role;

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
  ('order.created', 'pedidos', 'Nuevo pedido', true, true, false, array['business_owner','admin'], false),
  ('order.cancelled', 'pedidos', 'Pedido cancelado', true, true, false, array['business_owner','admin'], false),
  ('order.no_progress', 'pedidos', 'Pedido sin avance', true, false, false, array['business_owner','admin','vendedor','soporte'], false),
  ('order.delivered_unpaid', 'pedidos', 'Pedido entregado sin pago confirmado', true, true, false, array['business_owner','admin','contadora'], false),
  ('payment.pending', 'pagos', 'Pago pendiente', true, false, false, array['business_owner','admin','contadora'], false),
  ('payment.transfer_review', 'pagos', 'Transferencia en revision', true, true, false, array['business_owner','admin','contadora'], false),
  ('payment.rejected', 'pagos', 'Pago rechazado', true, true, false, array['business_owner','admin','contadora'], false),
  ('payment.confirmed', 'pagos', 'Pago confirmado', true, true, false, array['business_owner','admin','contadora','bodega'], false),
  ('payment.overdue', 'pagos', 'Pago pendiente vencido', true, true, false, array['business_owner','admin','contadora'], false),
  ('reservation.expired_review_required', 'reservas', 'Reserva vencida', true, true, false, array['technical_owner','business_owner','admin','contadora','bodega'], false),
  ('reservation.expiring_soon', 'reservas', 'Reserva por vencer', true, false, false, array['business_owner','admin','bodega'], false),
  ('reservation.extended', 'reservas', 'Reserva extendida', true, false, false, array['business_owner','admin','bodega'], false),
  ('reservation.released', 'reservas', 'Reserva liberada', true, false, false, array['business_owner','admin','bodega'], false),
  ('crm.followup_overdue', 'CRM', 'Seguimiento vencido', true, false, false, array['business_owner','admin','vendedor','soporte'], false),
  ('crm.general_contact', 'CRM', 'Nuevo contacto general', true, true, false, array['business_owner','admin','vendedor','soporte'], false),
  ('crm.wholesale_request', 'CRM', 'Nueva solicitud mayorista', true, true, false, array['business_owner','admin'], false),
  ('crm.task_pending', 'CRM', 'Tarea pendiente', true, false, false, array['business_owner','admin','vendedor','soporte'], false),
  ('crm.task_overdue', 'CRM', 'Tarea vencida', true, false, false, array['business_owner','admin','vendedor','soporte'], false),
  ('inventory.low_stock', 'inventario', 'Stock bajo', true, false, false, array['business_owner','admin','bodega'], false),
  ('inventory.out_of_stock', 'inventario', 'Producto agotado', true, false, false, array['business_owner','admin','bodega'], false),
  ('inventory.missing_image', 'inventario', 'Producto sin imagen', true, false, false, array['business_owner','admin'], false),
  ('inventory.product_disabled', 'inventario', 'Producto desactivado', true, false, false, array['business_owner','admin'], false),
  ('wholesale.request_new', 'mayoristas', 'Solicitud nueva', true, true, false, array['business_owner','admin'], false),
  ('wholesale.request_pending_24h', 'mayoristas', 'Solicitud pendiente mas de 24h', true, true, false, array['business_owner','admin'], false),
  ('wholesale.approved', 'mayoristas', 'Mayorista aprobado', true, true, false, array['business_owner','admin'], false),
  ('wholesale.rejected', 'mayoristas', 'Mayorista rechazado', true, true, false, array['business_owner','admin'], false),
  ('wholesale.suspended', 'mayoristas', 'Mayorista suspendido', true, true, false, array['business_owner','admin'], false),
  ('system.cron_failed', 'sistema', 'Cron fallido', true, true, false, array['technical_owner'], true),
  ('system.backup_failed', 'sistema', 'Backup fallido', true, true, false, array['technical_owner'], true),
  ('system.email_failed', 'sistema', 'Correo fallido', true, true, false, array['technical_owner'], true),
  ('system.cloudinary_high_usage', 'sistema', 'Uso alto de Cloudinary', true, true, false, array['technical_owner'], true),
  ('system.critical_error', 'sistema', 'Error critico', true, true, false, array['technical_owner'], true)
on conflict (notification_type) do update
set module = excluded.module,
    label = excluded.label,
    destination_roles = excluded.destination_roles,
    technical_only = excluded.technical_only,
    updated_at = now();

insert into public.audit_logs (actor_role, table_name, action, new_data)
values (
  'system_migration',
  'notification_preferences',
  'notifications.architecture_seeded',
  jsonb_build_object(
    'email_queue', true,
    'preferences', true,
    'service_account_email', 'carzonetech0@gmail.com',
    'brevo_ready', true,
    'fcm_future_ready', true
  )
);
