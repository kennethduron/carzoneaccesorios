create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  type text not null,
  parent_id uuid references public.accounting_accounts(id) on delete restrict,
  normal_balance text not null,
  is_active boolean not null default true,
  description text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_accounts_code_length check (char_length(trim(code)) between 1 and 32),
  constraint accounting_accounts_name_length check (char_length(trim(name)) between 2 and 140),
  constraint accounting_accounts_type_check check (type in ('asset', 'liability', 'equity', 'revenue', 'cost', 'expense')),
  constraint accounting_accounts_normal_balance_check check (normal_balance in ('debit', 'credit')),
  constraint accounting_accounts_parent_not_self check (parent_id is null or parent_id <> id)
);

create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'open',
  closed_by uuid references public.users(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_periods_status_check check (status in ('open', 'closed')),
  constraint accounting_periods_valid_range check (end_date >= start_date)
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_number text not null,
  entry_date date not null,
  description text not null,
  status text not null default 'borrador',
  source_type text,
  source_id text,
  created_by uuid not null references public.users(id) on delete restrict,
  posted_by uuid references public.users(id) on delete set null,
  posted_at timestamptz,
  reversed_entry_id uuid references public.journal_entries(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_entries_number_length check (char_length(trim(entry_number)) between 3 and 40),
  constraint journal_entries_description_length check (char_length(trim(description)) between 3 and 500),
  constraint journal_entries_status_check check (status in ('borrador', 'publicada', 'reversada', 'anulada')),
  constraint journal_entries_source_pair check (
    (source_type is null and source_id is null) or
    (source_type is not null and source_id is not null)
  ),
  constraint journal_entries_posted_metadata check (
    (status <> 'publicada') or (posted_by is not null and posted_at is not null)
  ),
  constraint journal_entries_reversal_not_self check (reversed_entry_id is null or reversed_entry_id <> id)
);

create table if not exists public.journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  debit numeric(14, 2) not null default 0,
  credit numeric(14, 2) not null default 0,
  description text,
  customer_id uuid references public.customers(id) on delete set null,
  vendor_id uuid,
  product_id uuid references public.products(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint journal_entry_lines_amounts_non_negative check (debit >= 0 and credit >= 0),
  constraint journal_entry_lines_one_side_only check (
    (debit > 0 and credit = 0) or
    (credit > 0 and debit = 0)
  )
);

create table if not exists public.accounting_event_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  source_type text,
  source_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint accounting_event_log_event_length check (char_length(trim(event_type)) between 3 and 120),
  constraint accounting_event_log_entity_length check (char_length(trim(entity_type)) between 3 and 120)
);

create table if not exists public.accounting_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_settings_key_length check (char_length(trim(key)) between 2 and 120)
);

create unique index if not exists accounting_accounts_code_key
  on public.accounting_accounts (code);
create index if not exists accounting_accounts_type_idx
  on public.accounting_accounts (type);
create index if not exists accounting_accounts_parent_id_idx
  on public.accounting_accounts (parent_id);
create index if not exists accounting_accounts_active_idx
  on public.accounting_accounts (is_active);
create unique index if not exists accounting_periods_range_key
  on public.accounting_periods (start_date, end_date);
create index if not exists accounting_periods_status_idx
  on public.accounting_periods (status);
create unique index if not exists journal_entries_entry_number_key
  on public.journal_entries (entry_number);
create index if not exists journal_entries_entry_date_idx
  on public.journal_entries (entry_date desc);
create index if not exists journal_entries_status_idx
  on public.journal_entries (status);
create index if not exists journal_entries_created_by_idx
  on public.journal_entries (created_by);
create unique index if not exists journal_entries_source_unique_idx
  on public.journal_entries (source_type, source_id)
  where source_type is not null and source_id is not null;
create index if not exists journal_entry_lines_entry_idx
  on public.journal_entry_lines (journal_entry_id);
create index if not exists journal_entry_lines_account_idx
  on public.journal_entry_lines (account_id);
create index if not exists accounting_event_log_entity_idx
  on public.accounting_event_log (entity_type, entity_id);
