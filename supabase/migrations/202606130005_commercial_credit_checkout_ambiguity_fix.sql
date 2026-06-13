-- Patch the already-deployed checkout function without duplicating its full
-- definition. The output variable order_id conflicts with an unqualified
-- invoices.order_id reference added by the credit migration.
do $$
declare
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order_v2(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  patched_definition := replace(
    function_definition,
    'where order_id = created_order.order_id
      and status = ''draft'';',
    'where invoices.order_id = created_order.order_id
      and invoices.status = ''draft'';'
  );

  if patched_definition = function_definition then
    raise exception 'Could not locate the ambiguous invoice draft predicate.';
  end if;

  execute patched_definition;
end;
$$;
