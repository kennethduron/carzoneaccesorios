create table if not exists public.admin_dashboard_notification_reads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  notification_key text not null,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_dashboard_notification_reads_key_length
    check (char_length(notification_key) between 2 and 160),
  constraint admin_dashboard_notification_reads_unique
    unique (user_id, notification_key)
);

create index if not exists admin_dashboard_notification_reads_user_read_idx
  on public.admin_dashboard_notification_reads(user_id, read_at desc);

alter table public.admin_dashboard_notification_reads enable row level security;

drop policy if exists "Users can read own admin dashboard notification reads"
  on public.admin_dashboard_notification_reads;
create policy "Users can read own admin dashboard notification reads"
  on public.admin_dashboard_notification_reads for select
  using (user_id = auth.uid());

drop policy if exists "Users can create own admin dashboard notification reads"
  on public.admin_dashboard_notification_reads;
create policy "Users can create own admin dashboard notification reads"
  on public.admin_dashboard_notification_reads for insert
  with check (user_id = auth.uid());

drop policy if exists "Users can update own admin dashboard notification reads"
  on public.admin_dashboard_notification_reads;
create policy "Users can update own admin dashboard notification reads"
  on public.admin_dashboard_notification_reads for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.admin_dashboard_notification_reads to authenticated;
grant select, insert, update, delete on public.admin_dashboard_notification_reads to service_role;