create index if not exists accounting_event_log_source_idx
  on public.accounting_event_log (source_type, source_id);
create index if not exists accounting_event_log_created_at_idx
  on public.accounting_event_log (created_at desc);
create unique index if not exists accounting_settings_key_key
  on public.accounting_settings (key);

drop trigger if exists accounting_accounts_set_updated_at on public.accounting_accounts;
create trigger accounting_accounts_set_updated_at
before update on public.accounting_accounts
for each row execute function public.set_updated_at();

drop trigger if exists accounting_periods_set_updated_at on public.accounting_periods;
create trigger accounting_periods_set_updated_at
before update on public.accounting_periods
for each row execute function public.set_updated_at();

drop trigger if exists journal_entries_set_updated_at on public.journal_entries;
create trigger journal_entries_set_updated_at
before update on public.journal_entries
for each row execute function public.set_updated_at();

drop trigger if exists accounting_settings_set_updated_at on public.accounting_settings;
create trigger accounting_settings_set_updated_at
before update on public.accounting_settings
for each row execute function public.set_updated_at();

create or replace function public.guard_journal_entry_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'borrador' then
      raise exception 'Las partidas publicadas no se eliminan. Debes registrar un reverso.';
    end if;
    return old;
  end if;

  if old.status in ('reversada', 'anulada') then
    raise exception 'Esta partida ya no admite cambios.';
  end if;

  if old.status = 'publicada' then
    if new.status = 'reversada'
      and new.reversed_entry_id is not null
      and new.entry_number = old.entry_number
      and new.entry_date = old.entry_date
      and new.description = old.description
      and coalesce(new.source_type, '') = coalesce(old.source_type, '')
      and coalesce(new.source_id, '') = coalesce(old.source_id, '')
      and new.created_by = old.created_by
      and new.posted_by = old.posted_by
      and new.posted_at = old.posted_at
    then
      return new;
    end if;

    raise exception 'Las partidas publicadas no se editan. Debes registrar un reverso.';
  end if;

  return new;
end;
$$;

drop trigger if exists journal_entries_guard_status_update on public.journal_entries;
create trigger journal_entries_guard_status_update
before update on public.journal_entries
for each row execute function public.guard_journal_entry_status();

drop trigger if exists journal_entries_guard_status_delete on public.journal_entries;
create trigger journal_entries_guard_status_delete
before delete on public.journal_entries
for each row execute function public.guard_journal_entry_status();

create or replace function public.guard_journal_entry_lines()
returns trigger
language plpgsql
as $$
declare
  parent_status text;
begin
  select status
    into parent_status
    from public.journal_entries
    where id = coalesce(new.journal_entry_id, old.journal_entry_id);

  if parent_status is null then
    raise exception 'La partida contable no existe.';
  end if;

  if parent_status <> 'borrador' then
    raise exception 'Las líneas de una partida publicada no se editan.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists journal_entry_lines_guard_insert on public.journal_entry_lines;
create trigger journal_entry_lines_guard_insert
before insert on public.journal_entry_lines
for each row execute function public.guard_journal_entry_lines();

drop trigger if exists journal_entry_lines_guard_update on public.journal_entry_lines;
create trigger journal_entry_lines_guard_update
before update on public.journal_entry_lines
for each row execute function public.guard_journal_entry_lines();

drop trigger if exists journal_entry_lines_guard_delete on public.journal_entry_lines;
create trigger journal_entry_lines_guard_delete
before delete on public.journal_entry_lines
for each row execute function public.guard_journal_entry_lines();

alter table public.accounting_accounts enable row level security;
alter table public.accounting_periods enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_entry_lines enable row level security;
alter table public.accounting_event_log enable row level security;
alter table public.accounting_settings enable row level security;

create policy "Accounting read accounts"
  on public.accounting_accounts for select
  using (public.has_permission('accounting:read'));
create policy "Accounting manage accounts"
  on public.accounting_accounts for insert
  with check (public.has_permission('accounting:manage') or public.has_permission('accounting:create'));
