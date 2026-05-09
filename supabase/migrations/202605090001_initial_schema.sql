create extension if not exists "pgcrypto";

create type public.payment_method as enum (
  'bank_transfer',
  'card',
  'cash'
);

create type public.order_price_mode as enum (
  'retail',
  'wholesale'
);

create type public.order_status as enum (
  'recibido',
  'confirmado',
  'preparacion',
  'empacado',
  'enviado',
  'en_ruta',
  'entregado',
  'cancelado',
  'pending',
  'confirmed',
  'paid',
  'preparing',
  'shipped',
  'delivered',
  'cancelled'
);

create type public.payment_status as enum (
  'pending',
  'approved',
  'rejected',
  'refunded'
);

create type public.invoice_status as enum (
  'emitida',
  'anulada',
  'draft',
  'issued',
  'paid',
  'cancelled'
);

create type public.inventory_movement_type as enum (
  'purchase',
  'sale',
  'return',
  'adjustment'
);

create type public.product_status as enum (
  'active',
  'inactive',
  'draft',
  'archived'
);

create type public.wholesale_code_status as enum (
  'active',
  'inactive',
  'expired',
  'disabled'
);

create type public.crm_followup_status as enum (
  'pending',
  'completed',
  'cancelled'
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  role_id uuid references public.roles(id) on delete set null,
  full_name text,
  email text unique,
  phone text,
  avatar_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  business_name text,
  contact_name text not null,
  email text,
  phone text not null,
  tax_id text,
  address text,
  city text,
  notes text,
  is_wholesale boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.categories(id) on delete set null,
  name text not null unique,
  slug text not null unique,
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  sku text not null unique,
  internal_code text unique,
  slug text not null unique,
  name text not null,
  brand text not null,
  description text not null default '',
  stock integer not null default 0 check (stock >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  min_stock integer not null default 5 check (min_stock >= 0),
  retail_price numeric(12, 2) not null check (retail_price >= 0),
  wholesale_price numeric(12, 2) not null check (wholesale_price >= 0),
  wholesale_min_quantity integer not null default 1 check (wholesale_min_quantity > 0),
  cost_price numeric(12, 2) not null default 0 check (cost_price >= 0),
  status public.product_status not null default 'active',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wholesale_not_higher_than_retail check (wholesale_price <= retail_price)
);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_bucket text not null default 'product-images',
  storage_path text not null,
  public_url text,
  angle text not null default 'principal',
  alt_text text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create table public.wholesale_codes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  code text not null unique,
  code_hash text not null unique,
  label text not null,
  minimum_order numeric(12, 2) not null default 0 check (minimum_order >= 0),
  max_uses integer check (max_uses is null or max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  status public.wholesale_code_status not null default 'active',
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  user_id uuid references public.users(id) on delete set null,
  movement_type public.inventory_movement_type not null,
  quantity integer not null,
  stock_before integer not null check (stock_before >= 0),
  stock_after integer not null check (stock_after >= 0),
  reference_type text,
  reference_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quantity_not_zero check (quantity <> 0)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  user_id uuid references public.users(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  wholesale_code_id uuid references public.wholesale_codes(id) on delete set null,
  customer_name text not null,
  email text,
  phone text not null,
  delivery_address text not null,
  payment_method public.payment_method not null,
  price_mode public.order_price_mode not null default 'retail',
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  tax numeric(12, 2) not null check (tax >= 0),
  shipping_total numeric(12, 2) not null default 0 check (shipping_total >= 0),
  total numeric(12, 2) not null check (total >= 0),
  status public.order_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  sku text not null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  applied_price_mode public.order_price_mode not null,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0),
  retail_price_snapshot numeric(12, 2) not null check (retail_price_snapshot >= 0),
  wholesale_price_snapshot numeric(12, 2) not null check (wholesale_price_snapshot >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  method public.payment_method not null,
  status public.payment_status not null default 'pending',
  amount numeric(12, 2) not null check (amount >= 0),
  reference text,
  provider text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  invoice_number text not null unique,
  rtn text,
  cai text,
  customer_rtn text,
  status public.invoice_status not null default 'draft',
  price_mode public.order_price_mode not null,
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  tax numeric(12, 2) not null check (tax >= 0),
  total numeric(12, 2) not null check (total >= 0),
  issued_at timestamptz,
  cancelled_at timestamptz,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  sku text not null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0),
  retail_price_snapshot numeric(12, 2) not null check (retail_price_snapshot >= 0),
  wholesale_price_snapshot numeric(12, 2) not null check (wholesale_price_snapshot >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shipment_tracking (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  tracking_number text,
  carrier text,
  status text not null default 'pending',
  shipped_at timestamptz,
  delivered_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crm_followups (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  assigned_user_id uuid references public.users(id) on delete set null,
  title text not null,
  due_at timestamptz,
  status public.crm_followup_status not null default 'pending',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crm_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_settings (
  id uuid primary key default gen_random_uuid(),
  company_name text not null default 'Car Zone Accesorios',
  tax_id text,
  email text,
  phone text,
  address text,
  currency text not null default 'HNL',
  tax_rate numeric(5, 4) not null default 0.1500 check (tax_rate >= 0),
  invoice_prefix text not null default 'CZ-F',
  order_prefix text not null default 'CZ',
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  table_name text not null,
  record_id uuid,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index roles_name_idx on public.roles(name);
create index users_role_id_idx on public.users(role_id);
create index users_email_idx on public.users(email);
create index customers_user_id_idx on public.customers(user_id);
create index customers_email_idx on public.customers(email);
create index customers_phone_idx on public.customers(phone);
create index customers_is_wholesale_idx on public.customers(is_wholesale);
create index categories_parent_id_idx on public.categories(parent_id);
create index categories_slug_idx on public.categories(slug);
create index products_category_id_idx on public.products(category_id);
create index products_active_idx on public.products(active);
create index products_status_idx on public.products(status);
create index products_slug_idx on public.products(slug);
create index products_sku_idx on public.products(sku);
create unique index products_internal_code_idx on public.products(internal_code) where internal_code is not null;
create index products_brand_idx on public.products(brand);
create index products_stock_idx on public.products(stock);
create index products_retail_price_idx on public.products(retail_price);
create index products_wholesale_price_idx on public.products(wholesale_price);
create index products_search_idx
  on public.products using gin (
    to_tsvector(
      'simple',
      coalesce(sku, '') || ' ' ||
      coalesce(internal_code, '') || ' ' ||
      coalesce(name, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(description, '')
    )
  );
create index product_images_product_id_idx on public.product_images(product_id);
create index product_images_primary_idx on public.product_images(product_id, is_primary);
create index product_images_angle_idx on public.product_images(product_id, angle, sort_order);
create index wholesale_codes_customer_id_idx on public.wholesale_codes(customer_id);
create unique index wholesale_codes_code_idx on public.wholesale_codes(code);
create index wholesale_codes_active_idx on public.wholesale_codes(active);
create index wholesale_codes_status_idx on public.wholesale_codes(status);
create index wholesale_codes_expires_at_idx on public.wholesale_codes(expires_at);
create index inventory_movements_product_id_idx on public.inventory_movements(product_id);
create index inventory_movements_user_id_idx on public.inventory_movements(user_id);
create index inventory_movements_created_at_idx on public.inventory_movements(created_at);
create index orders_user_id_idx on public.orders(user_id);
create index orders_customer_id_idx on public.orders(customer_id);
create index orders_status_idx on public.orders(status);
create index orders_created_at_idx on public.orders(created_at);
create index order_items_order_id_idx on public.order_items(order_id);
create index order_items_product_id_idx on public.order_items(product_id);
create index payments_order_id_idx on public.payments(order_id);
create index payments_customer_id_idx on public.payments(customer_id);
create index payments_status_idx on public.payments(status);
create index invoices_order_id_idx on public.invoices(order_id);
create index invoices_customer_id_idx on public.invoices(customer_id);
create index invoices_status_idx on public.invoices(status);
create index invoices_invoice_number_status_idx on public.invoices(invoice_number, status);
create index invoices_rtn_idx on public.invoices(rtn);
create index invoices_cai_idx on public.invoices(cai);
create index invoice_items_invoice_id_idx on public.invoice_items(invoice_id);
create index invoice_items_product_id_idx on public.invoice_items(product_id);
create index shipment_tracking_order_id_idx on public.shipment_tracking(order_id);
create index shipment_tracking_status_idx on public.shipment_tracking(status);
create index crm_followups_customer_id_idx on public.crm_followups(customer_id);
create index crm_followups_assigned_user_id_idx on public.crm_followups(assigned_user_id);
create index crm_followups_due_at_idx on public.crm_followups(due_at);
create index crm_notes_customer_id_idx on public.crm_notes(customer_id);
create index crm_notes_user_id_idx on public.crm_notes(user_id);
create index audit_logs_user_id_idx on public.audit_logs(user_id);
create index audit_logs_table_record_idx on public.audit_logs(table_name, record_id);
create index audit_logs_created_at_idx on public.audit_logs(created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'roles',
    'users',
    'customers',
    'categories',
    'products',
    'product_images',
    'wholesale_codes',
    'inventory_movements',
    'orders',
    'order_items',
    'payments',
    'invoices',
    'invoice_items',
    'shipment_tracking',
    'crm_followups',
    'crm_notes',
    'company_settings',
    'audit_logs'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      table_name || '_set_updated_at',
      table_name
    );
  end loop;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, role_id, full_name, email)
  values (
    new.id,
    (select roles.id from public.roles where roles.name = 'cliente' limit 1),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

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
      and roles.name = 'admin'
      and users.active = true
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
        roles.name = 'admin'
        or roles.permissions ? permission_key
      )
  );
$$;

create or replace function public.validate_wholesale_code(raw_code text)
returns table (
  id uuid,
  code text,
  customer_id uuid,
  customer_name text,
  business_name text,
  label text,
  minimum_order numeric,
  expires_at timestamptz,
  used_count integer,
  status public.wholesale_code_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := upper(trim(raw_code));
  matched_code public.wholesale_codes%rowtype;
  matched_customer public.customers%rowtype;
begin
  if normalized_code = '' then
    return;
  end if;

  select *
  into matched_code
  from public.wholesale_codes wc
  where wc.code = normalized_code
  limit 1;

  if matched_code.id is null then
    return;
  end if;

  if not matched_code.active
    or matched_code.status <> 'active'
    or (matched_code.starts_at is not null and matched_code.starts_at > now())
    or (matched_code.expires_at is not null and matched_code.expires_at < now())
    or (matched_code.max_uses is not null and matched_code.used_count >= matched_code.max_uses)
  then
    return;
  end if;

  update public.wholesale_codes wc
  set
    used_count = wc.used_count + 1,
    last_used_at = now(),
    updated_at = now()
  where wc.id = matched_code.id
  returning * into matched_code;

  if matched_code.customer_id is not null then
    select *
    into matched_customer
    from public.customers c
    where c.id = matched_code.customer_id;
  end if;

  id := matched_code.id;
  code := matched_code.code;
  customer_id := matched_code.customer_id;
  customer_name := coalesce(matched_customer.contact_name, matched_code.label);
  business_name := coalesce(matched_customer.business_name, matched_code.label);
  label := matched_code.label;
  minimum_order := matched_code.minimum_order;
  expires_at := matched_code.expires_at;
  used_count := matched_code.used_count;
  status := matched_code.status;

  return next;
end;
$$;

grant execute on function public.validate_wholesale_code(text) to anon, authenticated;
