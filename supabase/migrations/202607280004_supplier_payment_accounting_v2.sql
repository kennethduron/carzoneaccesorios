-- Supplier payment V2 plus the generalized accounting-outbox worker.
-- The payment, payable balance update, audit row and outbox enqueue happen in
-- one database transaction. Journal publication remains manual.

alter table public.supplier_payments
  add column if not exists payment_method_v2 text,
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text,
  add column if not exists void_idempotency_key text,
  add column if not exists void_request_fingerprint text;

alter table public.supplier_payments
  drop constraint if exists supplier_payments_method_v2_check,
  add constraint supplier_payments_method_v2_check check (
    payment_method_v2 is null
    or payment_method_v2 in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
  ),
  drop constraint if exists supplier_payments_idempotency_length_check,
  add constraint supplier_payments_idempotency_length_check check (
    (idempotency_key is null or char_length(idempotency_key) between 8 and 200)
    and (request_fingerprint is null or char_length(request_fingerprint) = 32)
    and (void_idempotency_key is null or char_length(void_idempotency_key) between 8 and 200)
    and (void_request_fingerprint is null or char_length(void_request_fingerprint) = 32)
  );

create unique index if not exists supplier_payments_idempotency_key_v2_idx
  on public.supplier_payments(idempotency_key)
  where idempotency_key is not null;
create unique index if not exists supplier_payments_void_idempotency_key_v2_idx
  on public.supplier_payments(void_idempotency_key)
  where void_idempotency_key is not null;
create index if not exists supplier_payments_method_v2_idx
  on public.supplier_payments(payment_method_v2, paid_at desc)
  where payment_method_v2 is not null;

create or replace function public.enqueue_supplier_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'paid' then
    return new;
  end if;

  perform public.route_accounting_fact_v2(
    'supplier_payment_draft_v2',
    'payables.supplier_payment',
    'supplier_payment',
    new.id,
    'supplier_payment',
    coalesce(new.payment_method_v2, 'legacy_method_pending_data'),
    coalesce(new.paid_at, new.created_at),
    coalesce(new.created_by, auth.uid())
  );
  return new;
end;
$$;

revoke all on function public.enqueue_supplier_payment_v2()
  from public, anon, authenticated;

drop trigger if exists supplier_payments_enqueue_accounting_v2
  on public.supplier_payments;
create trigger supplier_payments_enqueue_accounting_v2
after insert on public.supplier_payments
for each row
execute function public.enqueue_supplier_payment_v2();

create or replace function public.register_supplier_payment_v2(
  target_accounts_payable_id uuid,
  payment_amount numeric,
  supplier_payment_method text,
  payment_paid_date date,
  payment_notes text,
  request_key text
)
returns table (
  payment_id uuid,
  accounts_payable_status text,
  paid_amount numeric,
  balance numeric,
  outbox_id uuid,
  outbox_created boolean,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  clean_method text := lower(btrim(coalesce(supplier_payment_method, '')));
  clean_key text := nullif(left(btrim(coalesce(request_key, '')), 200), '');
  clean_notes text := nullif(left(btrim(coalesce(payment_notes, '')), 2000), '');
  effective_date date := coalesce(payment_paid_date, (now() at time zone 'America/Tegucigalpa')::date);
  effective_at timestamptz;
  fingerprint text;
  existing public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  saved public.supplier_payments%rowtype;
  next_paid numeric(12, 2);
  next_status text;
  ensured_outbox_id uuid;
begin
  if actor_id is null or not public.has_permission('payables:manage') then
    raise exception using errcode = '42501', message = 'No tienes permiso para registrar pagos a proveedores.';
  end if;
  if payment_amount is null or payment_amount <= 0 or round(payment_amount, 2) <> payment_amount then
    raise exception using errcode = '22023', message = 'El pago debe ser mayor que cero y tener maximo dos decimales.';
  end if;
  if clean_method not in ('cash', 'bank_transfer', 'card_credit', 'card_debit') then
    raise exception using errcode = '22023', message = 'Selecciona un metodo de pago permitido.';
  end if;
  if clean_key is null then
    raise exception using errcode = '22023', message = 'La clave de idempotencia es obligatoria.';
  end if;
  if effective_date > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception using errcode = '22023', message = 'La fecha del pago no puede estar en el futuro.';
  end if;

  effective_at := effective_date::timestamp at time zone 'America/Tegucigalpa';
  fingerprint := md5(
    target_accounts_payable_id::text || '|' || round(payment_amount, 2)::text
    || '|' || clean_method || '|' || effective_date::text
    || '|' || coalesce(clean_notes, '')
  );

  perform pg_advisory_xact_lock(hashtextextended('supplier_payment_v2:' || clean_key, 0));

  select * into existing
  from public.supplier_payments
  where idempotency_key = clean_key
  limit 1;

  if found then
    if existing.request_fingerprint is distinct from fingerprint then
      raise exception using
        errcode = '23505',
        message = 'La clave de idempotencia ya fue usada con un pago diferente.';
    end if;

    select * into payable
    from public.accounts_payable
    where id = existing.accounts_payable_id;

    select id into ensured_outbox_id
    from public.accounting_outbox_v2
    where source_type = 'supplier_payment'
      and source_id = existing.id
      and event_purpose = 'supplier_payment'
      and posting_version = 'v2';

    payment_id := existing.id;
    accounts_payable_status := payable.status;
    paid_amount := payable.paid_amount;
    balance := payable.balance;
    outbox_id := ensured_outbox_id;
    outbox_created := false;
    idempotent_replay := true;
    return next;
    return;
  end if;

  select * into payable
  from public.accounts_payable
  where id = target_accounts_payable_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'La cuenta por pagar no existe.';
  end if;
  if payable.status in ('paid', 'cancelled') then
    raise exception using errcode = '22023', message = 'Esta cuenta por pagar ya no admite pagos.';
  end if;
  if round(payment_amount, 2) > round(payable.balance, 2) then
    raise exception using errcode = '22023', message = 'El pago no puede exceder el saldo pendiente.';
  end if;

  next_paid := round(payable.paid_amount + payment_amount, 2);
  next_status := case
    when next_paid >= payable.total_amount then 'paid'
    when next_paid > 0 then 'partial'
    else 'pending'
  end;

  insert into public.supplier_payments (
    accounts_payable_id, supplier_id, amount, payment_method,
    payment_method_v2, status, paid_at, notes, created_by,
    idempotency_key, request_fingerprint
  )
  values (
    payable.id, payable.supplier_id, round(payment_amount, 2), clean_method,
    clean_method, 'paid', effective_at, clean_notes, actor_id,
    clean_key, fingerprint
  )
  returning * into saved;

  update public.accounts_payable
  set paid_amount = next_paid,
      status = next_status,
      updated_at = now()
  where id = payable.id
  returning * into payable;

  if payable.supplier_invoice_id is not null then
    update public.supplier_invoices
    set status = case when next_status = 'paid' then 'paid' else 'posted_to_ap' end,
        updated_at = now()
    where id = payable.supplier_invoice_id
      and status <> 'cancelled';
  end if;

  select id into ensured_outbox_id
  from public.accounting_outbox_v2
  where source_type = 'supplier_payment'
    and source_id = saved.id
    and event_purpose = 'supplier_payment'
    and posting_version = 'v2';

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'supplier_payments',
    saved.id,
    'supplier_payments.pay_v2',
    jsonb_build_object(
      'accounts_payable_id', payable.id,
      'previous_paid_amount', round(next_paid - saved.amount, 2)
    ),
    jsonb_build_object(
      'accounts_payable_id', payable.id,
      'amount', saved.amount,
      'payment_method', clean_method,
      'effective_date', effective_date,
      'accounts_payable_status', payable.status,
      'outbox_id', ensured_outbox_id
    )
  );

  payment_id := saved.id;
  accounts_payable_status := payable.status;
  paid_amount := payable.paid_amount;
  balance := payable.balance;
  outbox_id := ensured_outbox_id;
  outbox_created := ensured_outbox_id is not null;
  idempotent_replay := false;
  return next;
