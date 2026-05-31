-- Apply the final CRM/admin hierarchy with explicit permissions and protected owners.

update public.roles
set description = 'Superusuario tecnico protegido. Acceso total a operacion, seguridad e infraestructura.',
    permissions = '["admin:access","products:read","products:manage","inventory:manage","orders:read","orders:manage","orders:manage_logistics","customers:read","customers:manage","wholesale:manage","payments:read","payments:manage","invoices:read","invoices:create","invoices:correct","invoices:manage","fiscal:read","reports:export","shipments:manage","crm:manage","reports:read","settings:manage","commercial_settings:manage","settings:fiscal","security:read","security:manage","users:manage","users:read","users:create","users:manage_operational","roles:assign","roles:assign_admin","roles:assign_operational","audit:read","audit:read_operational","user_activity:read_operational","system:monitoring","system:backups","technical:tools","store:buy","orders:read_own","invoices:read_own"]'::jsonb,
    updated_at = now()
where name = 'technical_owner';

update public.roles
set description = 'Dueno operativo. Gestiona el negocio, admins y empleados sin acceso tecnico sensible.',
    permissions = '["admin:access","products:manage","inventory:manage","orders:manage","customers:read","customers:manage","wholesale:manage","payments:read","payments:manage","invoices:read","invoices:create","invoices:correct","invoices:manage","fiscal:read","settings:fiscal","crm:manage","reports:read","reports:export","shipments:manage","users:read","users:create","users:manage_operational","roles:assign_admin","roles:assign_operational","audit:read_operational","user_activity:read_operational","commercial_settings:manage","security:read","security:manage"]'::jsonb,
    updated_at = now()
where name = 'business_owner';

update public.roles
set description = 'Gerente delegado. Opera el negocio y administra accesos operativos sin herramientas tecnicas.',
    permissions = '["admin:access","products:manage","inventory:manage","orders:manage","customers:read","customers:manage","wholesale:manage","payments:read","payments:manage","invoices:read","invoices:create","invoices:correct","invoices:manage","fiscal:read","settings:fiscal","crm:manage","reports:read","reports:export","shipments:manage","users:read","users:create","users:manage_operational","roles:assign_operational","audit:read_operational","user_activity:read_operational","commercial_settings:manage","security:read","security:manage"]'::jsonb,
    updated_at = now()
where name = 'admin';

update public.roles set permissions = '["admin:access","products:read","orders:read","customers:read","customers:manage","crm:manage"]'::jsonb, updated_at = now() where name = 'vendedor';
update public.roles set permissions = '["admin:access","products:read","inventory:manage","shipments:manage","orders:read","orders:manage_logistics"]'::jsonb, updated_at = now() where name = 'bodega';
update public.roles set permissions = '["admin:access","orders:read","customers:read","payments:read","payments:manage","invoices:read","invoices:create","invoices:correct","invoices:manage","fiscal:read","settings:fiscal","reports:read","reports:export"]'::jsonb, updated_at = now() where name = 'contadora';
update public.roles set permissions = '["admin:access","customers:read","crm:manage","orders:read","invoices:read"]'::jsonb, updated_at = now() where name = 'soporte';
update public.roles set permissions = '["store:buy","orders:read_own","invoices:read_own"]'::jsonb, updated_at = now() where name = 'cliente';

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    active = true,
    updated_at = now()
where lower(coalesce(email, '')) = 'kennethduron.paz@gmail.com';

update public.users
set role_id = (select id from public.roles where name = 'business_owner'),
    active = true,
    updated_at = now()
where lower(coalesce(email, '')) = 'car.zone.accesorioshn@gmail.com'
   or lower(coalesce(username, '')) = 'jleiva03';

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
        roles.name = 'technical_owner'
        or lower(coalesce(users.email, '')) = 'kennethduron.paz@gmail.com'
        or coalesce(roles.permissions, '[]'::jsonb) ? permission_key
      )
  );
$$;

grant execute on function public.has_permission(text) to authenticated;

drop policy if exists "Public can read roles" on public.roles;
drop policy if exists "Authenticated users can read roles" on public.roles;
create policy "Authenticated users can read roles"
  on public.roles for select
  using (auth.uid() is not null);

drop policy if exists "Admins can manage roles" on public.roles;
drop policy if exists "Technical owner can manage roles" on public.roles;
create policy "Technical owner can manage roles"
  on public.roles for all
  using (public.has_permission('roles:assign'))
  with check (public.has_permission('roles:assign'));

drop policy if exists "Admins can manage users" on public.users;
drop policy if exists "Authorized staff can manage users" on public.users;
drop policy if exists "Technical owner can manage users directly" on public.users;
create policy "Technical owner can manage users directly"
  on public.users for all
  using (public.has_permission('users:manage'))
  with check (public.has_permission('users:manage'));

