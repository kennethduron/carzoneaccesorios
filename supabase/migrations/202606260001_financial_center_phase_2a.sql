create table if not exists public.accounting_mappings (
  id uuid primary key default gen_random_uuid(),
  mapping_type text not null,
  source_key text not null,
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  priority integer not null default 100,
  is_active boolean not null default true,
  effective_from date,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_mappings_type_check check (
    mapping_type in (
      'default_account',
      'payment_method',
      'revenue',
      'tax',
      'receivable',
      'inventory',
      'discount',
      'shipping',
      'rounding',
      'suspense'
    )
  ),
  constraint accounting_mappings_source_key_length check (char_length(trim(source_key)) between 1 and 120),
  constraint accounting_mappings_priority_check check (priority between 1 and 10000),
  constraint accounting_mappings_effective_range check (effective_to is null or effective_from is null or effective_to >= effective_from),
  constraint accounting_mappings_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.financial_events (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id text not null,
  event_purpose text not null,
  posting_version text not null default 'v1',
  status text not null,
  occurred_at timestamptz not null default now(),
  source_snapshot jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_events_status_check check (status in ('pending', 'ready', 'draft_created', 'posted', 'failed', 'skipped', 'reversed')),
  constraint financial_events_source_type_length check (char_length(trim(source_type)) between 1 and 120),
  constraint financial_events_source_id_length check (char_length(trim(source_id)) between 1 and 160),
  constraint financial_events_purpose_length check (char_length(trim(event_purpose)) between 1 and 120),
  constraint financial_events_posting_version_length check (char_length(trim(posting_version)) between 1 and 40),
  constraint financial_events_snapshot_object check (jsonb_typeof(source_snapshot) = 'object'),
  constraint financial_events_errors_array check (jsonb_typeof(validation_errors) = 'array'),
  constraint financial_events_source_unique unique (source_type, source_id, event_purpose, posting_version)
);

create table if not exists public.accounting_automation_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_automation_settings_key_length check (char_length(trim(key)) between 1 and 120),
  constraint accounting_automation_settings_value_object check (jsonb_typeof(value) = 'object')
);

create unique index if not exists accounting_mappings_unique_definition_idx
  on public.accounting_mappings (mapping_type, source_key, account_id, priority);
create index if not exists accounting_mappings_lookup_idx
  on public.accounting_mappings (mapping_type, source_key, is_active, priority);
create index if not exists accounting_mappings_account_idx
  on public.accounting_mappings (account_id);
create index if not exists financial_events_status_idx
  on public.financial_events (status, occurred_at desc);
create index if not exists financial_events_source_idx
  on public.financial_events (source_type, source_id);
create index if not exists financial_events_journal_entry_idx
  on public.financial_events (journal_entry_id);

drop trigger if exists accounting_mappings_set_updated_at on public.accounting_mappings;
create trigger accounting_mappings_set_updated_at
before update on public.accounting_mappings
for each row execute function public.set_updated_at();

drop trigger if exists financial_events_set_updated_at on public.financial_events;
create trigger financial_events_set_updated_at
before update on public.financial_events
for each row execute function public.set_updated_at();

drop trigger if exists accounting_automation_settings_set_updated_at on public.accounting_automation_settings;
create trigger accounting_automation_settings_set_updated_at
before update on public.accounting_automation_settings
for each row execute function public.set_updated_at();

alter table public.accounting_mappings enable row level security;
alter table public.financial_events enable row level security;
alter table public.accounting_automation_settings enable row level security;

create policy "Accounting read mappings"
  on public.accounting_mappings for select
  using (public.has_permission('accounting:read'));
create policy "Accounting configure mappings"
  on public.accounting_mappings for insert
  with check (public.has_permission('accounting:settings'));
create policy "Accounting update mappings"
  on public.accounting_mappings for update
  using (public.has_permission('accounting:settings'))
  with check (public.has_permission('accounting:settings'));
create policy "Accounting read financial events"
  on public.financial_events for select
  using (public.has_permission('accounting:read'));
create policy "Accounting create financial events"
  on public.financial_events for insert
  with check (public.has_permission('accounting:manage'));
create policy "Accounting update financial events"
  on public.financial_events for update
  using (public.has_permission('accounting:manage'))
  with check (public.has_permission('accounting:manage'));
create policy "Accounting read automation settings"
  on public.accounting_automation_settings for select
  using (public.has_permission('accounting:read'));
create policy "Accounting configure automation settings"
  on public.accounting_automation_settings for insert
  with check (public.has_permission('accounting:settings'));
create policy "Accounting update automation settings"
  on public.accounting_automation_settings for update
  using (public.has_permission('accounting:settings'))
  with check (public.has_permission('accounting:settings'));
grant select, insert, update on public.accounting_mappings to authenticated;
grant select, insert, update on public.financial_events to authenticated;
grant select, insert, update on public.accounting_automation_settings to authenticated;
grant select, insert, update on public.accounting_mappings to service_role;
grant select, insert, update on public.financial_events to service_role;
grant select, insert, update on public.accounting_automation_settings to service_role;

insert into public.accounting_automation_settings (key, value, description)
values (
  'automation_mode',
  '{"mode": "disabled"}'::jsonb,
  'Controla el modo de automatización contable futura.'
)
on conflict (key) do nothing;
