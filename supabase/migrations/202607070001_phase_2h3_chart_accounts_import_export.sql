create or replace function public.get_accounting_account_movement_flags(target_account_ids uuid[])
returns table(account_id uuid, has_movements boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('accounting:read') then
    raise exception 'No tienes permiso para consultar movimientos contables.';
  end if;

  return query
  select input.account_id,
    exists (
      select 1
      from public.journal_entry_lines line
      where line.account_id = input.account_id
    ) as has_movements
  from unnest(coalesce(target_account_ids, array[]::uuid[])) as input(account_id);
end;
$$;

grant execute on function public.get_accounting_account_movement_flags(uuid[]) to authenticated;
grant execute on function public.get_accounting_account_movement_flags(uuid[]) to service_role;

create or replace function public.apply_chart_of_accounts_import(import_rows jsonb, actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  duplicate_code text;
  invalid_code text;
  inactive_parent_code text;
  changed_with_movements text;
  cycle_account uuid;
  created_count integer := 0;
  updated_count integer := 0;
  skipped_count integer := 0;
  processed_count integer := 0;
begin
  if not public.has_permission('accounting:manage') then
    raise exception 'No tienes permiso para importar el catálogo de cuentas.';
  end if;

  if jsonb_typeof(import_rows) <> 'array' then
    raise exception 'El archivo validado no tiene una estructura válida.';
  end if;

  create temp table chart_import_accounts (
    ord integer not null,
    id uuid,
    existing boolean not null default false,
    code text not null,
    name text not null,
    type text not null,
    normal_balance text not null,
    parent_code text,
    parent_id uuid,
    is_active boolean not null,
    description text,
    old_name text,
    old_type text,
    old_normal_balance text,
    old_parent_id uuid,
    old_is_active boolean,
    old_description text,
    has_movements boolean not null default false
  ) on commit drop;

  insert into chart_import_accounts (ord, code, name, type, normal_balance, parent_code, is_active, description)
  select
    row_number() over (),
    upper(trim(value->>'code')),
    trim(value->>'name'),
    trim(value->>'type'),
    trim(value->>'normal_balance'),
    nullif(upper(trim(value->>'parent_code')), ''),
    coalesce((value->>'is_active')::boolean, true),
    nullif(trim(value->>'description'), '')
  from jsonb_array_elements(import_rows) as rows(value);

  select count(*) into processed_count from chart_import_accounts;

  if processed_count = 0 then
    raise exception 'El archivo no contiene cuentas para importar.';
  end if;

  if exists (
    select 1
    from chart_import_accounts
    where code = '' or name = ''
      or type not in ('asset', 'liability', 'equity', 'revenue', 'cost', 'expense')
      or normal_balance not in ('debit', 'credit')
  ) then
    raise exception 'El archivo contiene cuentas con datos inválidos.';
  end if;

  select code into duplicate_code
  from chart_import_accounts
  group by code
  having count(*) > 1
  limit 1;

  if duplicate_code is not null then
    raise exception 'El código de cuenta % está duplicado.', duplicate_code;
  end if;

  update chart_import_accounts imported
  set
    id = account.id,
    existing = true,
    old_name = account.name,
    old_type = account.type,
    old_normal_balance = account.normal_balance,
    old_parent_id = account.parent_id,
    old_is_active = account.is_active,
    old_description = account.description
  from public.accounting_accounts account
  where account.code = imported.code;

  update chart_import_accounts
  set id = gen_random_uuid()
  where id is null;

  update chart_import_accounts imported
  set has_movements = true
  where exists (
    select 1
    from public.journal_entry_lines line
    where line.account_id = imported.id
  );

  update chart_import_accounts imported
  set parent_id = parent.id
  from chart_import_accounts parent
  where imported.parent_code is not null
    and imported.parent_code = parent.code;

  update chart_import_accounts imported
  set parent_id = parent.id
  from public.accounting_accounts parent
  where imported.parent_code is not null
    and imported.parent_id is null
    and imported.parent_code = parent.code;

  select code into invalid_code
  from chart_import_accounts
  where parent_code is not null and parent_id is null
  limit 1;

  if invalid_code is not null then
    raise exception 'La cuenta % tiene una cuenta padre inválida.', invalid_code;
  end if;

  select imported.code into inactive_parent_code
  from chart_import_accounts imported
  join chart_import_accounts parent on parent.code = imported.parent_code
  where parent.is_active = false
  limit 1;

  if inactive_parent_code is null then
    select imported.code into inactive_parent_code
    from chart_import_accounts imported
    join public.accounting_accounts parent on parent.code = imported.parent_code
    left join chart_import_accounts imported_parent on imported_parent.code = parent.code
    where imported_parent.code is null
      and parent.is_active = false
    limit 1;
  end if;

  if inactive_parent_code is not null then
    raise exception 'La cuenta % usa una cuenta padre inactiva.', inactive_parent_code;
  end if;

  select code into changed_with_movements
  from chart_import_accounts
  where existing = true
    and has_movements = true
    and (
      type is distinct from old_type
      or normal_balance is distinct from old_normal_balance
      or parent_id is distinct from old_parent_id
    )
  limit 1;

  if changed_with_movements is not null then
    raise exception 'La cuenta % tiene movimientos y no admite cambios estructurales.', changed_with_movements;
  end if;

  with recursive graph as (
    select account.id, account.parent_id
    from public.accounting_accounts account
    where not exists (
      select 1 from chart_import_accounts imported where imported.code = account.code
    )
    union all
    select imported.id, imported.parent_id
    from chart_import_accounts imported
  ), walk(root_id, node_id, parent_id, path, cycle) as (
    select graph.id, graph.id, graph.parent_id, array[graph.id], false
    from graph
    union all
    select walk.root_id, graph.id, graph.parent_id, walk.path || graph.id, graph.id = any(walk.path)
    from walk
    join graph on graph.id = walk.parent_id
    where walk.parent_id is not null
      and not walk.cycle
  )
  select root_id into cycle_account
  from walk
  where cycle = true
  limit 1;

  if cycle_account is not null then
    raise exception 'La importación crea un ciclo de cuentas padre.';
  end if;

  select
    count(*) filter (where existing = false),
    count(*) filter (
      where existing = true
        and (
          name is distinct from old_name
          or type is distinct from old_type
          or normal_balance is distinct from old_normal_balance
          or parent_id is distinct from old_parent_id
          or is_active is distinct from old_is_active
          or description is distinct from old_description
        )
    ),
    count(*) filter (
      where existing = true
        and not (
          name is distinct from old_name
          or type is distinct from old_type
          or normal_balance is distinct from old_normal_balance
          or parent_id is distinct from old_parent_id
          or is_active is distinct from old_is_active
          or description is distinct from old_description
        )
    )
  into created_count, updated_count, skipped_count
  from chart_import_accounts;

  insert into public.accounting_accounts (
    id, code, name, type, parent_id, normal_balance, is_active, description, created_by
  )
  select id, code, name, type, parent_id, normal_balance, is_active, description, actor_id
  from chart_import_accounts
  where existing = false;

  update public.accounting_accounts account
  set
    name = imported.name,
    type = imported.type,
    parent_id = imported.parent_id,
    normal_balance = imported.normal_balance,
    is_active = imported.is_active,
    description = imported.description
  from chart_import_accounts imported
  where imported.existing = true
    and account.id = imported.id
    and (
      imported.name is distinct from imported.old_name
      or imported.type is distinct from imported.old_type
      or imported.normal_balance is distinct from imported.old_normal_balance
      or imported.parent_id is distinct from imported.old_parent_id
      or imported.is_active is distinct from imported.old_is_active
      or imported.description is distinct from imported.old_description
    );

  return jsonb_build_object(
    'processed', processed_count,
    'created', created_count,
    'updated', updated_count,
    'skipped', skipped_count
  );
end;
$$;

grant execute on function public.apply_chart_of_accounts_import(jsonb, uuid) to authenticated;
grant execute on function public.apply_chart_of_accounts_import(jsonb, uuid) to service_role;