drop index if exists products_search_idx;

create index if not exists products_search_idx
  on public.products using gin (
    to_tsvector(
      'simple',
      coalesce(sku, '') || ' ' ||
      coalesce(internal_code, '') || ' ' ||
      coalesce(name, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(vehicle_brand, '') || ' ' ||
      coalesce(vehicle_model, '') || ' ' ||
      coalesce(short_description, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(features, '') || ' ' ||
      coalesce(specifications, '') || ' ' ||
      coalesce(compatibility_notes, '')
    )
  );

create index if not exists products_active_vehicle_brand_model_idx
  on public.products(active, vehicle_brand, vehicle_model);
