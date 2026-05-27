-- Remove ambiguous customer_phone references from the checkout RPC.
-- Postgres can confuse the function argument with orders.customer_phone inside UPDATE statements.

do $$
declare
  checkout_function text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text)'::regprocedure
  )
  into checkout_function;

  checkout_function := replace(
    checkout_function,
    'public.normalize_hn_phone(customer_phone)',
    'public.normalize_hn_phone(create_checkout_order.customer_phone)'
  );

  checkout_function := replace(
    checkout_function,
    'coalesce(normalized_customer_phone, customer_phone',
    'coalesce(normalized_customer_phone, create_checkout_order.customer_phone'
  );

  if position('coalesce(normalized_customer_phone, customer_phone' in checkout_function) > 0 then
    raise exception 'create_checkout_order still contains ambiguous customer_phone references';
  end if;

  execute checkout_function;
end;
$$;
