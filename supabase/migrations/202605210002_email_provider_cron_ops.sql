create table if not exists public.operational_cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  status text not null check (status in ('success', 'failed', 'unauthorized')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists operational_cron_runs_job_created_at_idx
  on public.operational_cron_runs(job_name, created_at desc);

create index if not exists operational_cron_runs_status_created_at_idx
  on public.operational_cron_runs(status, created_at desc);

alter table public.operational_cron_runs enable row level security;

drop policy if exists "Technical staff can read cron runs" on public.operational_cron_runs;
create policy "Technical staff can read cron runs"
  on public.operational_cron_runs for select
  using (public.has_permission('system:monitoring'));

grant select on public.operational_cron_runs to authenticated;
grant select, insert on public.operational_cron_runs to service_role;

create or replace function public.get_latest_cron_run(target_job_name text default null)
returns table (
  job_name text,
  status text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  result jsonb,
  error_message text
)
language sql
security definer
set search_path = public
as $$
  select
    operational_cron_runs.job_name,
    operational_cron_runs.status,
    operational_cron_runs.started_at,
    operational_cron_runs.finished_at,
    operational_cron_runs.duration_ms,
    operational_cron_runs.result,
    operational_cron_runs.error_message
  from public.operational_cron_runs
  where target_job_name is null
     or operational_cron_runs.job_name = target_job_name
  order by operational_cron_runs.created_at desc
  limit 1;
$$;

grant execute on function public.get_latest_cron_run(text) to authenticated, service_role;

create or replace function public.count_rate_limits()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer from public.rate_limits;
$$;

grant execute on function public.count_rate_limits() to authenticated, service_role;
