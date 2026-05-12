alter table public.product_images
  add column if not exists public_id text;

update public.product_images
set public_id = storage_path
where public_id is null
  and public_url ilike 'https://res.cloudinary.com/%';

create index if not exists product_images_public_id_idx
  on public.product_images(public_id)
  where public_id is not null;
