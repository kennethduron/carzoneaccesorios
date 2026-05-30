-- Make technical_owner the global superuser role and keep business_owner operational only.

update public.roles
set
  description = 'Superusuario tecnico del sistema. Acceso total a operacion, administracion, seguridad, monitoreo e infraestructura.',
  permissions = '[
    "admin:access",
    "products:read",
    "products:manage",
    "inventory:manage",
    "orders:read",
    "orders:manage",
    "customers:read",
    "customers:manage",
    "payments:read",
    "payments:manage",
    "invoices:read",
    "invoices:create",
    "invoices:correct",
    "invoices:manage",
    "fiscal:read",
    "reports:export",
    "shipments:manage",
    "crm:manage",
    "reports:read",
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
    "system:monitoring",
    "store:buy",
    "orders:read_own",
    "invoices:read_own"
  ]'::jsonb,
  updated_at = now()
where name = 'technical_owner';

update public.roles
set
  description = 'Dueno operativo. Administra operacion, ventas, clientes, facturacion, reportes y empleados operativos sin acceso tecnico sensible.',
  permissions = '[
    "admin:access",
    "products:manage",
    "inventory:manage",
    "orders:manage",
    "customers:read",
    "customers:manage",
    "payments:read",
    "payments:manage",
    "invoices:read",
    "invoices:create",
    "invoices:correct",
    "invoices:manage",
    "fiscal:read",
    "crm:manage",
    "reports:read",
    "reports:export",
    "users:read",
    "users:manage_operational",
    "roles:assign_operational",
    "audit:read",
    "audit:read_operational",
    "user_activity:read_operational",
    "commercial_settings:manage"
  ]'::jsonb,
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

create or replace function public.is_admin()
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
        roles.name in ('admin', 'technical_owner')
        or lower(coalesce(users.email, '')) = 'kennethduron.paz@gmail.com'
      )
  );
$$;

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
        roles.name in ('admin', 'technical_owner')
        or lower(coalesce(users.email, '')) = 'kennethduron.paz@gmail.com'
        or roles.permissions ? permission_key
      )
  );
$$;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_permission(text) to authenticated;
