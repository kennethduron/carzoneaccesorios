-- Separate order status from payment and inventory transitions.

drop trigger if exists apply_order_sale_inventory_on_order_status on public.orders;

create or replace function public.apply_order_sale_inventory_from_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Order acceptance is not payment. Inventory is converted to final sale by
  -- approved payment only.
  if new.status::text = 'paid' then
    perform public.apply_order_sale_inventory(new.id, new.user_id);
  end if;

  return new;
end;
$$;

create or replace function public.apply_order_sale_inventory_from_approved_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_record public.orders%rowtype;
begin
  if new.payment_status = 'approved' or new.status = 'approved' then
    select *
    into order_record
    from public.orders
    where orders.id = new.order_id
    for update;

    perform public.apply_order_sale_inventory(new.order_id, order_record.user_id);

    update public.orders
    set
      status = case
        when orders.status::text in ('pending', 'recibido', 'paid') then 'confirmado'::public.order_status
        else orders.status
      end,
      tracking_status = case
        when orders.status::text in ('pending', 'recibido', 'paid') then 'confirmado'
        else coalesce(orders.tracking_status, orders.status::text)
      end,
      updated_at = now()
    where orders.id = new.order_id;
  end if;

  return new;
end;
$$;

drop trigger if exists apply_order_sale_inventory_on_payment_approval on public.payments;

create trigger apply_order_sale_inventory_on_payment_approval
after insert or update of payment_status, status on public.payments
for each row
when (new.payment_status = 'approved' or new.status = 'approved')
execute function public.apply_order_sale_inventory_from_approved_payment();

drop function if exists public.get_public_order_tracking(text);

create function public.get_public_order_tracking(raw_tracking_code text)
returns table (
  order_number text,
  tracking_code text,
  tracking_status text,
  order_status text,
  payment_status text,
  has_transfer_receipt boolean,
  created_at timestamptz,
  payment_method text,
  total numeric,
  customer_name_masked text,
  phone_last4 text,
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_tracking_code text := upper(trim(coalesce(raw_tracking_code, '')));
begin
  if normalized_tracking_code = '' then
    return;
  end if;

  return query
  select
    o.order_number,
    o.tracking_code,
    coalesce(o.tracking_status, o.status::text),
    o.status::text,
    coalesce(p.payment_status::text, p.status::text, 'pending'),
    coalesce(p.has_transfer_receipt, false),
    o.created_at,
    o.payment_method::text,
    o.total,
    trim(split_part(o.customer_name, ' ', 1)) || case when strpos(o.customer_name, ' ') > 0 then ' ' || left(split_part(o.customer_name, ' ', 2), 1) || '.' else '' end,
    right(regexp_replace(o.phone, '\D', '', 'g'), 4),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'sku', oi.sku,
          'product_name', oi.product_name,
          'quantity', oi.quantity,
          'unit_price', oi.unit_price,
          'line_total', oi.line_total
        )
        order by oi.created_at asc
      ) filter (where oi.id is not null),
      '[]'::jsonb
    )
  from public.orders o
  left join lateral (
    select
      payments.payment_status,
      payments.status,
      (payments.transfer_receipt_public_id is not null or payments.transfer_receipt_url is not null) as has_transfer_receipt
    from public.payments
    where payments.order_id = o.id
    order by payments.created_at desc
    limit 1
  ) p on true
  left join public.order_items oi on oi.order_id = o.id
  where upper(o.tracking_code) = normalized_tracking_code
    and o.public_tracking_enabled = true
  group by
    o.id,
    o.order_number,
    o.tracking_code,
    o.tracking_status,
    o.status,
    p.payment_status,
    p.status,
    p.has_transfer_receipt,
    o.created_at,
    o.payment_method,
    o.total,
    o.customer_name,
    o.phone;
end;
$$;

grant execute on function public.get_public_order_tracking(text) to anon, authenticated, service_role;
