alter table public.holiday_banners
  add column if not exists media_type text not null default 'image',
  add column if not exists media_url text,
  add column if not exists media_public_id text,
  add column if not exists media_resource_type text not null default 'image',
  add column if not exists media_bytes bigint not null default 0,
  add column if not exists media_created_at timestamptz,
  add column if not exists media_format text,
  add column if not exists media_width integer,
  add column if not exists media_height integer,
  add column if not exists media_duration_seconds numeric(8, 2),
  add column if not exists media_thumbnail_url text,
  add column if not exists created_by uuid references public.users(id) on delete set null,
  add column if not exists updated_by uuid references public.users(id) on delete set null;

update public.holiday_banners
set
  media_type = case
    when media_type in ('image', 'video') then media_type
    else 'image'
  end,
  media_resource_type = case
    when media_resource_type in ('image', 'video') then media_resource_type
    else 'image'
  end,
  media_url = coalesce(media_url, image_url),
  media_bytes = greatest(coalesce(media_bytes, 0), 0),
  priority = least(greatest(coalesce(priority, 1), 1), 5)
where true;

alter table public.holiday_banners
  alter column priority set default 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'holiday_banners_media_type_check'
      and conrelid = 'public.holiday_banners'::regclass
  ) then
    alter table public.holiday_banners
      add constraint holiday_banners_media_type_check
      check (media_type in ('image', 'video'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'holiday_banners_media_resource_type_check'
      and conrelid = 'public.holiday_banners'::regclass
  ) then
    alter table public.holiday_banners
      add constraint holiday_banners_media_resource_type_check
      check (media_resource_type in ('image', 'video'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'holiday_banners_media_bytes_check'
      and conrelid = 'public.holiday_banners'::regclass
  ) then
    alter table public.holiday_banners
      add constraint holiday_banners_media_bytes_check
      check (media_bytes >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'holiday_banners_priority_range_check'
      and conrelid = 'public.holiday_banners'::regclass
  ) then
    alter table public.holiday_banners
      add constraint holiday_banners_priority_range_check
      check (priority between 1 and 5);
  end if;
end $$;

create index if not exists holiday_banners_media_public_id_idx
  on public.holiday_banners(media_public_id)
  where media_public_id is not null;

create index if not exists holiday_banners_schedule_priority_idx
  on public.holiday_banners(is_active, start_date, end_date, priority desc, updated_at desc);

update public.roles
set
  permissions = (
    select jsonb_agg(distinct permission)
    from jsonb_array_elements_text(permissions || '["commercial_settings:manage"]'::jsonb) as permission
  ),
  updated_at = now()
where name = 'technical_owner';
