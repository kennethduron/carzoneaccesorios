create or replace function public.has_completed_wholesale_order(target_customer_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  minimum_amount numeric(12, 2) := 10000;
  bypasses_minimum boolean;
begin
  select coalesce(company_settings.first_wholesale_minimum, 10000)
  into minimum_amount
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  select
    customers.wholesale_customer_type = 'existing'
    or customers.wholesale_first_purchase_completed
    or exists (
      select 1
      from public.orders
      where orders.customer_id = customers.id
        and orders.price_mode = 'wholesale'
        and orders.status::text not in ('cancelado', 'cancelled')
        and (minimum_amount <= 0 or coalesce(orders.total, orders.subtotal, 0) >= minimum_amount)
    )
  into bypasses_minimum
  from public.customers
  where customers.id = target_customer_id;

  return coalesce(bypasses_minimum, false);
end;
$$;

revoke all on function public.has_completed_wholesale_order(uuid) from public, anon;
grant execute on function public.has_completed_wholesale_order(uuid) to authenticated, service_role;

create or replace function public.sync_wholesale_first_purchase_state(target_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_completed boolean;
  customer_type text;
  first_order_id uuid;
  first_order_at timestamptz;
  minimum_amount numeric(12, 2) := 10000;
  next_completed boolean;
begin
  if target_customer_id is null then
    return;
  end if;

  select coalesce(company_settings.first_wholesale_minimum, 10000)
  into minimum_amount
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  select
    customers.wholesale_customer_type,
    customers.wholesale_first_purchase_completed
  into customer_type, current_completed
  from public.customers
  where customers.id = target_customer_id
  for update;

  if not found or customer_type <> 'new' then
    return;
  end if;

  select orders.id, orders.created_at
  into first_order_id, first_order_at
  from public.orders
  where orders.customer_id = target_customer_id
    and orders.price_mode = 'wholesale'
    and orders.status::text not in ('cancelado', 'cancelled')
    and (minimum_amount <= 0 or coalesce(orders.total, orders.subtotal, 0) >= minimum_amount)
  order by orders.created_at asc
  limit 1;

  next_completed := first_order_id is not null;

  if current_completed is not distinct from next_completed then
    return;
  end if;

  perform set_config('app.wholesale_system_update', 'on', true);

  update public.customers
  set
    wholesale_first_purchase_completed = next_completed,
    wholesale_first_purchase_completed_at = case when next_completed then first_order_at else null end,
    updated_at = now()
  where id = target_customer_id;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    auth.uid(),
    public.current_actor_role(),
    'customers',
    target_customer_id,
    case
      when next_completed then 'wholesale.first_purchase_completed'
      else 'wholesale.first_purchase_reopened'
    end,
    jsonb_build_object('wholesale_first_purchase_completed', current_completed),
    jsonb_build_object(
      'wholesale_first_purchase_completed', next_completed,
      'wholesale_first_purchase_completed_at', case when next_completed then first_order_at else null end,
      'first_wholesale_minimum', minimum_amount,
      'order_id', first_order_id
    )
  );
end;
$$;

revoke all on function public.sync_wholesale_first_purchase_state(uuid) from public, anon, authenticated;
grant execute on function public.sync_wholesale_first_purchase_state(uuid) to service_role;

create or replace function public.sync_wholesale_first_purchase_from_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.sync_wholesale_first_purchase_state(old.customer_id);
    return old;
  end if;

  perform public.sync_wholesale_first_purchase_state(new.customer_id);

  if tg_op = 'UPDATE' and old.customer_id is distinct from new.customer_id then
    perform public.sync_wholesale_first_purchase_state(old.customer_id);
  end if;

  return new;
end;
$$;

drop trigger if exists sync_wholesale_first_purchase_from_order_trigger on public.orders;
create constraint trigger sync_wholesale_first_purchase_from_order_trigger
after insert or update or delete
on public.orders
deferrable initially deferred
for each row
execute function public.sync_wholesale_first_purchase_from_order();

do $$
declare
  function_definition text;
  old_block text;
  new_block text;
  old_fragment text;
  new_fragment text;
  customer_record record;
begin
  select pg_get_functiondef(
    'public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  old_fragment := $old_fragment$
          and previous_orders.id <> created_order.id
      )
$old_fragment$;

  new_fragment := $new_fragment$
          and previous_orders.id <> created_order.id
          and (
            first_wholesale_minimum <= 0
            or coalesce(previous_orders.total, previous_orders.subtotal, 0) >= first_wholesale_minimum
          )
      )
