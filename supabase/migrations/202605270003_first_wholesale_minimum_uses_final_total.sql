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

    if not has_previous_wholesale and created_order.subtotal < first_wholesale_minimum then
      missing_wholesale_minimum := first_wholesale_minimum - created_order.subtotal;
      raise exception 'Tu primera compra como mayorista debe ser de L % o mas. Agrega mas productos para completar el minimo. Te faltan L % para completar el minimo mayorista.',
        to_char(first_wholesale_minimum, 'FM999G999G990D00'),
        to_char(missing_wholesale_minimum, 'FM999G999G990D00');
    end if;
  end if;

  shipping_amount := case when created_order.subtotal >= free_shipping_threshold then 0 else standard_shipping_fee end;
  cod_amount := case
    when requested_payment_method = 'cash' and enable_cash_on_delivery_fee then round(created_order.subtotal * (cash_on_delivery_percentage / 100), 2)
    else 0
  end;
  final_total := round(created_order.subtotal + created_order.tax + shipping_amount + cod_amount + coalesce(created_order.small_order_fee, 0) - coalesce(created_order.discount_total, 0), 2);
$old$;

  new_block := $new$
  shipping_amount := case when created_order.subtotal >= free_shipping_threshold then 0 else standard_shipping_fee end;
  cod_amount := case
    when requested_payment_method = 'cash' and enable_cash_on_delivery_fee then round(created_order.subtotal * (cash_on_delivery_percentage / 100), 2)
    else 0
  end;
  final_total := round(
    created_order.subtotal
    + created_order.tax
    + shipping_amount
    + cod_amount
    + coalesce(created_order.small_order_fee, 0)
    + coalesce((
      select sum(
        case
          when fee.value ? 'amount' then (fee.value->>'amount')::numeric
          when fee.value ? 'total' then (fee.value->>'total')::numeric
          else 0
        end
      )
      from jsonb_array_elements(coalesce(created_order.additional_fees, '[]'::jsonb)) as fee(value)
    ), 0)
    - coalesce(created_order.discount_total, 0),
    2
  );

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
$new$;

  function_definition := replace(function_definition, old_block, new_block);

  if function_definition like '%created_order.subtotal < first_wholesale_minimum%' then
    raise exception 'create_checkout_order still validates first wholesale minimum against product subtotal';
  end if;

  if function_definition not like '%final_total < first_wholesale_minimum%' then
    raise exception 'create_checkout_order was not updated to validate first wholesale minimum against final total';
  end if;

  execute function_definition;
end;
$$;

comment on function public.create_checkout_order(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text
) is 'Creates checkout orders and validates first wholesale minimum against final total to pay.';
