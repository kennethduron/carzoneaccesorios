-- Safer operational error logs:
-- - keep user_id nullable when the auth session no longer has a public.users row
-- - allow anonymous auth/system errors
-- - classify errors for CRM/admin without exposing sensitive values

alter table public.error_logs
  add column if not exists module text,
  add column if not exists category text not null default 'system',
  add column if not exists severity text not null default 'error',
  add column if not exists status text not null default 'open',
  add column if not exists customer_message text,
  add column if not exists admin_reason text,
  add column if not exists recommendation text,
  add column if not exists error_code text,
  add column if not exists http_status integer,
  add column if not exists email_hash text;

alter table public.error_logs
  drop constraint if exists error_logs_category_check,
  add constraint error_logs_category_check
    check (category in ('auth', 'crm', 'checkout', 'payments', 'invoices', 'inventory', 'wholesale', 'email', 'cron', 'system'));

alter table public.error_logs
  drop constraint if exists error_logs_severity_check,
  add constraint error_logs_severity_check
    check (severity in ('info', 'warning', 'error', 'critical'));

alter table public.error_logs
  drop constraint if exists error_logs_status_check,
  add constraint error_logs_status_check
    check (status in ('open', 'reviewing', 'resolved', 'ignored'));

create index if not exists error_logs_category_created_at_idx
  on public.error_logs(category, created_at desc);

create index if not exists error_logs_severity_status_created_at_idx
  on public.error_logs(severity, status, created_at desc);

create index if not exists error_logs_module_action_created_at_idx
  on public.error_logs(module, action, created_at desc);

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
  valid_actor_id uuid;
  actor_email text := auth.jwt() ->> 'email';
  safe_route text := left(nullif(trim(coalesce(affected_route, '')), ''), 180);
  safe_action text := left(nullif(trim(coalesce(action_name, '')), ''), 120);
  safe_message text := left(nullif(trim(coalesce(error_message, '')), ''), 700);
  safe_stack text := left(nullif(trim(coalesce(error_stack, '')), ''), 2000);
  safe_metadata jsonb := coalesce(error_metadata, '{}'::jsonb);
  safe_module text := left(nullif(trim(coalesce(safe_metadata ->> 'module', '')), ''), 80);
  safe_category text := coalesce(nullif(safe_metadata ->> 'category', ''), 'system');
  safe_severity text := coalesce(nullif(safe_metadata ->> 'severity', ''), 'error');
  safe_status text := coalesce(nullif(safe_metadata ->> 'status', ''), 'open');
  safe_user_email text := left(nullif(trim(coalesce(safe_metadata ->> 'email_masked', '')), ''), 180);
  safe_http_status integer;
  email_name text;
  email_domain text;
begin
  if safe_action is null then
    raise exception 'La accion del error es obligatoria.';
  end if;

  if safe_message is null then
    raise exception 'El mensaje del error es obligatorio.';
  end if;

  if safe_category not in ('auth', 'crm', 'checkout', 'payments', 'invoices', 'inventory', 'wholesale', 'email', 'cron', 'system') then
    safe_category := 'system';
  end if;

  if safe_severity not in ('info', 'warning', 'error', 'critical') then
    safe_severity := 'error';
  end if;

  if safe_status not in ('open', 'reviewing', 'resolved', 'ignored') then
    safe_status := 'open';
  end if;

  if actor_id is not null then
    select users.id
    into valid_actor_id
    from public.users
    where users.id = actor_id
    limit 1;
  end if;

  if safe_user_email is null and nullif(trim(coalesce(actor_email, '')), '') is not null and position('@' in actor_email) > 1 then
    email_name := split_part(lower(trim(actor_email)), '@', 1);
    email_domain := split_part(lower(trim(actor_email)), '@', 2);
    safe_user_email := left(left(email_name, 2) || '***@' || left(email_domain, 2) || '***.' || coalesce(nullif(split_part(email_domain, '.', 2), ''), 'com'), 180);
  end if;

  if coalesce(safe_metadata ->> 'http_status', '') ~ '^[0-9]+$' then
    safe_http_status := (safe_metadata ->> 'http_status')::integer;
  end if;

  if valid_actor_id is null then
    if (
      select count(*)
      from public.error_logs
      where user_id is null
        and created_at > now() - interval '1 minute'
    ) >= 60 then
      return null;
    end if;

    if (
      select count(*)
      from public.error_logs
      where user_id is null
        and action = safe_action
        and coalesce(route, '') = coalesce(safe_route, '')
        and created_at > now() - interval '1 minute'
    ) >= 10 then
      return null;
    end if;

    safe_stack := null;
  end if;

  if length(safe_metadata::text) > 4000 then
    safe_metadata := jsonb_build_object(
      'truncated', true,
      'environment', safe_metadata ->> 'environment',
      'module', safe_module,
      'category', safe_category,
      'severity', safe_severity,
      'status', safe_status,
      'code', safe_metadata ->> 'code',
      'http_status', safe_metadata ->> 'http_status',
      'email_masked', safe_metadata ->> 'email_masked',
      'email_hash', safe_metadata ->> 'email_hash'
    );
  end if;

  insert into public.error_logs (
    route,
    user_id,
    user_email,
    action,
    error_message,
    error_stack,
    metadata,
    module,
    category,
    severity,
    status,
    customer_message,
    admin_reason,
    recommendation,
    error_code,
    http_status,
    email_hash
  )
  values (
    safe_route,
    valid_actor_id,
    safe_user_email,
    safe_action,
    safe_message,
    safe_stack,
    safe_metadata,
    safe_module,
    safe_category,
    safe_severity,
    safe_status,
    left(nullif(trim(coalesce(safe_metadata ->> 'customer_message', '')), ''), 300),
    left(nullif(trim(coalesce(safe_metadata ->> 'admin_reason', '')), ''), 300),
    left(nullif(trim(coalesce(safe_metadata ->> 'recommendation', '')), ''), 300),
    left(nullif(trim(coalesce(safe_metadata ->> 'code', '')), ''), 80),
    safe_http_status,
    left(nullif(trim(coalesce(safe_metadata ->> 'email_hash', '')), ''), 128)
  )
  returning id into log_id;

  return log_id;
end;
$$;

grant execute on function public.write_error_log(text, text, text, text, jsonb) to anon, authenticated, service_role;
