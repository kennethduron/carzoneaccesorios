alter table public.accounts_receivable
  alter column order_id drop not null;

alter table public.accounts_receivable
  add column if not exists historical_invoice_number text,
  add column if not exists imported_from_batch_id uuid references public.import_batches(id) on delete set null,
  add column if not exists imported_from_row_id uuid unique references public.import_rows(id) on delete set null,
  add column if not exists imported_observations text,
  add column if not exists imported_metadata jsonb not null default '{}'::jsonb;

alter table public.accounts_receivable
  drop constraint if exists accounts_receivable_order_id_key;

create unique index if not exists accounts_receivable_order_id_unique_idx
  on public.accounts_receivable(order_id)
  where order_id is not null;

create index if not exists accounts_receivable_import_batch_idx
  on public.accounts_receivable(imported_from_batch_id, created_at desc)
  where imported_from_batch_id is not null;

create index if not exists accounts_receivable_historical_invoice_idx
  on public.accounts_receivable(historical_invoice_number)
  where historical_invoice_number is not null;

alter table public.accounts_receivable_payments
  alter column order_id drop not null;

update public.roles
set permissions = (
    select jsonb_agg(distinct permission_value)
    from jsonb_array_elements_text(
      permissions || '["receivables:read","receivables:export","receivables:import","receivables:apply","receivables:assign","receivables:review","receivables:rollback"]'::jsonb
    ) as permission_value
  ),
  updated_at = now()
where name in ('technical_owner', 'business_owner');

update public.roles
set permissions = (
    select jsonb_agg(distinct permission_value)
    from jsonb_array_elements_text(
      permissions || '["receivables:read","receivables:export","receivables:import","receivables:apply","receivables:assign","receivables:review"]'::jsonb
    ) as permission_value
  ),
  updated_at = now()
where name in ('admin', 'contadora');

