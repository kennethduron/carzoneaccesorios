-- Add a dedicated permission for wholesale administration without granting it
-- to operational roles that can manage ordinary CRM customers.

update public.roles
set
  permissions = permissions || '["wholesale:manage"]'::jsonb,
  updated_at = now()
where name in ('technical_owner', 'admin', 'business_owner')
  and not (permissions ? 'wholesale:manage');

update public.roles
set
  permissions = permissions - 'wholesale:manage',
  updated_at = now()
where name in ('vendedor', 'bodega', 'contadora', 'soporte', 'cliente')
  and (permissions ? 'wholesale:manage');

update public.users
set
  role_id = (select id from public.roles where name = 'technical_owner'),
  active = true,
  updated_at = now()
where lower(coalesce(email, '')) = 'kennethduron.paz@gmail.com';

update public.users
set
  role_id = (select id from public.roles where name = 'business_owner'),
  active = true,
  updated_at = now()
where lower(coalesce(email, '')) = 'car.zone.accesorioshn@gmail.com';

drop policy if exists "Admins can manage wholesale codes" on public.wholesale_codes;

create policy "Authorized users can manage wholesale codes"
  on public.wholesale_codes for all
  using (public.has_permission('wholesale:manage'))
  with check (public.has_permission('wholesale:manage'));

drop function if exists public.write_audit_log(text, uuid, text, jsonb, jsonb);

create or replace function public.write_audit_log(
  target_table text,
  target_record_id uuid,
  action_name text,
  previous_data jsonb default null,
  next_data jsonb default null,
  actor_ip text default null,
  actor_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
  actor_role_name text := public.current_actor_role();
  safe_actor_ip inet;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  begin
    safe_actor_ip := nullif(trim(coalesce(actor_ip, '')), '')::inet;
  exception
    when invalid_text_representation then
      safe_actor_ip := null;
  end;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data,
    ip_address,
    user_agent
  )
  values (
    auth.uid(),
    actor_role_name,
    target_table,
    target_record_id,
    action_name,
    previous_data,
    next_data,
    safe_actor_ip,
    nullif(trim(coalesce(actor_user_agent, '')), '')
  )
  returning id into log_id;

  return log_id;
end;
$$;

grant execute on function public.write_audit_log(text, uuid, text, jsonb, jsonb, text, text) to authenticated;
