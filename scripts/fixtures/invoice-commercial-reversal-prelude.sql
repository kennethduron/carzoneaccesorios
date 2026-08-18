\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create schema if not exists auth;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create type public.order_status as enum ('confirmado','entregado','cancelado','confirmed','delivered','cancelled');
create type public.invoice_status as enum ('emitida','anulada','issued','paid','cancelled');
create type public.order_price_mode as enum ('retail','wholesale');
create type public.payment_method as enum ('bank_transfer','card','cash','commercial_credit');
create type public.payment_status as enum ('pending','approved','rejected','refunded');
create type public.inventory_movement_type as enum ('purchase','sale','return','adjustment');

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  permissions jsonb not null default '[]'::jsonb
);
create table public.users (
  id uuid primary key,
  role_id uuid references public.roles(id),
  active boolean not null default true
);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  contact_name text not null,
  business_name text,
  phone text,
  address text
);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  slug text not null unique,
  name text not null,
  brand text not null,
  stock integer not null default 0 check (stock >= 0),
  reserved_stock integer not null default 0 check (reserved_stock >= 0 and stock >= reserved_stock),
  retail_price numeric(12,2) not null,
  wholesale_price numeric(12,2) not null,
  cost_price numeric(12,2) not null default 0,
  tracks_inventory boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid references public.customers(id),
  customer_name text not null,
  phone text not null,
  customer_phone text not null,
  delivery_address text not null,
  payment_method public.payment_method not null,
  price_mode public.order_price_mode not null default 'retail',
  subtotal numeric(12,2) not null,
  tax numeric(12,2) not null,
  total numeric(12,2) not null,
  status public.order_status not null,
  tracking_status text not null,
  order_reservation_status text not null default 'not_required',
  reservation_review_required boolean not null default false,
  reservation_reviewed_at timestamptz,
  reservation_reviewed_by uuid references public.users(id),
  reservation_review_reason text,
  source text not null,
  channel text not null,
  created_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  product_id uuid references public.products(id),
  sku text not null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  applied_price_mode public.order_price_mode not null,
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null,
  retail_price_snapshot numeric(12,2) not null,
  wholesale_price_snapshot numeric(12,2) not null,
  unit_cost_snapshot numeric(12,2),
  total_cost_snapshot numeric(12,2),
  cost_source text,
  cost_captured_at timestamptz,
  tracks_inventory_snapshot boolean not null default true
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  customer_id uuid references public.customers(id),
  invoice_number text not null unique,
  status public.invoice_status not null,
  price_mode public.order_price_mode not null,
  subtotal numeric(12,2) not null,
  tax numeric(12,2) not null,
  total numeric(12,2) not null,
  issued_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.users(id),
  cancellation_reason text,
  updated_at timestamptz not null default now()
);
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  user_id uuid references public.users(id),
  movement_type public.inventory_movement_type not null,
  quantity integer not null check (quantity <> 0),
  stock_before integer not null,
  stock_after integer not null,
  reference_type text,
  reference_id uuid,
  order_item_id uuid references public.order_items(id),
  notes text,
  unit_cost_snapshot numeric(12,2),
  total_cost_snapshot numeric(12,2),
  cost_source text,
  cost_captured_at timestamptz,
  reserved_before integer,
  reserved_after integer,
  available_before integer,
  available_after integer,
  effective_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  customer_id uuid references public.customers(id),
  method public.payment_method not null,
  payment_method public.payment_method not null,
  status public.payment_status not null,
  payment_status public.payment_status not null,
  amount numeric(12,2) not null,
  paid_at timestamptz,
  rejected_by uuid references public.users(id),
  rejection_reason text,
  updated_at timestamptz not null default now()
);
create table public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  order_id uuid not null unique references public.orders(id),
  invoice_id uuid unique references public.invoices(id),
  original_amount numeric(12,2) not null,
  balance_due numeric(12,2) not null,
  due_date date not null,
  status text not null check (status in ('open','partial','paid','overdue','cancelled')),
  updated_at timestamptz not null default now(),
  check ((status='cancelled' and balance_due=0) or status<>'cancelled')
);
create table public.accounts_receivable_payments (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null references public.accounts_receivable(id),
  customer_id uuid not null references public.customers(id),
  order_id uuid not null references public.orders(id),
  amount numeric(12,2) not null,
  payment_method text not null,
  recorded_by uuid references public.users(id),
  voided_at timestamptz
);
create table public.email_queue (
  id uuid primary key default gen_random_uuid(), related_id uuid,
  template_key text, status text, updated_at timestamptz default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id), actor_role text,
  table_name text not null, record_id uuid, action text not null,
  old_data jsonb, new_data jsonb, created_at timestamptz default now()
);
create table public.journal_entries (
  id uuid primary key default gen_random_uuid(), entry_number text not null unique,
  entry_date date not null, description text not null,
  status text not null, created_by uuid not null references public.users(id),
  updated_by uuid references public.users(id), metadata jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);