drop policy if exists "Admins can read backup logs" on public.backup_logs;
drop policy if exists "Admins can create backup logs" on public.backup_logs;
drop policy if exists "Admins can update backup logs" on public.backup_logs;
create policy "Technical owner can read backup logs"
  on public.backup_logs for select
  using (public.has_permission('system:backups'));
create policy "Technical owner can create backup logs"
  on public.backup_logs for insert
  with check (public.has_permission('system:backups'));
create policy "Technical owner can update backup logs"
  on public.backup_logs for update
  using (public.has_permission('system:backups'))
  with check (public.has_permission('system:backups'));

drop policy if exists "Staff can read fiscal settings" on public.fiscal_settings;
create policy "Staff can read fiscal settings"
  on public.fiscal_settings for select
  using (
    public.has_permission('settings:fiscal')
    or public.has_permission('fiscal:read')
    or public.has_permission('invoices:read')
    or public.has_permission('reports:read')
  );

drop policy if exists "Admins can manage fiscal settings" on public.fiscal_settings;
create policy "Authorized staff can manage fiscal settings"
  on public.fiscal_settings for all
  using (public.has_permission('settings:fiscal'))
  with check (public.has_permission('settings:fiscal'));

create or replace function public.write_security_user_audit(
  actor_user_id uuid,
  actor_role_name text,
  target_user_id uuid,
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
  safe_ip inet;
begin
  begin
    safe_ip := nullif(trim(coalesce(actor_ip, '')), '')::inet;
  exception when others then
    safe_ip := null;
  end;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data, ip_address, user_agent)
  values (actor_user_id, actor_role_name, 'users', target_user_id, action_name, previous_data, next_data, safe_ip, nullif(actor_user_agent, ''))
  returning id into log_id;

  return log_id;
end;
$$;

revoke all on function public.write_security_user_audit(uuid, text, uuid, text, jsonb, jsonb, text, text) from public;
revoke all on function public.write_security_user_audit(uuid, text, uuid, text, jsonb, jsonb, text, text) from authenticated;

