create index if not exists products_active_name_idx on public.products(active, name);
create index if not exists products_active_updated_at_idx on public.products(active, updated_at desc);
create index if not exists products_status_updated_at_idx on public.products(status, updated_at desc);
create index if not exists products_category_updated_at_idx on public.products(category_id, updated_at desc);
create index if not exists product_images_primary_sort_idx on public.product_images(product_id, is_primary desc, sort_order);
