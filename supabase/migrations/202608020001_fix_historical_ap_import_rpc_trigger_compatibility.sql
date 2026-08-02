begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- This private, transaction-scoped row is established only by the authorized
-- historical AP apply RPC. It is never exposed through PostgREST or frontend
-- grants, and a successful payment insert removes it immediately.
create schema historical_ap_internal authorization postgres;
revoke all on schema historical_ap_internal from public;
revoke all on schema historical_ap_internal from anon, authenticated, service_role;

create table historical_ap_internal.payment_insert_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  batch_id uuid not null,
  row_id uuid not null,
  actor_id uuid not null,
  canonical_method text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (backend_pid, transaction_id),
  constraint historical_ap_payment_context_method_check
    check (canonical_method in ('cash', 'bank_transfer'))
);

alter table historical_ap_internal.payment_insert_context enable row level security;
revoke all on historical_ap_internal.payment_insert_context
  from public, anon, authenticated, service_role;

create or replace function public.require_supplier_payment_method_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  verified_historical_context boolean := false;
begin
  if new.imported_from_batch_id is not null
    or new.imported_from_row_id is not null
  then
    if new.imported_from_batch_id is null
      or new.imported_from_row_id is null
    then
      raise exception using
        errcode = '42501',
        message = 'El contexto del pago historico esta incompleto.';
    end if;

    select exists (
      select 1
      from historical_ap_internal.payment_insert_context context
      join public.import_batches batch
        on batch.id = context.batch_id
       and batch.module = 'accounts_payable'
      join public.import_rows import_row
        on import_row.id = context.row_id
       and import_row.batch_id = context.batch_id
       and import_row.module = 'accounts_payable'
      join public.accounts_payable payable
        on payable.id = new.accounts_payable_id
       and payable.imported_from_batch_id = context.batch_id
       and payable.imported_from_row_id = context.row_id
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.batch_id = new.imported_from_batch_id
        and context.row_id = new.imported_from_row_id
        and context.actor_id = auth.uid()
        and context.actor_id = new.created_by
        and context.canonical_method = new.payment_method
        and context.canonical_method = new.payment_method_v2
        and context.created_at >= clock_timestamp() - interval '5 minutes'
        and import_row.validation_status in ('valid', 'warning')
        and import_row.assignment_status = 'confirmed'
        and import_row.assigned_supplier_id = new.supplier_id
        and import_row.apply_status in ('pending', 'ready')
        and import_row.normalized_data->>'payment_method' = context.canonical_method
        and round((import_row.normalized_data->>'paid_amount')::numeric, 2) = new.amount
        and coalesce(nullif(import_row.normalized_data->>'currency', ''), 'HNL') = new.currency
        and payable.supplier_id = new.supplier_id
        and new.status = 'paid'
        and new.allocation_mode = 'legacy_single'
        and new.imported_metadata->>'source' = 'historical_accounts_payable_import'
        and new.imported_metadata->>'legacy_payment_method' = context.canonical_method
    ) into verified_historical_context;

    if not verified_historical_context then
      raise exception using
        errcode = '42501',
        message = 'El pago historico no tiene un contexto de importacion autorizado.';
    end if;

    return new;
  end if;

  if new.payment_method_v2 is null
    or new.payment_method_v2 not in (
      'cash', 'bank_transfer', 'card_credit', 'card_debit'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'Los pagos nuevos requieren un metodo cerrado: cash, bank_transfer, card_credit o card_debit.';
  end if;
  if lower(btrim(new.payment_method)) <> new.payment_method_v2 then
    raise exception using
      errcode = '22023',
      message = 'El metodo operativo no coincide con su clasificacion contable.';
  end if;
  return new;
end;
$$;

create or replace function public.enqueue_supplier_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  verified_historical_context boolean := false;
begin
  if new.status = 'paid'
    and new.imported_from_batch_id is not null
    and new.imported_from_row_id is not null
  then
    select exists (
      select 1
      from historical_ap_internal.payment_insert_context context
      join public.import_batches batch
        on batch.id = context.batch_id
       and batch.module = 'accounts_payable'
      join public.import_rows import_row
        on import_row.id = context.row_id
       and import_row.batch_id = context.batch_id
       and import_row.module = 'accounts_payable'
      join public.accounts_payable payable
        on payable.id = new.accounts_payable_id
       and payable.imported_from_batch_id = context.batch_id
       and payable.imported_from_row_id = context.row_id
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.batch_id = new.imported_from_batch_id
        and context.row_id = new.imported_from_row_id
        and context.actor_id = auth.uid()
        and context.actor_id = new.created_by
        and context.canonical_method = new.payment_method
        and context.canonical_method = new.payment_method_v2
        and context.created_at >= clock_timestamp() - interval '5 minutes'
        and import_row.validation_status in ('valid', 'warning')
        and import_row.assignment_status = 'confirmed'
        and import_row.assigned_supplier_id = new.supplier_id
        and import_row.apply_status in ('pending', 'ready')
        and import_row.normalized_data->>'payment_method' = context.canonical_method
        and round((import_row.normalized_data->>'paid_amount')::numeric, 2) = new.amount
        and payable.supplier_id = new.supplier_id
        and new.allocation_mode = 'legacy_single'
        and new.imported_metadata->>'source' = 'historical_accounts_payable_import'
    ) into verified_historical_context;

    if not verified_historical_context then
      raise exception using
        errcode = '42501',
        message = 'No se puede excluir un pago del enrutamiento V2 sin contexto historico autorizado.';
    end if;

    return new;
  end if;

  if new.status = 'paid'
    and (
      tg_op = 'INSERT'
      or old.status is distinct from 'paid'
    )
  then
    perform public.route_supplier_payment_accounting_v2(
      new.id,
      coalesce(new.created_by, auth.uid())
    );
  end if;
  return new;
end;
$$;

create or replace function public.apply_historical_accounts_payable_import(
  target_batch_id uuid
)
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
  ambiguous_methods text;
  created_invoices integer := 0;
  created_payables integer := 0;
  created_payments integer := 0;
  skipped_rows integer := 0;
  applied_total_amount numeric(14, 2) := 0;
  applied_paid_amount numeric(14, 2) := 0;
begin
  select *
    into target_batch
    from public.import_batches
    where id = target_batch_id
    for update;

  if target_batch.id is null
    or target_batch.module <> 'accounts_payable'
  then
    raise exception 'El lote de importacion de cuentas por pagar no existe.';
  end if;

  if not public.has_import_foundation_permission(
    'accounts_payable',
    'apply'
  ) then
    raise exception 'No tienes permiso para aplicar cuentas por pagar historicas.';
  end if;

  select string_agg(distinct coalesce(nullif(import_row.normalized_data->>'payment_method', ''), 'missing'), ', ' order by coalesce(nullif(import_row.normalized_data->>'payment_method', ''), 'missing'))
    into ambiguous_methods
  from public.import_rows import_row
  where import_row.batch_id = target_batch_id
    and import_row.module = 'accounts_payable'
    and import_row.validation_status in ('valid', 'warning')
    and import_row.assignment_status = 'confirmed'
    and import_row.assigned_supplier_id is not null
    and import_row.apply_status in ('pending', 'ready')
    and import_row.normalized_data->>'status' <> 'cancelled'
    and round((import_row.normalized_data->>'paid_amount')::numeric, 2) > 0
    and coalesce(nullif(import_row.normalized_data->>'payment_method', ''), 'missing')
      not in ('cash', 'bank_transfer');

  if ambiguous_methods is not null then
    raise exception using
      errcode = '22023',
      message = 'El lote contiene metodos de pago historicos ambiguos o ausentes: ' || ambiguous_methods || '. Selecciona explicitamente cash o bank_transfer antes de aplicarlo.';
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
    invoice_status := case
      when payable_status = 'paid' then 'paid'
      else 'posted_to_ap'
    end;

    insert into public.supplier_invoices (
      supplier_id, purchase_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, discount_amount, total, currency,
      notes, created_by, received_by, received_at,
      imported_from_batch_id, imported_from_row_id, imported_metadata
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
      supplier_id, purchase_id, supplier_invoice_id, total_amount,
      paid_amount, due_date, status, currency, notes, created_by,
      imported_from_batch_id, imported_from_row_id,
      historical_supplier_invoice_number, imported_observations,
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
    applied_total_amount := applied_total_amount
      + round((row_item.normalized_data->>'original_amount')::numeric, 2);
    applied_paid_amount := applied_paid_amount
      + round((row_item.normalized_data->>'paid_amount')::numeric, 2);

    if round((row_item.normalized_data->>'paid_amount')::numeric, 2) > 0 then
      payment_method := row_item.normalized_data->>'payment_method';

      insert into historical_ap_internal.payment_insert_context (
        backend_pid, transaction_id, batch_id, row_id, actor_id,
        canonical_method
      )
      values (
        pg_backend_pid(), txid_current(), target_batch_id, row_item.id,
        auth.uid(), payment_method
      );

      insert into public.supplier_payments (
        accounts_payable_id, supplier_id, amount, payment_method,
        payment_method_v2, status, paid_at, notes, created_by,
        imported_from_batch_id, imported_from_row_id, imported_metadata,
        allocation_mode, currency
      )
      values (
        payable_id,
        row_item.assigned_supplier_id,
        round((row_item.normalized_data->>'paid_amount')::numeric, 2),
        payment_method,
        payment_method,
        'paid',
        case
          when nullif(row_item.normalized_data->>'payment_date', '') is null
            then null
          else (row_item.normalized_data->>'payment_date')::date::timestamptz
        end,
        nullif(row_item.normalized_data->>'payment_reference', ''),
        auth.uid(),
        target_batch_id,
        row_item.id,
        jsonb_build_object(
          'source', 'historical_accounts_payable_import',
          'legacy_payment_method', payment_method,
          'legacy_payment_label', nullif(row_item.normalized_data->>'payment_label', ''),
          'payment_reference', nullif(row_item.normalized_data->>'payment_reference', ''),
          'prospective_accounting_v2_excluded', true
        ),
        'legacy_single',
        coalesce(nullif(row_item.normalized_data->>'currency', ''), 'HNL')
      );

      delete from historical_ap_internal.payment_insert_context
      where backend_pid = pg_backend_pid()
        and transaction_id = txid_current()
        and batch_id = target_batch_id
        and row_id = row_item.id;

      created_payments := created_payments + 1;
    end if;

    update public.import_rows
    set apply_status = 'applied',
        apply_error = null,
        audit_metadata = coalesce(audit_metadata, '{}'::jsonb)
          || jsonb_build_object(
            'supplier_invoice_id', invoice_id,
            'accounts_payable_id', payable_id
          ),
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
    applied_at = case
      when created_payables > 0 then now()
      else applied_at
    end,
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
      jsonb_build_object(
        'invoices', created_invoices,
        'payables', created_payables,
        'payments', created_payments,
        'skipped', skipped_rows
      )
    ),
    updated_at = now()
  where id = target_batch_id;

  insert into public.import_audit_events (
    batch_id, module, event_type, metadata, created_by
  )
  values (
    target_batch_id,
    'accounts_payable',
    'apply_completed',
    jsonb_build_object(
      'action', 'historical_accounts_payable_import_applied',
      'description', 'Aplicacion de cuentas por pagar historicas completada.',
      'batch_id', target_batch_id,
      'source', 'historical_accounts_payable_import',
      'record_count', created_payables,
      'total_amount', applied_total_amount,
      'paid_amount', applied_paid_amount,
      'invoices', created_invoices,
      'payables', created_payables,
      'payments', created_payments,
      'skipped', skipped_rows
    ),
    auth.uid()
  );

  return jsonb_build_object(
    'invoices', created_invoices,
    'payables', created_payables,
    'payments', created_payments,
    'skipped', skipped_rows
  );
end;
$$;

create or replace function public.rollback_historical_accounts_payable_import(
  target_batch_id uuid,
  rollback_reason text default null
)
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
  rollback_total_amount numeric(14, 2) := 0;
  rollback_paid_amount numeric(14, 2) := 0;
  rollback_payment_amount numeric(14, 2) := 0;
begin
  if not public.has_import_foundation_permission(
    'accounts_payable',
    'rollback'
  ) then
    raise exception 'Solo technical_owner o business_owner pueden revertir lotes aplicados.';
  end if;

  if not exists (
    select 1
    from public.import_batches
    where id = target_batch_id
      and module = 'accounts_payable'
  ) then
    raise exception 'El lote de importacion de cuentas por pagar no existe.';
  end if;

  select
    coalesce(sum(total_amount), 0),
    coalesce(sum(paid_amount), 0)
  into rollback_total_amount, rollback_paid_amount
  from public.accounts_payable
  where imported_from_batch_id = target_batch_id;

  select coalesce(sum(amount), 0)
    into rollback_payment_amount
  from public.supplier_payments
  where imported_from_batch_id = target_batch_id;

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
      audit_metadata = coalesce(audit_metadata, '{}'::jsonb)
        || jsonb_build_object('rollback_reason', rollback_note),
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
        jsonb_build_object(
          'invoices', deleted_invoices,
          'payables', deleted_payables,
          'payments', deleted_payments,
          'reason', rollback_note
        )
      ),
      updated_at = now()
  where id = target_batch_id;

  perform public.recount_import_batch(target_batch_id);

  insert into public.import_audit_events (
    batch_id, module, event_type, metadata, created_by
  )
  values (
    target_batch_id,
    'accounts_payable',
    'rollback_completed',
    jsonb_build_object(
      'action', 'historical_accounts_payable_import_rolled_back',
      'description', 'Rollback de cuentas por pagar historicas completado.',
      'batch_id', target_batch_id,
      'source', 'historical_accounts_payable_import',
      'record_count', deleted_payables,
      'total_amount', rollback_total_amount,
      'paid_amount', rollback_paid_amount,
      'payment_amount', rollback_payment_amount,
      'invoices', deleted_invoices,
      'payables', deleted_payables,
      'payments', deleted_payments,
      'reason', rollback_note
    ),
    auth.uid()
  );

  return jsonb_build_object(
    'invoices', deleted_invoices,
    'payables', deleted_payables,
    'payments', deleted_payments
  );
end;
$$;

commit;
