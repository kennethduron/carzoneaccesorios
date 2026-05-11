grant usage on schema public to anon, authenticated, service_role;

grant select on public.wholesale_codes to authenticated, service_role;
grant select on public.customers to service_role;

grant insert, update, delete on public.wholesale_codes to authenticated, service_role;
grant select, insert, update on public.customers to authenticated, service_role;

grant execute on function public.validate_wholesale_code(text) to anon, authenticated, service_role;
