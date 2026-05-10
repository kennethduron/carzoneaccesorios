alter table public.products
  add column if not exists vehicle_brand text,
  add column if not exists vehicle_model text,
  add column if not exists vehicle_year_start integer check (vehicle_year_start is null or vehicle_year_start between 1900 and 2100),
  add column if not exists vehicle_year_end integer check (vehicle_year_end is null or vehicle_year_end between 1900 and 2100);

alter table public.products
  drop constraint if exists products_vehicle_year_range_valid;

alter table public.products
  add constraint products_vehicle_year_range_valid
  check (
    vehicle_year_start is null
    or vehicle_year_end is null
    or vehicle_year_start <= vehicle_year_end
  );

create index if not exists products_vehicle_brand_idx on public.products(vehicle_brand);
create index if not exists products_vehicle_model_idx on public.products(vehicle_model);
create index if not exists products_vehicle_year_range_idx on public.products(vehicle_year_start, vehicle_year_end);

comment on column public.products.vehicle_brand is 'Marca del carro compatible con el producto, si aplica.';
comment on column public.products.vehicle_model is 'Modelo del carro compatible con el producto, si aplica.';
comment on column public.products.vehicle_year_start is 'Primer anio de carro compatible, si aplica.';
comment on column public.products.vehicle_year_end is 'Ultimo anio de carro compatible, si aplica.';
