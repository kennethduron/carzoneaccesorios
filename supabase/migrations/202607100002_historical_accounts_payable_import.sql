alter table public.supplier_invoices
  add column if not exists imported_from_batch_id uuid references public.import_batches(id) on delete set null,
  add column if not exists imported_from_row_id uuid references public.import_rows(id) on delete set null,
  add column if not exists imported_metadata jsonb not null default '{}'::jsonb;

alter table public.accounts_payable
  add column if not exists imported_from_batch_id uuid references public.import_batches(id) on delete set null,
  add column if not exists imported_from_row_id uuid references public.import_rows(id) on delete set null,
  add column if not exists historical_supplier_invoice_number text,
  add column if not exists imported_observations text,
  add column if not exists imported_metadata jsonb not null default '{}'::jsonb;

alter table public.supplier_payments
  add column if not exists imported_from_batch_id uuid references public.import_batches(id) on delete set null,
  add column if not exists imported_from_row_id uuid references public.import_rows(id) on delete set null,
  add column if not exists imported_metadata jsonb not null default '{}'::jsonb;

create index if not exists supplier_invoices_import_batch_idx
  on public.supplier_invoices(imported_from_batch_id, created_at desc);

create unique index if not exists supplier_invoices_import_row_unique_idx
  on public.supplier_invoices(imported_from_row_id)
  where imported_from_row_id is not null;

create index if not exists accounts_payable_import_batch_idx
  on public.accounts_payable(imported_from_batch_id, created_at desc);

create unique index if not exists accounts_payable_import_row_unique_idx
  on public.accounts_payable(imported_from_row_id)
  where imported_from_row_id is not null;

create index if not exists supplier_payments_import_batch_idx
  on public.supplier_payments(imported_from_batch_id, created_at desc);

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
      return actor_role_name in ('technical_owner', 'business_owner') and public.has_permission('receivables:rollback');
    elsif import_action = 'assign' then
      return public.has_permission('receivables:assign');
    elsif import_action = 'review' then
      return public.has_permission('receivables:review') or public.has_permission('receivables:read');
    elsif import_action = 'audit' then
      return public.has_permission('audit:read') or public.has_permission('audit:read_operational');
    end if;
  elsif import_module = 'accounts_payable' then
    if actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora') then
      return false;
    end if;

    if import_action = 'import' then
      return public.has_permission('payables:import');
    elsif import_action = 'apply' then
      return public.has_permission('payables:apply');
    elsif import_action = 'rollback' then
      return actor_role_name in ('technical_owner', 'business_owner') and public.has_permission('payables:rollback');
    elsif import_action = 'assign' then
      return public.has_permission('payables:assign');
    elsif import_action = 'review' then
      return public.has_permission('payables:review') or public.has_permission('payables:read');
    elsif import_action = 'audit' then
      return public.has_permission('audit:read') or public.has_permission('audit:read_operational');
    end if;
  end if;

  return false;
end;
$$;

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(
    coalesce(public.roles.permissions, '[]'::jsonb) ||
    '[
      "payables:read",
      "payables:manage",
      "payables:import",
      "payables:apply",
      "payables:assign",
      "payables:review"
    ]'::jsonb
  ) as permissions(permission)
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin', 'contadora');

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb) || '["payables:rollback"]'::jsonb) as permissions(permission)
),
updated_at = now()
where name in ('technical_owner', 'business_owner');

update public.roles
set permissions = coalesce((
  select jsonb_agg(permission order by permission)
  from jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb)) as permissions(permission)
  where permission <> 'payables:rollback'
), '[]'::jsonb),
updated_at = now()
where name in ('admin', 'contadora');