create or replace function public.security_user_block_message(
  actor_user_id uuid,
  actor_role_name text,
  actor_email text,
  target_user_id uuid,
  target_role_name text,
  target_email text,
  next_role_name text default null
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  protected_technical_email constant text := 'kennethduron.paz@gmail.com';
  actor_is_technical boolean := actor_role_name = 'technical_owner' or lower(coalesce(actor_email, '')) = protected_technical_email;
begin
  if actor_user_id = target_user_id then
    return 'No puedes modificar tu propia cuenta.';
  end if;

  if actor_is_technical then
    return null;
  end if;

  if target_role_name = 'technical_owner' or lower(coalesce(target_email, '')) = protected_technical_email then
    return 'Este usuario tecnico esta protegido.';
  end if;

  if target_role_name = 'business_owner' then
    return 'No puedes modificar al dueno operativo.';
  end if;

  if actor_role_name = 'business_owner' then
    if target_role_name not in ('admin', 'vendedor', 'bodega', 'contadora', 'soporte', 'cliente') then
      return 'Solo usuarios autorizados pueden realizar esta accion.';
    end if;
    if next_role_name is not null and next_role_name not in ('admin', 'vendedor', 'bodega', 'contadora', 'soporte', 'cliente') then
      return 'No puedes asignar ese rol.';
    end if;
    return null;
  end if;

  if actor_role_name = 'admin' then
    if target_role_name not in ('vendedor', 'bodega', 'contadora', 'soporte', 'cliente') then
      return 'Solo puedes modificar usuarios operativos.';
    end if;
    if next_role_name is not null and next_role_name not in ('vendedor', 'bodega', 'contadora', 'soporte', 'cliente') then
      return 'No puedes asignar ese rol.';
    end if;
    return null;
  end if;

  return 'Solo usuarios autorizados pueden realizar esta accion.';
end;
$$;

revoke all on function public.security_user_block_message(uuid, text, text, uuid, text, text, text) from public;
revoke all on function public.security_user_block_message(uuid, text, text, uuid, text, text, text) from authenticated;

drop function if exists public.change_user_role(uuid, text, text, text, text, text);
create function public.change_user_role(
  target_user_id uuid,
  target_role_name text,
  change_reason text default null,
  technical_confirmation text default null,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_record record;
  target_record record;
  next_role_record record;
  log_id uuid;
  block_message text;
  normalized_target_role text := lower(trim(coalesce(target_role_name, '')));
  normalized_reason text := nullif(trim(coalesce(change_reason, '')), '');
  operational_owner_count integer;
  actor_is_technical boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select users.id, lower(coalesce(users.email, '')) as email, roles.name as role_name, roles.permissions
  into actor_record
  from public.users join public.roles on roles.id = users.role_id
  where users.id = auth.uid() and users.active = true;
  if actor_record.id is null then raise exception 'Authentication required'; end if;

  actor_is_technical := actor_record.role_name = 'technical_owner' or actor_record.email = 'kennethduron.paz@gmail.com';

  select users.id, lower(coalesce(users.email, '')) as email, users.active, roles.name as role_name
  into target_record
  from public.users left join public.roles on roles.id = users.role_id
  where users.id = target_user_id;
  if target_record.id is null then raise exception 'Usuario no encontrado.'; end if;

  select id, name into next_role_record from public.roles where name = normalized_target_role;
  if next_role_record.id is null then
    block_message := 'El rol seleccionado no existe.';
  elsif not actor_is_technical and not (
    coalesce(actor_record.permissions, '[]'::jsonb) ? 'security:manage'
    and coalesce(actor_record.permissions, '[]'::jsonb) ? 'users:manage_operational'
  ) then
    block_message := 'Solo usuarios autorizados pueden realizar esta accion.';
  elsif not actor_is_technical
    and normalized_target_role = 'admin'
    and not (coalesce(actor_record.permissions, '[]'::jsonb) ? 'roles:assign_admin') then
    block_message := 'No puedes asignar ese rol.';
  elsif not actor_is_technical
    and normalized_target_role <> 'admin'
    and not (coalesce(actor_record.permissions, '[]'::jsonb) ? 'roles:assign_operational') then
    block_message := 'No puedes asignar ese rol.';
  else
    block_message := public.security_user_block_message(
      actor_record.id, actor_record.role_name, actor_record.email,
      target_record.id, target_record.role_name, target_record.email, normalized_target_role
    );
  end if;

  if block_message is not null then
    log_id := public.write_security_user_audit(
      actor_record.id, actor_record.role_name, target_record.id, 'user.role_change_blocked',
      jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
      jsonb_build_object('result', 'blocked', 'message', block_message, 'requested_role', normalized_target_role),
      actor_ip, actor_user_agent
    );
    return jsonb_build_object('ok', false, 'message', block_message, 'log_id', log_id);
  end if;

  if actor_is_technical
     and (target_record.role_name = 'technical_owner' or target_record.email = 'kennethduron.paz@gmail.com' or normalized_target_role = 'technical_owner')
     and technical_confirmation <> 'CONFIRMAR CAMBIO TECNICO' then
    block_message := 'Confirma expresamente el cambio del usuario tecnico.';
    log_id := public.write_security_user_audit(
      actor_record.id, actor_record.role_name, target_record.id, 'user.role_change_blocked',
      jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
      jsonb_build_object('result', 'blocked', 'message', block_message, 'requested_role', normalized_target_role),
      actor_ip, actor_user_agent
    );
    return jsonb_build_object('ok', false, 'message', block_message, 'log_id', log_id);
  end if;

  if target_record.role_name in ('admin', 'business_owner') and normalized_target_role not in ('admin', 'business_owner', 'technical_owner') then
    operational_owner_count := public.count_active_operational_owners();
    if target_record.active = true and operational_owner_count <= 1 then
      return jsonb_build_object('ok', false, 'message', 'No puedes degradar al ultimo administrador operativo.');
    end if;
  end if;

  update public.users set role_id = next_role_record.id, updated_at = now() where id = target_record.id;
  log_id := public.write_security_user_audit(
    actor_record.id, actor_record.role_name, target_record.id, 'user.role_changed',
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
    jsonb_build_object('result', 'success', 'email', target_record.email, 'role_before', target_record.role_name, 'role_after', next_role_record.name, 'reason', normalized_reason),
    actor_ip, actor_user_agent
  );
  return jsonb_build_object('ok', true, 'message', 'Rol actualizado.', 'log_id', log_id);
end;
$$;

grant execute on function public.change_user_role(uuid, text, text, text, text, text) to authenticated;

drop function if exists public.set_user_active(uuid, boolean, text, text, text, text);
create function public.set_user_active(
  target_user_id uuid,
  next_active boolean,
  change_reason text default null,
  technical_confirmation text default null,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_record record;
  target_record record;
  log_id uuid;
  block_message text;
  normalized_reason text := nullif(trim(coalesce(change_reason, '')), '');
  operational_owner_count integer;
  actor_is_technical boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select users.id, lower(coalesce(users.email, '')) as email, roles.name as role_name, roles.permissions
  into actor_record
  from public.users join public.roles on roles.id = users.role_id
  where users.id = auth.uid() and users.active = true;
  if actor_record.id is null then raise exception 'Authentication required'; end if;

  actor_is_technical := actor_record.role_name = 'technical_owner' or actor_record.email = 'kennethduron.paz@gmail.com';

  select users.id, lower(coalesce(users.email, '')) as email, users.active, roles.name as role_name
  into target_record
  from public.users left join public.roles on roles.id = users.role_id
  where users.id = target_user_id;
  if target_record.id is null then raise exception 'Usuario no encontrado.'; end if;

  if not actor_is_technical and not (
    coalesce(actor_record.permissions, '[]'::jsonb) ? 'security:manage'
    and coalesce(actor_record.permissions, '[]'::jsonb) ? 'users:manage_operational'
  ) then
    block_message := 'Solo usuarios autorizados pueden realizar esta accion.';
  else
    block_message := public.security_user_block_message(
      actor_record.id, actor_record.role_name, actor_record.email,
      target_record.id, target_record.role_name, target_record.email, null
    );
  end if;

  if block_message is not null then
    log_id := public.write_security_user_audit(
      actor_record.id, actor_record.role_name, target_record.id,
      case when next_active then 'user.reactivate_blocked' else 'user.suspend_blocked' end,
      jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
      jsonb_build_object('result', 'blocked', 'message', block_message, 'requested_active', next_active),
      actor_ip, actor_user_agent
    );
    return jsonb_build_object('ok', false, 'message', block_message, 'log_id', log_id);
  end if;

  if actor_is_technical
     and (target_record.role_name = 'technical_owner' or target_record.email = 'kennethduron.paz@gmail.com')
     and technical_confirmation <> 'CONFIRMAR CAMBIO TECNICO' then
    block_message := 'Confirma expresamente el cambio del usuario tecnico.';
    log_id := public.write_security_user_audit(
      actor_record.id, actor_record.role_name, target_record.id,
      case when next_active then 'user.reactivate_blocked' else 'user.suspend_blocked' end,
      jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
      jsonb_build_object('result', 'blocked', 'message', block_message, 'requested_active', next_active),
      actor_ip, actor_user_agent
    );
    return jsonb_build_object('ok', false, 'message', block_message, 'log_id', log_id);
  end if;

  if target_record.active = true and next_active = false and target_record.role_name in ('admin', 'business_owner') then
    operational_owner_count := public.count_active_operational_owners();
    if operational_owner_count <= 1 then
      return jsonb_build_object('ok', false, 'message', 'No puedes suspender al ultimo administrador operativo.');
    end if;
  end if;

  update public.users set active = next_active, updated_at = now() where id = target_record.id;
  log_id := public.write_security_user_audit(
    actor_record.id, actor_record.role_name, target_record.id,
    case when next_active then 'user.reactivated' else 'user.suspended' end,
    jsonb_build_object('email', target_record.email, 'role', target_record.role_name, 'active', target_record.active),
    jsonb_build_object('result', 'success', 'email', target_record.email, 'role', target_record.role_name, 'active', next_active, 'reason', normalized_reason),
    actor_ip, actor_user_agent
  );
  return jsonb_build_object('ok', true, 'message', case when next_active then 'Usuario reactivado.' else 'Usuario suspendido.' end, 'log_id', log_id);
end;
$$;

grant execute on function public.set_user_active(uuid, boolean, text, text, text, text) to authenticated;

create or replace function public.advance_order_logistics(target_order_id uuid, target_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  next_status text := lower(trim(coalesce(target_status, '')));
begin
  if auth.uid() is null or not public.has_permission('orders:manage_logistics') then
    raise exception 'Solo usuarios autorizados pueden realizar esta accion.';
  end if;

  select case lower(coalesce(status, ''))
    when 'confirmed' then 'confirmado' when 'paid' then 'confirmado'
    when 'preparing' then 'preparacion' when 'shipped' then 'enviado'
    when 'delivered' then 'entregado' else lower(coalesce(status, ''))
  end
  into current_status
  from public.orders
  where id = target_order_id
  for update;

  if current_status is null then raise exception 'Pedido no encontrado.'; end if;

  if not (
    (current_status = 'confirmado' and next_status = 'preparacion')
    or (current_status = 'preparacion' and next_status = 'empacado')
    or (current_status = 'empacado' and next_status = 'enviado')
    or (current_status = 'enviado' and next_status = 'en_ruta')
    or (current_status = 'en_ruta' and next_status = 'entregado')
  ) then
    raise exception 'Solo puedes avanzar el siguiente paso logistico permitido.';
  end if;

  update public.orders
  set status = next_status, tracking_status = next_status, updated_at = now()
  where id = target_order_id;
  return true;
end;
$$;

grant execute on function public.advance_order_logistics(uuid, text) to authenticated;
