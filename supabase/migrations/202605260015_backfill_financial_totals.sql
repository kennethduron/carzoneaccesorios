with recalculated_orders as (
  select
    orders.id,
    round(
      coalesce(orders.subtotal, 0)
      + coalesce(orders.tax, 0)
      + coalesce(orders.shipping_fee, orders.shipping_total, 0)
      + coalesce(orders.cash_on_delivery_fee, 0)
      + coalesce(orders.small_order_fee, 0)
      + coalesce(
        (
          select sum(coalesce((fee.value ->> 'amount')::numeric, 0))
          from jsonb_array_elements(coalesce(orders.additional_fees, '[]'::jsonb)) as fee(value)
        ),
        0
      )
      - coalesce(orders.discount_total, 0),
      2
    ) as expected_total
  from public.orders
)
update public.orders
set
  total = recalculated_orders.expected_total,
  updated_at = now()
from recalculated_orders
where orders.id = recalculated_orders.id
  and abs(coalesce(orders.total, 0) - recalculated_orders.expected_total) >= 0.01;

update public.payments
set
  amount = orders.total,
  updated_at = now()
from public.orders
where payments.order_id = orders.id
  and abs(coalesce(payments.amount, 0) - coalesce(orders.total, 0)) >= 0.01;

update public.invoices
set
  shipping_fee = coalesce(orders.shipping_fee, orders.shipping_total, 0),
  cash_on_delivery_fee = coalesce(orders.cash_on_delivery_fee, 0),
  small_order_fee = coalesce(orders.small_order_fee, 0),
  discount_total = coalesce(orders.discount_total, 0),
  additional_fees = coalesce(orders.additional_fees, '[]'::jsonb),
  total = orders.total,
  updated_at = now()
from public.orders
where invoices.order_id = orders.id
  and (
    abs(coalesce(invoices.shipping_fee, 0) - coalesce(orders.shipping_fee, orders.shipping_total, 0)) >= 0.01
    or abs(coalesce(invoices.cash_on_delivery_fee, 0) - coalesce(orders.cash_on_delivery_fee, 0)) >= 0.01
    or abs(coalesce(invoices.small_order_fee, 0) - coalesce(orders.small_order_fee, 0)) >= 0.01
    or abs(coalesce(invoices.discount_total, 0) - coalesce(orders.discount_total, 0)) >= 0.01
    or coalesce(invoices.additional_fees, '[]'::jsonb) <> coalesce(orders.additional_fees, '[]'::jsonb)
    or abs(coalesce(invoices.total, 0) - coalesce(orders.total, 0)) >= 0.01
  );

insert into public.audit_logs (
  table_name,
  action,
  new_data
)
values (
  'orders',
  'financial.breakdown.backfilled',
  jsonb_build_object(
    'reason', 'Backfill subtotal + ISV + fees - discounts after additional charge audit',
    'does_not_change', jsonb_build_array('invoice_number', 'cai', 'correlative', 'items', 'customer_snapshot')
  )
);