create or replace function public.has_import_foundation_permission(import_module text, import_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor_role_name text := public.current_actor_role();
begin
  if auth.uid() is null then
    return false;
  end if;

  if import_module = 'accounts_receivable' then
    if actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora') then
      return false;
    end if;

    if import_action = 'import' then
      return public.has_permission('receivables:import');
    elsif import_action = 'apply' then
      return public.has_permission('receivables:apply');
    elsif import_action = 'rollback' then
      return actor_role_name in ('technical_owner', 'business_owner')
        and public.has_permission('receivables:rollback');
    elsif import_action = 'assign' then
      return public.has_permission('receivables:assign');
    elsif import_action in ('review', 'audit') then
      return public.has_permission('receivables:review')
        or public.has_permission('receivables:read');
    end if;
  elsif import_module = 'accounts_payable' then
    if import_action = 'import' then
      return public.has_permission('payables:import') or public.has_permission('payables:manage');
    elsif import_action = 'apply' then
      return public.has_permission('payables:apply') or public.has_permission('payables:manage');
    elsif import_action = 'rollback' then
      return public.has_permission('payables:rollback') or public.has_permission('payables:manage');
    elsif import_action = 'assign' then
      return public.has_permission('payables:assign') or public.has_permission('payables:manage');
    elsif import_action in ('review', 'audit') then
      return public.has_permission('payables:review') or public.has_permission('payables:read') or public.has_permission('payables:manage');
    end if;
  end if;

  return false;
end;
$$;

create or replace function public.upsert_import_rows(target_batch_id uuid, row_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  inserted_count integer := 0;
begin
  select module into target_module from public.import_batches where id = target_batch_id;
  if target_module is null then
    raise exception 'Import batch not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'import') then
    raise exception 'Insufficient import permission';
  end if;

  if coalesce(jsonb_array_length(row_payload), 0) > 1000 then
    raise exception 'Import row limit exceeded';
  end if;

  delete from public.import_rows where batch_id = target_batch_id;

  insert into public.import_rows (
    batch_id,
    module,
    row_number,
    original_data,
    normalized_data,
    validation_status,
    validation_messages,
    suggested_customer_id,
    suggested_supplier_id,
    assignment_type,
    assignment_status,
    assigned_customer_id,
    assigned_supplier_id,
    assigned_by,
    assigned_at,
    apply_status,
    audit_metadata
  )
  select
    target_batch_id,
    target_module,
    coalesce(nullif(value->>'row_number', '')::integer, row_number() over ()) as row_number,
    coalesce(value->'original_data', '{}'::jsonb),
    coalesce(value->'normalized_data', '{}'::jsonb),
    coalesce(nullif(value->>'validation_status', ''), 'pending'),
    coalesce(value->'validation_messages', '[]'::jsonb),
    nullif(value->>'suggested_customer_id', '')::uuid,
    nullif(value->>'suggested_supplier_id', '')::uuid,
    coalesce(nullif(value->>'assignment_type', ''), 'none'),
    coalesce(nullif(value->>'assignment_status', ''), 'not_required'),
    nullif(value->>'assigned_customer_id', '')::uuid,
    nullif(value->>'assigned_supplier_id', '')::uuid,
    case
      when nullif(value->>'assigned_customer_id', '') is not null
        or nullif(value->>'assigned_supplier_id', '') is not null
      then auth.uid()
      else null
    end,
    case
      when nullif(value->>'assigned_customer_id', '') is not null
        or nullif(value->>'assigned_supplier_id', '') is not null
      then now()
      else null
    end,
    coalesce(nullif(value->>'apply_status', ''), 'pending'),
    coalesce(value->'audit_metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(row_payload, '[]'::jsonb)) as payload(value);

  get diagnostics inserted_count = row_count;

  perform public.recount_import_batch(target_batch_id);

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (target_batch_id, target_module, 'rows_staged', jsonb_build_object('rows', inserted_count), auth.uid());

  return jsonb_build_object('rows', inserted_count);
end;
$$;

create or replace function public.update_import_row_staging(
  target_row_id uuid,
  next_normalized_data jsonb,
  next_validation_status text,
  next_validation_messages jsonb,
  correction_metadata jsonb default '{}'::jsonb
)
returns public.import_rows
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  updated_row public.import_rows;
begin
  select module into target_module from public.import_rows where id = target_row_id;
  if target_module is null then
    raise exception 'Import row not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'import') then
    raise exception 'Insufficient import correction permission';
  end if;

  if next_validation_status not in ('pending', 'valid', 'invalid', 'warning') then
    raise exception 'Unsupported validation status';
  end if;

  update public.import_rows
  set normalized_data = coalesce(next_normalized_data, '{}'::jsonb),
      validation_status = next_validation_status,
      validation_messages = coalesce(next_validation_messages, '[]'::jsonb),
      apply_status = case when next_validation_status = 'invalid' then 'pending' else apply_status end,
      audit_metadata = audit_metadata || coalesce(correction_metadata, '{}'::jsonb),
      updated_at = now()
  where id = target_row_id
  returning * into updated_row;

  insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
  values (updated_row.batch_id, updated_row.id, updated_row.module, 'row_corrected', coalesce(correction_metadata, '{}'::jsonb), auth.uid());

  perform public.recount_import_batch(updated_row.batch_id);
  return updated_row;
end;
$$;

create or replace function public.cancel_import_row(target_row_id uuid, cancellation_metadata jsonb default '{}'::jsonb)
returns public.import_rows
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  updated_row public.import_rows;
begin
  select module into target_module from public.import_rows where id = target_row_id;
  if target_module is null then
    raise exception 'Import row not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'import') then
    raise exception 'Insufficient import cancellation permission';
  end if;

  update public.import_rows
  set apply_status = 'skipped',
      audit_metadata = audit_metadata || coalesce(cancellation_metadata, '{}'::jsonb),
      updated_at = now()
  where id = target_row_id
    and apply_status <> 'applied'
  returning * into updated_row;

  if updated_row.id is null then
    raise exception 'Applied rows cannot be cancelled from staging';
  end if;

  insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
  values (updated_row.batch_id, updated_row.id, updated_row.module, 'row_cancelled', coalesce(cancellation_metadata, '{}'::jsonb), auth.uid());

  perform public.recount_import_batch(updated_row.batch_id);
  return updated_row;
end;
$$;

create or replace function public.apply_historical_accounts_receivable_import(target_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_batch public.import_batches%rowtype;
  row_item public.import_rows%rowtype;
  created_receivable_id uuid;
  created_count integer := 0;
  skipped_count integer := 0;
  paid_amount numeric(12, 2);
  payment_method text;
  receivable_status text;
begin
  select * into target_batch
  from public.import_batches
  where id = target_batch_id
  for update;

  if target_batch.id is null or target_batch.module <> 'accounts_receivable' then
    raise exception 'Import batch not found';
  end if;

  if target_batch.status in ('applied', 'rolled_back', 'cancelled') then
    raise exception 'Este lote ya fue cerrado.';
  end if;

  if not public.has_import_foundation_permission('accounts_receivable', 'apply') then
    raise exception 'No tienes permiso para aplicar importaciones de cuentas por cobrar.';
  end if;

  for row_item in
    select *
    from public.import_rows
    where batch_id = target_batch_id
      and module = 'accounts_receivable'
      and validation_status in ('valid', 'warning')
      and assignment_status = 'confirmed'
      and assigned_customer_id is not null
      and apply_status in ('pending', 'ready')
    order by row_number asc
    for update
  loop
    if exists (
      select 1
      from public.accounts_receivable
      where imported_from_row_id = row_item.id
    ) then
      skipped_count := skipped_count + 1;
      update public.import_rows
      set apply_status = 'applied',
          updated_at = now()
      where id = row_item.id;
      continue;
    end if;

    paid_amount := round(coalesce((row_item.normalized_data->>'paid_amount')::numeric, 0), 2);
    payment_method := case nullif(row_item.normalized_data->>'payment_method', '')
      when 'bank_transfer' then 'bank_transfer'
      when 'card' then 'card'
      else 'cash'
    end;
    receivable_status := case row_item.normalized_data->>'status'
      when 'pending' then 'open'
      else row_item.normalized_data->>'status'
    end;

    insert into public.accounts_receivable (
      customer_id,
      order_id,
      invoice_id,
      original_amount,
      balance_due,
      due_date,
      status,
      paid_at,
      overdue_at,
      payment_received_method,
      payment_received_reference,
      payment_recorded_by,
      historical_invoice_number,
      imported_from_batch_id,
      imported_from_row_id,
      imported_observations,
      imported_metadata
    )
    values (
      row_item.assigned_customer_id,
      null,
      null,
      round((row_item.normalized_data->>'original_amount')::numeric, 2),
      round((row_item.normalized_data->>'balance_due')::numeric, 2),
      (row_item.normalized_data->>'due_date')::date,
      receivable_status,
      case when receivable_status = 'paid' then coalesce((row_item.normalized_data->>'issue_date')::date, current_date)::timestamptz else null end,
      case when receivable_status = 'overdue' then now() else null end,
      case when paid_amount > 0 or receivable_status = 'paid' then coalesce(payment_method, 'cash') else null end,
      nullif(row_item.normalized_data->>'reference', ''),
      case when paid_amount > 0 or receivable_status = 'paid' then auth.uid() else null end,
      nullif(row_item.normalized_data->>'invoice_number', ''),
      target_batch_id,
      row_item.id,
      nullif(row_item.normalized_data->>'notes', ''),
      jsonb_build_object(
        'source', 'historical_accounts_receivable_import',
        'imported_customer_name', row_item.normalized_data->>'customer_name',
        'customer_code', nullif(row_item.normalized_data->>'customer_code', ''),
        'customer_email', nullif(row_item.normalized_data->>'customer_email', ''),
        'customer_phone', nullif(row_item.normalized_data->>'customer_phone', ''),
        'customer_tax_id', nullif(row_item.normalized_data->>'customer_tax_id', ''),
        'issue_date', row_item.normalized_data->>'issue_date',
        'payment_label', nullif(row_item.normalized_data->>'payment_label', ''),
        'operational_payment_method', payment_method
      )
    )
    returning id into created_receivable_id;

    if paid_amount > 0 then
      insert into public.accounts_receivable_payments (
        receivable_id,
        customer_id,
        order_id,
        amount,
        payment_method,
        reference,
        received_at,
        note,
        recorded_by,
        idempotency_key
      )
      values (
        created_receivable_id,
        row_item.assigned_customer_id,
        null,
        paid_amount,
        coalesce(payment_method, 'cash'),
        nullif(row_item.normalized_data->>'reference', ''),
        coalesce((row_item.normalized_data->>'issue_date')::date, current_date)::timestamptz,
        'Pago historico importado.',
        auth.uid(),
        'historical-ar-import:' || row_item.id::text
      );
    end if;

    update public.import_rows
    set apply_status = 'applied',
        apply_error = null,
        audit_metadata = audit_metadata || jsonb_build_object('applied_receivable_id', created_receivable_id),
        updated_at = now()
    where id = row_item.id;

    insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
    values (
      target_batch_id,
      row_item.id,
      'accounts_receivable',
      'row_applied',
      jsonb_build_object('receivable_id', created_receivable_id),
      auth.uid()
    );

    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      auth.uid(),
      public.current_actor_role(),
      'accounts_receivable',
      created_receivable_id,
      'historical_receivable_import.applied',
      jsonb_build_object('batch_id', target_batch_id, 'row_id', row_item.id)
    );

    created_count := created_count + 1;
  end loop;

  perform public.recount_import_batch(target_batch_id);

  update public.import_batches
  set status = case
      when exists (
        select 1 from public.import_rows
        where batch_id = target_batch_id
          and apply_status <> 'applied'
          and validation_status <> 'invalid'
          and assignment_status not in ('pending', 'suggested', 'unassigned')
      ) then 'validated'
      else 'applied'
    end,
    applied_at = case when created_count > 0 then now() else applied_at end,
    completed_at = case
      when not exists (
        select 1 from public.import_rows
        where batch_id = target_batch_id
          and apply_status <> 'applied'
          and validation_status <> 'invalid'
          and assignment_status not in ('pending', 'suggested', 'unassigned')
      ) then now()
      else completed_at
    end,
    metadata = metadata || jsonb_build_object('last_apply_created', created_count, 'last_apply_skipped', skipped_count),
    updated_at = now()
  where id = target_batch_id;

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (
    target_batch_id,
    'accounts_receivable',
    'batch_applied',
    jsonb_build_object('created', created_count, 'skipped', skipped_count),
    auth.uid()
  );

  return jsonb_build_object('created', created_count, 'skipped', skipped_count);
end;
$$;

create or replace function public.rollback_historical_accounts_receivable_import(target_batch_id uuid, rollback_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_payments integer := 0;
  deleted_receivables integer := 0;
begin
  if not public.has_import_foundation_permission('accounts_receivable', 'rollback') then
    raise exception 'Solo technical_owner o business_owner pueden revertir un lote aplicado.';
  end if;

  if not exists (
    select 1 from public.import_batches
    where id = target_batch_id
      and module = 'accounts_receivable'
      and status = 'applied'
  ) then
    raise exception 'Solo se puede revertir un lote aplicado de cuentas por cobrar.';
  end if;

  delete from public.accounts_receivable_payments payment
  using public.accounts_receivable receivable
  where payment.receivable_id = receivable.id
    and receivable.imported_from_batch_id = target_batch_id;
  get diagnostics deleted_payments = row_count;

  delete from public.accounts_receivable
  where imported_from_batch_id = target_batch_id;
  get diagnostics deleted_receivables = row_count;

  update public.import_rows
  set apply_status = 'rolled_back',
      updated_at = now()
  where batch_id = target_batch_id
    and apply_status = 'applied';

  update public.import_batches
  set status = 'rolled_back',
      rollback_reason = nullif(trim(coalesce(rollback_reason, '')), ''),
      rolled_back_at = now(),
      completed_at = now(),
      updated_at = now()
  where id = target_batch_id;

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (
    target_batch_id,
    'accounts_receivable',
    'batch_rolled_back',
    jsonb_build_object('receivables', deleted_receivables, 'payments', deleted_payments, 'reason', rollback_reason),
    auth.uid()
  );

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
  values (
    auth.uid(),
    public.current_actor_role(),
    'accounts_receivable',
    target_batch_id,
    'historical_receivable_import.rolled_back',
    jsonb_build_object('receivables', deleted_receivables, 'payments', deleted_payments, 'reason', rollback_reason)
  );

  return jsonb_build_object('receivables', deleted_receivables, 'payments', deleted_payments);
end;
$$;

grant execute on function public.update_import_row_staging(uuid, jsonb, text, jsonb, jsonb) to authenticated;
grant execute on function public.cancel_import_row(uuid, jsonb) to authenticated;
grant execute on function public.apply_historical_accounts_receivable_import(uuid) to authenticated;
grant execute on function public.rollback_historical_accounts_receivable_import(uuid, text) to authenticated;
