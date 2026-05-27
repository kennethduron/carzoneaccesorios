create table if not exists public.technical_alert_settings (
  id boolean primary key default true check (id = true),
  enabled boolean not null default true,
  email text not null default 'kennethduron.paz@gmail.com',
  cloudinary_storage_threshold_percent integer not null default 70
    check (cloudinary_storage_threshold_percent between 1 and 100),
  last_alert_sent_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.technical_alert_settings enable row level security;

drop policy if exists "Technical users can read alert settings" on public.technical_alert_settings;
create policy "Technical users can read alert settings"
  on public.technical_alert_settings for select
  using (public.has_permission('system:monitoring'));

drop policy if exists "Technical users can manage alert settings" on public.technical_alert_settings;
create policy "Technical users can manage alert settings"
  on public.technical_alert_settings for all
  using (public.has_permission('system:monitoring'))
  with check (public.has_permission('system:monitoring'));

grant select, insert, update on public.technical_alert_settings to authenticated;
grant select, insert, update, delete on public.technical_alert_settings to service_role;

insert into public.technical_alert_settings (id, enabled, email, cloudinary_storage_threshold_percent)
values (true, true, 'kennethduron.paz@gmail.com', 70)
on conflict (id) do nothing;
