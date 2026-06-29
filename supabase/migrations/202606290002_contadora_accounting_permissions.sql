-- Phase 2C deploy readiness: allow contadora to operate accounting drafts
-- without granting accounting settings, reversals, period close, or test cleanup.

update public.roles
set
  permissions = (
    select jsonb_agg(distinct permission order by permission)
    from jsonb_array_elements_text(
      (
        coalesce(public.roles.permissions, '[]'::jsonb)
        - 'accounting:reverse'
        - 'accounting:settings'
        - 'accounting:close_period'
      ) ||
      '[
        "accounting:read",
        "accounting:view_reports",
        "accounting:export",
        "accounting:create",
        "accounting:post",
        "accounting:manage"
      ]'::jsonb
    ) as permissions(permission)
  ),
  updated_at = now()
where name = 'contadora';

drop function if exists public.cleanup_accounting_test_fixtures(text);

create function public.cleanup_accounting_test_fixtures(test_prefix text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed_prefixes constant text[] := array[
    'TEST-BORRADOR-CONTABLE',
    'TEST-CENTRO-FINANCIERO',
    'TEST-EVENTOS-FINANCIEROS',
    'TEST-CONTADORA-PERMISOS'
  ];
  normalized_prefix text := upper(trim(coalesce(test_prefix, '')));
  actor_user_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  service_role_call boolean := coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
  prefix_length integer;
  draft_entry_ids uuid[] := '{}'::uuid[];
  deleted_journal_entry_lines integer := 0;
  deleted_journal_entries integer := 0;
  deleted_financial_events integer := 0;
  deleted_accounting_mappings integer := 0;
  deleted_accounting_accounts integer := 0;
  protected_journal_entries_preserved integer := 0;
  result jsonb;
begin
  if normalized_prefix <> all(allowed_prefixes) then
    raise exception 'Prefijo de limpieza contable no permitido.';
  end if;

  if not service_role_call and (actor_user_id is null or coalesce(actor_role_name, '') <> 'technical_owner') then
    raise exception 'Solo el technical_owner puede limpiar fixtures contables de prueba.';
  end if;

  prefix_length := char_length(normalized_prefix);
  actor_role_name := coalesce(actor_role_name, case when service_role_call then 'service_role' else null end);

  select coalesce(array_agg(journal_entries.id), '{}'::uuid[])
    into draft_entry_ids
  from public.journal_entries
  where status = 'borrador'
    and posted_by is null
    and posted_at is null
    and reversed_entry_id is null
    and (
      upper(left(coalesce(entry_number, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(source_type, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(source_id, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(description, ''), prefix_length)) = normalized_prefix
    );

  select count(*)::integer
    into protected_journal_entries_preserved
  from public.journal_entries
  where status in ('publicada', 'reversada')
    and (
      upper(left(coalesce(entry_number, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(source_type, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(source_id, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(description, ''), prefix_length)) = normalized_prefix
    );

  delete from public.journal_entry_lines
  where journal_entry_id = any(draft_entry_ids);
  get diagnostics deleted_journal_entry_lines = row_count;

  delete from public.journal_entries
  where id = any(draft_entry_ids)
    and status = 'borrador'
    and posted_by is null
    and posted_at is null
    and reversed_entry_id is null;
  get diagnostics deleted_journal_entries = row_count;

  delete from public.financial_events
  where upper(left(coalesce(source_type, ''), prefix_length)) = normalized_prefix
     or upper(left(coalesce(source_id, ''), prefix_length)) = normalized_prefix
     or upper(left(coalesce(event_purpose, ''), prefix_length)) = normalized_prefix
     or upper(coalesce(source_snapshot ->> 'test_prefix', '')) = normalized_prefix
     or upper(coalesce(source_snapshot ->> 'fixture_prefix', '')) = normalized_prefix;
  get diagnostics deleted_financial_events = row_count;

  delete from public.accounting_mappings
  where is_active = false
    and (
      upper(left(coalesce(source_key, ''), prefix_length)) = normalized_prefix
      or upper(coalesce(metadata ->> 'test_prefix', '')) = normalized_prefix
      or upper(coalesce(metadata ->> 'fixture_prefix', '')) = normalized_prefix
    );
  get diagnostics deleted_accounting_mappings = row_count;

  delete from public.accounting_accounts
  where is_active = false
    and (
      upper(left(coalesce(code, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(name, ''), prefix_length)) = normalized_prefix
      or upper(left(coalesce(description, ''), prefix_length)) = normalized_prefix
    )
    and not exists (
      select 1
      from public.journal_entry_lines
      where journal_entry_lines.account_id = accounting_accounts.id
    )
    and not exists (
      select 1
      from public.accounting_mappings
      where accounting_mappings.account_id = accounting_accounts.id
    );
  get diagnostics deleted_accounting_accounts = row_count;

  result := jsonb_build_object(
    'ok', true,
    'test_prefix', normalized_prefix,
    'deleted', jsonb_build_object(
      'journal_entry_lines', deleted_journal_entry_lines,
      'journal_entries', deleted_journal_entries,
      'financial_events', deleted_financial_events,
      'accounting_mappings', deleted_accounting_mappings,
      'accounting_accounts', deleted_accounting_accounts
    ),
    'preserved', jsonb_build_object(
      'published_or_reversed_journal_entries', protected_journal_entries_preserved
    )
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
  values (
    'test_fixtures.cleanup',
    'accounting_test_fixtures',
    null,
    'accounting_test_cleanup',
    normalized_prefix,
    jsonb_build_object(
      'prefix', normalized_prefix,
      'actor_role', actor_role_name,
      'deleted', result -> 'deleted',
      'preserved', result -> 'preserved'
    ),
    actor_user_id
  );

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    actor_user_id,
    actor_role_name,
    'accounting_test_fixtures',
    null,
    'accounting.test_fixtures.cleanup',
    null,
    result
  );

  return result;
end;
$$;

revoke all on function public.cleanup_accounting_test_fixtures(text) from public;
grant execute on function public.cleanup_accounting_test_fixtures(text) to authenticated, service_role;
