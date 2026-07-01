create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  phone text,
  email text,
  tax_id text,
  address text,
  notes text,
  is_active boolean not null default true,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_name_not_empty check (char_length(trim(name)) > 0)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  purchase_number text not null,
  purchase_date date not null default current_date,
  status text not null default 'draft',
  subtotal numeric(12, 2) not null default 0,
  tax_amount numeric(12, 2) not null default 0,
  discount_amount numeric(12, 2) not null default 0,
  shipping_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  currency text not null default 'HNL',
  notes text,
  created_by uuid references public.users(id) on delete set null,
  confirmed_by uuid references public.users(id) on delete set null,
  confirmed_at timestamptz,
  cancelled_by uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchases_number_not_empty check (char_length(trim(purchase_number)) > 0),
  constraint purchases_status_check check (status in ('draft', 'confirmed', 'received', 'cancelled', 'returned')),
  constraint purchases_amounts_non_negative check (
    subtotal >= 0 and
    tax_amount >= 0 and
    discount_amount >= 0 and
    shipping_amount >= 0 and
    total >= 0
  ),
  constraint purchases_currency_not_empty check (char_length(trim(currency)) > 0)
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  description text not null,
  quantity numeric(12, 2) not null,
  unit_cost numeric(12, 2) not null,
  tax_amount numeric(12, 2) not null default 0,
  discount_amount numeric(12, 2) not null default 0,
  total_cost numeric(12, 2) not null,
  inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint purchase_items_description_not_empty check (char_length(trim(description)) > 0),
  constraint purchase_items_quantity_positive check (quantity > 0),
  constraint purchase_items_amounts_non_negative check (
    unit_cost >= 0 and
    tax_amount >= 0 and
    discount_amount >= 0 and
    total_cost >= 0
  )
);

create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete set null,
  invoice_number text not null,
  invoice_date date not null default current_date,
  due_date date,
  status text not null default 'draft',
  subtotal numeric(12, 2) not null default 0,
  tax_amount numeric(12, 2) not null default 0,
  discount_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  currency text not null default 'HNL',
  notes text,
  created_by uuid references public.users(id) on delete set null,
  received_by uuid references public.users(id) on delete set null,
  received_at timestamptz,
  cancelled_by uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_invoices_number_not_empty check (char_length(trim(invoice_number)) > 0),
  constraint supplier_invoices_status_check check (status in ('draft', 'received', 'posted_to_ap', 'cancelled', 'paid')),
  constraint supplier_invoices_amounts_non_negative check (
    subtotal >= 0 and
    tax_amount >= 0 and
    discount_amount >= 0 and
    total >= 0
  ),
  constraint supplier_invoices_currency_not_empty check (char_length(trim(currency)) > 0)
);

create table if not exists public.accounts_payable (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete set null,
  supplier_invoice_id uuid references public.supplier_invoices(id) on delete set null,
  total_amount numeric(12, 2) not null,
  paid_amount numeric(12, 2) not null default 0,
  balance numeric(12, 2) generated always as (total_amount - paid_amount) stored,
  due_date date,
  status text not null default 'pending',
  currency text not null default 'HNL',
  notes text,
  created_by uuid references public.users(id) on delete set null,
  cancelled_by uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_payable_status_check check (status in ('pending', 'partial', 'paid', 'cancelled', 'overdue')),
  constraint accounts_payable_amounts_non_negative check (
    total_amount >= 0 and
    paid_amount >= 0 and
    balance >= 0
  ),
  constraint accounts_payable_paid_not_above_total check (paid_amount <= total_amount),
  constraint accounts_payable_currency_not_empty check (char_length(trim(currency)) > 0)
);

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  accounts_payable_id uuid not null references public.accounts_payable(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  amount numeric(12, 2) not null,
  payment_method text not null,
  status text not null default 'draft',
  paid_at timestamptz,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  voided_by uuid references public.users(id) on delete set null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_payments_status_check check (status in ('draft', 'paid', 'voided')),
  constraint supplier_payments_amount_positive check (amount > 0),
  constraint supplier_payments_method_not_empty check (char_length(trim(payment_method)) > 0)
);

create unique index if not exists suppliers_normalized_name_key
  on public.suppliers ((lower(trim(name))));
create unique index if not exists suppliers_tax_id_key
  on public.suppliers ((lower(trim(tax_id))))
  where tax_id is not null and char_length(trim(tax_id)) > 0;
create index if not exists suppliers_name_idx
  on public.suppliers (name);
create index if not exists suppliers_is_active_idx
  on public.suppliers (is_active);
create index if not exists suppliers_tax_id_idx
  on public.suppliers (tax_id);

create unique index if not exists purchases_purchase_number_key
  on public.purchases ((lower(trim(purchase_number))));
create index if not exists purchases_supplier_id_idx
  on public.purchases (supplier_id);
create index if not exists purchases_status_idx
  on public.purchases (status);
create index if not exists purchases_purchase_date_idx
  on public.purchases (purchase_date desc);
create index if not exists purchases_purchase_number_idx
  on public.purchases (purchase_number);

create index if not exists purchase_items_purchase_id_idx
  on public.purchase_items (purchase_id);
create index if not exists purchase_items_product_id_idx
  on public.purchase_items (product_id);
create index if not exists purchase_items_inventory_movement_id_idx
  on public.purchase_items (inventory_movement_id);

create unique index if not exists supplier_invoices_supplier_invoice_number_key
  on public.supplier_invoices (supplier_id, (lower(trim(invoice_number))))
  where status <> 'cancelled';
create index if not exists supplier_invoices_supplier_id_idx
  on public.supplier_invoices (supplier_id);
