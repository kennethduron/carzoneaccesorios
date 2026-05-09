do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_status') then
    create type public.product_status as enum ('active', 'inactive', 'draft', 'archived');
  end if;
end;
$$;

alter table public.products
  add column if not exists internal_code text,
  add column if not exists wholesale_min_quantity integer not null default 1 check (wholesale_min_quantity > 0),
  add column if not exists min_stock integer not null default 5 check (min_stock >= 0),
  add column if not exists cost_price numeric(12, 2) not null default 0 check (cost_price >= 0),
  add column if not exists status public.product_status not null default 'active';

alter table public.product_images
  add column if not exists angle text not null default 'principal';

update public.products
set min_stock = low_stock_threshold
where min_stock = 5
  and low_stock_threshold is not null;

update public.products
set status = case when active then 'active'::public.product_status else 'inactive'::public.product_status end
where status is null
   or (active = false and status = 'active');

create unique index if not exists products_internal_code_idx
  on public.products(internal_code)
  where internal_code is not null;

create index if not exists products_status_idx on public.products(status);
create index if not exists products_brand_idx on public.products(brand);
create index if not exists products_stock_idx on public.products(stock);
create index if not exists products_retail_price_idx on public.products(retail_price);
create index if not exists products_wholesale_price_idx on public.products(wholesale_price);
create index if not exists products_search_idx
  on public.products using gin (
    to_tsvector(
      'simple',
      coalesce(sku, '') || ' ' ||
      coalesce(internal_code, '') || ' ' ||
      coalesce(name, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(description, '')
    )
  );

create index if not exists product_images_angle_idx
  on public.product_images(product_id, angle, sort_order);
