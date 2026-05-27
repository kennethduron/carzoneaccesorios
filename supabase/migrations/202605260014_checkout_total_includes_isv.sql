do $$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  function_definition := replace(
    function_definition,
    'final_total := round(created_order.subtotal + shipping_amount + cod_amount, 2);',
    'final_total := round(created_order.subtotal + created_order.tax + shipping_amount + cod_amount + coalesce(created_order.small_order_fee, 0) - coalesce(created_order.discount_total, 0), 2);'
  );

  if function_definition not like '%created_order.subtotal + created_order.tax + shipping_amount + cod_amount%' then
    raise exception 'create_checkout_order total formula was not updated to include ISV';
  end if;

  execute function_definition;
end;
$$;

comment on function public.create_checkout_order(
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
) is 'Creates checkout orders with final total = subtotal + ISV + persisted fees - discounts.';
