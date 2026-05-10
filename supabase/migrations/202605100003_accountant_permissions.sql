update public.roles
set permissions = '[
  "admin:access",
  "products:manage",
  "inventory:manage",
  "orders:manage",
  "payments:read",
  "payments:manage",
  "invoices:read",
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
set
  description = 'Revisa facturas fiscales, referencias bancarias, rangos fiscales, ISV y reportes contables.',
  permissions = '[
    "admin:access",
    "orders:read",
    "payments:read",
    "invoices:read",
    "fiscal:read",
    "reports:read",
    "reports:export"
  ]'::jsonb,
  updated_at = now()
where name = 'contadora';

drop policy if exists "Staff can read payments" on public.payments;
create policy "Staff can read payments"
  on public.payments for select
  using (public.has_permission('payments:read') or public.has_permission('payments:manage'));

drop policy if exists "Staff can read invoices" on public.invoices;
create policy "Staff can read invoices"
  on public.invoices for select
  using (public.has_permission('invoices:read') or public.has_permission('invoices:manage'));

drop policy if exists "Staff can read invoice items" on public.invoice_items;
create policy "Staff can read invoice items"
  on public.invoice_items for select
  using (
    public.has_permission('invoices:read')
    or public.has_permission('invoices:manage')
    or exists (
      select 1
      from public.invoices
      join public.orders on orders.id = invoices.order_id
      where invoices.id = invoice_items.invoice_id
        and orders.user_id = auth.uid()
    )
  );

drop policy if exists "Staff can read fiscal settings" on public.fiscal_settings;
create policy "Staff can read fiscal settings"
  on public.fiscal_settings for select
  using (
    public.has_permission('fiscal:read')
    or public.has_permission('invoices:read')
    or public.has_permission('invoices:manage')
    or public.has_permission('reports:read')
    or public.has_permission('settings:manage')
  );

drop policy if exists "Admins can manage fiscal settings" on public.fiscal_settings;
create policy "Admins can manage fiscal settings"
  on public.fiscal_settings for all
  using (public.has_permission('settings:manage'))
  with check (public.has_permission('settings:manage'));