create index if not exists supplier_invoices_purchase_id_idx
  on public.supplier_invoices (purchase_id);
create index if not exists supplier_invoices_status_idx
  on public.supplier_invoices (status);
create index if not exists supplier_invoices_invoice_date_idx
  on public.supplier_invoices (invoice_date desc);
create index if not exists supplier_invoices_due_date_idx
  on public.supplier_invoices (due_date);

create index if not exists accounts_payable_supplier_id_idx
  on public.accounts_payable (supplier_id);
create index if not exists accounts_payable_purchase_id_idx
  on public.accounts_payable (purchase_id);
create index if not exists accounts_payable_supplier_invoice_id_idx
  on public.accounts_payable (supplier_invoice_id);
create index if not exists accounts_payable_status_idx
  on public.accounts_payable (status);
create index if not exists accounts_payable_due_date_idx
  on public.accounts_payable (due_date);

create index if not exists supplier_payments_accounts_payable_id_idx
  on public.supplier_payments (accounts_payable_id);
create index if not exists supplier_payments_supplier_id_idx
  on public.supplier_payments (supplier_id);
create index if not exists supplier_payments_status_idx
  on public.supplier_payments (status);
create index if not exists supplier_payments_paid_at_idx
  on public.supplier_payments (paid_at desc);

drop trigger if exists suppliers_set_updated_at on public.suppliers;
create trigger suppliers_set_updated_at
before update on public.suppliers
for each row execute function public.set_updated_at();

drop trigger if exists purchases_set_updated_at on public.purchases;
create trigger purchases_set_updated_at
before update on public.purchases
for each row execute function public.set_updated_at();

drop trigger if exists supplier_invoices_set_updated_at on public.supplier_invoices;
create trigger supplier_invoices_set_updated_at
before update on public.supplier_invoices
for each row execute function public.set_updated_at();

drop trigger if exists accounts_payable_set_updated_at on public.accounts_payable;
create trigger accounts_payable_set_updated_at
before update on public.accounts_payable
for each row execute function public.set_updated_at();

drop trigger if exists supplier_payments_set_updated_at on public.supplier_payments;
create trigger supplier_payments_set_updated_at
before update on public.supplier_payments
for each row execute function public.set_updated_at();

alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.supplier_invoices enable row level security;
alter table public.accounts_payable enable row level security;
alter table public.supplier_payments enable row level security;

create policy suppliers_select
  on public.suppliers for select
  using (public.has_permission('suppliers:read') or public.has_permission('suppliers:manage'));
create policy suppliers_insert
  on public.suppliers for insert
  with check (public.has_permission('suppliers:manage'));
create policy suppliers_update
  on public.suppliers for update
  using (public.has_permission('suppliers:manage'))
  with check (public.has_permission('suppliers:manage'));

create policy purchases_select
  on public.purchases for select
  using (public.has_permission('purchases:read') or public.has_permission('purchases:manage'));
create policy purchases_insert
  on public.purchases for insert
  with check (public.has_permission('purchases:manage'));
create policy purchases_update
  on public.purchases for update
  using (public.has_permission('purchases:manage'))
  with check (public.has_permission('purchases:manage'));

create policy purchase_items_select
  on public.purchase_items for select
  using (public.has_permission('purchases:read') or public.has_permission('purchases:manage'));
create policy purchase_items_insert
  on public.purchase_items for insert
  with check (public.has_permission('purchases:manage'));
create policy purchase_items_update
  on public.purchase_items for update
  using (public.has_permission('purchases:manage'))
  with check (public.has_permission('purchases:manage'));

create policy supplier_invoices_select
  on public.supplier_invoices for select
  using (
    public.has_permission('purchases:read') or
    public.has_permission('purchases:manage') or
    public.has_permission('payables:read') or
    public.has_permission('payables:manage')
  );
create policy supplier_invoices_insert
  on public.supplier_invoices for insert
  with check (public.has_permission('purchases:manage') or public.has_permission('payables:manage'));
create policy supplier_invoices_update
  on public.supplier_invoices for update
  using (public.has_permission('purchases:manage') or public.has_permission('payables:manage'))
  with check (public.has_permission('purchases:manage') or public.has_permission('payables:manage'));

create policy accounts_payable_select
  on public.accounts_payable for select
  using (public.has_permission('payables:read') or public.has_permission('payables:manage'));
create policy accounts_payable_insert
  on public.accounts_payable for insert
  with check (public.has_permission('payables:manage'));
create policy accounts_payable_update
  on public.accounts_payable for update
  using (public.has_permission('payables:manage'))
  with check (public.has_permission('payables:manage'));

create policy supplier_payments_select
  on public.supplier_payments for select
  using (public.has_permission('payables:read') or public.has_permission('payables:manage'));
create policy supplier_payments_insert
  on public.supplier_payments for insert
  with check (public.has_permission('payables:manage'));
create policy supplier_payments_update
  on public.supplier_payments for update
  using (public.has_permission('payables:manage'))
  with check (public.has_permission('payables:manage'));

grant select, insert, update on public.suppliers to authenticated, service_role;
grant select, insert, update on public.purchases to authenticated, service_role;
grant select, insert, update on public.purchase_items to authenticated, service_role;
grant select, insert, update on public.supplier_invoices to authenticated, service_role;
grant select, insert, update on public.accounts_payable to authenticated, service_role;
grant select, insert, update on public.supplier_payments to authenticated, service_role;

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(
    coalesce(public.roles.permissions, '[]'::jsonb) ||
    '[
      "suppliers:read",
      "suppliers:manage",
      "purchases:read",
      "purchases:manage",
      "payables:read",
      "payables:manage"
    ]'::jsonb
  ) as permissions(permission)
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin', 'contadora');
