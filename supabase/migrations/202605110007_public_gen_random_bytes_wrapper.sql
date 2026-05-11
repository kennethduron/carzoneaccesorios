create or replace function public.gen_random_bytes(bytes integer)
returns bytea
language sql
stable
set search_path = extensions
as $$
  select extensions.gen_random_bytes(bytes);
$$;

grant execute on function public.gen_random_bytes(integer) to anon, authenticated, service_role;
