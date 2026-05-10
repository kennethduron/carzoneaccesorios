create table if not exists public.fiscal_settings (
  id boolean primary key default true,
  legal_name text not null default 'Car Zone Accesorios',
  rtn text not null default '',
  cai text not null default '',
  invoice_range_start text not null default '',
  invoice_range_end text not null default '',
  current_invoice_number text not null default '',
  emission_deadline date,
  fiscal_address text not null default '',
  phone text not null default '',
  email text not null default '',
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_settings_singleton check (id)
);

insert into public.fiscal_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.invoices
  add column if not exists company_legal_name text,
  add column if not exists company_rtn text,
  add column if not exists company_address text,
  add column if not exists company_phone text,
  add column if not exists company_email text,
  add column if not exists company_logo_url text,
  add column if not exists fiscal_range_start text,
  add column if not exists fiscal_range_end text;

create index if not exists fiscal_settings_updated_at_idx on public.fiscal_settings(updated_at);

alter table public.fiscal_settings enable row level security;

drop policy if exists "Staff can read fiscal settings" on public.fiscal_settings;
create policy "Staff can read fiscal settings"
  on public.fiscal_settings for select
  using (
    public.has_permission('invoices:manage')
    or public.has_permission('reports:read')
    or public.has_permission('settings:manage')
  );

drop policy if exists "Admins can manage fiscal settings" on public.fiscal_settings;
create policy "Admins can manage fiscal settings"
  on public.fiscal_settings for all
  using (public.has_permission('settings:manage') or public.has_permission('invoices:manage'))
  with check (public.has_permission('settings:manage') or public.has_permission('invoices:manage'));

grant select, insert, update on public.fiscal_settings to authenticated;
