insert into public.roles (name, description, permissions)
values (
  'technical_owner',
  'Proveedor tecnico del sistema. Acceso exclusivo a monitoreo de infraestructura y mantenimiento tecnico.',
  '["admin:access","system:monitoring"]'::jsonb
)
on conflict (name) do update
set
  description = excluded.description,
  permissions = excluded.permissions;

create or replace function public.has_permission(permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users
    join public.roles on roles.id = users.role_id
    where users.id = auth.uid()
      and users.active = true
      and (
        roles.permissions ? permission_key
        or (roles.name = 'admin' and permission_key <> 'system:monitoring')
      )
  );
$$;

drop policy if exists "Admins can read error logs" on public.error_logs;
create policy "Technical owners can read error logs"
  on public.error_logs for select
  using (public.has_permission('system:monitoring'));

drop policy if exists "Admins can read notification logs" on public.notification_logs;
create policy "Technical owners can read notification logs"
  on public.notification_logs for select
  using (public.has_permission('system:monitoring'));

create or replace function public.cleanup_old_operational_logs(retention_days integer default 90)
returns table (
  table_name text,
  deleted_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(coalesce(retention_days, 90), 30));
  deleted_errors integer := 0;
  deleted_notifications integer := 0;
begin
  delete from public.error_logs
  where created_at < cutoff;
  get diagnostics deleted_errors = row_count;

  delete from public.notification_logs
  where created_at < cutoff;
  get diagnostics deleted_notifications = row_count;

  return query values
    ('error_logs'::text, deleted_errors),
    ('notification_logs'::text, deleted_notifications);
end;
$$;

revoke all on function public.cleanup_old_operational_logs(integer) from public;
grant execute on function public.cleanup_old_operational_logs(integer) to service_role;

create or replace function public.get_system_monitoring_snapshot()
returns table (
  database_size_bytes bigint,
  table_name text,
  row_estimate bigint,
  table_size_bytes bigint,
  index_size_bytes bigint,
  total_size_bytes bigint
)
language sql
security definer
set search_path = public
as $$
  select
    pg_database_size(current_database())::bigint as database_size_bytes,
    c.relname::text as table_name,
    greatest(c.reltuples::bigint, 0)::bigint as row_estimate,
    pg_table_size(c.oid)::bigint as table_size_bytes,
    pg_indexes_size(c.oid)::bigint as index_size_bytes,
    pg_total_relation_size(c.oid)::bigint as total_size_bytes
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
  limit 20;
$$;

revoke all on function public.get_system_monitoring_snapshot() from public;
grant execute on function public.get_system_monitoring_snapshot() to service_role;
