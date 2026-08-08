-- Read-only POS inventory visibility. This migration intentionally changes no
-- tables, inventory enforcement, reservation lifecycle, or sale confirmation.

create or replace function public.get_pos_product_inventory_snapshot_v1(
  p_product_ids uuid[]
)
returns table (
  product_id uuid,
  tracks_inventory boolean,
  physical_stock integer,
  reserved_stock integer,
  available_stock integer,
  has_active_reservations boolean,
  stock_observed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_product_ids uuid[];
begin
  if auth.uid() is null
     or not public.pos_permission_allowed('pos:products:search') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;

  select coalesce(array_agg(candidate.product_id order by candidate.product_id), array[]::uuid[])
  into normalized_product_ids
  from (
    select distinct requested.product_id
    from unnest(coalesce(p_product_ids, array[]::uuid[])) as requested(product_id)
    where requested.product_id is not null
  ) candidate;

  if cardinality(normalized_product_ids) > 50 then
    raise exception using errcode = '22023', message = 'POS_PRODUCT_QUERY_INVALID';
  end if;

  return query
  select
    products.id,
    products.tracks_inventory,
    case when products.tracks_inventory then products.stock else null end,
    case when products.tracks_inventory then products.reserved_stock else null end,
    case when products.tracks_inventory then products.available_stock else null end,
    products.tracks_inventory and products.reserved_stock > 0,
    statement_timestamp()
  from public.products
  where products.id = any(normalized_product_ids)
  order by products.id;
end;
$$;

revoke all on function public.get_pos_product_inventory_snapshot_v1(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_pos_product_inventory_snapshot_v1(uuid[])
  to authenticated, service_role;

comment on function public.get_pos_product_inventory_snapshot_v1(uuid[]) is
  'Read-only POS inventory snapshot. Physical, reserved, and available values come directly from the canonical products row; non-tracked products return null quantities.';

create or replace function public.get_pos_product_reservations_v1(
  p_product_id uuid,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  reservation_id uuid,
  order_id uuid,
  order_number text,
  reserved_quantity integer,
  reservation_status text,
  order_status text,
  reservation_created_at timestamptz,
  expires_at timestamptz,
  review_required boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_limit integer := coalesce(p_limit, 20);
  normalized_offset integer := coalesce(p_offset, 0);
begin
  if auth.uid() is null
     or not public.pos_permission_allowed('pos:products:search')
     or not (
       public.has_permission('orders:read')
       or public.has_permission('orders:manage')
     ) then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;

  if p_product_id is null
     or normalized_limit < 1
     or normalized_limit > 50
     or normalized_offset < 0 then
    raise exception using errcode = '22023', message = 'POS_RESERVATION_QUERY_INVALID';
  end if;

  return query
  select
    reservations.id,
    reservations.order_id,
    orders.order_number,
    reservations.quantity,
    reservations.status::text,
    orders.status::text,
    reservations.created_at,
    reservations.expires_at,
    reservations.review_required,
    count(*) over ()
  from public.inventory_reservations reservations
  join public.orders on orders.id = reservations.order_id
  where reservations.product_id = p_product_id
    and reservations.status = 'reserved'
  order by
    reservations.review_required desc,
    reservations.expires_at asc,
    reservations.created_at asc,
    reservations.id asc
  limit normalized_limit
  offset normalized_offset;
end;
$$;

revoke all on function public.get_pos_product_reservations_v1(uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_pos_product_reservations_v1(uuid, integer, integer)
  to authenticated, service_role;

comment on function public.get_pos_product_reservations_v1(uuid, integer, integer) is
  'Read-only, PII-free list of active order reservations for an authorized POS product detail view.';
