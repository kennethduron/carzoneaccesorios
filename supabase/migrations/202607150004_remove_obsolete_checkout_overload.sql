-- The application and all current checkout wrappers use create_checkout_order_v2,
-- which delegates to the 16-argument identity-safe checkout function.
-- Remove the obsolete 11-argument overload because it can still associate an
-- authenticated order with a customer selected by submitted email or phone.

revoke all on function public.create_checkout_order(
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
  text
) from public, anon, authenticated, service_role;

drop function public.create_checkout_order(
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
  text
);
