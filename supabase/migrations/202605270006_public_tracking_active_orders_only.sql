drop function if exists public.get_public_order_tracking(text);

create function public.get_public_order_tracking(raw_tracking_code text)
returns table (
  lookup_status text,
  order_number text,
  tracking_code text,
  tracking_status text,
  order_status text,
  payment_status text,
  has_transfer_receipt boolean,
  has_bank_reference boolean,
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
  with matched_order as (
    select
      o.id,
      o.order_number,
      o.tracking_code,
      o.tracking_status,
      o.status,
      o.public_tracking_enabled,
      o.created_at,
      o.payment_method,
      o.total,
      o.customer_name,
      o.phone,
      coalesce(o.order_reservation_status, '') as order_reservation_status,
      p.payment_status,
      p.status as payment_fallback_status,
      p.has_transfer_receipt,
      p.has_bank_reference,
      (
        lower(o.status::text) in ('entregado', 'delivered', 'cancelado', 'cancelled', 'cerrado', 'closed')
        or lower(coalesce(p.payment_status::text, p.status::text, 'pending')) = 'rejected'
        or lower(coalesce(o.order_reservation_status, '')) in ('released', 'canceled', 'liberado', 'cancelado')
      ) as is_finalized_for_public_tracking
    from public.orders o
    left join lateral (
      select
        payments.payment_status,
        payments.status,
        (payments.transfer_receipt_public_id is not null or payments.transfer_receipt_url is not null) as has_transfer_receipt,
        (nullif(trim(coalesce(payments.bank_reference_number, payments.reference, '')), '') is not null) as has_bank_reference
      from public.payments
      where payments.order_id = o.id
      order by payments.created_at desc
      limit 1
    ) p on true
    where upper(o.tracking_code) = normalized_tracking_code
    order by o.created_at desc
    limit 1
  ),
  active_public_order as (
    select *
    from matched_order
    where public_tracking_enabled = true
      and is_finalized_for_public_tracking = false
  ),
  active_public_payload as (
    select
      'active'::text as lookup_status,
      o.order_number,
      o.tracking_code,
      coalesce(o.tracking_status, o.status::text) as tracking_status,
      o.status::text as order_status,
      coalesce(o.payment_status::text, o.payment_fallback_status::text, 'pending') as payment_status,
      coalesce(o.has_transfer_receipt, false) as has_transfer_receipt,
      coalesce(o.has_bank_reference, false) as has_bank_reference,
      o.created_at,
      o.payment_method::text as payment_method,
      o.total,
      trim(split_part(o.customer_name, ' ', 1)) || case when strpos(o.customer_name, ' ') > 0 then ' ' || left(split_part(o.customer_name, ' ', 2), 1) || '.' else '' end as customer_name_masked,
      right(regexp_replace(o.phone, '\D', '', 'g'), 4) as phone_last4,
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
      ) as items
    from active_public_order o
    left join public.order_items oi on oi.order_id = o.id
    group by
      o.id,
      o.order_number,
      o.tracking_code,
      o.tracking_status,
      o.status,
      o.payment_status,
      o.payment_fallback_status,
      o.has_transfer_receipt,
      o.has_bank_reference,
      o.created_at,
      o.payment_method,
      o.total,
      o.customer_name,
      o.phone
  ),
  finalized_payload as (
    select
      'finalized'::text as lookup_status,
      null::text as order_number,
      null::text as tracking_code,
      null::text as tracking_status,
      null::text as order_status,
      null::text as payment_status,
      null::boolean as has_transfer_receipt,
      null::boolean as has_bank_reference,
      null::timestamptz as created_at,
      null::text as payment_method,
      null::numeric as total,
      null::text as customer_name_masked,
      null::text as phone_last4,
      '[]'::jsonb as items
    from matched_order
    where is_finalized_for_public_tracking = true
  )
  select *
  from active_public_payload
  union all
  select *
  from finalized_payload
  limit 1;
end;
$$;

grant execute on function public.get_public_order_tracking(text) to anon, authenticated, service_role;
