update public.roles
set permissions = '[
  "admin:access",
  "products:manage",
  "inventory:manage",
  "orders:manage",
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
  "payments:read",
  "invoices:read",
  "invoices:create",
  "fiscal:read",
  "reports:read",
  "reports:export"
]'::jsonb,
updated_at = now()
where name = 'contadora';

drop policy if exists "Staff can create invoices" on public.invoices;
create policy "Staff can create invoices"
  on public.invoices for insert
  with check (public.has_permission('invoices:create') or public.has_permission('invoices:manage'));

drop policy if exists "Staff can create invoice items" on public.invoice_items;
create policy "Staff can create invoice items"
  on public.invoice_items for insert
  with check (public.has_permission('invoices:create') or public.has_permission('invoices:manage'));
