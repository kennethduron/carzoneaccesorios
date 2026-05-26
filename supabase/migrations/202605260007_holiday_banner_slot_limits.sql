alter table public.holiday_banners
  add column if not exists banner_slot text not null default 'main';

update public.holiday_banners
set banner_slot = case
  when banner_slot in ('main', 'secondary') then banner_slot
  when priority >= 5 then 'main'
  else 'secondary'
end
where true;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'holiday_banners_banner_slot_check'
      and conrelid = 'public.holiday_banners'::regclass
  ) then
    alter table public.holiday_banners
      add constraint holiday_banners_banner_slot_check
      check (banner_slot in ('main', 'secondary'));
  end if;
end $$;

create index if not exists holiday_banners_slot_schedule_idx
  on public.holiday_banners(banner_slot, is_active, start_date, end_date, priority desc, updated_at desc);
