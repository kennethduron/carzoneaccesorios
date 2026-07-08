-- Controlled accounting period reopening and final close permission correction.
-- Additive only: no destructive SQL, no operational data changes, no auto-posting.

alter table public.accounting_periods
  add column if not exists reopen_reason text;

alter table public.accounting_periods
  drop constraint if exists accounting_periods_reopen_reason_length,
  add constraint accounting_periods_reopen_reason_length
    check (reopen_reason is null or char_length(reopen_reason) <= 500);

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

    if new.closed_at is not null or new.closed_by is not null or new.reopened_at is not null or new.reopened_by is not null or new.reopen_reason is not null then
      raise exception 'Los metadatos de cierre o reapertura no se registran al crear períodos abiertos.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'closed' then
      if new.status <> 'reopened' then
        raise exception 'Los períodos cerrados son de solo lectura.';
      end if;

      if new.reopened_at is null or new.reopened_by is null or nullif(btrim(coalesce(new.reopen_reason, '')), '') is null then
        raise exception 'Debe ingresar un motivo para reabrir el período.';
      end if;

      if new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by then
        raise exception 'La reapertura no puede modificar los datos originales de cierre.';
      end if;
    elsif old.status in ('open', 'reopened') then
      if new.status = 'closed' then
        if old.status = 'open' and (new.reopened_at is not null or new.reopened_by is not null or new.reopen_reason is not null) then
          raise exception 'La reapertura solo se registra sobre períodos cerrados.';
        end if;

        if new.closed_at is null or new.closed_by is null then
          raise exception 'El cierre debe registrar responsable y fecha.';
        end if;
      elsif new.status not in ('open', 'reopened') then
        raise exception 'Solo se permite administrar períodos abiertos, reabiertos o cerrar períodos validados.';
      end if;

      if old.status = 'open' and new.status = 'reopened' then
        raise exception 'Solo se pueden reabrir períodos cerrados.';
      end if;
    else
      raise exception 'Estado de período contable no permitido.';
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

  if target_period.status not in ('open', 'reopened') then
    blockers := blockers || jsonb_build_array('Solo se pueden cerrar períodos abiertos o reabiertos.');
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
  if auth.uid() is null or not public.has_permission('accounting:close_period') then
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

  if not found or target_period.status not in ('open', 'reopened') then
    return public.validate_accounting_period_close(period_id) || jsonb_build_object('closed', false);
  end if;

  update public.accounting_periods
  set status = 'closed',
      closed_at = now(),
      closed_by = auth.uid(),
      updated_at = now()
  where id = period_id
    and status in ('open', 'reopened');

  insert into public.accounting_event_log (event_type, entity_type, entity_id, metadata, created_by)
  values (
    'period.closed',
    'accounting_periods',
    period_id,
    jsonb_build_object(
      'period_name', target_period.name,
      'start_date', target_period.start_date,
      'end_date', target_period.end_date,
      'previous_status', target_period.status,
      'validation', validation
    ),
    auth.uid()
  );

  return validation || jsonb_build_object('closed', true, 'message', 'Período contable cerrado correctamente.');
end;
$$;

create or replace function public.reopen_accounting_period(period_id uuid, reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_period public.accounting_periods%rowtype;
  cleaned_reason text := nullif(btrim(coalesce(reason, '')), '');
begin
  if auth.uid() is null or not public.has_permission('accounting:reopen_period') then
    raise exception 'Solo un usuario autorizado puede reabrir períodos cerrados.';
  end if;

  if cleaned_reason is null then
    raise exception 'Debe ingresar un motivo para reabrir el período.';
  end if;

  select *
    into target_period
    from public.accounting_periods
    where id = period_id
    for update;

  if not found or target_period.status <> 'closed' then
    raise exception 'Solo se pueden reabrir períodos cerrados.';
  end if;

  update public.accounting_periods
  set status = 'reopened',
      reopened_at = now(),
      reopened_by = auth.uid(),
      reopen_reason = left(cleaned_reason, 500),
      updated_at = now()
  where id = period_id
    and status = 'closed';

  insert into public.accounting_event_log (event_type, entity_type, entity_id, metadata, created_by)
  values (
    'period.reopened',
    'accounting_periods',
    period_id,
    jsonb_build_object(
      'period_name', target_period.name,
      'start_date', target_period.start_date,
      'end_date', target_period.end_date,
      'closed_at', target_period.closed_at,
      'closed_by', target_period.closed_by,
      'reason', left(cleaned_reason, 500)
    ),
    auth.uid()
  );

  return jsonb_build_object(
    'ok', true,
    'reopened', true,
    'period_id', period_id,
    'message', 'Período contable reabierto correctamente.'
  );
end;
$$;

with role_permission_changes(role_name, add_permissions, remove_permissions) as (
  values
    ('technical_owner', '["accounting:close_period", "accounting:reopen_period"]'::jsonb, '[]'::jsonb),
    ('business_owner', '["accounting:close_period", "accounting:reopen_period"]'::jsonb, '[]'::jsonb),
    ('admin', '["accounting:close_period", "accounting:reopen_period"]'::jsonb, '[]'::jsonb),
    ('contadora', '["accounting:close_period"]'::jsonb, '["accounting:reopen_period", "accounting:reverse", "accounting:settings", "accounting:cleanup", "security:manage", "technical:tools"]'::jsonb),
    ('vendedor', '[]'::jsonb, '["accounting:close_period", "accounting:reopen_period"]'::jsonb),
    ('bodega', '[]'::jsonb, '["accounting:close_period", "accounting:reopen_period"]'::jsonb),
    ('soporte', '[]'::jsonb, '["accounting:close_period", "accounting:reopen_period"]'::jsonb),
    ('cliente', '[]'::jsonb, '["accounting:close_period", "accounting:reopen_period"]'::jsonb)
),
normalized as (
  select
    r.id,
    coalesce(jsonb_agg(distinct permission order by permission) filter (where permission is not null), '[]'::jsonb) as permissions
  from public.roles r
  join role_permission_changes rpc on rpc.role_name = r.name
  left join lateral (
    select permission
    from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb) || rpc.add_permissions) as p(permission)
    where not exists (
      select 1
      from jsonb_array_elements_text(rpc.remove_permissions) as removed(permission)
      where removed.permission = p.permission
    )
  ) kept on true
  group by r.id
)
update public.roles r
set permissions = normalized.permissions,
    updated_at = now()
from normalized
where normalized.id = r.id;

grant execute on function public.validate_accounting_period_close(uuid) to authenticated;
grant execute on function public.close_accounting_period(uuid) to authenticated;
grant execute on function public.reopen_accounting_period(uuid, text) to authenticated;