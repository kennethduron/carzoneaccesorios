-- Accounting period close foundation.
-- Allows validation and closing only; no reopen, annual close, auto-posting, or closing entries.

create index if not exists journal_entries_status_date_idx
  on public.journal_entries (status, entry_date);

create index if not exists financial_events_status_occurred_idx
  on public.financial_events (status, occurred_at);

create or replace function public.accounting_closed_period_message()
returns text
language sql
immutable
as $$
  select 'No se puede registrar o modificar una partida dentro de un período contable cerrado.';
$$;

create or replace function public.is_date_in_closed_accounting_period(target_date date)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.accounting_periods
    where status = 'closed'
      and target_date between start_date and end_date
  );
$$;

create or replace function public.guard_accounting_period_foundation()
returns trigger
language plpgsql
as $$
begin
  if new.end_date <= new.start_date then
    raise exception 'La fecha inicial debe ser anterior a la fecha final.';
  end if;

  if new.fiscal_year is null or new.fiscal_year < 2000 or new.fiscal_year > 2100 then
    raise exception 'El año fiscal no es válido.';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'Solo se pueden crear períodos abiertos.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'open' then
      raise exception 'Los períodos cerrados son de solo lectura.';
    end if;

    if new.status = 'closed' then
      if old.status <> 'open' then
        raise exception 'Solo se pueden cerrar períodos abiertos.';
      end if;

      if new.closed_at is null or new.closed_by is null then
        raise exception 'El cierre debe registrar responsable y fecha.';
      end if;

      if new.reopened_at is not null or new.reopened_by is not null then
        raise exception 'La reapertura de períodos no está disponible.';
      end if;
    elsif new.status <> 'open' then
      raise exception 'Solo se permite administrar períodos abiertos o cerrar períodos validados.';
    end if;
  end if;

  if exists (
    select 1
    from public.accounting_periods existing
    where existing.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and daterange(existing.start_date, existing.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'El período contable se cruza con otro período existente.';
  end if;

  return new;
end;
$$;

create or replace function public.guard_journal_entry_closed_period()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_date_in_closed_accounting_period(new.entry_date) then
      raise exception '%', public.accounting_closed_period_message();
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'borrador'
      and (
        public.is_date_in_closed_accounting_period(old.entry_date)
        or public.is_date_in_closed_accounting_period(new.entry_date)
      )
    then
      raise exception '%', public.accounting_closed_period_message();
    end if;

    if old.status = 'borrador' and new.status = 'publicada' and public.is_date_in_closed_accounting_period(old.entry_date) then
      raise exception '%', public.accounting_closed_period_message();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists journal_entries_guard_closed_period_insert on public.journal_entries;
create trigger journal_entries_guard_closed_period_insert
before insert on public.journal_entries
for each row execute function public.guard_journal_entry_closed_period();

drop trigger if exists journal_entries_guard_closed_period_update on public.journal_entries;
create trigger journal_entries_guard_closed_period_update
before update on public.journal_entries
for each row execute function public.guard_journal_entry_closed_period();

create or replace function public.guard_journal_entry_lines()
returns trigger
language plpgsql
as $$
declare
  parent_status text;
  parent_date date;
begin
  select status, entry_date
    into parent_status, parent_date
    from public.journal_entries
    where id = coalesce(new.journal_entry_id, old.journal_entry_id);

  if parent_status is null then
    raise exception 'La partida contable no existe.';
  end if;

  if parent_status <> 'borrador' then
    raise exception 'Las lineas de una partida publicada no se editan.';
  end if;

  if public.is_date_in_closed_accounting_period(parent_date) then
    raise exception '%', public.accounting_closed_period_message();
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function public.validate_accounting_period_close(period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_period public.accounting_periods%rowtype;
  blockers jsonb := '[]'::jsonb;
  warnings jsonb := '[]'::jsonb;
  draft_count integer := 0;
  unbalanced_count integer := 0;
  missing_lines_count integer := 0;
  invalid_accounts_count integer := 0;
  pending_events_count integer := 0;
  published_debit numeric := 0;
  published_credit numeric := 0;
  active_mappings_count integer := 0;
begin
  if auth.uid() is null or not (
    public.has_permission('accounting:read') or
    public.has_permission('accounting:manage') or
    public.has_permission('accounting:settings') or
    public.has_permission('accounting:close_period')
  ) then
    raise exception 'No tienes permiso para validar cierres contables.';
  end if;

  select *
    into target_period
    from public.accounting_periods
    where id = period_id;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'ready', false,
      'period_id', period_id,
      'period_name', null,
      'blockers', jsonb_build_array('El período contable no existe.'),
      'warnings', warnings,
      'summary', jsonb_build_object()
    );
  end if;

  if target_period.status <> 'open' then
    blockers := blockers || jsonb_build_array('Solo se pueden cerrar períodos abiertos.');
  end if;

  if target_period.end_date <= target_period.start_date then
    blockers := blockers || jsonb_build_array('La fecha inicial debe ser anterior a la fecha final.');
  end if;

  select count(*)
    into draft_count
    from public.journal_entries
    where status = 'borrador'
      and entry_date between target_period.start_date and target_period.end_date;
  if draft_count > 0 then
    blockers := blockers || jsonb_build_array('No se puede cerrar el período porque existen partidas en borrador.');
  end if;

  with entry_totals as (
    select je.id,
      coalesce(sum(jel.debit), 0) as debit,
      coalesce(sum(jel.credit), 0) as credit,
      count(jel.id) as line_count
    from public.journal_entries je
    left join public.journal_entry_lines jel on jel.journal_entry_id = je.id
    where je.entry_date between target_period.start_date and target_period.end_date
    group by je.id
  )
  select count(*)
    into unbalanced_count
    from entry_totals
    where debit <= 0 or credit <= 0 or round(debit, 2) <> round(credit, 2);
  if unbalanced_count > 0 then
    blockers := blockers || jsonb_build_array('No se puede cerrar el período porque existen partidas descuadradas.');
  end if;

  with entry_totals as (
    select je.id, count(jel.id) as line_count
    from public.journal_entries je
    left join public.journal_entry_lines jel on jel.journal_entry_id = je.id
    where je.entry_date between target_period.start_date and target_period.end_date
    group by je.id
  )
  select count(*)
    into missing_lines_count
    from entry_totals
    where line_count = 0;
  if missing_lines_count > 0 then
    blockers := blockers || jsonb_build_array('No se puede cerrar el período porque hay partidas sin líneas contables.');
  end if;

  select count(*)
    into invalid_accounts_count
    from public.journal_entry_lines jel
    join public.journal_entries je on je.id = jel.journal_entry_id
    left join public.accounting_accounts aa on aa.id = jel.account_id
    where je.entry_date between target_period.start_date and target_period.end_date
      and aa.id is null;
  if invalid_accounts_count > 0 then
    blockers := blockers || jsonb_build_array('No se puede cerrar el período porque hay líneas con cuentas contables inválidas.');
  end if;

  select count(*)
    into pending_events_count
    from public.financial_events
    where status in ('pending', 'ready', 'failed')
      and occurred_at::date between target_period.start_date and target_period.end_date;
  if pending_events_count > 0 then
    blockers := blockers || jsonb_build_array('No se puede cerrar el período porque hay eventos financieros pendientes.');
  end if;

  select coalesce(sum(jel.debit), 0), coalesce(sum(jel.credit), 0)
    into published_debit, published_credit
    from public.journal_entry_lines jel
    join public.journal_entries je on je.id = jel.journal_entry_id
    where je.status = 'publicada'
      and je.entry_date between target_period.start_date and target_period.end_date;
  if round(published_debit, 2) <> round(published_credit, 2) then
    blockers := blockers || jsonb_build_array('No se puede cerrar el período porque el Balance de Comprobación no está cuadrado.');
  end if;

  select count(*)
    into active_mappings_count
    from public.accounting_mappings
    where is_active = true;
  if active_mappings_count = 0 then
    warnings := warnings || jsonb_build_array('No hay mapeos contables activos configurados. Revisa la configuración antes de automatizar registros.');
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(blockers) = 0,
    'ready', jsonb_array_length(blockers) = 0,
    'period_id', target_period.id,
    'period_name', target_period.name,
    'blockers', blockers,
    'warnings', warnings,
    'summary', jsonb_build_object(
      'draft_entries', draft_count,
      'unbalanced_entries', unbalanced_count,
      'entries_missing_lines', missing_lines_count,
      'invalid_account_lines', invalid_accounts_count,
      'pending_financial_events', pending_events_count,
      'trial_balance_debit', published_debit,
      'trial_balance_credit', published_credit,
      'active_mappings', active_mappings_count
    )
  );
end;
$$;

create or replace function public.close_accounting_period(period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  validation jsonb;
  target_period public.accounting_periods%rowtype;
begin
  if auth.uid() is null or not (
    public.has_permission('accounting:manage') or
    public.has_permission('accounting:settings') or
    public.has_permission('accounting:close_period')
  ) then
    raise exception 'No tienes permiso para cerrar períodos contables.';
  end if;

  validation := public.validate_accounting_period_close(period_id);
  if coalesce((validation ->> 'ready')::boolean, false) is not true then
    return validation || jsonb_build_object('closed', false);
  end if;

  select *
    into target_period
    from public.accounting_periods
    where id = period_id
    for update;

  if not found or target_period.status <> 'open' then
    return public.validate_accounting_period_close(period_id) || jsonb_build_object('closed', false);
  end if;

  update public.accounting_periods
  set status = 'closed',
      closed_at = now(),
      closed_by = auth.uid(),
      updated_at = now()
  where id = period_id
    and status = 'open';

  insert into public.accounting_event_log (event_type, entity_type, entity_id, metadata, created_by)
  values (
    'period.closed',
    'accounting_periods',
    period_id,
    jsonb_build_object(
      'period_name', target_period.name,
      'start_date', target_period.start_date,
      'end_date', target_period.end_date,
      'validation', validation
    ),
    auth.uid()
  );

  return validation || jsonb_build_object('closed', true, 'message', 'Período contable cerrado correctamente.');
end;
$$;


update public.roles
set
  permissions = (
    select jsonb_agg(distinct permission order by permission)
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb) || '["accounting:close_period"]'::jsonb
    ) as permissions(permission)
  ),
  updated_at = now()
where name = 'contadora';

grant execute on function public.validate_accounting_period_close(uuid) to authenticated;
grant execute on function public.close_accounting_period(uuid) to authenticated;