end;
$$;

revoke all on function public.register_supplier_payment_v2(
  uuid, numeric, text, date, text, text
) from public, anon;
grant execute on function public.register_supplier_payment_v2(
  uuid, numeric, text, date, text, text
) to authenticated;

create or replace function public.void_supplier_payment_v2(
  target_supplier_payment_id uuid,
  void_notes text,
  request_key text
)
returns table (
  payment_id uuid,
  accounts_payable_id uuid,
  accounts_payable_status text,
  paid_amount numeric,
  balance numeric,
  compensation_outbox_id uuid,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  clean_key text := nullif(left(btrim(coalesce(request_key, '')), 200), '');
  clean_notes text := nullif(left(btrim(coalesce(void_notes, '')), 1000), '');
  fingerprint text;
  payment public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  next_paid numeric(12, 2);
  next_status text;
  compensation_id uuid;
begin
  if actor_id is null or not public.has_permission('payables:manage') then
    raise exception using errcode = '42501', message = 'No tienes permiso para anular pagos a proveedores.';
  end if;
  if clean_key is null then
    raise exception using errcode = '22023', message = 'La clave de idempotencia es obligatoria.';
  end if;
  fingerprint := md5(target_supplier_payment_id::text || '|' || coalesce(clean_notes, ''));
  perform pg_advisory_xact_lock(hashtextextended('supplier_payment_void_v2:' || clean_key, 0));

  select * into payment
  from public.supplier_payments
  where id = target_supplier_payment_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'El pago a proveedor no existe.';
  end if;

  if payment.status = 'voided' then
    if payment.void_idempotency_key = clean_key
      and payment.void_request_fingerprint = fingerprint
    then
      select * into payable
      from public.accounts_payable where id = payment.accounts_payable_id;
      select id into compensation_id
      from public.accounting_outbox_v2
      where source_type = 'supplier_payment'
        and source_id = payment.id
        and event_purpose = 'supplier_payment_compensation'
        and posting_version = 'v2';

      payment_id := payment.id;
      accounts_payable_id := payable.id;
      accounts_payable_status := payable.status;
      paid_amount := payable.paid_amount;
      balance := payable.balance;
      compensation_outbox_id := compensation_id;
      idempotent_replay := true;
      return next;
      return;
    end if;
    raise exception using errcode = '22023', message = 'El pago ya fue anulado con otra solicitud.';
  end if;
  if payment.status <> 'paid' then
    raise exception using errcode = '22023', message = 'Solo se pueden anular pagos registrados como pagados.';
  end if;

  select * into payable
  from public.accounts_payable
  where id = payment.accounts_payable_id
  for update;

  if not found or payable.status = 'cancelled' then
    raise exception using errcode = '22023', message = 'La cuenta por pagar no admite esta anulacion.';
  end if;

  next_paid := greatest(round(payable.paid_amount - payment.amount, 2), 0);
  next_status := case
    when next_paid <= 0 then 'pending'
    when next_paid < payable.total_amount then 'partial'
    else 'paid'
  end;

  update public.supplier_payments
  set status = 'voided',
      voided_by = actor_id,
      voided_at = now(),
      void_idempotency_key = clean_key,
      void_request_fingerprint = fingerprint,
      notes = case
        when clean_notes is null then notes
        when notes is null or btrim(notes) = '' then clean_notes
        else notes || E'\nAnulacion: ' || clean_notes
      end,
      updated_at = now()
  where id = payment.id
  returning * into payment;

  update public.accounts_payable
  set paid_amount = next_paid,
      status = next_status,
      updated_at = now()
  where id = payable.id
  returning * into payable;

  if payable.supplier_invoice_id is not null then
    update public.supplier_invoices
    set status = case when next_status = 'paid' then 'paid' else 'posted_to_ap' end,
        updated_at = now()
    where id = payable.supplier_invoice_id
      and status <> 'cancelled';
  end if;

  compensation_id := public.cancel_accounting_fact_v2(
    'supplier_payment',
    payment.id,
    'supplier_payment',
    'supplier_payment_compensation',
    actor_id
  );

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  )
  values (
    actor_id,
    public.current_actor_role(),
    'supplier_payments',
    payment.id,
    'supplier_payments.void_v2',
    jsonb_build_object(
      'status', 'paid',
      'accounts_payable_id', payable.id,
      'paid_amount', round(next_paid + payment.amount, 2)
    ),
    jsonb_build_object(
      'status', 'voided',
      'accounts_payable_id', payable.id,
      'paid_amount', payable.paid_amount,
      'compensation_outbox_id', compensation_id
    )
  );

  payment_id := payment.id;
  accounts_payable_id := payable.id;
  accounts_payable_status := payable.status;
  paid_amount := payable.paid_amount;
  balance := payable.balance;
  compensation_outbox_id := compensation_id;
  idempotent_replay := false;
  return next;
