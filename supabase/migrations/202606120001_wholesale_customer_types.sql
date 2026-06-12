alter table public.customers
  add column if not exists wholesale_customer_type text not null default 'new',
  add column if not exists wholesale_first_purchase_completed boolean not null default false,
  add column if not exists wholesale_first_purchase_completed_at timestamptz;

alter table public.customers
  drop constraint if exists customers_wholesale_customer_type_check;

alter table public.customers
  add constraint customers_wholesale_customer_type_check
  check (wholesale_customer_type in ('new', 'existing'));

update public.customers customer
set
  wholesale_first_purchase_completed = true,
  wholesale_first_purchase_completed_at = coalesce(
    customer.wholesale_first_purchase_completed_at,
    (
      select min(orders.created_at)
      from public.orders
      where orders.customer_id = customer.id
        and orders.price_mode = 'wholesale'
        and orders.status::text not in ('cancelado', 'cancelled')
    )
  )
where exists (
  select 1
  from public.orders
  where orders.customer_id = customer.id
    and orders.price_mode = 'wholesale'
    and orders.status::text not in ('cancelado', 'cancelled')
);

create or replace function public.has_completed_wholesale_order(target_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select
      customers.wholesale_customer_type = 'existing'
      or customers.wholesale_first_purchase_completed
      or exists (
        select 1
        from public.orders
        where orders.customer_id = customers.id
          and orders.price_mode = 'wholesale'
          and orders.status::text not in ('cancelado', 'cancelled')
      )
    from public.customers
    where customers.id = target_customer_id
  ), false);
$$;

revoke all on function public.has_completed_wholesale_order(uuid) from public, anon;
grant execute on function public.has_completed_wholesale_order(uuid) to authenticated, service_role;

create or replace function public.complete_wholesale_first_purchase(
  target_customer_id uuid,
  target_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_customer public.customers%rowtype;
begin
  perform set_config('app.wholesale_system_update', 'on', true);

  update public.customers
  set
    wholesale_first_purchase_completed = true,
    wholesale_first_purchase_completed_at = coalesce(wholesale_first_purchase_completed_at, now()),
    updated_at = now()
  where id = target_customer_id
    and wholesale_customer_type = 'new'
    and wholesale_first_purchase_completed = false
  returning *
  into updated_customer;

  if not found then
    return false;
  end if;

  perform public.write_audit_log(
    'customers',
    target_customer_id,
    'wholesale.first_purchase_completed',
    jsonb_build_object(
      'wholesale_customer_type', updated_customer.wholesale_customer_type,
      'wholesale_first_purchase_completed', false
    ),
    jsonb_build_object(
      'wholesale_customer_type', updated_customer.wholesale_customer_type,
      'wholesale_first_purchase_completed', true,
      'wholesale_first_purchase_completed_at', updated_customer.wholesale_first_purchase_completed_at,
      'order_id', target_order_id
    )
  );

  return true;
end;
$$;

revoke all on function public.complete_wholesale_first_purchase(uuid, uuid) from public, anon;
revoke all on function public.complete_wholesale_first_purchase(uuid, uuid) from authenticated;
grant execute on function public.complete_wholesale_first_purchase(uuid, uuid) to service_role;

create or replace function public.protect_wholesale_customer_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role_name text := public.current_actor_role();
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if current_setting('app.wholesale_system_update', true) = 'on' then
    return new;
  end if;

  if actor_role_name in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('wholesale:manage') then
    return new;
  end if;

  raise exception 'Solo technical_owner, business_owner o admin pueden modificar la configuración mayorista.';
end;
$$;

drop trigger if exists protect_wholesale_customer_fields_trigger on public.customers;
create trigger protect_wholesale_customer_fields_trigger
before update of
  is_wholesale,
  wholesale_status,
  wholesale_approved_at,
  wholesale_approved_notice_seen,
  wholesale_customer_type,
  wholesale_first_purchase_completed,
  wholesale_first_purchase_completed_at
on public.customers
for each row
when (
  old.is_wholesale is distinct from new.is_wholesale
  or old.wholesale_status is distinct from new.wholesale_status
  or old.wholesale_approved_at is distinct from new.wholesale_approved_at
  or old.wholesale_approved_notice_seen is distinct from new.wholesale_approved_notice_seen
  or old.wholesale_customer_type is distinct from new.wholesale_customer_type
  or old.wholesale_first_purchase_completed is distinct from new.wholesale_first_purchase_completed
  or old.wholesale_first_purchase_completed_at is distinct from new.wholesale_first_purchase_completed_at
)
execute function public.protect_wholesale_customer_fields();

drop policy if exists "Authorized users can manage wholesale customer state" on public.customers;
create policy "Authorized users can manage wholesale customer state"
  on public.customers for update
  using (
    public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('wholesale:manage')
  )
  with check (
    public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('wholesale:manage')
  );

do $$
declare
  function_definition text;
  old_block text;
  new_block text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  old_block := $old$
  if requested_price_mode = 'wholesale' and first_wholesale_minimum > 0 then
    select exists (
      select 1
      from public.orders previous_orders
      where previous_orders.customer_id = created_order.customer_id
        and previous_orders.price_mode = 'wholesale'
        and previous_orders.status::text not in ('cancelado', 'cancelled')
        and previous_orders.id <> created_order.id
    )
    into has_previous_wholesale;

    if not has_previous_wholesale and final_total < first_wholesale_minimum then
      missing_wholesale_minimum := first_wholesale_minimum - final_total;
      raise exception 'Tu primera compra mayorista debe alcanzar un total final de L % o mas. Te faltan L % para completar el minimo de primera compra mayorista.',
        to_char(first_wholesale_minimum, 'FM999G999G990D00'),
        to_char(missing_wholesale_minimum, 'FM999G999G990D00');
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
      )
    into has_previous_wholesale
    from public.customers
    where customers.id = created_order.customer_id;

    if not coalesce(has_previous_wholesale, false)
      and first_wholesale_minimum > 0
      and final_total < first_wholesale_minimum then
      missing_wholesale_minimum := first_wholesale_minimum - final_total;
      raise exception 'Para activar tu primera compra mayorista, el monto mínimo debe ser de L %. Después de tu primera compra mayorista, podrás comprar cualquier monto. Te faltan L %.',
        to_char(first_wholesale_minimum, 'FM999G999G990D00'),
        to_char(missing_wholesale_minimum, 'FM999G999G990D00');
    end if;

    if not coalesce(has_previous_wholesale, false) then
      perform public.complete_wholesale_first_purchase(created_order.customer_id, created_order.id);
    end if;
  end if;
$new$;

  function_definition := replace(function_definition, old_block, new_block);

  if function_definition like '%select exists (%previous_orders.customer_id = created_order.customer_id%' then
    raise exception 'create_checkout_order still uses the legacy wholesale minimum validation';
  end if;

  if function_definition not like '%complete_wholesale_first_purchase(created_order.customer_id, created_order.id)%' then
    raise exception 'create_checkout_order was not updated for wholesale customer types';
  end if;

  execute function_definition;
end;
$$;

comment on column public.customers.wholesale_customer_type is
  'Approved wholesale classification: new requires the first-purchase minimum; existing bypasses it.';
comment on column public.customers.wholesale_first_purchase_completed is
  'True after a new wholesale customer creates the first valid wholesale order.';
comment on function public.has_completed_wholesale_order(uuid) is
  'Returns true when the wholesale minimum no longer applies, including existing wholesale customers.';
