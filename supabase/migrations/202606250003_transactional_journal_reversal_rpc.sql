create or replace function public.reverse_journal_entry(target_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  original_entry record;
  existing_reversal_id uuid;
  reversal_entry_id uuid;
  reversal_entry_number text;
  reversal_entry_date date := (now() at time zone 'America/Tegucigalpa')::date;
  reversal_posted_at timestamptz := now();
  line_count integer;
  total_debit numeric(14, 2);
  total_credit numeric(14, 2);
begin
  if actor_user_id is null or not public.has_permission('accounting:reverse') then
    raise exception 'Solo usuarios autorizados pueden reversar partidas contables.';
  end if;

  select *
    into original_entry
    from public.journal_entries
    where id = target_entry_id
    for update;

  if not found then
    raise exception 'La partida contable no existe.';
  end if;

  if original_entry.status <> 'publicada' then
    raise exception 'Solo se pueden reversar partidas publicadas.';
  end if;

  if original_entry.reversed_entry_id is not null then
    raise exception 'La partida contable ya fue reversada.';
  end if;

  select id
    into existing_reversal_id
    from public.journal_entries
    where source_type = 'journal_reversal'
      and source_id = original_entry.id::text
    limit 1;

  if existing_reversal_id is not null then
    raise exception 'La partida contable ya tiene un asiento de reverso.';
  end if;

  select count(*)::integer,
         coalesce(sum(debit), 0)::numeric(14, 2),
         coalesce(sum(credit), 0)::numeric(14, 2)
    into line_count, total_debit, total_credit
    from public.journal_entry_lines
    where journal_entry_id = original_entry.id;

  if line_count < 2 or total_debit <= 0 or total_debit <> total_credit then
    raise exception 'La partida original no está cuadrada y no puede reversarse automáticamente.';
  end if;

  loop
    reversal_entry_number :=
      'PC-' ||
      to_char(now() at time zone 'America/Tegucigalpa', 'YYYYMMDD') ||
      '-' ||
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

    exit when not exists (
      select 1
      from public.journal_entries
      where entry_number = reversal_entry_number
    );
  end loop;

  insert into public.journal_entries (
    entry_number,
    entry_date,
    description,
    status,
    source_type,
    source_id,
    created_by
  )
  values (
    reversal_entry_number,
    reversal_entry_date,
    left(format('Reverso de %s: %s', original_entry.entry_number, original_entry.description), 500),
    'borrador',
    'journal_reversal',
    original_entry.id::text,
    actor_user_id
  )
  returning id into reversal_entry_id;

  insert into public.journal_entry_lines (
    journal_entry_id,
    account_id,
    debit,
    credit,
    description,
    customer_id,
    vendor_id,
    product_id
  )
  select
    reversal_entry_id,
    account_id,
    credit,
    debit,
    description,
    customer_id,
    vendor_id,
    product_id
  from public.journal_entry_lines
  where journal_entry_id = original_entry.id
  order by created_at, id;

  update public.journal_entries
  set status = 'publicada',
      posted_by = actor_user_id,
      posted_at = reversal_posted_at
  where id = reversal_entry_id;

  update public.journal_entries
  set status = 'reversada',
      reversed_entry_id = reversal_entry_id
  where id = original_entry.id;

  perform public.write_audit_log(
    'journal_entries',
    reversal_entry_id,
    'accounting.journal_reversal.created',
    null,
    jsonb_build_object(
      'status', 'publicada',
      'original_entry_id', original_entry.id,
      'original_entry_number', original_entry.entry_number,
      'total_debit', total_debit,
      'total_credit', total_credit
    ),
    null,
    null
  );

  perform public.write_audit_log(
    'journal_entries',
    original_entry.id,
    'accounting.journal_entry.reversed',
    jsonb_build_object('status', 'publicada'),
    jsonb_build_object('status', 'reversada', 'reversal_entry_id', reversal_entry_id),
    null,
    null
  );
  insert into public.accounting_event_log (
    event_type,
    entity_type,
    entity_id,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values
  (
    'journal_reversal.created',
    'journal_entries',
    reversal_entry_id,
    'journal_reversal',
    original_entry.id::text,
    jsonb_build_object(
      'original_entry_id', original_entry.id,
      'original_entry_number', original_entry.entry_number,
      'reversal_entry_id', reversal_entry_id,
      'reversal_entry_number', reversal_entry_number,
      'total_debit', total_debit,
      'total_credit', total_credit
    ),
    actor_user_id
  ),
  (
    'journal_entry.reversed',
    'journal_entries',
    original_entry.id,
    'journal_reversal',
    reversal_entry_id::text,
    jsonb_build_object(
      'original_entry_id', original_entry.id,
      'original_entry_number', original_entry.entry_number,
      'reversal_entry_id', reversal_entry_id,
      'reversal_entry_number', reversal_entry_number,
      'previous_status', 'publicada',
      'next_status', 'reversada'
    ),
    actor_user_id
  );

  return jsonb_build_object(
    'ok', true,
    'original_entry_id', original_entry.id,
    'reversal_entry_id', reversal_entry_id,
    'reversal_entry_number', reversal_entry_number
  );
end;
$$;

revoke all on function public.reverse_journal_entry(uuid) from public;
grant execute on function public.reverse_journal_entry(uuid) to authenticated;


