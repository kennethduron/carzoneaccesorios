create table if not exists public.error_logs (
  id uuid primary key default gen_random_uuid(),
  route text,
  user_id uuid references public.users(id) on delete set null,
  user_email text,
  action text not null,
  error_message text not null,
  error_stack text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.error_logs enable row level security;

create index if not exists error_logs_route_idx on public.error_logs(route);
create index if not exists error_logs_user_id_idx on public.error_logs(user_id);
create index if not exists error_logs_action_created_at_idx on public.error_logs(action, created_at desc);
create index if not exists error_logs_created_at_idx on public.error_logs(created_at desc);

drop policy if exists "Admins can read error logs" on public.error_logs;
create policy "Admins can read error logs"
  on public.error_logs for select
  using (public.has_permission('audit:read') or public.has_permission('settings:manage'));

create or replace function public.write_error_log(
  affected_route text,
  action_name text,
  error_message text,
  error_stack text default null,
  error_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
  actor_id uuid := auth.uid();
  actor_email text := auth.jwt() ->> 'email';
begin
  if nullif(trim(coalesce(action_name, '')), '') is null then
    raise exception 'La accion del error es obligatoria.';
  end if;

  if nullif(trim(coalesce(error_message, '')), '') is null then
    raise exception 'El mensaje del error es obligatorio.';
  end if;

  insert into public.error_logs (
    route,
    user_id,
    user_email,
    action,
    error_message,
    error_stack,
    metadata
  )
  values (
    nullif(trim(coalesce(affected_route, '')), ''),
    actor_id,
    nullif(trim(coalesce(actor_email, '')), ''),
    trim(action_name),
    trim(error_message),
    nullif(error_stack, ''),
    coalesce(error_metadata, '{}'::jsonb)
  )
  returning id into log_id;

  return log_id;
end;
$$;

grant execute on function public.write_error_log(text, text, text, text, jsonb) to anon, authenticated;
