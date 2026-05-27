insert into public.roles (name, description, permissions)
values (
  'soporte',
  'Soporte operativo. Atiende consultas, revisa clientes, pedidos y seguimiento CRM sin permisos administrativos sensibles.',
  '["admin:access","customers:read","crm:manage","orders:read","invoices:read"]'::jsonb
)
on conflict (name) do update
set
  description = excluded.description,
  permissions = excluded.permissions,
  updated_at = now();

create or replace function public.change_user_role(
  target_user_id uuid,
  target_role_name text,
  change_reason text default null,
  technical_confirmation text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_record record;
  target_record record;
  next_role_record record;
  log_id uuid;
  normalized_target_role text := lower(trim(coalesce(target_role_name, '')));
  normalized_reason text := nullif(trim(coalesce(change_reason, '')), '');
  operational_owner_count integer;
  protected_technical_email constant text := 'kennethduron.paz@gmail.com';
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select users.id, lower(coalesce(users.email, '')) as email, users.active, roles.name as role_name, roles.permissions
  into actor_record
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = auth.uid()
    and users.active = true;

  if actor_record.id is null then
    raise exception 'Authentication required';
  end if;

  if not (actor_record.permissions ? 'users:manage' and actor_record.permissions ? 'roles:assign') then
    raise exception 'No tienes autorizacion para asignar roles.';
  end if;

  select users.id, users.full_name, lower(coalesce(users.email, '')) as email, users.active, users.role_id, roles.name as role_name
  into target_record
  from public.users
  left join public.roles on roles.id = users.role_id
  where users.id = target_user_id;

  if target_record.id is null then
    raise exception 'Usuario no encontrado.';
  end if;

  select id, name, permissions
  into next_role_record
  from public.roles
  where name = normalized_target_role;

  if next_role_record.id is null then
    raise exception 'Rol no valido.';
  end if;

  if actor_record.role_name = 'business_owner' then
    if target_record.role_name not in ('cliente', 'vendedor', 'bodega', 'contadora', 'soporte')
       or normalized_target_role not in ('cliente', 'vendedor', 'bodega', 'contadora', 'soporte') then
      raise exception 'No tienes autorizacion para asignar este rol.';
    end if;
  end if;

  if normalized_target_role = 'technical_owner' and actor_record.role_name <> 'technical_owner' then
    raise exception 'No tienes autorizacion para asignar este rol.';
  end if;

  if target_record.role_name = 'technical_owner'
     or target_record.email = protected_technical_email then
    if not (actor_record.permissions ? 'system:monitoring') then
      raise exception 'No tienes autorizacion para modificar usuarios tecnicos.';
    end if;

    if technical_confirmation <> 'CONFIRMAR CAMBIO TECNICO' then
      raise exception 'La cuenta tecnica protegida requiere confirmacion especial.';
    end if;
  end if;

  if target_record.role_name in ('admin', 'business_owner')
     and normalized_target_role not in ('admin', 'business_owner') then
    operational_owner_count := public.count_active_operational_owners();
    if target_record.active = true and operational_owner_count <= 1 then
      raise exception 'No puedes degradar al ultimo administrador operativo.';
    end if;
  end if;

  update public.users
  set role_id = next_role_record.id, updated_at = now()
  where id = target_record.id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_record.id,
    actor_record.role_name,
    'users',
    target_record.id,
    'user.role_changed',
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
    jsonb_build_object('email', target_record.email, 'role', next_role_record.name, 'reason', normalized_reason)
  )
  returning id into log_id;

  return log_id;
end;
$$;

create or replace function public.set_user_active(
  target_user_id uuid,
  next_active boolean,
  change_reason text default null,
  technical_confirmation text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_record record;
  target_record record;
  log_id uuid;
  normalized_reason text := nullif(trim(coalesce(change_reason, '')), '');
  operational_owner_count integer;
  protected_technical_email constant text := 'kennethduron.paz@gmail.com';
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select users.id, lower(coalesce(users.email, '')) as email, users.active, roles.name as role_name, roles.permissions
  into actor_record
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = auth.uid()
    and users.active = true;

  if actor_record.id is null then
    raise exception 'Authentication required';
  end if;

  if not (actor_record.permissions ? 'users:manage') then
    raise exception 'No tienes autorizacion para modificar usuarios.';
  end if;

  select users.id, users.full_name, lower(coalesce(users.email, '')) as email, users.active, roles.name as role_name
  into target_record
  from public.users
  left join public.roles on roles.id = users.role_id
  where users.id = target_user_id;

  if target_record.id is null then
    raise exception 'Usuario no encontrado.';
  end if;

  if target_record.id = actor_record.id and next_active = false then
    raise exception 'No puedes suspender tu propia cuenta.';
  end if;

  if actor_record.role_name = 'business_owner'
     and target_record.role_name not in ('cliente', 'vendedor', 'bodega', 'contadora', 'soporte') then
    raise exception 'No tienes autorizacion para modificar este usuario.';
  end if;

  if target_record.role_name = 'technical_owner'
     or target_record.email = protected_technical_email then
    if not (actor_record.permissions ? 'system:monitoring') then
      raise exception 'No tienes autorizacion para modificar usuarios tecnicos.';
    end if;

    if technical_confirmation <> 'CONFIRMAR CAMBIO TECNICO' then
      raise exception 'La cuenta tecnica protegida requiere confirmacion especial.';
    end if;
  end if;

  if target_record.active = true
     and next_active = false
     and target_record.role_name in ('admin', 'business_owner') then
    operational_owner_count := public.count_active_operational_owners();
    if operational_owner_count <= 1 then
      raise exception 'No puedes suspender al ultimo administrador operativo.';
    end if;
  end if;

  update public.users
  set active = next_active, updated_at = now()
  where id = target_record.id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_record.id,
    actor_record.role_name,
    'users',
    target_record.id,
    case when next_active then 'user.reactivated' else 'user.suspended' end,
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', next_active, 'reason', normalized_reason)
  )
  returning id into log_id;

  return log_id;
end;
$$;

revoke all on function public.change_user_role(uuid, text, text, text) from public;
revoke all on function public.set_user_active(uuid, boolean, text, text) from public;
grant execute on function public.change_user_role(uuid, text, text, text) to authenticated;
grant execute on function public.set_user_active(uuid, boolean, text, text) to authenticated;
