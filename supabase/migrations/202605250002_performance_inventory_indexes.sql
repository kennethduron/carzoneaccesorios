create index if not exists inventory_movements_product_created_at_idx
  on public.inventory_movements(product_id, created_at desc);
