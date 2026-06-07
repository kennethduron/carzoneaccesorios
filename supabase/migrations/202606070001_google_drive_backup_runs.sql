create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  type text not null default 'manual'
    check (type in ('manual', 'daily', 'weekly', 'monthly', 'scheduled', 'pre_deploy')),
  file_name text,
  file_size bigint,
  google_drive_file_id text,
  google_drive_folder_id text,
  tables_exported text[] not null default '{}',
  tables_missing text[] not null default '{}',
  error_message text,
  triggered_by text not null default 'manual'
    check (triggered_by in ('manual', 'cron', 'system')),
  created_by_user_id uuid references public.users(id) on delete set null,
  retention_deleted integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.backup_runs enable row level security;

create index if not exists backup_runs_started_at_idx
  on public.backup_runs(started_at desc);

create index if not exists backup_runs_status_started_at_idx
  on public.backup_runs(status, started_at desc);

create index if not exists backup_runs_type_started_at_idx
  on public.backup_runs(type, started_at desc);

drop policy if exists "Technical owner can read backup runs" on public.backup_runs;
create policy "Technical owner can read backup runs"
  on public.backup_runs for select
  using (public.has_permission('system:backups'));

drop policy if exists "Technical owner can create backup runs" on public.backup_runs;
create policy "Technical owner can create backup runs"
  on public.backup_runs for insert
  with check (public.has_permission('system:backups'));

drop policy if exists "Technical owner can update backup runs" on public.backup_runs;
create policy "Technical owner can update backup runs"
  on public.backup_runs for update
  using (public.has_permission('system:backups'))
  with check (public.has_permission('system:backups'));

grant select, insert, update on public.backup_runs to authenticated;
grant select, insert, update, delete on public.backup_runs to service_role;
