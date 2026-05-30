update public.roles
set
  description = 'Technical owner. Control total de infraestructura, monitoreo, seguridad, usuarios y operación.',
  permissions = '[
    "admin:access",
    "system:monitoring",
    "settings:manage",
    "commercial_settings:manage",
    "users:manage",
    "users:read",
    "users:manage_operational",
    "roles:assign",
    "roles:assign_operational",
    "audit:read",
    "audit:read_operational",
    "user_activity:read_operational",
    "invoices:read",
    "invoices:correct",
    "invoices:manage",
    "reports:read",
    "reports:export"
  ]'::jsonb,
  updated_at = now()
where name = 'technical_owner';

update public.roles
set permissions = permissions || '[
  "users:read",
  "users:manage_operational",
  "roles:assign_operational",
  "audit:read_operational",
  "user_activity:read_operational"
]'::jsonb,
updated_at = now()
where name = 'admin';

update public.roles
set
  description = 'Dueño operativo. Administra operación, ventas, clientes, facturación, reportes y empleados operativos sin acceso técnico sensible.',
  permissions = (
    (permissions - 'users:manage' - 'roles:assign' - 'settings:manage' - 'system:monitoring')
    || '[
      "users:read",
      "users:manage_operational",
      "roles:assign_operational",
      "audit:read_operational",
      "user_activity:read_operational"
    ]'::jsonb
  ),
  updated_at = now()
where name = 'business_owner';

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
where lower(coalesce(email, '')) = 'car.zone.accesorioshn@gmail.com'
   or lower(coalesce(username, '')) = 'jleiva03';

drop function if exists public.change_user_role(uuid, text, text, text);
drop function if exists public.set_user_active(uuid, boolean, text, text);

create or replace function public.change_user_role(
  target_user_id uuid,
  target_role_name text,
  change_reason text default null,
  technical_confirmation text default null,
  actor_ip text default null,
  actor_user_agent text default null
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

  if not (
    (actor_record.permissions ? 'users:manage' or actor_record.permissions ? 'users:manage_operational')
    and (actor_record.permissions ? 'roles:assign' or actor_record.permissions ? 'roles:assign_operational')
  ) then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data, ip_address, user_agent)
    values (
      actor_record.id,
      actor_record.role_name,
      'users',
      target_user_id,
      'user.role_change_blocked',
      jsonb_build_object('result', 'blocked', 'reason', 'missing_permission', 'requested_role', normalized_target_role),
      nullif(actor_ip, '')::inet,
      nullif(actor_user_agent, '')
    );
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
      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
      values (
        actor_record.id,
        actor_record.role_name,
        'users',
        target_record.id,
        'user.role_change_blocked',
        jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
        jsonb_build_object('result', 'blocked', 'reason', 'role_not_allowed', 'requested_role', normalized_target_role),
        nullif(actor_ip, '')::inet,
        nullif(actor_user_agent, '')
      );
      raise exception 'No tienes permiso para asignar roles tecnicos.';
    end if;
  end if;

  if normalized_target_role = 'technical_owner'
     and actor_record.role_name <> 'technical_owner'
     and actor_record.email <> protected_technical_email then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
    values (
      actor_record.id,
      actor_record.role_name,
      'users',
      target_record.id,
      'user.role_change_blocked',
      jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
      jsonb_build_object('result', 'blocked', 'reason', 'technical_role_not_allowed', 'requested_role', normalized_target_role),
      nullif(actor_ip, '')::inet,
      nullif(actor_user_agent, '')
    );
    raise exception 'No tienes permiso para asignar roles tecnicos.';
  end if;

  if target_record.role_name in ('technical_owner', 'admin')
     or target_record.email = protected_technical_email then
    if not (actor_record.role_name = 'technical_owner' or actor_record.email = protected_technical_email) then
      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
      values (
        actor_record.id,
        actor_record.role_name,
        'users',
        target_record.id,
        'user.role_change_blocked',
        jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
        jsonb_build_object('result', 'blocked', 'reason', 'protected_technical_user', 'requested_role', normalized_target_role),
        nullif(actor_ip, '')::inet,
        nullif(actor_user_agent, '')
      );
      raise exception 'Este usuario esta protegido y solo puede ser modificado por el administrador tecnico.';
    end if;

    if technical_confirmation <> 'CONFIRMAR CAMBIO TECNICO' then
      raise exception 'La cuenta tecnica protegida requiere confirmacion especial.';
    end if;
  end if;

  if target_record.role_name in ('admin', 'business_owner')
     and normalized_target_role not in ('admin', 'business_owner', 'technical_owner') then
    operational_owner_count := public.count_active_operational_owners();
    if target_record.active = true and operational_owner_count <= 1 then
      raise exception 'No puedes degradar al ultimo administrador operativo.';
    end if;
  end if;

  update public.users
  set role_id = next_role_record.id, updated_at = now()
  where id = target_record.id;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
  values (
    actor_record.id,
    actor_record.role_name,
    'users',
    target_record.id,
    'user.role_changed',
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
    jsonb_build_object(
      'result', 'success',
      'email', target_record.email,
      'role', next_role_record.name,
      'role_before', target_record.role_name,
      'role_after', next_role_record.name,
      'reason', normalized_reason
    ),
    nullif(actor_ip, '')::inet,
    nullif(actor_user_agent, '')
  )
  returning id into log_id;

  return log_id;