create or replace function public.apply_historical_accounts_payable_import(target_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_batch public.import_batches%rowtype;
  row_item public.import_rows%rowtype;
  invoice_id uuid;
  payable_id uuid;
  payable_status text;
  invoice_status text;
  payment_method text;
  created_invoices integer := 0;
  created_payables integer := 0;
  created_payments integer := 0;
  skipped_rows integer := 0;
begin
  select *
    into target_batch
    from public.import_batches
    where id = target_batch_id
    for update;

  if target_batch.id is null or target_batch.module <> 'accounts_payable' then
    raise exception 'El lote de importacion de cuentas por pagar no existe.';
  end if;

  if not public.has_import_foundation_permission('accounts_payable', 'apply') then
    raise exception 'No tienes permiso para aplicar cuentas por pagar historicas.';
  end if;

  for row_item in
    select *
    from public.import_rows
    where batch_id = target_batch_id
      and module = 'accounts_payable'
      and validation_status in ('valid', 'warning')
      and assignment_status = 'confirmed'
      and assigned_supplier_id is not null
      and apply_status in ('pending', 'ready')
    order by row_number
    for update
  loop
    if row_item.normalized_data->>'status' = 'cancelled' then
      update public.import_rows
      set apply_status = 'skipped',
          apply_error = 'Fila cancelada historica conservada en staging; no se creo cuenta por pagar activa.',
          updated_at = now()
      where id = row_item.id;
      skipped_rows := skipped_rows + 1;
      continue;
    end if;

    if exists (
      select 1
      from public.supplier_invoices invoice
      where invoice.supplier_id = row_item.assigned_supplier_id
        and lower(trim(invoice.invoice_number)) = lower(trim(row_item.normalized_data->>'supplier_invoice_number'))
        and invoice.status <> 'cancelled'
        and coalesce(invoice.imported_from_row_id, '00000000-0000-0000-0000-000000000000'::uuid) <> row_item.id
    ) then
      update public.import_rows
      set apply_status = 'failed',
          apply_error = 'Ya existe una factura activa para este proveedor con el mismo numero.',
          updated_at = now()
      where id = row_item.id;
      continue;
    end if;

    payable_status := case row_item.normalized_data->>'status'
      when 'paid' then 'paid'
      when 'partial' then 'partial'
      when 'overdue' then 'overdue'
      else 'pending'
    end;
    invoice_status := case when payable_status = 'paid' then 'paid' else 'posted_to_ap' end;

    insert into public.supplier_invoices (
      supplier_id,
      purchase_id,
      invoice_number,
      invoice_date,
      due_date,
      status,
      subtotal,
      tax_amount,
      discount_amount,
      total,
      currency,
      notes,
      created_by,
      received_by,
      received_at,
      imported_from_batch_id,
      imported_from_row_id,
      imported_metadata
    )
    values (
      row_item.assigned_supplier_id,
      null,
      trim(row_item.normalized_data->>'supplier_invoice_number'),
      (row_item.normalized_data->>'issue_date')::date,
      (row_item.normalized_data->>'due_date')::date,
      invoice_status,
      round((row_item.normalized_data->>'original_amount')::numeric, 2),
      0,
      0,
      round((row_item.normalized_data->>'original_amount')::numeric, 2),
      coalesce(nullif(row_item.normalized_data->>'currency', ''), 'HNL'),
      nullif(row_item.normalized_data->>'notes', ''),
      auth.uid(),
      auth.uid(),
      now(),
      target_batch_id,
      row_item.id,
      jsonb_build_object(
        'source', 'historical_accounts_payable_import',
        'purchase_number', nullif(row_item.normalized_data->>'purchase_number', ''),
        'payment_reference', nullif(row_item.normalized_data->>'payment_reference', '')
      )
    )
    returning id into invoice_id;

    created_invoices := created_invoices + 1;

    insert into public.accounts_payable (
      supplier_id,
      purchase_id,
      supplier_invoice_id,
      total_amount,
      paid_amount,
      due_date,
      status,
      currency,
      notes,
      created_by,
      imported_from_batch_id,
      imported_from_row_id,
      historical_supplier_invoice_number,
      imported_observations,
      imported_metadata
    )
    values (
      row_item.assigned_supplier_id,
      null,
      invoice_id,
      round((row_item.normalized_data->>'original_amount')::numeric, 2),
      round((row_item.normalized_data->>'paid_amount')::numeric, 2),
      (row_item.normalized_data->>'due_date')::date,
      payable_status,
      coalesce(nullif(row_item.normalized_data->>'currency', ''), 'HNL'),
      nullif(row_item.normalized_data->>'notes', ''),
      auth.uid(),
      target_batch_id,
      row_item.id,
      trim(row_item.normalized_data->>'supplier_invoice_number'),
      nullif(row_item.normalized_data->>'notes', ''),
      jsonb_build_object(
        'source', 'historical_accounts_payable_import',
        'issue_date', row_item.normalized_data->>'issue_date',
        'purchase_number', nullif(row_item.normalized_data->>'purchase_number', ''),
        'payment_label', nullif(row_item.normalized_data->>'payment_label', ''),
        'payment_reference', nullif(row_item.normalized_data->>'payment_reference', '')
      )
    )
    returning id into payable_id;

    created_payables := created_payables + 1;

    if round((row_item.normalized_data->>'paid_amount')::numeric, 2) > 0 then
      payment_method := case nullif(row_item.normalized_data->>'payment_method', '')
        when 'cash' then 'cash'
        when 'bank_transfer' then 'bank_transfer'
        when 'card' then 'card'
        when 'check' then 'check'
        else 'other'
      end;

      insert into public.supplier_payments (
        accounts_payable_id,
        supplier_id,
        amount,
        payment_method,
        status,
        paid_at,
        notes,
        created_by,
        imported_from_batch_id,
        imported_from_row_id,
        imported_metadata
      )
      values (
        payable_id,
        row_item.assigned_supplier_id,
        round((row_item.normalized_data->>'paid_amount')::numeric, 2),
        coalesce(payment_method, 'other'),
        'paid',
        case
          when nullif(row_item.normalized_data->>'payment_date', '') is null then null
          else (row_item.normalized_data->>'payment_date')::date::timestamptz
        end,
        nullif(row_item.normalized_data->>'payment_reference', ''),
        auth.uid(),
        target_batch_id,
        row_item.id,
        jsonb_build_object(
          'source', 'historical_accounts_payable_import',
          'payment_label', nullif(row_item.normalized_data->>'payment_label', ''),
          'payment_reference', nullif(row_item.normalized_data->>'payment_reference', '')
        )
      );

      created_payments := created_payments + 1;
    end if;

    update public.import_rows
    set apply_status = 'applied',
        apply_error = null,
        audit_metadata = coalesce(audit_metadata, '{}'::jsonb) || jsonb_build_object('supplier_invoice_id', invoice_id, 'accounts_payable_id', payable_id),
        updated_at = now()
    where id = row_item.id;
  end loop;

  perform public.recount_import_batch(target_batch_id);

  update public.import_batches
  set status = case
      when exists (
        select 1 from public.import_rows
        where batch_id = target_batch_id
          and apply_status not in ('applied', 'skipped', 'rolled_back')
      ) then 'pending_assignment'
      else 'applied'
    end,
    applied_at = case when created_payables > 0 then now() else applied_at end,
    completed_at = case
      when not exists (
        select 1 from public.import_rows
        where batch_id = target_batch_id
          and apply_status not in ('applied', 'skipped', 'rolled_back')
      ) then now()
      else completed_at
    end,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_apply_summary',
      jsonb_build_object('invoices', created_invoices, 'payables', created_payables, 'payments', created_payments, 'skipped', skipped_rows)
    ),
    updated_at = now()
  where id = target_batch_id;

  insert into public.import_audit_events (batch_id, module, event_type, actor_id, summary, metadata)
  values (
    target_batch_id,
    'accounts_payable',
    'apply_completed',
    auth.uid(),
    'Aplicacion de cuentas por pagar historicas completada.',
    jsonb_build_object('invoices', created_invoices, 'payables', created_payables, 'payments', created_payments, 'skipped', skipped_rows)
  );

  return jsonb_build_object('invoices', created_invoices, 'payables', created_payables, 'payments', created_payments, 'skipped', skipped_rows);
