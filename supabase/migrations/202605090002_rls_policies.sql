alter table public.roles enable row level security;
alter table public.users enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.categories enable row level security;
alter table public.product_images enable row level security;
alter table public.wholesale_codes enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.shipment_tracking enable row level security;
alter table public.crm_followups enable row level security;
alter table public.crm_notes enable row level security;
alter table public.company_settings enable row level security;
alter table public.audit_logs enable row level security;

create policy "Public can read roles"
  on public.roles for select
  using (true);

create policy "Admins can manage roles"
  on public.roles for all
  using (public.is_admin())
  with check (public.is_admin());

create policy "Users can read own user profile"
  on public.users for select
  using (id = auth.uid() or public.is_admin());

create policy "Admins can manage users"
  on public.users for all
  using (public.has_permission('settings:manage'))
  with check (public.has_permission('settings:manage'));

create policy "Users can read own customer record"
  on public.customers for select
  using (user_id = auth.uid() or public.is_admin());

create policy "Users can update own customer record"
  on public.customers for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Authenticated users can create customer record"
  on public.customers for insert
  with check (user_id = auth.uid());

create policy "Admins can manage customers"
  on public.customers for all
  using (public.has_permission('customers:manage'))
  with check (public.has_permission('customers:manage'));

create policy "Public can read active categories"
  on public.categories for select
  using (active = true);

create policy "Admins can manage categories"
  on public.categories for all
  using (public.has_permission('products:manage'))
  with check (public.has_permission('products:manage'));

create policy "Public can read active products"
  on public.products for select
  using (active = true);

create policy "Admins can manage products"
  on public.products for all
  using (public.has_permission('products:manage'))
  with check (public.has_permission('products:manage'));

create policy "Public can read product images"
  on public.product_images for select
  using (
    exists (
      select 1
      from public.products
      where products.id = product_images.product_id
        and products.active = true
    )
  );

create policy "Admins can manage product images"
  on public.product_images for all
  using (public.has_permission('products:manage'))
  with check (public.has_permission('products:manage'));

create policy "Customers can read own wholesale codes"
  on public.wholesale_codes for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.customers
      where customers.id = wholesale_codes.customer_id
        and customers.user_id = auth.uid()
    )
  );

create policy "Admins can manage wholesale codes"
  on public.wholesale_codes for all
  using (public.has_permission('customers:manage'))
  with check (public.has_permission('customers:manage'));

create policy "Admins can manage inventory movements"
  on public.inventory_movements for all
  using (public.has_permission('inventory:manage'))
  with check (public.has_permission('inventory:manage'));

create policy "Users can create own orders"
  on public.orders for insert
  with check (user_id is null or user_id = auth.uid());

create policy "Users can read own orders"
  on public.orders for select
  using (user_id = auth.uid() or public.is_admin());

create policy "Staff can read orders"
  on public.orders for select
  using (public.has_permission('orders:read') or public.has_permission('orders:manage'));

create policy "Admins can update orders"
  on public.orders for update
  using (public.has_permission('orders:manage'))
  with check (public.has_permission('orders:manage'));

create policy "Users can create items for own orders"
  on public.order_items for insert
  with check (
    exists (
      select 1
      from public.orders
      where orders.id = order_items.order_id
        and (orders.user_id is null or orders.user_id = auth.uid())
    )
  );

create policy "Users can read own order items"
  on public.order_items for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.orders
      where orders.id = order_items.order_id
        and orders.user_id = auth.uid()
    )
  );

create policy "Admins can manage order items"
  on public.order_items for all
  using (public.has_permission('orders:manage'))
  with check (public.has_permission('orders:manage'));

create policy "Users can read own payments"
  on public.payments for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.orders
      where orders.id = payments.order_id
        and orders.user_id = auth.uid()
    )
  );

create policy "Staff can read payments"
  on public.payments for select
  using (public.has_permission('payments:manage'));

create policy "Users can create own payments"
  on public.payments for insert
  with check (
    exists (
      select 1
      from public.orders
      where orders.id = payments.order_id
        and (orders.user_id is null or orders.user_id = auth.uid())
    )
  );

create policy "Admins can manage payments"
  on public.payments for all
  using (public.has_permission('payments:manage'))
  with check (public.has_permission('payments:manage'));

create policy "Users can read own invoices"
  on public.invoices for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.orders
      where orders.id = invoices.order_id
        and orders.user_id = auth.uid()
    )
  );

create policy "Staff can read invoices"
  on public.invoices for select
  using (public.has_permission('invoices:manage'));

create policy "Admins can manage invoices"
  on public.invoices for all
  using (public.has_permission('invoices:manage'))
  with check (public.has_permission('invoices:manage'));

create policy "Users can read own invoice items"
  on public.invoice_items for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.invoices
      join public.orders on orders.id = invoices.order_id
      where invoices.id = invoice_items.invoice_id
        and orders.user_id = auth.uid()
    )
  );

create policy "Admins can manage invoice items"
  on public.invoice_items for all
  using (public.has_permission('invoices:manage'))
  with check (public.has_permission('invoices:manage'));

create policy "Users can read own shipment tracking"
  on public.shipment_tracking for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.orders
      where orders.id = shipment_tracking.order_id
        and orders.user_id = auth.uid()
    )
  );

create policy "Admins can manage shipment tracking"
  on public.shipment_tracking for all
  using (public.has_permission('shipments:manage'))
  with check (public.has_permission('shipments:manage'));

create policy "Users can read own crm followups"
  on public.crm_followups for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.customers
      where customers.id = crm_followups.customer_id
        and customers.user_id = auth.uid()
    )
  );

create policy "Admins can manage crm followups"
  on public.crm_followups for all
  using (public.has_permission('crm:manage'))
  with check (public.has_permission('crm:manage'));

create policy "Users can read own crm notes"
  on public.crm_notes for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.customers
      where customers.id = crm_notes.customer_id
        and customers.user_id = auth.uid()
    )
  );

create policy "Admins can manage crm notes"
  on public.crm_notes for all
  using (public.has_permission('crm:manage'))
  with check (public.has_permission('crm:manage'));

create policy "Public can read company settings"
  on public.company_settings for select
  using (true);

create policy "Admins can manage company settings"
  on public.company_settings for all
  using (public.has_permission('settings:manage'))
  with check (public.has_permission('settings:manage'));

create policy "Admins can read audit logs"
  on public.audit_logs for select
  using (public.has_permission('audit:read'));

create policy "Admins can create audit logs"
  on public.audit_logs for insert
  with check (public.is_admin());