end;
$$;

create or replace function public.set_user_active(
  target_user_id uuid,
  next_active boolean,
  change_reason text default null,
  technical_confirmation text default null,
  actor_ip text default null,
  actor_user_agent text default null
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

  if not (actor_record.permissions ? 'users:manage' or actor_record.permissions ? 'users:manage_operational') then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data, ip_address, user_agent)
    values (
      actor_record.id,
      actor_record.role_name,
      'users',
      target_user_id,
      case when next_active then 'user.reactivate_blocked' else 'user.suspend_blocked' end,
      jsonb_build_object('result', 'blocked', 'reason', 'missing_permission', 'requested_active', next_active),
      nullif(actor_ip, '')::inet,
      nullif(actor_user_agent, '')
    );
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
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
    values (
      actor_record.id,
      actor_record.role_name,
      'users',
      target_record.id,
      case when next_active then 'user.reactivate_blocked' else 'user.suspend_blocked' end,
      jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
      jsonb_build_object('result', 'blocked', 'reason', 'target_not_operational', 'requested_active', next_active),
      nullif(actor_ip, '')::inet,
      nullif(actor_user_agent, '')
    );
    raise exception 'Este usuario esta protegido y solo puede ser modificado por el administrador tecnico.';
  end if;

  if target_record.role_name in ('technical_owner', 'admin')
     or target_record.email = protected_technical_email then
    if not (actor_record.role_name = 'technical_owner' or actor_record.email = protected_technical_email) then
      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
      values (
        actor_record.id,
        actor_record.role_name,
        'users',
        target_record.id,
        case when next_active then 'user.reactivate_blocked' else 'user.suspend_blocked' end,
        jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
        jsonb_build_object('result', 'blocked', 'reason', 'protected_technical_user', 'requested_active', next_active),
        nullif(actor_ip, '')::inet,
        nullif(actor_user_agent, '')
      );
      raise exception 'Este usuario esta protegido y solo puede ser modificado por el administrador tecnico.';
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

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
  values (
    actor_record.id,
    actor_record.role_name,
    'users',
    target_record.id,
    case when next_active then 'user.reactivated' else 'user.suspended' end,
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
    jsonb_build_object(
      'result', 'success',
      'email', target_record.email,
      'role', target_record.role_name,
      'active', next_active,
      'reason', normalized_reason
    ),
    nullif(actor_ip, '')::inet,
    nullif(actor_user_agent, '')
  )
  returning id into log_id;

  return log_id;
end;
$$;

revoke all on function public.change_user_role(uuid, text, text, text, text, text) from public;
revoke all on function public.set_user_active(uuid, boolean, text, text, text, text) from public;
grant execute on function public.change_user_role(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.set_user_active(uuid, boolean, text, text, text, text) to authenticated;
