-- Canonical product taxonomy requested by the business owner.
-- Existing products with null or unknown categories are intentionally left untouched.

create or replace function public.preserve_product_updated_at_during_category_migration()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := old.updated_at;
  return new;
end;
$$;

drop trigger if exists zz_products_preserve_updated_at_category_migration on public.products;
create trigger zz_products_preserve_updated_at_category_migration
before update of category_id on public.products
for each row
execute function public.preserve_product_updated_at_during_category_migration();

do $$
declare
  category_spec record;
  chosen_id uuid;
  candidate_ids uuid[];
begin
  for category_spec in
    select *
    from (
      values
        ('Exterior'::text, 'exterior'::text, 10, array['Exterior']::text[], array['exterior']::text[]),
        ('Interior', 'interior', 20, array['Interior', 'Tecnologia', 'Tecnología'], array['interior', 'tecnologia']),
        ('Iluminación', 'iluminacion', 30, array['Iluminación', 'Iluminacion', 'Luces'], array['iluminacion', 'luces']),
        (
          'Polarizado y Herramientas',
          'polarizado-y-herramientas',
          40,
          array['Polarizado y Herramientas', 'Herramientas'],
          array['polarizado-y-herramientas', 'herramientas']
        ),
        ('Carrocería', 'carroceria', 50, array['Carrocería', 'Carroceria'], array['carroceria']),
        ('Seguridad', 'seguridad', 60, array['Seguridad'], array['seguridad']),
        ('Audio y Sonido', 'audio-y-sonido', 70, array['Audio y Sonido', 'Audio'], array['audio-y-sonido', 'audio'])
    ) as requested(name, slug, sort_order, accepted_names, accepted_slugs)
  loop
    chosen_id := null;
    candidate_ids := null;

    select category.id
    into chosen_id
    from public.categories as category
    where category.name = any(category_spec.accepted_names)
       or category.slug = any(category_spec.accepted_slugs)
    order by
      (category.name = category_spec.name and category.slug = category_spec.slug) desc,
      (category.slug = category_spec.slug) desc,
      (category.name = category_spec.name) desc,
      category.created_at,
      category.id
    limit 1;

    if chosen_id is null then
      insert into public.categories (name, slug, active, sort_order)
      values (category_spec.name, category_spec.slug, true, category_spec.sort_order)
      returning id into chosen_id;
    else
      select array_agg(category.id)
      into candidate_ids
      from public.categories as category
      where category.name = any(category_spec.accepted_names)
         or category.slug = any(category_spec.accepted_slugs);

      update public.products
      set category_id = chosen_id
      where category_id = any(candidate_ids)
        and category_id <> chosen_id;

      update public.categories
      set parent_id = null
      where id = chosen_id
        and parent_id = any(candidate_ids);

      update public.categories
      set parent_id = chosen_id
      where parent_id = any(candidate_ids)
        and not (id = any(candidate_ids));

      delete from public.categories
      where id = any(candidate_ids)
        and id <> chosen_id;

      update public.categories
      set
        name = category_spec.name,
        slug = category_spec.slug,
        active = true,
        sort_order = category_spec.sort_order
      where id = chosen_id;
    end if;
  end loop;
end;
$$;

drop trigger if exists zz_products_preserve_updated_at_category_migration on public.products;
drop function if exists public.preserve_product_updated_at_during_category_migration();

create or replace function public.enforce_official_product_category()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.category_id is null then
    raise exception 'Selecciona una categoría para guardar el producto.';
  end if;

  if not exists (
    select 1
    from public.categories as category
    where category.id = new.category_id
      and category.active
      and (category.name, category.slug) in (
        ('Exterior', 'exterior'),
        ('Interior', 'interior'),
        ('Iluminación', 'iluminacion'),
        ('Polarizado y Herramientas', 'polarizado-y-herramientas'),
        ('Carrocería', 'carroceria'),
        ('Seguridad', 'seguridad'),
        ('Audio y Sonido', 'audio-y-sonido')
      )
  ) then
    raise exception 'Selecciona una categoría oficial para guardar el producto.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_official_product_category() from public;

drop trigger if exists products_require_official_category on public.products;
create trigger products_require_official_category
before insert or update of category_id on public.products
for each row
execute function public.enforce_official_product_category();

comment on function public.enforce_official_product_category() is
  'Requires new products and explicit category changes to use one of the seven official active product categories. Existing null categories remain compatible with stock-only updates.';