create table public.financial_events (
  id uuid primary key default gen_random_uuid(), source_type text not null,
  source_id text not null, event_purpose text not null,
  posting_version text not null, status text not null,
  occurred_at timestamptz not null, journal_entry_id uuid references public.journal_entries(id),
  validation_errors jsonb default '[]'::jsonb, updated_at timestamptz default now()
);
create table public.accounting_outbox_v2 (
  id uuid primary key default gen_random_uuid(), feature_key text not null,
  topic text not null, source_type text not null, source_id uuid not null,
  event_purpose text not null, posting_version text not null,
  scenario text not null, idempotency_key text not null unique,
  occurred_at timestamptz not null, cutover_at timestamptz not null,
  status text not null, actor_id uuid references public.users(id),
  financial_event_id uuid references public.financial_events(id),
  journal_entry_id uuid references public.journal_entries(id),
  cancelled_at timestamptz, lease_until timestamptz, locked_by text,
  last_error_code text, last_error_message text,
  compensated_event_id uuid references public.financial_events(id),
  duplicate_avoided boolean not null default false,
  unique(source_type,source_id,event_purpose,posting_version)
);

create or replace function public.has_permission(permission_key text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.users join public.roles on roles.id=users.role_id
    where users.id=auth.uid() and users.active and roles.permissions ? permission_key
  )
$$;
create or replace function public.current_actor_role()
returns text language sql stable security definer set search_path=public as $$
  select roles.name from public.users join public.roles on roles.id=users.role_id
  where users.id=auth.uid() and users.active
$$;

create or replace function public.cancel_fiscal_invoice(target_invoice_id uuid, cancellation_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare old_row public.invoices%rowtype;
begin
  if not public.has_permission('invoices:manage') then raise exception 'FISCAL_PERMISSION_DENIED'; end if;
  select * into strict old_row from public.invoices where id=target_invoice_id for update;
  if old_row.status::text in ('anulada','cancelled') then raise exception 'FISCAL_ALREADY_CANCELLED'; end if;
  update public.invoices set status='anulada',cancelled_at=now(),cancelled_by=auth.uid(),
    cancellation_reason=trim(cancel_fiscal_invoice.cancellation_reason),updated_at=now()
    where id=cancel_fiscal_invoice.target_invoice_id;
  insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,old_data,new_data)
  values(auth.uid(),public.current_actor_role(),'invoices',target_invoice_id,'fiscal.invoice.cancelled',
    to_jsonb(old_row),jsonb_build_object('status','anulada'));
end $$;

create or replace function public.cancel_receivable_for_cancelled_credit_order()
returns trigger language plpgsql security definer set search_path=public as $$
declare item public.accounts_receivable%rowtype;
begin
  if new.payment_method='commercial_credit' and new.status::text in ('cancelado','cancelled')
    and old.status::text not in ('cancelado','cancelled') then
    select * into item from public.accounts_receivable where order_id=new.id
      and status in ('open','partial','overdue') for update;
    if found then
      update public.accounts_receivable set status='cancelled',balance_due=0,updated_at=now() where id=item.id;
      insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,old_data,new_data)
      values(auth.uid(),public.current_actor_role(),'accounts_receivable',item.id,
        'commercial_credit.receivable_cancelled_with_order',to_jsonb(item),jsonb_build_object('status','cancelled'));
    end if;
  end if;
  return new;
end $$;
create trigger cancel_receivable_on_credit_order_cancel after update of status on public.orders
for each row execute function public.cancel_receivable_for_cancelled_credit_order();