end;
$$;

revoke all on function public.void_supplier_payment_v2(uuid, text, text)
  from public, anon;
grant execute on function public.void_supplier_payment_v2(uuid, text, text)
  to authenticated;

create or replace function public.resolve_accounting_mapping_v2(
  target_mapping_type text,
  target_source_key text,
  effective_date date
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select mapping.account_id
  from public.accounting_mappings mapping
  join public.accounting_accounts account on account.id = mapping.account_id
  where mapping.mapping_type = target_mapping_type
    and mapping.source_key = target_source_key
    and mapping.is_active = true
    and account.is_active = true
    and (mapping.effective_from is null or mapping.effective_from <= effective_date)
    and (mapping.effective_to is null or mapping.effective_to >= effective_date)
  order by mapping.priority, mapping.created_at, mapping.id
  limit 1
$$;

revoke all on function public.resolve_accounting_mapping_v2(text, text, date)
  from public, anon, authenticated;

create or replace function public.validate_accounting_shadow_fact_v2(
  target_feature_key text,
  target_source_type text,
  target_source_id uuid,
  target_scenario text,
  target_occurred_at timestamptz
)
returns table (validation_status text, validation_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_date date := (target_occurred_at at time zone 'America/Tegucigalpa')::date;
  order_row public.orders%rowtype;
  movement public.inventory_movements%rowtype;
  payment public.supplier_payments%rowtype;
  missing_keys text[] := array[]::text[];
  payment_mapping text;
begin
  validation_status := 'eligible';
  validation_code := null;

  if public.is_date_in_closed_accounting_period(effective_date) then
    validation_status := 'pending_data';
    validation_code := 'period_closed';
    return next;
    return;
  end if;

  if target_feature_key = 'sales_draft_v2' and target_source_type = 'order' then
    select * into order_row from public.orders where id = target_source_id;
    if not found then
      validation_status := 'pending_data'; validation_code := 'sale_source_missing';
      return next; return;
    end if;
    if order_row.status::text in ('cancelado', 'cancelled') then
      validation_status := 'ineligible'; validation_code := 'source_cancelled';
      return next; return;
    end if;
    if not exists (select 1 from public.order_items item where item.order_id = order_row.id) then
      validation_status := 'pending_data'; validation_code := 'sale_lines_missing';
      return next; return;
    end if;

    if target_scenario = 'commercial_credit_on_delivery' then
      if not exists (
        select 1 from public.accounts_receivable receivable
        where receivable.order_id = order_row.id and receivable.status <> 'cancelled'
      ) then
        validation_status := 'pending_data'; validation_code := 'receivable_missing';
        return next; return;
      end if;
      if public.resolve_accounting_mapping_v2('receivable', 'accounts_receivable', effective_date) is null then
        missing_keys := array_append(missing_keys, 'receivable:accounts_receivable');
      end if;
    else
      payment_mapping := case target_scenario
        when 'cash_or_cod_after_delivery' then 'cash'
        when 'prepaid_bank_transfer' then 'bank_transfer'
        when 'prepaid_customer_card' then 'card'
        when 'prepaid_cash' then 'cash'
        else order_row.payment_method::text
      end;
      if public.resolve_accounting_mapping_v2('payment_method', payment_mapping, effective_date) is null then
        missing_keys := array_append(missing_keys, 'payment_method:' || payment_mapping);
      end if;
    end if;
    if public.resolve_accounting_mapping_v2('revenue', 'sales_revenue', effective_date) is null then
      missing_keys := array_append(missing_keys, 'revenue:sales_revenue');
    end if;
    if coalesce(order_row.tax, 0) > 0
      and public.resolve_accounting_mapping_v2('tax', 'tax_payable', effective_date) is null
    then missing_keys := array_append(missing_keys, 'tax:tax_payable'); end if;
    if coalesce(order_row.shipping_fee, order_row.shipping_total, 0) > 0 then
      payment_mapping := case when order_row.external_delivery_provider is null
        then 'sale_shipping_fee' else 'sale_external_charge' end;
      if public.resolve_accounting_mapping_v2('revenue', payment_mapping, effective_date) is null then
        missing_keys := array_append(missing_keys, 'revenue:' || payment_mapping);
      end if;
    end if;
    if coalesce(order_row.cash_on_delivery_fee, 0) > 0
      and public.resolve_accounting_mapping_v2('revenue', 'sale_cod_fee', effective_date) is null
    then missing_keys := array_append(missing_keys, 'revenue:sale_cod_fee'); end if;
    if (coalesce(order_row.small_order_fee, 0) > 0
        or coalesce(jsonb_array_length(order_row.additional_fees), 0) > 0)
      and public.resolve_accounting_mapping_v2('revenue', 'sale_other_charge', effective_date) is null
    then missing_keys := array_append(missing_keys, 'revenue:sale_other_charge'); end if;

  elsif target_feature_key = 'cogs_draft_v2' and target_source_type = 'inventory_movement' then
    select * into movement from public.inventory_movements where id = target_source_id;
    if not found then
      validation_status := 'pending_data'; validation_code := 'inventory_movement_missing';
      return next; return;
    end if;
    if movement.movement_type::text <> 'sale' or movement.quantity >= 0
      or movement.stock_after >= movement.stock_before or movement.reference_type <> 'orders'
      or movement.reference_id is null
      or not exists (select 1 from public.orders where id = movement.reference_id)
      or not exists (select 1 from public.products where id = movement.product_id)
    then
      validation_status := 'ineligible'; validation_code := 'invalid_sale_movement';
      return next; return;
    end if;
    if coalesce(movement.unit_cost_snapshot, 0) <= 0
      or coalesce(movement.total_cost_snapshot, 0) <= 0
    then
      validation_status := 'pending_data'; validation_code := 'historical_cost_missing';
      return next; return;
    end if;
    if public.resolve_accounting_mapping_v2('inventory', 'cost_of_goods_sold', effective_date) is null then
      missing_keys := array_append(missing_keys, 'inventory:cost_of_goods_sold');
    end if;
    if public.resolve_accounting_mapping_v2('inventory', 'inventory_asset', effective_date) is null then
      missing_keys := array_append(missing_keys, 'inventory:inventory_asset');
    end if;

  elsif target_feature_key = 'supplier_payment_draft_v2' and target_source_type = 'supplier_payment' then
    select * into payment from public.supplier_payments where id = target_source_id;
    if not found then
      validation_status := 'pending_data'; validation_code := 'supplier_payment_missing';
      return next; return;
    end if;
    if payment.status = 'voided' then
      validation_status := 'ineligible'; validation_code := 'source_cancelled';
      return next; return;
    end if;
    if payment.status <> 'paid' or payment.amount <= 0
      or payment.payment_method_v2 not in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
      or not exists (
        select 1 from public.accounts_payable payable
        where payable.id = payment.accounts_payable_id and payable.supplier_id = payment.supplier_id
      )
    then
      validation_status := 'pending_data'; validation_code := 'supplier_payment_data_invalid';
      return next; return;
    end if;
    if public.resolve_accounting_mapping_v2('default_account', 'accounts_payable', effective_date) is null then
      missing_keys := array_append(missing_keys, 'default_account:accounts_payable');
    end if;
    payment_mapping := case payment.payment_method_v2
      when 'cash' then 'supplier_payment_cash'
      when 'bank_transfer' then 'supplier_payment_bank'
      when 'card_credit' then 'supplier_payment_card'
      when 'card_debit' then 'supplier_payment_bank'
    end;
    if public.resolve_accounting_mapping_v2('payment_method', payment_mapping, effective_date) is null then
      missing_keys := array_append(missing_keys, 'payment_method:' || payment_mapping);
    end if;
  else
    validation_status := 'ineligible'; validation_code := 'unsupported_shadow_contract';
    return next; return;
  end if;

  if cardinality(missing_keys) > 0 then
    validation_status := 'pending_mapping';
    validation_code := left(array_to_string(missing_keys, ', '), 120);
  end if;
  return next;
end;
$$;

revoke all on function public.validate_accounting_shadow_fact_v2(
  text, text, uuid, text, timestamptz
) from public, anon, authenticated;

create or replace function public.process_accounting_outbox_v2(
  target_outbox_id uuid,
  worker_token text,
  force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  clean_worker text := nullif(left(btrim(coalesce(worker_token, '')), 120), '');
  box public.accounting_outbox_v2%rowtype;
  flag public.accounting_feature_flags%rowtype;
  event public.financial_events%rowtype;
  order_row public.orders%rowtype;
  movement public.inventory_movements%rowtype;
  supplier_payment public.supplier_payments%rowtype;
  original_event public.financial_events%rowtype;
  original_entry public.journal_entries%rowtype;
  draft_actor uuid;
  effective_date date;
  event_snapshot jsonb := '{}'::jsonb;
  validation_errors jsonb := '[]'::jsonb;
  canonical_lines jsonb := '[]'::jsonb;
  normalized_lines jsonb;
  missing_keys text[] := array[]::text[];
  reason_code text;
  debit_account uuid;
  revenue_account uuid;
  tax_account uuid;
  shipping_account uuid;
  cod_account uuid;
  other_account uuid;
  cogs_account uuid;
  inventory_account uuid;
  payable_account uuid;
  payment_account uuid;
  receivable_id uuid;
  resolved_lines jsonb;
  financials jsonb;
  configured_tax_rate numeric := 0.15;
  wholesale_minimum numeric := 10000;
  delivery_threshold numeric := 3000;
  suggested_delivery numeric := 120;
  merchandise_base numeric(14, 2);
  tax_amount numeric(14, 2);
  shipping_amount numeric(14, 2);
  cod_amount numeric(14, 2);
  other_amount numeric(14, 2);
  additional_amount numeric(14, 2);
  total_amount numeric(14, 2);
  draft_description text;
  entry_id uuid;
  entry_number_value text;
  existing_entry_id uuid;
begin
  if clean_worker is null then
    raise exception using errcode = '22023', message = 'El worker requiere un identificador.';
  end if;
  if not service_call and (
    caller_id is null
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  ) then
    raise exception using errcode = '42501', message = 'No tienes permiso para procesar la outbox contable.';
  end if;

  select * into box
  from public.accounting_outbox_v2
  where id = target_outbox_id
  for update skip locked;

  if not found then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', target_outbox_id,
      'reason', 'already_processing'
    );
  end if;

  if box.status = 'completed' then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'event_id', box.financial_event_id,
      'journal_entry_id', box.journal_entry_id, 'reason', 'already_completed'
    );
  end if;
  if box.status = 'cancelled' then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'reason', 'source_cancelled'
    );
  end if;
  if box.status = 'processing'
    and box.lease_until > now()
    and box.locked_by is distinct from clean_worker
  then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'reason', 'active_lease'
    );
  end if;
  if box.attempt_count >= box.max_attempts and not force_retry then
    return jsonb_build_object(
      'ok', false, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'reason', 'max_attempts_reached'
    );
  end if;
  if box.next_attempt_at > now() and not force_retry then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'reason', 'retry_not_available',
      'next_attempt_at', box.next_attempt_at
    );
  end if;

  select * into flag
  from public.accounting_feature_flags
  where key = box.feature_key;

  if box.topic <> 'accounting.compensation'
    and (flag.state <> 'enabled' or flag.cutover_at is null or box.occurred_at < flag.cutover_at)
  then
    update public.accounting_outbox_v2
    set status = 'failed',
        last_error_code = 'feature_not_enabled',
        last_error_message = 'El modulo no esta habilitado para esta fecha de corte.',
        next_attempt_at = now() + interval '15 minutes',
        lease_until = null,
        locked_by = null
    where id = box.id;
    return jsonb_build_object(
      'ok', false, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', 'failed', 'reason', 'feature_not_enabled'
    );
  end if;

  update public.accounting_outbox_v2
  set status = 'processing',
      attempt_count = attempt_count + 1,
      lease_until = now() + interval '15 minutes',
      locked_by = clean_worker,
      last_error_code = null,
      last_error_message = null,
      missing_key = null
  where id = box.id
  returning * into box;

  draft_actor := coalesce(box.actor_id, flag.updated_by);
  if draft_actor is null or not exists (
    select 1 from public.users where id = draft_actor and active = true
  ) then
    reason_code := 'missing_automation_actor';
    validation_errors := jsonb_build_array(reason_code);
  end if;

  if reason_code is null and box.topic = 'sales.recognized' then
    select * into order_row
    from public.orders
    where id = box.source_id
    for share;

    if not found then
      reason_code := 'sale_source_missing';
    elsif order_row.status::text in ('cancelado', 'cancelled') then
      update public.accounting_outbox_v2
      set status = 'cancelled', cancelled_at = now(), lease_until = null,
          locked_by = null, last_error_code = 'source_cancelled',
          last_error_message = 'El pedido fue cancelado.'
      where id = box.id;
      return jsonb_build_object(
        'ok', true, 'claimed', true, 'outbox_id', box.id,
        'outbox_status', 'cancelled', 'reason', 'source_cancelled'
      );
    end if;

    if reason_code is null then
      select
        coalesce((select settings.tax_rate from public.company_settings settings order by settings.created_at limit 1), 0.15),
        coalesce((select settings.first_wholesale_minimum from public.company_settings settings order by settings.created_at limit 1), 10000),
        coalesce((select settings.free_shipping_threshold from public.company_settings settings order by settings.created_at limit 1), 3000),
        coalesce((select settings.standard_shipping_fee from public.company_settings settings order by settings.created_at limit 1), 120)
      into configured_tax_rate, wholesale_minimum, delivery_threshold, suggested_delivery;

      select jsonb_agg(jsonb_build_object(
        'quantity', item.quantity,
        'unit_price', item.unit_price,
        'discount_amount', 0
      ) order by item.id)
      into resolved_lines
      from public.order_items item
      where item.order_id = order_row.id;

      if resolved_lines is null then
        reason_code := 'sale_lines_missing';
      else
        financials := public.calculate_sale_financials_v1(
          resolved_lines,
          configured_tax_rate,
          coalesce(order_row.discount_total, 0),
          coalesce(order_row.shipping_fee, order_row.shipping_total, 0),
          coalesce(order_row.cash_on_delivery_fee, 0),
          coalesce(order_row.small_order_fee, 0),
          coalesce(order_row.additional_fees, '[]'::jsonb),
          wholesale_minimum,
          delivery_threshold,
          suggested_delivery,
          coalesce(order_row.delivery_mode, 'home_delivery'),
          case when order_row.price_mode::text = 'wholesale' then 'wholesale' else 'retail' end,
          'HNL'
        );
        merchandise_base := round((financials->>'fiscal_subtotal')::numeric, 2);
        tax_amount := round((financials->>'included_tax_total')::numeric, 2);
        shipping_amount := round((financials->>'delivery_charge')::numeric, 2);
        cod_amount := round((financials->>'cash_on_delivery_charge')::numeric, 2);
        additional_amount := round((financials->>'additional_charges_total')::numeric, 2);
        other_amount := round((financials->>'minimum_order_charge')::numeric + additional_amount, 2);
        total_amount := round((financials->>'total_final')::numeric, 2);

        if total_amount <= 0 or total_amount <> round(order_row.total, 2) then
          reason_code := 'sale_total_mismatch';
        end if;
      end if;
    end if;

    effective_date := (box.occurred_at at time zone 'America/Tegucigalpa')::date;
    if reason_code is null and public.is_date_in_closed_accounting_period(effective_date) then
      reason_code := 'period_closed';
    end if;

    if reason_code is null then
      if order_row.payment_method::text = 'commercial_credit' then
        select receivable.id into receivable_id
        from public.accounts_receivable receivable
        where receivable.order_id = order_row.id
          and receivable.status <> 'cancelled'
        order by receivable.created_at desc
        limit 1;
        debit_account := public.resolve_accounting_mapping_v2(
          'receivable', 'accounts_receivable', effective_date
        );
        if receivable_id is null then
          reason_code := 'receivable_missing';
        end if;
      else
        debit_account := public.resolve_accounting_mapping_v2(
          'payment_method', order_row.payment_method::text, effective_date
        );
      end if;

      revenue_account := public.resolve_accounting_mapping_v2(
        'revenue', 'sales_revenue', effective_date
      );
      if tax_amount > 0 then
        tax_account := public.resolve_accounting_mapping_v2(
          'tax', 'tax_payable', effective_date
        );
      end if;
      if shipping_amount > 0 then
        shipping_account := public.resolve_accounting_mapping_v2(
          'revenue',
          case
            when order_row.external_delivery_provider is not null then 'sale_external_charge'
            else 'sale_shipping_fee'
          end,
          effective_date
        );
      end if;
      if cod_amount > 0 then
        cod_account := public.resolve_accounting_mapping_v2(
          'revenue', 'sale_cod_fee', effective_date
        );
      end if;
      if other_amount > 0 then
        other_account := public.resolve_accounting_mapping_v2(
          'revenue', 'sale_other_charge', effective_date
        );
      end if;

      if debit_account is null then missing_keys := array_append(missing_keys,
        case when order_row.payment_method::text = 'commercial_credit'
          then 'receivable:accounts_receivable'
          else 'payment_method:' || order_row.payment_method::text end);
      end if;
      if revenue_account is null then missing_keys := array_append(missing_keys, 'revenue:sales_revenue'); end if;
      if tax_amount > 0 and tax_account is null then missing_keys := array_append(missing_keys, 'tax:tax_payable'); end if;
      if shipping_amount > 0 and shipping_account is null then missing_keys := array_append(missing_keys,
        'revenue:' || case when order_row.external_delivery_provider is not null then 'sale_external_charge' else 'sale_shipping_fee' end); end if;
      if cod_amount > 0 and cod_account is null then missing_keys := array_append(missing_keys, 'revenue:sale_cod_fee'); end if;
      if other_amount > 0 and other_account is null then missing_keys := array_append(missing_keys, 'revenue:sale_other_charge'); end if;

      event_snapshot := jsonb_build_object(
        'event_type', 'sale_recognized',
        'order_id', order_row.id,
        'customer_id', order_row.customer_id,
        'receivable_id', receivable_id,
        'payment_method', order_row.payment_method::text,
        'scenario', box.scenario,
        'currency', 'HNL',
        'effective_date', effective_date,
        'financials', financials
      );

      canonical_lines := jsonb_build_array(jsonb_build_object(
        'account_id', debit_account,
        'debit', total_amount,
        'credit', 0,
        'description', 'Reconocimiento de venta ' || left(order_row.id::text, 8),
        'customer_id', order_row.customer_id
      ));
      if merchandise_base > 0 then canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
        'account_id', revenue_account, 'debit', 0, 'credit', merchandise_base,
        'description', 'Mercaderia', 'customer_id', order_row.customer_id
      )); end if;
      if tax_amount > 0 then canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
        'account_id', tax_account, 'debit', 0, 'credit', tax_amount,
        'description', 'ISV incluido', 'customer_id', order_row.customer_id
      )); end if;
      if shipping_amount > 0 then canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
        'account_id', shipping_account, 'debit', 0, 'credit', shipping_amount,
        'description', 'Cargo de entrega', 'customer_id', order_row.customer_id
      )); end if;
      if cod_amount > 0 then canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
        'account_id', cod_account, 'debit', 0, 'credit', cod_amount,
        'description', 'Cargo contra entrega', 'customer_id', order_row.customer_id
      )); end if;
      if other_amount > 0 then canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
        'account_id', other_account, 'debit', 0, 'credit', other_amount,
        'description', 'Otros cargos', 'customer_id', order_row.customer_id
      )); end if;
      draft_description := 'Borrador automatico de venta ' || left(order_row.id::text, 8);
    end if;

  elsif reason_code is null and box.topic = 'inventory.cogs' then
    select * into movement
    from public.inventory_movements
    where id = box.source_id
    for share;

    effective_date := (box.occurred_at at time zone 'America/Tegucigalpa')::date;
    if not found then
      reason_code := 'inventory_movement_missing';
    elsif movement.movement_type::text <> 'sale'
      or movement.quantity >= 0
      or movement.stock_after >= movement.stock_before
      or movement.reference_type <> 'orders'
      or movement.reference_id is null
      or not exists (select 1 from public.orders where id = movement.reference_id)
    then
      reason_code := 'invalid_sale_movement';
    elsif movement.total_cost_snapshot is null
      or movement.total_cost_snapshot <= 0
      or movement.unit_cost_snapshot is null
      or movement.unit_cost_snapshot <= 0
    then
      reason_code := 'historical_cost_missing';
    elsif public.is_date_in_closed_accounting_period(effective_date) then
      reason_code := 'period_closed';
    else
      cogs_account := public.resolve_accounting_mapping_v2(
        'inventory', 'cost_of_goods_sold', effective_date
      );
      inventory_account := public.resolve_accounting_mapping_v2(
        'inventory', 'inventory_asset', effective_date
      );
      if cogs_account is null then missing_keys := array_append(missing_keys, 'inventory:cost_of_goods_sold'); end if;
      if inventory_account is null then missing_keys := array_append(missing_keys, 'inventory:inventory_asset'); end if;

      total_amount := round(movement.total_cost_snapshot, 2);
      event_snapshot := jsonb_build_object(
        'event_type', 'inventory_cogs',
        'inventory_movement_id', movement.id,
        'order_id', movement.reference_id,
        'product_id', movement.product_id,
        'quantity', movement.quantity,
        'unit_cost_snapshot', movement.unit_cost_snapshot,
        'total_cost_snapshot', total_amount,
        'cost_source', movement.cost_source,
        'effective_date', effective_date,
        'currency', 'HNL'
      );
      canonical_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', cogs_account, 'debit', total_amount, 'credit', 0,
          'description', 'Costo de salida ' || left(movement.id::text, 8),
          'product_id', movement.product_id
        ),
        jsonb_build_object(
          'account_id', inventory_account, 'debit', 0, 'credit', total_amount,
          'description', 'Disminucion de inventario ' || left(movement.id::text, 8),
          'product_id', movement.product_id
        )
      );
      draft_description := 'Borrador automatico de costo ' || left(movement.id::text, 8);
    end if;

  elsif reason_code is null and box.topic = 'payables.supplier_payment' then
    select * into supplier_payment
    from public.supplier_payments
    where id = box.source_id
    for share;

    effective_date := (box.occurred_at at time zone 'America/Tegucigalpa')::date;
    if not found then
      reason_code := 'supplier_payment_missing';
    elsif supplier_payment.status = 'voided' then
      update public.accounting_outbox_v2
      set status = 'cancelled', cancelled_at = now(), lease_until = null,
          locked_by = null, last_error_code = 'source_cancelled',
          last_error_message = 'El pago a proveedor fue anulado.'
      where id = box.id;
      return jsonb_build_object(
        'ok', true, 'claimed', true, 'outbox_id', box.id,
        'outbox_status', 'cancelled', 'reason', 'source_cancelled'
      );
    elsif supplier_payment.status <> 'paid' then
      reason_code := 'supplier_payment_not_paid';
    elsif supplier_payment.payment_method_v2 is null then
      reason_code := 'supplier_payment_method_pending_classification';
    elsif supplier_payment.payment_method_v2 not in ('cash', 'bank_transfer', 'card_credit', 'card_debit') then
      reason_code := 'supplier_payment_method_invalid';
    elsif supplier_payment.amount <= 0 then
      reason_code := 'supplier_payment_amount_invalid';
    elsif public.is_date_in_closed_accounting_period(effective_date) then
      reason_code := 'period_closed';
    else
      perform 1
      from public.accounts_payable
      where id = supplier_payment.accounts_payable_id
        and supplier_id = supplier_payment.supplier_id
      for share;
      if not found then
        reason_code := 'accounts_payable_missing';
      end if;
    end if;

    if reason_code is null then
      payable_account := public.resolve_accounting_mapping_v2(
        'default_account', 'accounts_payable', effective_date
      );
      payment_account := public.resolve_accounting_mapping_v2(
        'payment_method',
        case supplier_payment.payment_method_v2
          when 'cash' then 'supplier_payment_cash'
          when 'bank_transfer' then 'supplier_payment_bank'
          when 'card_credit' then 'supplier_payment_card'
          when 'card_debit' then 'supplier_payment_bank'
        end,
        effective_date
      );
      if payable_account is null then missing_keys := array_append(missing_keys, 'default_account:accounts_payable'); end if;
      if payment_account is null then missing_keys := array_append(missing_keys,
        'payment_method:' || case supplier_payment.payment_method_v2
          when 'cash' then 'supplier_payment_cash'
          when 'bank_transfer' then 'supplier_payment_bank'
          when 'card_credit' then 'supplier_payment_card'
          when 'card_debit' then 'supplier_payment_bank'
        end); end if;

      total_amount := round(supplier_payment.amount, 2);
      event_snapshot := jsonb_build_object(
        'event_type', 'supplier_payment',
        'supplier_payment_id', supplier_payment.id,
        'accounts_payable_id', supplier_payment.accounts_payable_id,
        'supplier_id', supplier_payment.supplier_id,
        'payment_method', supplier_payment.payment_method_v2,
        'amount', total_amount,
        'effective_date', effective_date,
        'currency', 'HNL'
      );
      canonical_lines := jsonb_build_array(
        jsonb_build_object(
          'account_id', payable_account, 'debit', total_amount, 'credit', 0,
          'description', 'Abono a proveedores ' || left(supplier_payment.id::text, 8),
          'vendor_id', supplier_payment.supplier_id
        ),
        jsonb_build_object(
          'account_id', payment_account, 'debit', 0, 'credit', total_amount,
          'description', 'Salida por pago a proveedor ' || left(supplier_payment.id::text, 8),
          'vendor_id', supplier_payment.supplier_id
        )
      );
      draft_description := 'Borrador automatico de pago a proveedor '
        || left(supplier_payment.id::text, 8);
    end if;

  elsif reason_code is null and box.topic = 'accounting.compensation' then
    select * into original_event
    from public.financial_events
    where id = box.compensated_event_id
    for share;

    if not found or original_event.journal_entry_id is null then
      reason_code := 'compensated_event_missing';
    else
      select * into original_entry
      from public.journal_entries
      where id = original_event.journal_entry_id
      for share;
      if not found or original_entry.status not in ('publicada', 'reversada') then
        reason_code := 'published_entry_missing';
      else
        effective_date := (box.occurred_at at time zone 'America/Tegucigalpa')::date;
        if public.is_date_in_closed_accounting_period(effective_date) then
          reason_code := 'period_closed';
        else
          select coalesce(jsonb_agg(jsonb_build_object(
            'account_id', line.account_id,
            'debit', line.credit,
            'credit', line.debit,
            'description', 'Compensacion de ' || left(original_entry.id::text, 8),
            'customer_id', line.customer_id,
            'vendor_id', line.vendor_id,
            'product_id', line.product_id
          ) order by line.created_at, line.id), '[]'::jsonb)
          into canonical_lines
          from public.journal_entry_lines line
          where line.journal_entry_id = original_entry.id;

          if jsonb_array_length(canonical_lines) < 2 then
            reason_code := 'published_entry_lines_missing';
          else
            event_snapshot := jsonb_build_object(
              'event_type', box.event_purpose,
              'original_event_id', original_event.id,
              'original_journal_entry_id', original_entry.id,
              'source_type', box.source_type,
              'source_id', box.source_id,
              'effective_date', effective_date,
              'currency', 'HNL'
            );
            draft_description := 'Borrador compensatorio de partida '
              || left(original_entry.id::text, 8);
          end if;
        end if;
      end if;
    end if;
  elsif reason_code is null then
    reason_code := 'unsupported_topic';
  end if;

  if array_length(missing_keys, 1) is not null then
    reason_code := 'mapping_missing';
    validation_errors := to_jsonb(missing_keys);
  elsif reason_code is not null and validation_errors = '[]'::jsonb then
    validation_errors := jsonb_build_array(reason_code);
  end if;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  )
  values (
    box.source_type, box.source_id::text, box.event_purpose, 'v2',
    case when reason_code is null then 'ready' else 'pending' end,
    box.occurred_at,
    event_snapshot || jsonb_build_object(
      'outbox_id', box.id,
      'feature_key', box.feature_key,
      'cutover_at', box.cutover_at,
      'scenario', box.scenario,
      'posting_version', 'v2'
    ),
    validation_errors,
    draft_actor
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do update set
    status = case
      when public.financial_events.journal_entry_id is null
        and public.financial_events.status not in ('posted', 'reversed')
      then excluded.status
      else public.financial_events.status
    end,
    source_snapshot = case
      when public.financial_events.status not in ('posted', 'reversed')
      then excluded.source_snapshot
      else public.financial_events.source_snapshot
    end,
    validation_errors = case
      when public.financial_events.journal_entry_id is null
      then excluded.validation_errors
      else public.financial_events.validation_errors
    end,
    updated_at = now()
  returning * into event;

  if event.journal_entry_id is not null then
    update public.accounting_outbox_v2
    set status = 'completed',
        financial_event_id = event.id,
        journal_entry_id = event.journal_entry_id,
        duplicate_avoided = true,
        processed_at = now(),
        lease_until = null,
        locked_by = null,
        last_error_code = null,
        last_error_message = null,
        missing_key = null
    where id = box.id;
    return jsonb_build_object(
      'ok', true, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', 'completed', 'event_id', event.id,
      'journal_entry_id', event.journal_entry_id, 'reason', 'existing_draft_reused'
    );
  end if;

  select id into existing_entry_id
  from public.journal_entries
  where source_type = 'financial_event'
    and source_id = event.id::text
  limit 1;

  if existing_entry_id is not null then
    update public.financial_events
    set status = 'draft_created', journal_entry_id = existing_entry_id,
        validation_errors = '[]'::jsonb, updated_at = now()
    where id = event.id;
    update public.accounting_outbox_v2
    set status = 'completed', financial_event_id = event.id,
        journal_entry_id = existing_entry_id, duplicate_avoided = true,
        processed_at = now(), lease_until = null, locked_by = null
    where id = box.id;
    return jsonb_build_object(
      'ok', true, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', 'completed', 'event_id', event.id,
      'journal_entry_id', existing_entry_id, 'reason', 'existing_draft_reused'
    );
  end if;

  if reason_code is not null then
    update public.accounting_outbox_v2
    set status = case when reason_code = 'mapping_missing' then 'pending_mapping' else 'pending_data' end,
        financial_event_id = event.id,
        next_attempt_at = now() + interval '15 minutes',
        lease_until = null,
        locked_by = null,
        last_error_code = reason_code,
        last_error_message = case
          when reason_code = 'mapping_missing'
            then 'Falta configurar uno o mas mappings contables exactos.'
          else 'Falta un dato canonico o el hecho no cumple las precondiciones.'
        end,
        missing_key = case
          when reason_code = 'mapping_missing' then left(array_to_string(missing_keys, ', '), 240)
          else left(reason_code, 240)
        end
    where id = box.id;

    return jsonb_build_object(
      'ok', true, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', case when reason_code = 'mapping_missing' then 'pending_mapping' else 'pending_data' end,
      'event_id', event.id, 'reason', reason_code,
      'missing_keys', to_jsonb(missing_keys)
    );
  end if;

  normalized_lines := public.normalize_journal_draft_lines(canonical_lines);
  entry_number_value := public.next_journal_entry_number();

  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id,
    created_by, updated_by, metadata
  )
  values (
    entry_number_value, effective_date, draft_description, 'borrador',
    'financial_event', event.id::text, draft_actor, draft_actor,
    jsonb_build_object(
      'entry_kind', 'automatic',
      'generated_from_source', true,
      'accounting_outbox_v2_id', box.id,
      'feature_key', box.feature_key,
      'posting_version', 'v2',
      'scenario', box.scenario,
      'manual_publication_required', true,
      'compensates_event_id', box.compensated_event_id
    )
  )
  returning id into entry_id;

  insert into public.journal_entry_lines (
    id, journal_entry_id, account_id, debit, credit, description,
    customer_id, vendor_id, product_id
  )
  select
    gen_random_uuid(),
    entry_id,
    (item->>'account_id')::uuid,
    (item->>'debit')::numeric,
    (item->>'credit')::numeric,
    item->>'description',
    nullif(item->>'customer_id', '')::uuid,
    nullif(item->>'vendor_id', '')::uuid,
    nullif(item->>'product_id', '')::uuid
  from jsonb_array_elements(normalized_lines->'lines') item;

  update public.financial_events
  set status = 'draft_created',
      journal_entry_id = entry_id,
      validation_errors = '[]'::jsonb,
      updated_at = now()
  where id = event.id;

  update public.accounting_outbox_v2
  set status = 'completed',
      financial_event_id = event.id,
      journal_entry_id = entry_id,
      processed_at = now(),
      lease_until = null,
      locked_by = null,
      last_error_code = null,
      last_error_message = null,
      missing_key = null
  where id = box.id;

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  )
  values (
    'accounting_v2.draft_created',
    'accounting_outbox_v2',
    box.id,
    box.source_type,
    box.source_id::text,
    jsonb_build_object(
      'feature_key', box.feature_key,
      'topic', box.topic,
      'event_id', event.id,
      'journal_entry_id', entry_id,
      'attempt_count', box.attempt_count,
      'worker', left(clean_worker, 24),
      'manual_publication_required', true
    ),
    draft_actor
  );

  return jsonb_build_object(
    'ok', true, 'claimed', true, 'outbox_id', box.id,
    'outbox_status', 'completed', 'event_id', event.id,
    'event_status', 'draft_created', 'journal_entry_id', entry_id,
    'draft_status', 'borrador', 'reason', null
  );
