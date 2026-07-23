insert into public.roles (name, description, permissions)
values
  (
    'technical_owner',
    'Superusuario tecnico del sistema. Acceso total a operacion, administracion, seguridad, monitoreo e infraestructura.',
    '["admin:access","products:read","products:manage","inventory:manage","orders:read","orders:manage","customers:read","customers:manage","payments:read","payments:manage","invoices:read","invoices:create","invoices:correct","invoices:manage","fiscal:read","reports:export","shipments:manage","crm:manage","reports:read","settings:manage","commercial_settings:manage","users:manage","users:read","users:manage_operational","roles:assign","roles:assign_operational","audit:read","audit:read_operational","user_activity:read_operational","system:monitoring","store:buy","orders:read_own","invoices:read_own"]'::jsonb
  ),
  (
    'admin',
    'Acceso completo al panel administrativo.',
    '["admin:access","products:manage","inventory:manage","orders:manage","customers:read","payments:read","payments:manage","invoices:read","invoices:create","invoices:manage","fiscal:read","crm:manage","reports:read","reports:export","settings:manage","audit:read","system:monitoring","users:manage","roles:assign","commercial_settings:manage"]'::jsonb
  ),
  (
    'business_owner',
    'Dueno operativo del negocio. Administra operacion, equipo, clientes, inventario, pedidos, facturas y reportes sin acceso tecnico critico.',
    '["admin:access","products:manage","inventory:manage","orders:manage","customers:read","customers:manage","payments:read","payments:manage","invoices:read","invoices:create","invoices:correct","invoices:manage","fiscal:read","crm:manage","reports:read","reports:export","users:read","users:manage_operational","roles:assign_operational","audit:read","audit:read_operational","user_activity:read_operational","commercial_settings:manage"]'::jsonb
  ),
  (
    'vendedor',
    'Gestiona clientes, cotizaciones, pedidos y seguimiento comercial.',
    '["admin:access","products:read","orders:manage","customers:manage","crm:manage"]'::jsonb
  ),
  (
    'bodega',
    'Gestiona inventario, existencias y despacho.',
    '["admin:access","products:read","inventory:manage","shipments:manage","orders:read"]'::jsonb
  ),
  (
    'contadora',
    'Revisa facturas fiscales, referencias bancarias, rangos fiscales, ISV y reportes contables.',
    '["customers:link_portal_account","admin:access","products:read","products:create","products:update","products:import","products:images_manage","products:export","products:adjust_stock","inventory:read","notifications:read","invoices:read","invoices:export","fiscal:read","fiscal:reports","settings:fiscal","tax:read","tax:export","reports:fiscal_read","reports:fiscal_export","credit:read","credit:mark_paid","receivables:read","receivables:export","receivables:import","receivables:apply","receivables:assign","receivables:review","suppliers:read","suppliers:manage","purchases:read","purchases:manage","payables:read","payables:manage","payables:import","payables:apply","payables:assign","payables:review","accounting:read","accounting:create","accounting:edit_draft_entries","accounting:post","accounting:manage","accounting:reverse","accounting:export","accounting:settings","accounting:close_period","accounting:reopen_period","accounting:view_reports"]'::jsonb
  ),
  (
    'cliente',
    'Cliente de tienda con acceso a pedidos propios.',
    '["store:buy","orders:read_own","invoices:read_own"]'::jsonb
  )
on conflict (name) do update
set
  description = excluded.description,
  permissions = excluded.permissions;

update public.roles
set permissions = coalesce(permissions, '[]'::jsonb)
  || '["customers:link_portal_account","customers:update_identity"]'::jsonb
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles set permissions = permissions - 'customers:update_identity'
where name in ('contadora', 'vendedor', 'bodega', 'soporte', 'cliente');

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb) || '["accounting:edit_draft_entries"]'::jsonb) permission(permission)
)
where name in ('technical_owner', 'business_owner', 'admin', 'contadora');

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(
    coalesce(public.roles.permissions, '[]'::jsonb)
    || jsonb_build_array('pos:create_sale', 'pos:apply_discount')
  ) permission(permission)
)
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = (coalesce(permissions, '[]'::jsonb) - 'pos:create_sale') - 'pos:apply_discount'
where name in ('contadora', 'vendedor', 'bodega', 'soporte', 'cliente');

insert into public.company_settings (
  company_name,
  tax_id,
  email,
  phone,
  address,
  currency,
  tax_rate,
  invoice_prefix,
  order_prefix
)
values (
  'Car Zone Accesorios',
  null,
  'ventas@carzoneaccesorios.com',
  '+504 0000-0000',
  'Honduras',
  'HNL',
  0.1500,
  'CZ-F',
  'CZ'
);

insert into public.categories (name, slug, sort_order)
values
  ('Exterior', 'exterior', 10),
  ('Interior', 'interior', 20),
  ('Iluminación', 'iluminacion', 30),
  ('Polarizado y Herramientas', 'polarizado-y-herramientas', 40),
  ('Carrocería', 'carroceria', 50),
  ('Seguridad', 'seguridad', 60),
  ('Audio y Sonido', 'audio-y-sonido', 70)
on conflict (slug) do update
set
  name = excluded.name,
  sort_order = excluded.sort_order;

insert into public.customers (
  business_name,
  contact_name,
  email,
  phone,
  address,
  city,
  is_wholesale,
  wholesale_status,
  status,
  active
)
select
  'Auto Repuestos Lopez',
  'Auto Repuestos Lopez',
  'compras@autorepuestoslopez.com',
  '+504 0000-0001',
  'Honduras',
  'Tegucigalpa',
  true,
  'approved',
  'pending_account',
  true
where not exists (
  select 1
  from public.customers
  where business_name = 'Auto Repuestos Lopez'
);

insert into public.products (
  category_id,
  sku,
  internal_code,
  slug,
  name,
  brand,
  description,
  stock,
  low_stock_threshold,
  min_stock,
  cost_price,
  retail_price,
  wholesale_price,
  wholesale_min_quantity,
  status,
  active
)
values
  (
    (select id from public.categories where slug = 'iluminacion'),
    'CZ-LED-9005',
    'INT-LED-9005',
    'luces-led-9005-probeam',
    'Luces LED 9005 ProBeam',
    'ProBeam',
    'Kit LED de alta intensidad para faros principales.',
    42,
    8,
    8,
    980,
    1850,
    1390,
    6,
    'active',
    true
  ),
  (
    (select id from public.categories where slug = 'seguridad'),
    'CZ-CAM-HD',
    'INT-CAM-HD',
    'camara-reversa-hd',
    'Camara de reversa HD',
    'DriveSafe',
    'Camara de reversa resistente al agua con vision nocturna.',
    28,
    6,
    6,
    760,
    1450,
    1125,
    4,
    'active',
    true
  )
on conflict (sku) do update
set
  category_id = excluded.category_id,
  internal_code = excluded.internal_code,
  slug = excluded.slug,
  name = excluded.name,
  brand = excluded.brand,
  description = excluded.description,
  stock = excluded.stock,
  low_stock_threshold = excluded.low_stock_threshold,
  min_stock = excluded.min_stock,
  cost_price = excluded.cost_price,
  retail_price = excluded.retail_price,
  wholesale_price = excluded.wholesale_price,
  wholesale_min_quantity = excluded.wholesale_min_quantity,
  status = excluded.status,
  active = excluded.active;
