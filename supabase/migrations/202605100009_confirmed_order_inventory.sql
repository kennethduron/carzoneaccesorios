create or replace function public.apply_order_sale_inventory(target_order_id uuid, actor_user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_order public.orders%rowtype;
  item_record record;
  product_record public.products%rowtype;
  existing_sale_movements integer := 0;
  order_item_count integer := 0;
  missing_product_count integer := 0;
  stock_update_count integer := 0;
begin
  if target_order_id is null then
    raise exception 'El pedido es obligatorio para descontar inventario.';
  end if;

  select *
  into target_order
  from public.orders
  where orders.id = target_order_id
  for update;

  if target_order.id is null then
    raise exception 'No se encontro el pedido para descontar inventario.';
  end if;

  select count(*)
  into existing_sale_movements
  from public.inventory_movements
  where inventory_movements.reference_type = 'orders'
    and inventory_movements.reference_id = target_order_id
    and inventory_movements.movement_type = 'sale';

  if existing_sale_movements > 0 then
    return;
  end if;

  select count(*)
  into order_item_count
  from public.order_items
  where order_items.order_id = target_order_id;

  if order_item_count = 0 then
    raise exception 'El pedido no tiene productos para descontar inventario.';
  end if;

  select count(*)
  into missing_product_count
  from public.order_items
  where order_items.order_id = target_order_id
    and order_items.product_id is null;

  if missing_product_count > 0 then
    raise exception 'El pedido tiene productos sin referencia de inventario.';
  end if;

  for item_record in
    select
      order_items.product_id,
      sum(order_items.quantity)::integer as quantity
    from public.order_items
    where order_items.order_id = target_order_id
    group by order_items.product_id
    order by order_items.product_id
  loop
    select *
    into product_record
    from public.products
    where products.id = item_record.product_id
    for update;

    if product_record.id is null then
      raise exception 'No se encontro el producto del pedido para descontar inventario.';
    end if;

    if item_record.quantity <= 0 then
      raise exception 'El producto % tiene una cantidad invalida.', product_record.name;
    end if;

    if item_record.quantity > product_record.stock then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    update public.products
    set
      stock = product_record.stock - item_record.quantity,
      updated_at = now()
    where products.id = product_record.id
      and products.stock >= item_record.quantity;

    get diagnostics stock_update_count = row_count;

    if stock_update_count <> 1 then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    insert into public.inventory_movements (
      product_id,
      user_id,
      movement_type,
      quantity,
      stock_before,
      stock_after,
      reference_type,
      reference_id,
      notes
    )
    values (
      product_record.id,
      actor_user_id,
      'sale',
      -item_record.quantity,
      product_record.stock,
      product_record.stock - item_record.quantity,
      'orders',
      target_order_id,
      'Salida automatica por pedido confirmado'
    );
  end loop;
end;
$$;

create or replace function public.apply_order_sale_inventory_from_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('confirmado', 'confirmed', 'paid') then
    perform public.apply_order_sale_inventory(new.id, new.user_id);
  end if;

  return new;
end;
$$;

drop trigger if exists apply_order_sale_inventory_on_order_status on public.orders;

create trigger apply_order_sale_inventory_on_order_status
after update of status on public.orders
for each row
when (old.status is distinct from new.status and new.status in ('confirmado', 'confirmed', 'paid'))
execute function public.apply_order_sale_inventory_from_order_status();

create or replace function public.apply_order_sale_inventory_from_approved_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_user_id uuid;
begin
  if new.payment_status = 'approved' or new.status = 'approved' then
    select orders.user_id
    into order_user_id
    from public.orders
    where orders.id = new.order_id;

    perform public.apply_order_sale_inventory(new.order_id, order_user_id);

    update public.orders
    set
      status = 'paid',
      updated_at = now()
    where orders.id = new.order_id
      and orders.status <> 'paid';
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

grant execute on function public.apply_order_sale_inventory(uuid, uuid) to authenticated;
