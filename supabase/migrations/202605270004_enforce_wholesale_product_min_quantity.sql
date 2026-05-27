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
  minimum_wholesale_quantity integer := 1;
begin
  if new.product_id is null then
    return new;
  end if;

  select
    products.name,
    products.retail_price,
    products.wholesale_price,
    coalesce(products.wholesale_min_quantity, 1) as wholesale_min_quantity
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

  minimum_wholesale_quantity := greatest(1, coalesce(product_row.wholesale_min_quantity, 1));

  if effective_mode = 'wholesale'
    and minimum_wholesale_quantity > 1
    and coalesce(new.quantity, 0) < minimum_wholesale_quantity then
    raise exception 'Este producto requiere una compra mínima de % unidades para precio mayorista.', minimum_wholesale_quantity
      using detail = format(
        'Producto % requiere mínimo mayorista % y la cantidad solicitada fue %.',
        coalesce(product_row.name, new.product_id::text),
        minimum_wholesale_quantity,
        coalesce(new.quantity, 0)
      );
  end if;

  new.applied_price_mode := effective_mode;
  new.unit_price := effective_unit_price;
  new.line_total := round(effective_unit_price * greatest(coalesce(new.quantity, 0), 0), 2);
  new.retail_price_snapshot := round(coalesce(product_row.retail_price, 0), 2);
  new.wholesale_price_snapshot := round(coalesce(product_row.wholesale_price, 0), 2);

  return new;
end;
$$;

drop trigger if exists apply_order_item_authorized_price_before_write on public.order_items;

create trigger apply_order_item_authorized_price_before_write
before insert or update of product_id, quantity, applied_price_mode, unit_price, line_total on public.order_items
for each row
execute function public.apply_order_item_authorized_price();

comment on function public.apply_order_item_authorized_price() is
  'Applies authorized order item pricing and blocks wholesale lines below products.wholesale_min_quantity.';
