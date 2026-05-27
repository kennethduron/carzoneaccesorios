alter table public.orders
  add column if not exists small_order_fee numeric(12, 2) not null default 0 check (small_order_fee >= 0),
  add column if not exists discount_total numeric(12, 2) not null default 0 check (discount_total >= 0),
  add column if not exists additional_fees jsonb not null default '[]'::jsonb;

alter table public.invoices
  add column if not exists small_order_fee numeric(12, 2) not null default 0 check (small_order_fee >= 0),
  add column if not exists discount_total numeric(12, 2) not null default 0 check (discount_total >= 0),
  add column if not exists additional_fees jsonb not null default '[]'::jsonb;

update public.orders
set
  shipping_fee = coalesce(shipping_fee, shipping_total, 0),
  shipping_total = coalesce(shipping_total, shipping_fee, 0),
  cash_on_delivery_fee = coalesce(cash_on_delivery_fee, 0),
  small_order_fee = coalesce(small_order_fee, 0),
  discount_total = coalesce(discount_total, 0),
  additional_fees = coalesce(additional_fees, '[]'::jsonb)
where true;

update public.invoices
set
  shipping_fee = coalesce(invoices.shipping_fee, orders.shipping_fee, orders.shipping_total, 0),
  cash_on_delivery_fee = coalesce(invoices.cash_on_delivery_fee, orders.cash_on_delivery_fee, 0),
  small_order_fee = coalesce(invoices.small_order_fee, orders.small_order_fee, 0),
  discount_total = coalesce(invoices.discount_total, orders.discount_total, 0),
  additional_fees = coalesce(invoices.additional_fees, orders.additional_fees, '[]'::jsonb)
from public.orders
where invoices.order_id = orders.id;

create or replace function public.apply_order_fees_to_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  order_fee_record record;
begin
  select
    coalesce(orders.shipping_fee, orders.shipping_total, 0) as shipping_fee,
    coalesce(orders.cash_on_delivery_fee, 0) as cash_on_delivery_fee,
    coalesce(orders.small_order_fee, 0) as small_order_fee,
    coalesce(orders.discount_total, 0) as discount_total,
    coalesce(orders.additional_fees, '[]'::jsonb) as additional_fees
  into order_fee_record
  from public.orders
  where orders.id = new.order_id;

  if found then
    new.shipping_fee := coalesce(new.shipping_fee, order_fee_record.shipping_fee, 0);
    new.cash_on_delivery_fee := coalesce(new.cash_on_delivery_fee, order_fee_record.cash_on_delivery_fee, 0);
    new.small_order_fee := coalesce(new.small_order_fee, order_fee_record.small_order_fee, 0);
    new.discount_total := coalesce(new.discount_total, order_fee_record.discount_total, 0);
    new.additional_fees := coalesce(new.additional_fees, order_fee_record.additional_fees, '[]'::jsonb);
  end if;

  return new;
end;
$$;

drop trigger if exists apply_order_fees_to_invoice_on_insert on public.invoices;
create trigger apply_order_fees_to_invoice_on_insert
before insert on public.invoices
for each row
execute function public.apply_order_fees_to_invoice();

create or replace view public.order_financial_audit as
select
  orders.id,
  orders.order_number,
  orders.created_at,
  orders.subtotal,
  orders.tax,
  coalesce(orders.shipping_fee, orders.shipping_total, 0) as shipping_fee,
  coalesce(orders.cash_on_delivery_fee, 0) as cash_on_delivery_fee,
  coalesce(orders.small_order_fee, 0) as small_order_fee,
  coalesce(orders.discount_total, 0) as discount_total,
  coalesce(
    (
      select sum(coalesce((fee.value ->> 'amount')::numeric, 0))
      from jsonb_array_elements(coalesce(orders.additional_fees, '[]'::jsonb)) as fee(value)
    ),
    0
  ) as additional_fees_total,
  orders.total,
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
  ) as expected_total,
  round(
    coalesce(orders.total, 0)
    - (
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
      - coalesce(orders.discount_total, 0)
    ),
    2
  ) as difference
from public.orders;

grant select on public.order_financial_audit to authenticated, service_role;
