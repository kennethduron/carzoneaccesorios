alter table public.company_settings
  add column if not exists notification_emails text,
  add column if not exists notify_new_orders boolean not null default true,
  add column if not exists notify_payment_confirmed boolean not null default true,
  add column if not exists notify_wholesale_requests boolean not null default true;

create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  order_id uuid references public.orders(id) on delete set null,
  recipient_email text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  provider text not null default 'resend',
  provider_message_id text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.notification_logs enable row level security;

create index if not exists notification_logs_event_created_at_idx on public.notification_logs(event_type, created_at desc);
create index if not exists notification_logs_order_id_idx on public.notification_logs(order_id);
create index if not exists notification_logs_status_idx on public.notification_logs(status);

drop policy if exists "Admins can read notification logs" on public.notification_logs;
create policy "Admins can read notification logs"
  on public.notification_logs for select
  using (public.has_permission('audit:read') or public.has_permission('settings:manage'));

grant select on public.notification_logs to authenticated;
grant select, insert, update, delete on public.notification_logs to service_role;
grant select, insert, update on public.company_settings to service_role;
