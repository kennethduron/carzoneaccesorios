-- Customer-facing price visibility and explicit New badge control.

alter table public.products
  add column if not exists is_new boolean not null default false;

comment on column public.products.is_new is 'Controls whether the public catalog shows the Nuevo badge for this product.';

create index if not exists products_is_new_idx on public.products(is_new)
where is_new = true;

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

  if effective_mode = 'wholesale'
    and product_row.wholesale_price > 0
    and product_row.wholesale_price < product_row.retail_price then
    effective_unit_price := round(product_row.wholesale_price, 2);
  else
    effective_mode := 'retail';
    effective_unit_price := round(product_row.retail_price, 2);
  end if;

  new.applied_price_mode := effective_mode;
  new.unit_price := effective_unit_price;
  new.line_total := round(effective_unit_price * greatest(coalesce(new.quantity, 0), 0), 2);
  new.retail_price_snapshot := round(product_row.retail_price, 2);
  new.wholesale_price_snapshot := round(product_row.wholesale_price, 2);

  return new;
end;
$$;

drop trigger if exists apply_order_item_authorized_price_before_write on public.order_items;

create trigger apply_order_item_authorized_price_before_write
before insert or update of product_id, quantity, applied_price_mode, unit_price, line_total on public.order_items
for each row
execute function public.apply_order_item_authorized_price();
