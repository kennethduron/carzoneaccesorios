-- Permission-denied audit rows must survive the RPC call. Raising an exception
-- would roll back the audit insert, so public wrappers return an explicit
-- failure value and delegate authorized work to private implementations.

alter function public.set_customer_commercial_credit(uuid, boolean, numeric, integer, text, text)
  rename to set_customer_commercial_credit_authorized;

revoke all on function public.set_customer_commercial_credit_authorized(uuid, boolean, numeric, integer, text, text)
  from anon, authenticated;

create function public.set_customer_commercial_credit(
  target_customer_id uuid,
  credit_enabled boolean,
  target_credit_limit numeric,
  target_terms_days integer,
  target_status text default 'active',
  internal_notes text default null
)
returns table (
  credit_account_id uuid,
  is_credit_enabled boolean,
  credit_limit numeric,
  terms_days integer,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.commercial_credit_manage_allowed() then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      auth.uid(),
      public.current_actor_role(),
      'customer_credit_accounts',
      target_customer_id,
      'commercial_credit.permission_denied',
      jsonb_build_object(
        'customer_id', target_customer_id,
        'attempted_action', 'update_credit',
        'attempted_status', target_status,
        'credit_enabled', credit_enabled
      )
    );
    return;
  end if;

  return query
  select *
  from public.set_customer_commercial_credit_authorized(
    target_customer_id,
    credit_enabled,
    target_credit_limit,
    target_terms_days,
    target_status,
    internal_notes
  );
end;
$$;

grant execute on function public.set_customer_commercial_credit(uuid, boolean, numeric, integer, text, text)
  to authenticated;

alter function public.mark_credit_receivable_paid(uuid)
  rename to mark_credit_receivable_paid_authorized;

revoke all on function public.mark_credit_receivable_paid_authorized(uuid)
  from anon, authenticated;

create function public.mark_credit_receivable_paid(target_receivable_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (
    public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('credit:mark_paid')
  ) then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      auth.uid(),
      public.current_actor_role(),
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.permission_denied',
      jsonb_build_object('attempted_action', 'mark_paid')
    );
    return false;
  end if;

  return public.mark_credit_receivable_paid_authorized(target_receivable_id);
end;
$$;

grant execute on function public.mark_credit_receivable_paid(uuid) to authenticated;