exception
  when others then
    if box.id is not null then
      update public.accounting_outbox_v2
      set status = 'failed',
          next_attempt_at = now() + make_interval(
            mins => least(360, greatest(1, power(2, least(box.attempt_count, 8))::integer))
          ),
          lease_until = null,
          locked_by = null,
          last_error_code = 'technical_error',
          last_error_message = left(
            regexp_replace(
              coalesce(sqlerrm, 'Fallo tecnico del worker contable.'),
              E'[\\n\\r\\t]+', ' ', 'g'
            ),
            500
          )
      where id = box.id;
    end if;
    return jsonb_build_object(
      'ok', false, 'claimed', box.id is not null,
      'outbox_id', coalesce(box.id, target_outbox_id),
      'outbox_status', 'failed', 'reason', 'technical_error',
      'error', left(
        regexp_replace(
          coalesce(sqlerrm, 'Fallo tecnico del worker contable.'),
          E'[\\n\\r\\t]+', ' ', 'g'
        ),
        500
      )
    );
end;
$$;

revoke all on function public.process_accounting_outbox_v2(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.process_accounting_outbox_v2(uuid, text, boolean)
  to service_role;

create or replace function public.claim_due_accounting_outbox_v2(
  batch_size integer default 20
)
returns table (outbox_id uuid)
language sql
security definer
set search_path = public
as $$
  select box.id
  from public.accounting_outbox_v2 box
  where (
      box.status in ('queued', 'failed', 'pending_mapping', 'pending_data')
      and box.next_attempt_at <= now()
      and box.attempt_count < box.max_attempts
    )
    or (
      box.status = 'processing'
      and box.lease_until <= now()
      and box.attempt_count < box.max_attempts
    )
  order by box.next_attempt_at, box.created_at
  limit least(greatest(batch_size, 1), 100)
  for update skip locked
$$;

revoke all on function public.claim_due_accounting_outbox_v2(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_accounting_outbox_v2(integer)
  to service_role;
