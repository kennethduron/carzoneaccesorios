do $$
declare
  function_definition text;
begin
  select pg_get_functiondef('public.extend_order_reservation(uuid,integer,text)'::regprocedure)
  into function_definition;

  function_definition := replace(
    function_definition,
    'trim(coalesce(extension_reason, ''''))',
    'trim(coalesce(extend_order_reservation.extension_reason, ''''))'
  );
  function_definition := replace(
    function_definition,
    'trim(extension_reason)',
    'trim(extend_order_reservation.extension_reason)'
  );

  execute function_definition;

  select pg_get_functiondef('public.reject_order_payment_and_release(uuid,text)'::regprocedure)
  into function_definition;

  function_definition := replace(
    function_definition,
    'trim(coalesce(rejection_reason, ''''))',
    'trim(coalesce(reject_order_payment_and_release.rejection_reason, ''''))'
  );
  function_definition := replace(
    function_definition,
    'trim(rejection_reason)',
    'trim(reject_order_payment_and_release.rejection_reason)'
  );

  execute function_definition;
end;
$$;
