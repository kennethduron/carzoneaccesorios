-- Compact customer account metrics for /cuenta.

create or replace function public.get_customer_account_summary(
  target_user_id uuid,
  target_email text default null
)
returns table (
  order_count integer,
  total_purchased numeric,
  issued_invoice_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with related_customers as (
    select customers.id
    from public.customers
    where customers.user_id = target_user_id
       or (target_email is not null and lower(customers.email) = lower(target_email))
  ),
  related_orders as (
    select distinct orders.id, orders.total, orders.status
    from public.orders
    where orders.user_id = target_user_id
       or (target_email is not null and lower(orders.email) = lower(target_email))
       or orders.customer_id in (select related_customers.id from related_customers)
  )
  select
    (select count(*)::integer from related_orders) as order_count,
    coalesce(
      (
        select sum(coalesce(related_orders.total, 0))
        from related_orders
        where related_orders.status::text not in ('cancelado', 'cancelled')
      ),
      0
    ) as total_purchased,
    (
      select count(distinct invoices.id)::integer
      from public.invoices
      where invoices.status::text in ('emitida', 'issued', 'paid')
        and (
          invoices.customer_id in (select related_customers.id from related_customers)
          or invoices.order_id in (select related_orders.id from related_orders)
        )
    ) as issued_invoice_count;
$$;

revoke all on function public.get_customer_account_summary(uuid, text) from public;
revoke all on function public.get_customer_account_summary(uuid, text) from anon;
revoke all on function public.get_customer_account_summary(uuid, text) from authenticated;
grant execute on function public.get_customer_account_summary(uuid, text) to service_role;