create or replace function public.cancel_accounting_fact_v2(
  target_source_type text,target_source_id uuid,target_event_purpose text,
  target_compensation_purpose text,cancellation_actor uuid default null
)
returns uuid language plpgsql security definer set search_path=public as $$
declare box public.accounting_outbox_v2%rowtype; entry public.journal_entries%rowtype;
begin
  select * into box from public.accounting_outbox_v2 where source_type=target_source_type
    and source_id=target_source_id and event_purpose=target_event_purpose and posting_version='v2' for update;
  if not found then return null; end if;
  if box.journal_entry_id is null then
    update public.accounting_outbox_v2 set status='cancelled',cancelled_at=now() where id=box.id;
    return box.id;
  end if;
  select * into strict entry from public.journal_entries where id=box.journal_entry_id for update;
  if entry.status='borrador' then
    update public.journal_entries set status='anulada',updated_by=coalesce(cancellation_actor,auth.uid()),updated_at=now() where id=entry.id;
    update public.financial_events set status='skipped',updated_at=now() where id=box.financial_event_id;
    update public.accounting_outbox_v2 set status='cancelled',cancelled_at=now() where id=box.id;
    return box.id;
  end if;
  if entry.status in ('publicada','reversada') then
    insert into public.accounting_outbox_v2(feature_key,topic,source_type,source_id,event_purpose,
      posting_version,scenario,idempotency_key,occurred_at,cutover_at,status,actor_id,compensated_event_id)
    values(box.feature_key,'accounting.compensation',box.source_type,box.source_id,target_compensation_purpose,
      'v2','source_cancelled_after_publication',box.source_type||':'||box.source_id||':'||target_compensation_purpose||':v2',
      now(),box.cutover_at,'queued',coalesce(cancellation_actor,auth.uid()),box.financial_event_id)
    on conflict(source_type,source_id,event_purpose,posting_version) do update set duplicate_avoided=true
    returning id into box.id;
  end if;
  return box.id;
end $$;

create or replace function public.handle_order_cancellation_accounting_v2()
returns trigger language plpgsql security definer set search_path=public as $$
declare movement_id uuid;
begin
  if new.status::text not in ('cancelado','cancelled') or old.status::text in ('cancelado','cancelled') then return new; end if;
  perform public.cancel_accounting_fact_v2('order',new.id,'sale_recognized','sale_compensation',auth.uid());
  for movement_id in select id from public.inventory_movements where reference_type='orders'
    and reference_id=new.id and movement_type='sale' and quantity<0 loop
    perform public.cancel_accounting_fact_v2('inventory_movement',movement_id,'inventory_cogs','inventory_cogs_compensation',auth.uid());
  end loop;
  return new;
end $$;
create trigger orders_cancel_accounting_v2 after update of status on public.orders
for each row execute function public.handle_order_cancellation_accounting_v2();

create or replace function public.apply_order_sale_inventory(target_order_id uuid,actor_user_id uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare line record; item public.products%rowtype;
begin
  for line in select product_id,sum(quantity)::integer quantity,(array_agg(id order by id))[1] order_item_id
    from public.order_items where order_id=target_order_id and tracks_inventory_snapshot group by product_id order by product_id loop
    select * into strict item from public.products where id=line.product_id for update;
    if item.stock-item.reserved_stock < line.quantity then raise exception 'POS_INSUFFICIENT_STOCK'; end if;
    update public.products set stock=item.stock-line.quantity,updated_at=now() where id=item.id;
    insert into public.inventory_movements(product_id,user_id,movement_type,quantity,stock_before,stock_after,
      reference_type,reference_id,order_item_id,unit_cost_snapshot,total_cost_snapshot,cost_source,cost_captured_at,
      reserved_before,reserved_after,available_before,available_after,effective_date,notes)
    values(item.id,actor_user_id,'sale',-line.quantity,item.stock,item.stock-line.quantity,'orders',target_order_id,
      line.order_item_id,item.cost_price,item.cost_price*line.quantity,'synthetic_normal_sale',now(),
      item.reserved_stock,item.reserved_stock,item.stock-item.reserved_stock,item.stock-line.quantity-item.reserved_stock,
      current_date,'Normal independent sale');
  end loop;
end $$;
