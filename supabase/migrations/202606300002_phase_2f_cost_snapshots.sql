-- Phase 2F-2: cost snapshot foundation for future inventory COGS.
-- This migration is intentionally additive: nullable columns only, no backfill,
-- no accounting events, no journal entries and no auto-posting behavior.

alter table public.order_items
  add column if not exists unit_cost_snapshot numeric(12, 2),
  add column if not exists total_cost_snapshot numeric(12, 2),
  add column if not exists cost_source text,
  add column if not exists cost_captured_at timestamptz;

alter table public.inventory_movements
  add column if not exists unit_cost_snapshot numeric(12, 2),
  add column if not exists total_cost_snapshot numeric(12, 2),
  add column if not exists cost_source text,
  add column if not exists cost_captured_at timestamptz,
  add column if not exists order_item_id uuid references public.order_items(id) on delete set null;

create index if not exists inventory_movements_order_item_id_idx
  on public.inventory_movements(order_item_id);

create index if not exists inventory_movements_reference_idx
  on public.inventory_movements(reference_type, reference_id);

create or replace function public.capture_order_item_cost_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  product_unit_cost numeric(12, 2);
begin
  if new.product_id is null then
    return new;
  end if;

  if new.unit_cost_snapshot is null then
    select round(coalesce(products.cost_price, 0), 2)
    into product_unit_cost
    from public.products
    where products.id = new.product_id;

    if product_unit_cost is not null then
      new.unit_cost_snapshot := product_unit_cost;
    end if;
  end if;

  if new.total_cost_snapshot is null and new.unit_cost_snapshot is not null then
    new.total_cost_snapshot := round(new.unit_cost_snapshot * greatest(coalesce(new.quantity, 0), 0), 2);
  end if;

  if new.unit_cost_snapshot is not null or new.total_cost_snapshot is not null then
    new.cost_source := coalesce(nullif(trim(coalesce(new.cost_source, '')), ''), 'product_cost_price_at_order_creation');
    new.cost_captured_at := coalesce(new.cost_captured_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists order_items_capture_cost_snapshot on public.order_items;
create trigger order_items_capture_cost_snapshot
before insert on public.order_items
for each row
execute function public.capture_order_item_cost_snapshot();

create or replace function public.capture_inventory_movement_cost_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  movement_quantity integer := abs(coalesce(new.quantity, 0));
  matching_item_count integer := 0;
  matched_order_item_id uuid;
  matched_unit_cost numeric(12, 2);
  matched_cost_source text;
  matched_cost_captured_at timestamptz;
  product_unit_cost numeric(12, 2);
begin
  if new.movement_type <> 'sale' then
    return new;
  end if;

  if movement_quantity = 0 then
    return new;
  end if;

  if new.order_item_id is not null then
    select
      1,
      order_items.id,
      order_items.unit_cost_snapshot,
      order_items.cost_source,
      order_items.cost_captured_at
    into
      matching_item_count,
      matched_order_item_id,
      matched_unit_cost,
      matched_cost_source,
      matched_cost_captured_at
    from public.order_items
    where order_items.id = new.order_item_id
    limit 1;
  elsif new.reference_type = 'orders' and new.reference_id is not null then
    select
      count(*)::integer,
      (array_agg(order_items.id order by order_items.created_at, order_items.id))[1],
      max(order_items.unit_cost_snapshot),
      max(order_items.cost_source),
      max(order_items.cost_captured_at)
    into
      matching_item_count,
      matched_order_item_id,
      matched_unit_cost,
      matched_cost_source,
      matched_cost_captured_at
    from public.order_items
    where order_items.order_id = new.reference_id
      and order_items.product_id = new.product_id;

    if matching_item_count = 1 then
      new.order_item_id := matched_order_item_id;
    end if;
  end if;

  if new.unit_cost_snapshot is null then
    if matched_unit_cost is not null then
      new.unit_cost_snapshot := round(matched_unit_cost, 2);
    else
      select round(coalesce(products.cost_price, 0), 2)
      into product_unit_cost
      from public.products
      where products.id = new.product_id;

      if product_unit_cost is not null then
        new.unit_cost_snapshot := product_unit_cost;
      end if;
    end if;
  end if;

  if new.total_cost_snapshot is null and new.unit_cost_snapshot is not null then
    new.total_cost_snapshot := round(new.unit_cost_snapshot * movement_quantity, 2);
  end if;

  if new.unit_cost_snapshot is not null or new.total_cost_snapshot is not null then
    new.cost_source := coalesce(
      nullif(trim(coalesce(new.cost_source, '')), ''),
      nullif(trim(coalesce(matched_cost_source, '')), ''),
      case
        when matched_unit_cost is not null then 'order_item_cost_snapshot'
        else 'product_cost_price_at_inventory_movement'
      end
    );
    new.cost_captured_at := coalesce(new.cost_captured_at, matched_cost_captured_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists inventory_movements_capture_cost_snapshot on public.inventory_movements;
create trigger inventory_movements_capture_cost_snapshot
before insert on public.inventory_movements
for each row
execute function public.capture_inventory_movement_cost_snapshot();
