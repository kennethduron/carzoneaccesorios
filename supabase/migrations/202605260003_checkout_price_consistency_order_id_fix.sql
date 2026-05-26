-- Keep product pricing deterministic and remove ambiguous order_id references in checkout.

create or replace function public.get_authorized_product_price(
  retail_price numeric,
  wholesale_price numeric,
  requested_price_mode public.order_price_mode
)
returns numeric
language sql
immutable
as $$
  select round(
    case
      when requested_price_mode = 'wholesale'
        and coalesce(wholesale_price, 0) > 0
        and (
          retail_price is null
          or wholesale_price <= retail_price
        )
      then wholesale_price
      else coalesce(retail_price, 0)
    end,
    2
  );
$$;

comment on function public.get_authorized_product_price(numeric, numeric, public.order_price_mode) is
  'Central pricing rule: approved wholesale uses valid wholesale_price; otherwise retail_price.';

create or replace function public.apply_order_item_authorized_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  product_row record;
  effective_mode public.order_price_mode := coalesce(new.applied_price_mode, 'retail'::public.order_price_mode);
  effective_unit_price numeric(12, 2);
begin
  if new.product_id is null then
    return new;
  end if;

  select products.retail_price, products.wholesale_price
  into product_row
  from public.products
  where products.id = new.product_id;

  if product_row is null then
    return new;
  end if;

  effective_unit_price := public.get_authorized_product_price(product_row.retail_price, product_row.wholesale_price, effective_mode);

  if effective_mode = 'wholesale' and effective_unit_price <> round(coalesce(product_row.wholesale_price, 0), 2) then
    effective_mode := 'retail';
  end if;

  new.applied_price_mode := effective_mode;
  new.unit_price := effective_unit_price;
  new.line_total := round(effective_unit_price * greatest(coalesce(new.quantity, 0), 0), 2);
  new.retail_price_snapshot := round(coalesce(product_row.retail_price, 0), 2);
  new.wholesale_price_snapshot := round(coalesce(product_row.wholesale_price, 0), 2);

  return new;
end;
$$;

do $$
declare
  checkout_function text;
begin
  select pg_get_functiondef(
    'public.create_checkout_order(text,text,text,text,text,public.order_price_mode,public.payment_method,text,jsonb,text,uuid,text,text,text,text,text)'::regprocedure
  )
  into checkout_function;

  checkout_function := replace(
    checkout_function,
    $old$
    update public.order_items oi
    set
      applied_price_mode = 'wholesale',
      unit_price = round(products.wholesale_price, 2),
      line_total = round(products.wholesale_price * oi.quantity, 2),
      retail_price_snapshot = round(products.retail_price, 2),
      wholesale_price_snapshot = round(products.wholesale_price, 2)
    from public.products
    where oi.order_id = legacy_row.order_id
      and products.id = oi.product_id;
$old$,
    $new$
    update public.order_items oi
    set
      applied_price_mode = case
        when public.get_authorized_product_price(products.retail_price, products.wholesale_price, 'wholesale') = round(coalesce(products.wholesale_price, 0), 2)
        then 'wholesale'::public.order_price_mode
        else 'retail'::public.order_price_mode
      end,
      unit_price = public.get_authorized_product_price(products.retail_price, products.wholesale_price, 'wholesale'),
      line_total = round(public.get_authorized_product_price(products.retail_price, products.wholesale_price, 'wholesale') * oi.quantity, 2),
      retail_price_snapshot = round(coalesce(products.retail_price, 0), 2),
      wholesale_price_snapshot = round(coalesce(products.wholesale_price, 0), 2)
    from public.products
    where oi.order_id = legacy_row.order_id
      and products.id = oi.product_id;
$new$
  );

  checkout_function := replace(
    checkout_function,
    $old$
    update public.payments
    set customer_id = authorized_wholesale_customer_id,
        amount = wholesale_subtotal + wholesale_tax,
        updated_at = now()
    where order_id = legacy_row.order_id;
$old$,
    $new$
    update public.payments
    set customer_id = authorized_wholesale_customer_id,
        amount = wholesale_subtotal + wholesale_tax,
        updated_at = now()
    where payments.order_id = legacy_row.order_id;
$new$
  );

  checkout_function := replace(
    checkout_function,
    $old$
    update public.payments
    set customer_id = account_customer_id,
        updated_at = now()
    where order_id = legacy_row.order_id;
$old$,
    $new$
    update public.payments
    set customer_id = account_customer_id,
        updated_at = now()
    where payments.order_id = legacy_row.order_id;
$new$
  );

  checkout_function := replace(
    checkout_function,
    $old$
    update public.invoices
    set customer_id = account_customer_id,
        customer_email = account_email,
        updated_at = now()
    where order_id = legacy_row.order_id;
$old$,
    $new$
    update public.invoices
    set customer_id = account_customer_id,
        customer_email = account_email,
        updated_at = now()
    where invoices.order_id = legacy_row.order_id;
$new$
  );

  checkout_function := replace(
    checkout_function,
    $old$
    update public.crm_followups
    set customer_id = account_customer_id
    where order_id = legacy_row.order_id;
$old$,
    $new$
    update public.crm_followups
    set customer_id = account_customer_id
    where crm_followups.order_id = legacy_row.order_id;
$new$
  );

  checkout_function := replace(
    checkout_function,
    $old$
    update public.crm_notes
    set customer_id = account_customer_id
    where order_id = legacy_row.order_id;
$old$,
    $new$
    update public.crm_notes
    set customer_id = account_customer_id
    where crm_notes.order_id = legacy_row.order_id;
$new$
  );

  if position('where order_id = legacy_row.order_id' in checkout_function) > 0 then
    raise exception 'create_checkout_order still contains an unqualified order_id reference';
  end if;

  execute checkout_function;
end;
$$;
