-- Make the rate-limit upsert target explicit so PostgreSQL does not confuse
-- RPC parameter names with table columns during schema linting/runtime checks.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.rate_limits'::regclass
      and conname = 'rate_limits_identifier_route_window_key'
  ) then
    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'rate_limits_identifier_route_window_key'
        and c.relkind = 'i'
    ) then
      alter table public.rate_limits
        add constraint rate_limits_identifier_route_window_key
        unique using index rate_limits_identifier_route_window_key;
    else
      alter table public.rate_limits
        add constraint rate_limits_identifier_route_window_key
        unique (identifier_hash, route_key, window_start);
    end if;
  end if;
end;
$$;

create or replace function public.check_rate_limit(
  identifier_hash text,
  route_key text,
  max_attempts integer,
  window_seconds integer
)
returns table (
  allowed boolean,
  attempts integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_identifier text := left(nullif(trim(coalesce(identifier_hash, '')), ''), 128);
  safe_route text := left(nullif(trim(coalesce(route_key, '')), ''), 160);
  safe_max integer := greatest(coalesce(max_attempts, 10), 1);
  safe_window integer := greatest(coalesce(window_seconds, 60), 10);
  current_window timestamptz;
  current_attempts integer;
begin
  if safe_identifier is null or safe_route is null then
    allowed := true;
    attempts := 0;
    retry_after_seconds := 0;
    return next;
    return;
  end if;

  current_window := to_timestamp(floor(extract(epoch from now()) / safe_window) * safe_window);

  insert into public.rate_limits(identifier_hash, route_key, window_start, attempts, updated_at)
  values (safe_identifier, safe_route, current_window, 1, now())
  on conflict on constraint rate_limits_identifier_route_window_key
  do update set
    attempts = public.rate_limits.attempts + 1,
    updated_at = now()
  returning public.rate_limits.attempts into current_attempts;

  if current_attempts > safe_max then
    update public.rate_limits
    set blocked_until = current_window + make_interval(secs => safe_window),
        updated_at = now()
    where public.rate_limits.identifier_hash = safe_identifier
      and public.rate_limits.route_key = safe_route
      and public.rate_limits.window_start = current_window;

    allowed := false;
    attempts := current_attempts;
    retry_after_seconds := greatest(1, ceil(extract(epoch from (current_window + make_interval(secs => safe_window) - now())))::integer);
  else
    allowed := true;
    attempts := current_attempts;
    retry_after_seconds := 0;
  end if;

  return next;
end;
$$;

grant execute on function public.check_rate_limit(text, text, integer, integer) to anon, authenticated, service_role;