end;
$$;

create or replace function public.rollback_historical_accounts_payable_import(target_batch_id uuid, rollback_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rollback_note text := nullif(trim(rollback_reason), '');
  deleted_payments integer := 0;
  deleted_payables integer := 0;
  deleted_invoices integer := 0;
begin
  if not public.has_import_foundation_permission('accounts_payable', 'rollback') then
    raise exception 'Solo technical_owner o business_owner pueden revertir lotes aplicados.';
  end if;

  if not exists (
    select 1 from public.import_batches
    where id = target_batch_id
      and module = 'accounts_payable'
  ) then
    raise exception 'El lote de importacion de cuentas por pagar no existe.';
  end if;

  delete from public.supplier_payments
  where imported_from_batch_id = target_batch_id;
  get diagnostics deleted_payments = row_count;

  delete from public.accounts_payable
  where imported_from_batch_id = target_batch_id;
  get diagnostics deleted_payables = row_count;

  delete from public.supplier_invoices
  where imported_from_batch_id = target_batch_id;
  get diagnostics deleted_invoices = row_count;

  update public.import_rows
  set apply_status = 'rolled_back',
      audit_metadata = coalesce(audit_metadata, '{}'::jsonb) || jsonb_build_object('rollback_reason', rollback_note),
      updated_at = now()
  where batch_id = target_batch_id
    and module = 'accounts_payable'
    and apply_status = 'applied';

  update public.import_batches
  set status = 'rolled_back',
      rollback_reason = rollback_note,
      rolled_back_at = now(),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'rollback_summary',
        jsonb_build_object('invoices', deleted_invoices, 'payables', deleted_payables, 'payments', deleted_payments, 'reason', rollback_note)
      ),
      updated_at = now()
  where id = target_batch_id;

  perform public.recount_import_batch(target_batch_id);

  insert into public.import_audit_events (batch_id, module, event_type, actor_id, summary, metadata)
  values (
    target_batch_id,
    'accounts_payable',
    'rollback_completed',
    auth.uid(),
    'Rollback de cuentas por pagar historicas completado.',
    jsonb_build_object('invoices', deleted_invoices, 'payables', deleted_payables, 'payments', deleted_payments, 'reason', rollback_note)
  );

  return jsonb_build_object('invoices', deleted_invoices, 'payables', deleted_payables, 'payments', deleted_payments);
end;
$$;

grant execute on function public.apply_historical_accounts_payable_import(uuid) to authenticated;
grant execute on function public.rollback_historical_accounts_payable_import(uuid, text) to authenticated;
