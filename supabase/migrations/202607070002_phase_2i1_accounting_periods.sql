-- Phase 2I-1: accounting periods foundation only.
-- No close, reopen, locking, auto-posting, or journal-entry mutation is enabled here.

alter table public.accounting_periods
  add column if not exists period_type text not null default 'monthly',
  add column if not exists fiscal_year integer,
  add column if not exists reopened_at timestamptz,
  add column if not exists reopened_by uuid references public.users(id) on delete set null,
  add column if not exists notes text,
  add column if not exists created_by uuid references public.users(id) on delete set null;

update public.accounting_periods
set fiscal_year = extract(year from start_date)::integer
where fiscal_year is null;

alter table public.accounting_periods
  alter column fiscal_year set not null;

alter table public.accounting_periods
  drop constraint if exists accounting_periods_status_check,
  add constraint accounting_periods_status_check check (status in ('open', 'closed', 'reopened'));

alter table public.accounting_periods
  drop constraint if exists accounting_periods_valid_range,
  add constraint accounting_periods_valid_range check (end_date > start_date);

alter table public.accounting_periods
  drop constraint if exists accounting_periods_period_type_check,
  add constraint accounting_periods_period_type_check check (period_type in ('monthly', 'annual', 'custom'));

alter table public.accounting_periods
  drop constraint if exists accounting_periods_fiscal_year_check,
  add constraint accounting_periods_fiscal_year_check check (fiscal_year between 2000 and 2100);

create index if not exists accounting_periods_start_date_desc_idx
  on public.accounting_periods (start_date desc);

create index if not exists accounting_periods_fiscal_year_idx
  on public.accounting_periods (fiscal_year);

create or replace function public.guard_accounting_period_foundation()
returns trigger
language plpgsql
as $$
begin
  if new.end_date <= new.start_date then
    raise exception 'La fecha inicial debe ser anterior a la fecha final.';
  end if;

  if new.fiscal_year is null or new.fiscal_year < 2000 or new.fiscal_year > 2100 then
    raise exception 'El anio fiscal no es valido.';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'Phase 2I-1 solo permite crear periodos abiertos.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'open' then
      raise exception 'Los periodos cerrados no se editan en Phase 2I-1.';
    end if;

    if new.status <> 'open' then
      raise exception 'El cierre o reapertura de periodos no esta disponible en Phase 2I-1.';
    end if;
  end if;

  if exists (
    select 1
    from public.accounting_periods existing
    where existing.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and daterange(existing.start_date, existing.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'El periodo contable se cruza con otro periodo existente.';
  end if;

  return new;
end;
$$;

drop trigger if exists accounting_periods_guard_foundation on public.accounting_periods;
create trigger accounting_periods_guard_foundation
before insert or update on public.accounting_periods
for each row execute function public.guard_accounting_period_foundation();

drop policy if exists "Accounting manage periods" on public.accounting_periods;
drop policy if exists "Accounting create open periods" on public.accounting_periods;
drop policy if exists "Accounting update open periods" on public.accounting_periods;

create policy "Accounting create open periods"
  on public.accounting_periods for insert
  with check (
    (public.has_permission('accounting:create') or public.has_permission('accounting:manage') or public.has_permission('accounting:settings'))
    and status = 'open'
    and closed_at is null
    and closed_by is null
    and reopened_at is null
    and reopened_by is null
  );

create policy "Accounting update open periods"
  on public.accounting_periods for update
  using (
    (public.has_permission('accounting:create') or public.has_permission('accounting:manage') or public.has_permission('accounting:settings'))
    and status = 'open'
  )
  with check (
    (public.has_permission('accounting:create') or public.has_permission('accounting:manage') or public.has_permission('accounting:settings'))
    and status = 'open'
    and closed_at is null
    and closed_by is null
    and reopened_at is null
    and reopened_by is null
  );
