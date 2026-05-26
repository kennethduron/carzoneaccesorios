-- Bank transfers require a bank reference for new payments. Receipts remain optional.

update public.company_settings
set
  require_bank_reference = true,
  transfer_receipt_requirement = 'optional',
  updated_at = now();

alter table public.payments
  drop constraint if exists payments_bank_reference_required_for_transfer;

alter table public.payments
  add constraint payments_bank_reference_required_for_transfer
  check (
    payment_method <> 'bank_transfer'
    or trim(coalesce(bank_reference_number, '')) ~ '^[[:alnum:] -]{4,80}$'
  ) not valid;

comment on column public.payments.bank_reference_number is
  'Numero de referencia bancaria reportado por el cliente. Obligatorio para transferencias nuevas; minimo 4, maximo 80, letras/numeros/espacios/guiones.';

comment on column public.payments.transfer_receipt_url is
  'Comprobante de transferencia opcional. La validacion administrativa puede hacerse con la referencia bancaria.';

comment on column public.company_settings.transfer_receipt_requirement is
  'El checkout publico trata el comprobante de transferencia como opcional; el campo se conserva por compatibilidad.';

drop function if exists public.get_public_order_tracking(text);

create function public.get_public_order_tracking(raw_tracking_code text)
returns table (
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
  select
    o.order_number,
    o.tracking_code,
    coalesce(o.tracking_status, o.status::text),
    o.status::text,
    coalesce(p.payment_status::text, p.status::text, 'pending'),
    coalesce(p.has_transfer_receipt, false),
    coalesce(p.has_bank_reference, false),
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
      (payments.transfer_receipt_public_id is not null or payments.transfer_receipt_url is not null) as has_transfer_receipt,
      (nullif(trim(coalesce(payments.bank_reference_number, payments.reference, '')), '') is not null) as has_bank_reference
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
    p.has_bank_reference,
    o.created_at,
    o.payment_method,
    o.total,
    o.customer_name,
    o.phone;
end;
$$;

grant execute on function public.get_public_order_tracking(text) to anon, authenticated, service_role;
