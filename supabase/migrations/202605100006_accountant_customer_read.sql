update public.roles
set permissions = '[
  "admin:access",
  "products:manage",
  "inventory:manage",
  "orders:manage",
  "customers:read",
  "payments:read",
  "payments:manage",
  "invoices:read",
  "invoices:create",
  "invoices:manage",
  "fiscal:read",
  "crm:manage",
  "reports:read",
  "reports:export",
  "settings:manage",
  "audit:read"
]'::jsonb,
updated_at = now()
where name = 'admin';

update public.roles
set permissions = '[
  "admin:access",
  "orders:read",
  "customers:read",
  "payments:read",
  "invoices:read",
  "invoices:create",
  "fiscal:read",
  "reports:read",
  "reports:export"
]'::jsonb,
updated_at = now()
where name = 'contadora';

drop policy if exists "Staff can read customers" on public.customers;
create policy "Staff can read customers"
  on public.customers for select
  using (public.has_permission('customers:read') or public.has_permission('customers:manage'));
