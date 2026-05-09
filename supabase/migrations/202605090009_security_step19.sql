create table if not exists public.backup_logs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references public.users(id) on delete set null,
  backup_type text not null default 'manual'
    check (backup_type in ('manual', 'scheduled', 'pre_deploy')),
  status text not null default 'requested'
    check (status in ('requested', 'running', 'completed', 'failed')),
  storage_location text,
  notes text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.backup_logs enable row level security;

create index if not exists backup_logs_requested_by_idx on public.backup_logs(requested_by);
create index if not exists backup_logs_status_idx on public.backup_logs(status);
create index if not exists backup_logs_created_at_idx on public.backup_logs(created_at);

create policy "Admins can read backup logs"
  on public.backup_logs for select
  using (public.has_permission('settings:manage') or public.has_permission('audit:read'));

create policy "Admins can create backup logs"
  on public.backup_logs for insert
  with check (public.has_permission('settings:manage'));

create policy "Admins can update backup logs"
  on public.backup_logs for update
  using (public.has_permission('settings:manage'))
  with check (public.has_permission('settings:manage'));

create or replace function public.write_audit_log(
  target_table text,
  target_record_id uuid,
  action_name text,
  previous_data jsonb default null,
  next_data jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.audit_logs (
    user_id,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    auth.uid(),
    target_table,
    target_record_id,
    action_name,
    previous_data,
    next_data
  )
  returning id into log_id;

  return log_id;
end;
$$;

grant execute on function public.write_audit_log(text, uuid, text, jsonb, jsonb) to authenticated;
