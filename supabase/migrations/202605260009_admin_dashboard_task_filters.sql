-- Align owner-dashboard counters with the filtered admin routes.

create index if not exists orders_status_created_idx
  on public.orders(status, created_at desc);

create index if not exists payments_manual_review_idx
  on public.payments(payment_status, payment_method, order_id)
  where payment_status = 'pending'
    and payment_method in ('bank_transfer', 'cash');

create index if not exists payments_confirmed_order_idx
  on public.payments(payment_status, order_id)
  where payment_status = 'approved';

create or replace function public.get_admin_low_stock_products(
  search_query text default null,
  result_limit integer default 50
)
returns table (
  id uuid,
  sku text,
  name text,
  stock integer,
  reserved_stock integer,
  available_stock integer,
  min_stock integer
)
language sql
security definer
set search_path = public
as $$
  select
    p.id,
    p.sku,
    p.name,
    p.stock,
    p.reserved_stock,
    coalesce(p.available_stock, greatest(p.stock - coalesce(p.reserved_stock, 0), 0), p.stock, 0)::integer as available_stock,
    coalesce(p.min_stock, 0)::integer as min_stock
  from public.products p
  where p.active = true
    and coalesce(p.available_stock, greatest(p.stock - coalesce(p.reserved_stock, 0), 0), p.stock, 0) <= coalesce(p.min_stock, 0)
    and (
      coalesce(search_query, '') = ''
      or p.sku ilike '%' || search_query || '%'
      or p.internal_code ilike '%' || search_query || '%'
      or p.name ilike '%' || search_query || '%'
      or p.brand ilike '%' || search_query || '%'
    )
  order by p.name asc
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
$$;

grant execute on function public.get_admin_low_stock_products(text, integer) to authenticated, service_role;

create or replace function public.get_admin_dashboard_operational_summary()
returns table (
  sales_today numeric,
  sales_month numeric,
  orders_today integer,
  pending_orders integer,
  pending_payments integer,
  orders_to_prepare integer,
  pending_invoices integer,
  out_of_stock_products integer,
  low_stock_products integer,
  new_customers_today integer,
  new_customers_month integer,
  pending_wholesale_requests integer,
  overdue_followups integer,
  active_reservations integer,
  expired_reservations integer,
  latest_cron_job text,
  latest_cron_status text,
  latest_cron_at timestamptz,
  latest_backup_status text,
  latest_backup_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  hn_today date := timezone('America/Tegucigalpa', now())::date;
  today_start timestamptz := hn_today::timestamp at time zone 'America/Tegucigalpa';
  today_end timestamptz := (hn_today + 1)::timestamp at time zone 'America/Tegucigalpa';
  month_start timestamptz := date_trunc('month', timezone('America/Tegucigalpa', now()))::timestamp at time zone 'America/Tegucigalpa';
  latest_cron record;
  latest_backup record;
begin
  select job_name, status, started_at
    into latest_cron
  from public.operational_cron_runs
  order by started_at desc
  limit 1;

  select status, checked_at
    into latest_backup
  from public.operational_backup_checks
  order by checked_at desc
  limit 1;

  return query
  select
    coalesce((
      select sum(total)
      from public.invoices
      where coalesce(issued_at, created_at) >= today_start
        and coalesce(issued_at, created_at) < today_end
        and status::text in ('emitida', 'issued', 'paid')
    ), 0)::numeric as sales_today,
    coalesce((
      select sum(total)
      from public.invoices
      where coalesce(issued_at, created_at) >= month_start
        and status::text in ('emitida', 'issued', 'paid')
    ), 0)::numeric as sales_month,
    (select count(*)::integer from public.orders where created_at >= today_start and created_at < today_end) as orders_today,
    (
      select count(*)::integer
      from public.orders
      where status::text in ('pending', 'recibido')
    ) as pending_orders,
    (
      select count(distinct o.id)::integer
      from public.orders o
      join public.payments p on p.order_id = o.id
      where o.payment_method::text in ('bank_transfer', 'cash')
        and o.status::text not in ('cancelado', 'cancelled')
        and coalesce(p.payment_status::text, p.status::text) = 'pending'
    ) as pending_payments,
    (
      select count(distinct o.id)::integer
      from public.orders o
      join public.payments p on p.order_id = o.id
      where o.status::text in ('confirmado', 'confirmed', 'paid', 'preparacion', 'preparing')
        and coalesce(p.payment_status::text, p.status::text) = 'approved'
    ) as orders_to_prepare,
    (select count(*)::integer from public.invoices where status::text in ('pendiente', 'draft')) as pending_invoices,
    (
      select count(*)::integer
      from public.products
      where active = true
        and coalesce(available_stock, stock - coalesce(reserved_stock, 0), stock, 0) <= 0
    ) as out_of_stock_products,
    (
      select count(*)::integer
      from public.products
      where active = true
        and coalesce(available_stock, stock - coalesce(reserved_stock, 0), stock, 0) <= coalesce(min_stock, 0)
    ) as low_stock_products,
    (select count(*)::integer from public.customers where created_at >= today_start and created_at < today_end) as new_customers_today,
    (select count(*)::integer from public.customers where created_at >= month_start) as new_customers_month,
    (select count(*)::integer from public.customers where wholesale_status = 'pending') as pending_wholesale_requests,
    (
      select count(*)::integer
      from public.crm_followups
      where status = 'pending'
        and due_at is not null
        and due_at < now()
    ) as overdue_followups,
    (
      select count(*)::integer
      from public.inventory_reservations
      where status = 'reserved'
    ) as active_reservations,
    (
      select count(*)::integer
      from public.inventory_reservations
      where status = 'reserved'
        and expires_at <= now()
    ) as expired_reservations,
    latest_cron.job_name::text,
    latest_cron.status::text,
    latest_cron.started_at,
    latest_backup.status::text,
    latest_backup.checked_at;
end;
$$;

grant execute on function public.get_admin_dashboard_operational_summary() to authenticated, service_role;
