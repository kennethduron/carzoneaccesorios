-- Checkout orders must be created through public.create_checkout_order so totals,
-- prices, wholesale ownership, fees, CRM links, payments and inventory movements
-- are calculated in one backend transaction.

revoke insert on public.orders from anon, authenticated;
revoke insert on public.order_items from anon, authenticated;
revoke insert on public.payments from anon, authenticated;

drop policy if exists "Users can create own orders" on public.orders;
drop policy if exists "Users can create items for own orders" on public.order_items;
drop policy if exists "Users can create own payments" on public.payments;

grant execute on function public.create_checkout_order(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text
) to anon, authenticated, service_role;
