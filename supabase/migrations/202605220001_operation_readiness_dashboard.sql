-- Operational readiness summary for the owner dashboard.
-- Keeps dashboard aggregations in Postgres so the admin home does not pull
-- product, invoice, or order rows just to count them.

create index if not exists products_active_available_min_idx
  on public.products(active, available_stock, min_stock);

create index if not exists crm_followups_pending_due_idx
  on public.crm_followups(status, due_at)
  where status = 'pending';

create index if not exists customers_wholesale_pending_created_idx
  on public.customers(wholesale_status, created_at desc)
  where wholesale_status = 'pending';

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
    (select count(*)::integer from public.orders where status::text in ('pending', 'recibido')) as pending_orders,
    (
      select count(*)::integer
      from public.payments
      where coalesce(payment_status::text, status::text) = 'pending'
    ) as pending_payments,
    (
      select count(*)::integer
      from public.orders
      where status::text in ('confirmado', 'confirmed', 'paid', 'preparacion', 'preparing')
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
