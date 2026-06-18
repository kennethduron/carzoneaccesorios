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
    '  insert into public.accounts_receivable_payments (
    receivable_id,
    customer_id,
    order_id,
    amount,
    payment_method,
    reference,
    received_at,
    note,
    receipt_url,
    receipt_public_id,
    recorded_by,
    idempotency_key
  )
  values (
    receivable_row.id,
    receivable_row.customer_id,
    receivable_row.order_id,
    normalized_amount,
    normalized_method,
    normalized_reference,
    normalized_received_at,
    normalized_note,
    normalized_receipt_url,
    normalized_receipt_public_id,
    actor_id,
    normalized_request_key
  )
  returning * into saved_payment;',
    '  begin
    insert into public.accounts_receivable_payments (
      receivable_id,
      customer_id,
      order_id,
      amount,
      payment_method,
      reference,
      received_at,
      note,
      receipt_url,
      receipt_public_id,
      recorded_by,
      idempotency_key
    )
    values (
      receivable_row.id,
      receivable_row.customer_id,
      receivable_row.order_id,
      normalized_amount,
      normalized_method,
      normalized_reference,
      normalized_received_at,
      normalized_note,
      normalized_receipt_url,
      normalized_receipt_public_id,
      actor_id,
      normalized_request_key
    )
    returning * into saved_payment;
  exception
    when unique_violation then
      if normalized_request_key is null then
        raise;
      end if;

      select *
        into saved_payment
        from public.accounts_receivable_payments
        where idempotency_key = normalized_request_key
        limit 1;

      if saved_payment.id is null then
        raise;
      end if;

      select round(coalesce(sum(amount), 0), 2)
        into paid_total
        from public.accounts_receivable_payments
        where receivable_id = saved_payment.receivable_id
          and voided_at is null;

      select ar.status, ar.balance_due
        into receivable_status, balance_due
        from public.accounts_receivable ar
        where ar.id = saved_payment.receivable_id;

      payment_id := saved_payment.id;
      total_paid := paid_total;
      queued_email_id := null;
      return next;
      return;
  end;'
  );

  if patched_definition = function_definition then
    raise exception 'Could not patch register_credit_receivable_payment idempotency unique retry.';
  end if;

  execute patched_definition;
end;
$$;