create policy "Accounting update accounts"
  on public.accounting_accounts for update
  using (public.has_permission('accounting:manage'))
  with check (public.has_permission('accounting:manage'));

create policy "Accounting read periods"
  on public.accounting_periods for select
  using (public.has_permission('accounting:read'));
create policy "Accounting manage periods"
  on public.accounting_periods for all
  using (public.has_permission('accounting:close_period') or public.has_permission('accounting:settings'))
  with check (public.has_permission('accounting:close_period') or public.has_permission('accounting:settings'));

create policy "Accounting read journal entries"
  on public.journal_entries for select
  using (public.has_permission('accounting:read'));
create policy "Accounting create journal entries"
  on public.journal_entries for insert
  with check (public.has_permission('accounting:create') or public.has_permission('accounting:manage'));
create policy "Accounting update journal entries"
  on public.journal_entries for update
  using (
    public.has_permission('accounting:manage') or
    public.has_permission('accounting:post') or
    public.has_permission('accounting:reverse')
  )
  with check (
    public.has_permission('accounting:manage') or
    public.has_permission('accounting:post') or
    public.has_permission('accounting:reverse')
  );
create policy "Accounting delete draft journal entries"
  on public.journal_entries for delete
  using (public.has_permission('accounting:manage') and status = 'borrador');

create policy "Accounting read journal lines"
  on public.journal_entry_lines for select
  using (public.has_permission('accounting:read'));
create policy "Accounting create journal lines"
  on public.journal_entry_lines for insert
  with check (public.has_permission('accounting:create') or public.has_permission('accounting:manage'));
create policy "Accounting update journal lines"
  on public.journal_entry_lines for update
  using (public.has_permission('accounting:create') or public.has_permission('accounting:manage'))
  with check (public.has_permission('accounting:create') or public.has_permission('accounting:manage'));
create policy "Accounting delete journal lines"
  on public.journal_entry_lines for delete
  using (public.has_permission('accounting:create') or public.has_permission('accounting:manage'));

create policy "Accounting read event log"
  on public.accounting_event_log for select
  using (public.has_permission('accounting:read'));
create policy "Accounting create event log"
  on public.accounting_event_log for insert
  with check (
    public.has_permission('accounting:create') or
    public.has_permission('accounting:post') or
    public.has_permission('accounting:reverse') or
    public.has_permission('accounting:manage') or
    public.has_permission('accounting:settings')
  );

create policy "Accounting read settings"
  on public.accounting_settings for select
  using (public.has_permission('accounting:read'));
create policy "Accounting manage settings"
  on public.accounting_settings for all
  using (public.has_permission('accounting:settings'))
  with check (public.has_permission('accounting:settings'));

grant select, insert, update on public.accounting_accounts to authenticated;
grant select, insert, update, delete on public.accounting_accounts to service_role;
grant select, insert, update on public.accounting_periods to authenticated;
grant select, insert, update, delete on public.accounting_periods to service_role;
grant select, insert, update, delete on public.journal_entries to authenticated;
grant select, insert, update, delete on public.journal_entries to service_role;
grant select, insert, update, delete on public.journal_entry_lines to authenticated;
grant select, insert, update, delete on public.journal_entry_lines to service_role;
grant select, insert on public.accounting_event_log to authenticated;
grant select, insert, update, delete on public.accounting_event_log to service_role;
grant select, insert, update on public.accounting_settings to authenticated;
grant select, insert, update, delete on public.accounting_settings to service_role;

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(
    coalesce(public.roles.permissions, '[]'::jsonb) ||
    '[
      "accounting:read",
      "accounting:create",
      "accounting:post",
      "accounting:manage",
      "accounting:reverse",
      "accounting:export",
      "accounting:settings",
      "accounting:close_period",
      "accounting:view_reports"
    ]'::jsonb
  ) as permissions(permission)
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(
    coalesce(public.roles.permissions, '[]'::jsonb) ||
    '[
      "accounting:read",
      "accounting:view_reports",
      "accounting:export"
    ]'::jsonb
  ) as permissions(permission)
),
updated_at = now()
where name = 'contadora';

