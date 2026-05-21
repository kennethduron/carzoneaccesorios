-- Operational hardening for national-scale usage.
-- Keeps existing tracking codes valid, but makes newly generated public codes
-- much harder to guess and adds indexes for common private/admin searches.

create extension if not exists pg_trgm with schema extensions;

create index if not exists products_sku_trgm_idx on public.products using gin (sku extensions.gin_trgm_ops);
create index if not exists products_internal_code_trgm_idx on public.products using gin (internal_code extensions.gin_trgm_ops);
create index if not exists products_name_trgm_idx on public.products using gin (name extensions.gin_trgm_ops);
create index if not exists products_brand_trgm_idx on public.products using gin (brand extensions.gin_trgm_ops);
create index if not exists products_vehicle_brand_model_idx on public.products(vehicle_brand, vehicle_model);

create index if not exists customers_email_trgm_idx on public.customers using gin (email extensions.gin_trgm_ops);
create index if not exists customers_phone_trgm_idx on public.customers using gin (phone extensions.gin_trgm_ops);
create index if not exists customers_contact_name_trgm_idx on public.customers using gin (contact_name extensions.gin_trgm_ops);
create index if not exists customers_user_id_idx on public.customers(user_id) where user_id is not null;
create index if not exists customers_wholesale_status_idx on public.customers(is_wholesale, status, active);

create index if not exists orders_user_created_at_idx on public.orders(user_id, created_at desc) where user_id is not null;
create index if not exists orders_status_created_at_idx on public.orders(status, created_at desc);
create index if not exists order_items_order_created_at_idx on public.order_items(order_id, created_at);
create index if not exists inventory_movements_reference_idx on public.inventory_movements(reference_type, reference_id);
create index if not exists wholesale_codes_customer_status_idx on public.wholesale_codes(customer_id, status, active);

update public.roles
set permissions = permissions || '["system:monitoring"]'::jsonb
where name = 'admin'
  and not (permissions ? 'system:monitoring');

create or replace function public.generate_order_tracking_code(source_order_number text default null)
returns text
language plpgsql
set search_path = public
as $$
declare
  generated_code text;
  suffix text;
begin
  for attempt in 1..20 loop
    suffix := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 12));
    generated_code := 'TRK-CZ-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || suffix;

    if not exists (
      select 1
      from public.orders
      where orders.tracking_code = generated_code
    ) then
      return generated_code;
    end if;
  end loop;

  return 'TRK-CZ-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS') || '-' || upper(substr(encode(gen_random_bytes(12), 'hex'), 1, 16));
end;
$$;
