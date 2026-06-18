-- Ensure new fiscal invoices snapshot order charges even when invoice defaults are 0.
-- This intentionally does not backfill or recalculate existing issued invoices.
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
    new.shipping_fee := coalesce(order_fee_record.shipping_fee, 0);
    new.cash_on_delivery_fee := coalesce(order_fee_record.cash_on_delivery_fee, 0);
    new.small_order_fee := coalesce(order_fee_record.small_order_fee, 0);
    new.discount_total := coalesce(order_fee_record.discount_total, 0);
    new.additional_fees := coalesce(order_fee_record.additional_fees, '[]'::jsonb);
  else
    new.shipping_fee := coalesce(new.shipping_fee, 0);
    new.cash_on_delivery_fee := coalesce(new.cash_on_delivery_fee, 0);
    new.small_order_fee := coalesce(new.small_order_fee, 0);
    new.discount_total := coalesce(new.discount_total, 0);
    new.additional_fees := coalesce(new.additional_fees, '[]'::jsonb);
  end if;

  return new;
end;
$$;

drop trigger if exists apply_order_fees_to_invoice_on_insert on public.invoices;

create trigger apply_order_fees_to_invoice_on_insert
before insert on public.invoices
for each row
execute function public.apply_order_fees_to_invoice();