$new_fragment$;

  if function_definition not like '%coalesce(previous_orders.total, previous_orders.subtotal, 0) >= first_wholesale_minimum%' then
    function_definition := replace(function_definition, old_fragment, new_fragment);
  end if;

  old_block := $old$
  if requested_price_mode = 'wholesale' then
    select
      customers.wholesale_customer_type = 'existing'
      or customers.wholesale_first_purchase_completed
      or exists (
        select 1
        from public.orders previous_orders
        where previous_orders.customer_id = created_order.customer_id
          and previous_orders.price_mode = 'wholesale'
          and previous_orders.status::text not in ('cancelado', 'cancelled')
          and previous_orders.id <> created_order.id
      )
    into has_previous_wholesale
    from public.customers
    where customers.id = created_order.customer_id;

    if not coalesce(has_previous_wholesale, false)
      and first_wholesale_minimum > 0
      and final_total < first_wholesale_minimum then
      missing_wholesale_minimum := first_wholesale_minimum - final_total;
      raise exception 'Para activar tu primera compra mayorista, el monto mÃ­nimo debe ser de L %. DespuÃ©s de tu primera compra mayorista, podrÃ¡s comprar cualquier monto. Te faltan L %.',
        to_char(first_wholesale_minimum, 'FM999G999G990D00'),
        to_char(missing_wholesale_minimum, 'FM999G999G990D00');
    end if;

    if not coalesce(has_previous_wholesale, false) then
      perform public.complete_wholesale_first_purchase(created_order.customer_id, created_order.id);
    end if;
  end if;
$old$;

  new_block := $new$
  if requested_price_mode = 'wholesale' then
    select
      customers.wholesale_customer_type = 'existing'
      or customers.wholesale_first_purchase_completed
      or exists (
        select 1
        from public.orders previous_orders
        where previous_orders.customer_id = created_order.customer_id
          and previous_orders.price_mode = 'wholesale'
          and previous_orders.status::text not in ('cancelado', 'cancelled')
          and previous_orders.id <> created_order.id
          and (
            first_wholesale_minimum <= 0
            or coalesce(previous_orders.total, previous_orders.subtotal, 0) >= first_wholesale_minimum
          )
      )
    into has_previous_wholesale
    from public.customers
    where customers.id = created_order.customer_id;

    if not coalesce(has_previous_wholesale, false)
      and first_wholesale_minimum > 0
      and final_total < first_wholesale_minimum then
      missing_wholesale_minimum := first_wholesale_minimum - final_total;
      raise exception 'Para activar tu primera compra mayorista, el monto mÃ­nimo debe ser de L %. DespuÃ©s de tu primera compra mayorista, podrÃ¡s comprar cualquier monto. Te faltan L %.',
        to_char(first_wholesale_minimum, 'FM999G999G990D00'),
        to_char(missing_wholesale_minimum, 'FM999G999G990D00');
    end if;

    if not coalesce(has_previous_wholesale, false) then
      perform public.complete_wholesale_first_purchase(created_order.customer_id, created_order.id);
    end if;
  end if;
$new$;

  function_definition := replace(function_definition, old_block, new_block);

  if function_definition like '%and previous_orders.id <> created_order.id
      )
    into has_previous_wholesale%' then
    raise exception 'create_checkout_order still counts any previous wholesale order as first-purchase completion';
  end if;

  if function_definition not like '%coalesce(previous_orders.total, previous_orders.subtotal, 0) >= first_wholesale_minimum%' then
    raise exception 'create_checkout_order was not updated to require a valid previous wholesale order';
  end if;

  execute function_definition;

  for customer_record in
    select customers.id
    from public.customers
    where customers.wholesale_customer_type = 'new'
  loop
    perform public.sync_wholesale_first_purchase_state(customer_record.id);
  end loop;
end;
$$;

comment on function public.sync_wholesale_first_purchase_state(uuid) is
  'Keeps first wholesale purchase completion aligned with non-cancelled wholesale orders that satisfy the current first-purchase minimum.';
comment on function public.has_completed_wholesale_order(uuid) is
  'Returns true when the wholesale minimum no longer applies: existing customer, persisted valid first purchase, or valid non-cancelled wholesale order.';
