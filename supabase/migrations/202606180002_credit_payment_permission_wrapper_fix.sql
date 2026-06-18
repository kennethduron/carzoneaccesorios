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
    'if actor_role_name not in (''technical_owner'', ''business_owner'', ''admin'')
     or not public.has_permission(''credit:mark_paid'') then',
    'if actor_role_name not in (''technical_owner'', ''business_owner'', ''admin'') then'
  );

  if patched_definition = function_definition then
    raise exception 'Could not patch register_credit_receivable_payment permission check.';
  end if;

  execute patched_definition;
end;
$$;

create or replace function public.mark_credit_receivable_paid(
  target_receivable_id uuid,
  received_payment_method text,
  payment_reference text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  receivable_row record;
  result_row record;
begin
  if actor_role_name not in ('technical_owner', 'business_owner', 'admin') then
    insert into public.audit_logs (table_name, record_id, action, user_id, actor_role, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_permission_denied',
      actor_id,
      actor_role_name,
      jsonb_build_object('attempted_action', 'mark_paid')
    );
    return false;
  end if;

  select id, balance_due
    into receivable_row
    from public.accounts_receivable
    where id = target_receivable_id
    for update;

  if receivable_row.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  if receivable_row.balance_due <= 0 then
    insert into public.audit_logs (table_name, record_id, action, user_id, actor_role, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.paid_edit_denied',
      actor_id,
      actor_role_name,
      jsonb_build_object('attempted_action', 'mark_paid_without_balance')
    );
    return false;
  end if;

  for result_row in
    select *
    from public.register_credit_receivable_payment(
      target_receivable_id,
      receivable_row.balance_due,
      received_payment_method,
      payment_reference,
      now(),
      'Marcado como pagado desde accion rapida.',
      null,
      null,
      'mark-paid:' || target_receivable_id::text || ':' || extract(epoch from now())::text
    )
  loop
    return true;
  end loop;

  return false;
end;
$$;

grant execute on function public.mark_credit_receivable_paid(uuid, text, text) to authenticated;
