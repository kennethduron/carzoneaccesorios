do $$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order_v2(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  function_definition := replace(
    function_definition,
    'else bank_reference_number',
    'else create_checkout_order_v2.bank_reference_number'
  );

  if function_definition not like '%else create_checkout_order_v2.bank_reference_number%' then
    raise exception 'create_checkout_order_v2 bank reference ambiguity was not fixed';
  end if;

  execute function_definition;
end;
$$;
