-- Read-only inventory access for accounting and every role that already manages inventory.
-- This migration does not grant stock mutations or inventory movement writes.

update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || jsonb_build_array('inventory:read')
    ) as expanded(permission)
  ) deduplicated
),
updated_at = now()
where name = 'contadora'
   or coalesce(permissions, '[]'::jsonb) ? 'inventory:manage';

-- Inventory readers need the stock columns stored on products, while all write
-- policies remain bound to the existing product and inventory mutation permits.
drop policy if exists "Product staff can read all products" on public.products;
create policy "Product staff can read all products"
  on public.products for select
  using (
    public.has_permission('products:read')
    or public.has_permission('products:manage')
    or public.has_permission('inventory:read')
    or public.has_permission('inventory:manage')
  );

drop policy if exists "Inventory readers can read movements" on public.inventory_movements;
create policy "Inventory readers can read movements"
  on public.inventory_movements for select
  using (
    public.has_permission('inventory:read')
    or public.has_permission('inventory:manage')
  );

-- Preserve the existing operational readers and add the new read-only inventory scope.
drop policy if exists "Staff can read inventory reservations" on public.inventory_reservations;
create policy "Staff can read inventory reservations"
  on public.inventory_reservations for select
  using (
    public.has_permission('inventory:read')
    or public.has_permission('inventory:manage')
    or public.has_permission('orders:read')
    or public.has_permission('orders:manage')
    or public.has_permission('system:monitoring')
  );

create or replace function public.get_admin_low_stock_products(
  search_query text default null,
  result_limit integer default 50
)
returns table (
  id uuid,
  sku text,
  name text,
  stock integer,
  reserved_stock integer,
  available_stock integer,
  min_stock integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (
    coalesce(auth.role() = 'service_role', false)
    or public.has_permission('inventory:read')
    or public.has_permission('inventory:manage')
  ) then
    raise exception 'No tienes permiso para consultar inventario.' using errcode = '42501';
  end if;

  return query
  select
    products.id,
    products.sku,
    products.name,
    products.stock,
    products.reserved_stock,
    coalesce(
      products.available_stock,
      greatest(products.stock - coalesce(products.reserved_stock, 0), 0),
      products.stock,
      0
    )::integer as available_stock,
    coalesce(products.min_stock, 0)::integer as min_stock
  from public.products
  where products.active = true
    and coalesce(
      products.available_stock,
      greatest(products.stock - coalesce(products.reserved_stock, 0), 0),
      products.stock,
      0
    ) <= coalesce(products.min_stock, 0)
    and (
      coalesce(search_query, '') = ''
      or products.sku ilike '%' || search_query || '%'
      or products.internal_code ilike '%' || search_query || '%'
      or products.name ilike '%' || search_query || '%'
      or products.brand ilike '%' || search_query || '%'
    )
  order by products.name asc
  limit least(greatest(coalesce(result_limit, 50), 1), 100);
end;
$$;

revoke all on function public.get_admin_low_stock_products(text, integer) from public, anon, authenticated;
grant execute on function public.get_admin_low_stock_products(text, integer) to authenticated, service_role;

comment on function public.get_admin_low_stock_products(text, integer) is
  'Returns read-only low-stock inventory data to inventory readers and managers.';
