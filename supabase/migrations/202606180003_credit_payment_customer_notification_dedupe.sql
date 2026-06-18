do $$
declare
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.register_credit_receivable_payment(uuid,numeric,text,text,timestamptz,text,text,text,text)'::regprocedure
  )
  into function_definition;

  patched_definition := replace(
    function_definition,
    'values (
      case when remaining_balance = 0 then ''commercial_credit.paid_complete'' else ''commercial_credit.payment_registered'' end,
      case when remaining_balance = 0 then ''commercial_credit.paid_complete'' else ''commercial_credit.payment_registered'' end,
      ''pagos'',
      receivable_row.customer_user_id,',
    'values (
      case when remaining_balance = 0 then ''customer.commercial_credit.paid_complete'' else ''customer.commercial_credit.payment_registered'' end,
      case when remaining_balance = 0 then ''commercial_credit.paid_complete'' else ''commercial_credit.payment_registered'' end,
      ''pagos'',
      receivable_row.customer_user_id,'
  );

  if patched_definition = function_definition then
    raise exception 'Could not patch customer notification event type for credit payments.';
  end if;

  execute patched_definition;
end;
$$;
