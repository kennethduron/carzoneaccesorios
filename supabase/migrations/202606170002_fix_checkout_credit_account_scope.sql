-- Keep commercial credit state out of normal checkout paths.
-- The previous function stored the credit row in an unassigned record when
-- payment_method was not commercial_credit, then referenced record fields in
-- shared order/payment/invoice updates.
do $$
declare
  function_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order_v2(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  if function_definition not like '%credit_account record%' and function_definition not like '%credit_account.%' then
    return;
  end if;

  patched_definition := function_definition;

  patched_definition := replace(
    patched_definition,
    '  credit_account record;',
    '  credit_account_id uuid := null;
  credit_customer_id uuid := null;
  credit_limit numeric(12, 2) := null;
  credit_terms_days integer := null;'
  );

  patched_definition := replace(
    patched_definition,
    '    select
      customer_credit_accounts.*,
      customers.id as linked_customer_id
    into credit_account',
    '    select
      customer_credit_accounts.id,
      customers.id,
      customer_credit_accounts.credit_limit,
      customer_credit_accounts.terms_days
    into credit_account_id, credit_customer_id, credit_limit, credit_terms_days'
  );

  patched_definition := replace(
    patched_definition,
    '    if credit_account.id is null then',
    '    if credit_account_id is null then'
  );

  patched_definition := replace(patched_definition, 'credit_account.linked_customer_id', 'credit_customer_id');
  patched_definition := replace(patched_definition, 'credit_account.credit_limit', 'credit_limit');
  patched_definition := replace(patched_definition, 'credit_account.terms_days', 'credit_terms_days');

  if patched_definition = function_definition then
    raise exception 'Could not patch create_checkout_order_v2 credit account scope.';
  end if;

  if patched_definition like '%credit_account record%' or patched_definition like '%credit_account.%' then
    raise exception 'create_checkout_order_v2 still contains unsafe credit_account record references.';
  end if;

  execute patched_definition;
end;
$$;
