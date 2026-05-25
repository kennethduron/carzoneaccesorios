alter table public.products
  add column if not exists short_description text,
  add column if not exists features text,
  add column if not exists specifications text,
  add column if not exists compatibility_notes text;

alter table public.products
  drop constraint if exists products_short_description_length;

alter table public.products
  add constraint products_short_description_length
  check (short_description is null or char_length(short_description) <= 160);

drop index if exists products_search_idx;

create index if not exists products_search_idx
  on public.products using gin (
    to_tsvector(
      'simple',
      coalesce(sku, '') || ' ' ||
      coalesce(internal_code, '') || ' ' ||
      coalesce(name, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(short_description, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(features, '') || ' ' ||
      coalesce(specifications, '') || ' ' ||
      coalesce(compatibility_notes, '')
    )
  );

comment on column public.products.short_description is 'Resumen comercial corto para cards y SEO. Maximo 160 caracteres.';
comment on column public.products.features is 'Caracteristicas visibles en la pagina de detalle del producto.';
comment on column public.products.specifications is 'Especificaciones tecnicas visibles en la pagina de detalle del producto.';
comment on column public.products.compatibility_notes is 'Notas de compatibilidad adicionales visibles en la pagina de detalle del producto.';
