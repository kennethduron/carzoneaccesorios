-- Aggregate accounting report movements inside PostgreSQL because PostgREST
-- aggregates are intentionally disabled for the project API.

create or replace function public.get_accounting_report_aggregates(
  p_date_from date default null,
  p_date_to date default null,
  p_account_ids uuid[] default null,
  p_mode text default 'period'
)
returns table (
  calculation_mode text,
  account_id uuid,
  debit_total numeric(20, 2),
  credit_total numeric(20, 2)
)
language sql
stable
security invoker
set search_path = public
as $function$
  with requested_modes as (
    select unnest(
      case p_mode
        when 'opening' then array['opening']::text[]
        when 'period' then array['period']::text[]
        when 'both' then array['opening', 'period']::text[]
        when 'as_of' then array['as_of']::text[]
        else array[]::text[]
      end
    ) as calculation_mode
  )
  select
    requested_modes.calculation_mode,
    lines.account_id,
    coalesce(sum(lines.debit), 0)::numeric(20, 2) as debit_total,
    coalesce(sum(lines.credit), 0)::numeric(20, 2) as credit_total
  from requested_modes
  cross join public.journal_entry_lines as lines
  inner join public.journal_entries as entries
    on entries.id = lines.journal_entry_id
  where entries.status = 'publicada'
    and (p_account_ids is null or lines.account_id = any(p_account_ids))
    and case requested_modes.calculation_mode
      when 'opening' then p_date_from is not null and entries.entry_date < p_date_from
      when 'period' then
        (p_date_from is null or entries.entry_date >= p_date_from)
        and (p_date_to is null or entries.entry_date <= p_date_to)
      when 'as_of' then p_date_to is null or entries.entry_date <= p_date_to
      else false
    end
  group by requested_modes.calculation_mode, lines.account_id
  order by requested_modes.calculation_mode, lines.account_id;
$function$;

comment on function public.get_accounting_report_aggregates(date, date, uuid[], text) is
  'Read-only debit and credit totals for published accounting entries. Modes: opening, period, both, as_of.';

revoke all on function public.get_accounting_report_aggregates(date, date, uuid[], text) from public;
revoke all on function public.get_accounting_report_aggregates(date, date, uuid[], text) from anon;
grant execute on function public.get_accounting_report_aggregates(date, date, uuid[], text) to authenticated;
