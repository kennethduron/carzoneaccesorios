-- Supplier multi-invoice payment registration, routing, worker and full void.
-- All economic writes are RPC-only and transactional. The worker creates one
-- V2 event and one balanced draft; publication remains exclusively manual.

create or replace function public.supplier_payment_mapping_key_v1(
  p_payment_method text
)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case p_payment_method
    when 'cash' then 'supplier_payment_cash'
    when 'bank_transfer' then 'supplier_payment_bank'
    when 'card_credit' then 'supplier_payment_card'
    when 'card_debit' then 'supplier_payment_bank'
    else null
  end
$$;

revoke all on function public.supplier_payment_mapping_key_v1(text)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_mapping_key_v1(text)
  to service_role;

create or replace function public.set_accounting_feature_flag_v2(
  target_key text,
  target_state text,
  target_cutover_at timestamptz,
  technical_notes text default null
)
returns public.accounting_feature_flags
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  result public.accounting_feature_flags%rowtype;
begin
  if actor_id is null
    or public.current_actor_role()
      not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:settings')
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para configurar la automatizacion contable.';
  end if;

  if target_key not in (
    'sales_draft_v2',
    'cogs_draft_v2',
    'supplier_payment_draft_v2',
    'supplier_multi_invoice_payment_v1'
  ) then
    raise exception using
      errcode = '22023',
      message = 'El feature flag contable no es valido.';
  end if;
  if target_state not in ('disabled', 'shadow', 'enabled') then
    raise exception using
      errcode = '22023',
      message = 'El estado del feature flag no es valido.';
  end if;
  if target_state <> 'disabled' and target_cutover_at is null then
    raise exception using
      errcode = '22023',
      message = 'Shadow y enabled requieren una fecha de corte explicita.';
  end if;
  if target_state = 'enabled' and target_cutover_at < now() then
    raise exception using
      errcode = '22023',
      message = 'Enabled requiere una fecha de corte prospectiva.';
  end if;

  update public.accounting_feature_flags
  set state = target_state,
      cutover_at = case
        when target_state = 'disabled' then null
        else target_cutover_at
      end,
      updated_by = actor_id,
      notes = nullif(left(btrim(coalesce(technical_notes, '')), 500), '')
  where key = target_key
  returning * into result;

  if result.key is null then
    raise exception using
      errcode = 'P0002',
      message = 'El feature flag no existe.';
  end if;

  insert into public.accounting_event_log (
    event_type,
    entity_type,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values (
    'accounting_v2.feature_flag_changed',
    'accounting_feature_flags',
    'accounting_feature_flag',
    target_key,
    jsonb_build_object(
      'state', result.state,
      'cutover_at', result.cutover_at,
      'version', result.version
    ),
    actor_id
  );

  return result;
end;
$$;

revoke all on function
  public.set_accounting_feature_flag_v2(text, text, timestamptz, text)
  from public, anon;
grant execute on function
  public.set_accounting_feature_flag_v2(text, text, timestamptz, text)
  to authenticated;

alter function public.route_supplier_payment_accounting_v2(uuid, uuid)
  rename to route_supplier_payment_accounting_v016;

create or replace function public.route_supplier_payment_accounting_v2(
  p_payment_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment public.supplier_payments%rowtype;
  accounting_flag public.accounting_feature_flags%rowtype;
  routing_at timestamptz;
  journal_date date;
  application_count integer;
  application_total numeric(12, 2);
  recognition_max_date date;
  result_id uuid;
  existing_box_id uuid;
begin
  if p_payment_id is null then
    return null;
  end if;

  select * into payment
  from public.supplier_payments
  where id = p_payment_id;

  if payment.id is null then
    return null;
  end if;

  if payment.allocation_mode = 'legacy_single' then
    return public.route_supplier_payment_accounting_v016(
      p_payment_id,
      p_actor_id
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'supplier_payment_accounting:' || payment.id::text,
      0
    )
  );

  if payment.status <> 'paid'
    or payment.accounts_payable_id is not null
    or payment.currency <> 'HNL'
    or payment.payment_account_id is null
  then
    return null;
  end if;

  select * into accounting_flag
  from public.accounting_feature_flags
  where key = 'supplier_payment_draft_v2';

  if accounting_flag.key is null
    or accounting_flag.state <> 'enabled'
    or accounting_flag.cutover_at is null
  then
    return null;
  end if;

  routing_at := public.supplier_payment_accounting_occurred_at(
    payment.paid_at,
    payment.created_at,
    accounting_flag.cutover_at
  );

  if routing_at is null then
    return null;
  end if;

  journal_date :=
    (routing_at at time zone 'America/Tegucigalpa')::date;

  select
    count(*),
    coalesce(sum(application.applied_amount), 0),
    max(application.recognition_date)
  into application_count, application_total, recognition_max_date
  from public.supplier_payment_applications application
  where application.supplier_payment_id = payment.id
    and application.status = 'applied';

  if application_count < 1
    or application_total <> payment.amount
    or recognition_max_date is null
    or recognition_max_date > journal_date
  then
    return null;
  end if;

  select box.id into existing_box_id
  from public.accounting_outbox_v2 box
  where box.source_type = 'supplier_payment'
    and box.source_id = payment.id
    and box.event_purpose = 'supplier_payment'
    and box.posting_version = 'v2';

  result_id := public.route_accounting_fact_v2(
    'supplier_payment_draft_v2',
    'payables.supplier_payment',
    'supplier_payment',
    payment.id,
    'supplier_payment',
    'multi_application_v1',
    routing_at,
    coalesce(p_actor_id, payment.created_by, auth.uid())
  );

  if result_id is null then
    return null;
  end if;

  update public.accounting_outbox_v2
  set scenario = 'multi_application_v1',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'source_type', 'supplier_payment',
        'payment_id', payment.id,
        'supplier_id', payment.supplier_id,
        'allocation_mode', 'applications_v1',
        'scenario', 'multi_application_v1',
        'application_count', application_count,
        'amount', payment.amount,
        'currency', payment.currency,
        'payment_method', payment.payment_method_v2,
        'effective_paid_at', payment.paid_at,
        'recorded_at', payment.created_at,
        'accounting_occurred_at', routing_at,
        'journal_date', journal_date,
        'recognition_max_date', recognition_max_date,
        'manual_publication_required', true
      )
  where id = result_id;

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
    'supplier_multi_payment_accounting_routed',
    'accounting_outbox_v2',
    result_id,
    'supplier_payment',
    payment.id::text,
    jsonb_build_object(
      'payment_id', payment.id,
      'supplier_id', payment.supplier_id,
      'outbox_id', result_id,
      'application_count', application_count,
      'amount', payment.amount,
      'payment_method', payment.payment_method_v2,
      'accounting_date', journal_date,
      'duplicate_avoided', existing_box_id is not null,
      'manual_publication_required', true
    ),
    coalesce(p_actor_id, payment.created_by, auth.uid())
  );

  return result_id;
end;
$$;

revoke all on function
  public.route_supplier_payment_accounting_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.route_supplier_payment_accounting_v2(uuid, uuid)
  to service_role;

create or replace function public.enqueue_supplier_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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

revoke all on function public.enqueue_supplier_payment_v2()
  from public, anon, authenticated;

drop trigger if exists supplier_payments_enqueue_accounting_v2
  on public.supplier_payments;
create trigger supplier_payments_enqueue_accounting_v2
after insert or update of status on public.supplier_payments
for each row execute function public.enqueue_supplier_payment_v2();

create or replace function public.register_supplier_multi_payment_v1(
  p_request_key uuid,
  p_supplier_id uuid,
  p_payment_method text,
  p_paid_date date,
  p_reference text,
  p_applications jsonb,
  p_notes text default null,
  p_receipt_public_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  clean_method text :=
    lower(regexp_replace(btrim(coalesce(p_payment_method, '')), '\s+', '_', 'g'));
  clean_reference text := nullif(
    regexp_replace(btrim(coalesce(p_reference, '')), '\s+', ' ', 'g'),
    ''
  );
  clean_notes text := nullif(
    left(regexp_replace(btrim(coalesce(p_notes, '')), '\s+', ' ', 'g'), 2000),
    ''
  );
  clean_receipt text := nullif(
    left(btrim(coalesce(p_receipt_public_id, '')), 240),
    ''
  );
  effective_date date := p_paid_date;
  effective_at timestamptz;
  recorded_at timestamptz := statement_timestamp();
  accounting_date date;
  accounting_occurred_at timestamptz;
  accounting_flag public.accounting_feature_flags%rowtype;
  ui_flag public.accounting_feature_flags%rowtype;
  supplier public.suppliers%rowtype;
  existing public.supplier_payments%rowtype;
  saved public.supplier_payments%rowtype;
  recognition jsonb;
  repeated_recognition jsonb;
  mapping_key text;
  payable_account_id uuid;
  financial_account_id uuid;
  total numeric(12, 2);
  application_count integer;
  canonical_applications jsonb;
  fingerprint text;
  idempotency_value text;
  ensured_outbox_id uuid;
  item jsonb;
  input_row record;
  result_applications jsonb;
begin
  if actor_id is null
    or actor_role
      not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('payables:manage')
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para registrar pagos a proveedores.';
  end if;

  if p_request_key is null or p_supplier_id is null then
    raise exception using
      errcode = '22023',
      message = 'La solicitud y el proveedor son obligatorios.';
  end if;
  if clean_method not in (
    'cash',
    'bank_transfer',
    'card_credit',
    'card_debit'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Selecciona un metodo de pago permitido.';
  end if;
  if char_length(coalesce(clean_reference, '')) > 160 then
    raise exception using
      errcode = '22023',
      message = 'La referencia no puede exceder 160 caracteres.';
  end if;
  if char_length(btrim(coalesce(p_receipt_public_id, ''))) > 240 then
    raise exception using
      errcode = '22023',
      message = 'El identificador del comprobante no es valido.';
  end if;
  if clean_method = 'bank_transfer' and clean_reference is null then
    raise exception using
      errcode = '22023',
      message = 'La referencia es obligatoria para una transferencia bancaria.';
  end if;
  if effective_date is null
    or effective_date > (now() at time zone 'America/Tegucigalpa')::date
  then
    raise exception using
      errcode = '22023',
      message = 'La fecha efectiva no es valida o esta en el futuro.';
  end if;
  if p_applications is null
    or jsonb_typeof(p_applications) <> 'array'
    or jsonb_array_length(p_applications) not between 1 and 200
  then
    raise exception using
      errcode = '22023',
      message = 'Debes enviar entre 1 y 200 aplicaciones.';
  end if;

  for item in
    select value from jsonb_array_elements(p_applications)
  loop
    if jsonb_typeof(item) <> 'object'
      or (
        select count(*) from jsonb_object_keys(item)
      ) <> 2
      or not item ? 'accounts_payable_id'
      or not item ? 'applied_amount'
      or exists (
        select 1
        from jsonb_object_keys(item) key_name
        where key_name not in ('accounts_payable_id', 'applied_amount')
      )
      or jsonb_typeof(item->'accounts_payable_id') <> 'string'
      or jsonb_typeof(item->'applied_amount') <> 'number'
      or not (
        item->>'accounts_payable_id'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      or not (
        item->>'applied_amount'
        ~ '^[0-9]+(\.[0-9]{1,2})?$'
      )
    then
      raise exception using
        errcode = '22023',
        message = 'Cada aplicacion debe contener solo una CxP UUID y un importe positivo con dos decimales.';
    end if;
  end loop;

  create temporary table if not exists supplier_multi_payment_input_v1 (
    accounts_payable_id uuid primary key,
    applied_amount numeric(12, 2) not null,
    supplier_invoice_id uuid,
    balance_before numeric(12, 2),
    status_before text,
    recognition_origin text,
    recognition_journal_entry_id uuid,
    opening_balance_batch_id uuid,
    recognition_date date
  ) on commit drop;

  truncate table pg_temp.supplier_multi_payment_input_v1;

  begin
    insert into pg_temp.supplier_multi_payment_input_v1 (
      accounts_payable_id,
      applied_amount
    )
    select
      (value->>'accounts_payable_id')::uuid,
      (value->>'applied_amount')::numeric(12, 2)
    from jsonb_array_elements(p_applications);
  exception
    when unique_violation then
      raise exception using
        errcode = '22023',
        message = 'Una cuenta por pagar no puede aparecer dos veces.';
    when numeric_value_out_of_range then
      raise exception using
        errcode = '22003',
        message = 'Un importe excede el limite permitido.';
  end;

  if exists (
    select 1
    from pg_temp.supplier_multi_payment_input_v1 input
    where input.applied_amount <= 0
  ) then
    raise exception using
      errcode = '22023',
      message = 'Todas las aplicaciones deben ser mayores que cero.';
  end if;

  select
    count(*),
    sum(input.applied_amount),
    jsonb_agg(
      jsonb_build_object(
        'accounts_payable_id', input.accounts_payable_id::text,
        'applied_amount', to_char(
          input.applied_amount,
          'FM9999999990.00'
        )
      )
      order by input.accounts_payable_id
    )
  into application_count, total, canonical_applications
  from pg_temp.supplier_multi_payment_input_v1 input;

  idempotency_value :=
    'supplier_multi_payment:v1:' || p_request_key::text;
  fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'version', 'supplier_multi_payment:v1',
          'supplier_id', p_supplier_id::text,
          'currency', 'HNL',
          'payment_method', clean_method,
          'paid_date', effective_date::text,
          'reference', clean_reference,
          'notes', clean_notes,
          'receipt_public_id', clean_receipt,
          'applications', canonical_applications
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(idempotency_value, 0)
  );

  select * into existing
  from public.supplier_payments payment
  where payment.idempotency_key = idempotency_value
  limit 1;

  if existing.id is not null then
    if existing.allocation_mode <> 'applications_v1'
      or existing.request_fingerprint is distinct from fingerprint
    then
      raise exception using
        errcode = '23505',
        message = 'La clave de solicitud ya fue usada con un pago diferente.';
    end if;

    select box.id into ensured_outbox_id
    from public.accounting_outbox_v2 box
    where box.source_type = 'supplier_payment'
      and box.source_id = existing.id
      and box.event_purpose = 'supplier_payment'
      and box.posting_version = 'v2';

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'application_id', application.id,
          'accounts_payable_id', application.accounts_payable_id,
          'applied_amount', application.applied_amount,
          'balance_before', application.balance_before,
          'balance_after', application.balance_after,
          'status_after', application.status_after
        )
        order by application.accounts_payable_id
      ),
      '[]'::jsonb
    )
    into result_applications
    from public.supplier_payment_applications application
    where application.supplier_payment_id = existing.id;

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
      'supplier_multi_payment_replayed',
      'supplier_payments',
      existing.id,
      'supplier_payment',
      existing.id::text,
      jsonb_build_object(
        'payment_id', existing.id,
        'supplier_id', existing.supplier_id,
        'amount', existing.amount,
        'payment_method', existing.payment_method_v2,
        'application_count', jsonb_array_length(result_applications),
        'request_key_suffix', right(p_request_key::text, 8),
        'outbox_id', ensured_outbox_id,
        'result', 'replayed'
      ),
      actor_id
    );

    return jsonb_build_object(
      'status', existing.status,
      'replayed', true,
      'payment_id', existing.id,
      'supplier_id', existing.supplier_id,
      'payment_total', existing.amount,
      'application_count', jsonb_array_length(result_applications),
      'applications', result_applications,
      'outbox_id', ensured_outbox_id,
      'accounting_status', coalesce(
        (
          select box.status
          from public.accounting_outbox_v2 box
          where box.id = ensured_outbox_id
        ),
        'not_routed'
      ),
      'accounting_date',
        (existing.created_at at time zone 'America/Tegucigalpa')::date
    );
  end if;

  select * into ui_flag
  from public.accounting_feature_flags
  where key = 'supplier_multi_invoice_payment_v1'
  for share;

  if ui_flag.key is null
    or ui_flag.state <> 'enabled'
    or ui_flag.cutover_at is null
    or ui_flag.cutover_at > now()
  then
    raise exception using
      errcode = '55000',
      message = 'El pago multifáctura todavía no está habilitado.';
  end if;

  select * into supplier
  from public.suppliers
  where id = p_supplier_id
  for share;

  if supplier.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'El proveedor no existe.';
  end if;
  if not supplier.is_active then
    raise exception using
      errcode = '22023',
      message = 'El proveedor seleccionado esta inactivo.';
  end if;

  perform payable.id
  from public.accounts_payable payable
  join pg_temp.supplier_multi_payment_input_v1 input
    on input.accounts_payable_id = payable.id
  order by payable.id
  for update of payable;

  if (
    select count(*)
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
  ) <> application_count then
    raise exception using
      errcode = 'P0002',
      message = 'Una o mas cuentas por pagar no existen.';
  end if;

  if exists (
    select 1
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
    where payable.supplier_id <> p_supplier_id
  ) then
    raise exception using
      errcode = '22023',
      message = 'Todas las cuentas por pagar deben pertenecer al mismo proveedor.';
  end if;

  if exists (
    select 1
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
    where payable.currency <> 'HNL'
  ) then
    raise exception using
      errcode = '22023',
      message = 'La primera version acepta unicamente obligaciones en HNL.';
  end if;

  if exists (
    select 1
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
    where payable.status not in ('pending', 'partial', 'overdue')
      or payable.balance <= 0
  ) then
    raise exception using
      errcode = '22023',
      message = 'Una cuenta por pagar esta pagada, cancelada o no admite aplicaciones.';
  end if;

  if exists (
    select 1
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
    where input.applied_amount > payable.balance
  ) then
    raise exception using
      errcode = '40001',
      message = 'El saldo de una cuenta por pagar cambio o la aplicacion lo excede.';
  end if;

  update pg_temp.supplier_multi_payment_input_v1 input
  set supplier_invoice_id = payable.supplier_invoice_id,
      balance_before = payable.balance,
      status_before = payable.status
  from public.accounts_payable payable
  where payable.id = input.accounts_payable_id;

  perform invoice.id
  from public.supplier_invoices invoice
  join pg_temp.supplier_multi_payment_input_v1 input
    on input.supplier_invoice_id = invoice.id
  order by invoice.id
  for update of invoice;

  perform purchase.id
  from public.purchases purchase
  join public.accounts_payable payable
    on payable.purchase_id = purchase.id
  join pg_temp.supplier_multi_payment_input_v1 input
    on input.accounts_payable_id = payable.id
  order by purchase.id
  for share of purchase;

  if exists (
    select 1
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
    join public.supplier_invoices invoice
      on invoice.id = payable.supplier_invoice_id
    where invoice.supplier_id <> payable.supplier_id
      or invoice.status = 'cancelled'
      or (
        payable.purchase_id is not null
        and invoice.purchase_id is distinct from payable.purchase_id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'La factura, la compra y la cuenta por pagar no son coherentes.';
  end if;

  if exists (
    select 1
    from public.accounts_payable payable
    join pg_temp.supplier_multi_payment_input_v1 input
      on input.accounts_payable_id = payable.id
    join public.purchases purchase
      on purchase.id = payable.purchase_id
    where purchase.supplier_id <> payable.supplier_id
      or purchase.status = 'cancelled'
  ) then
    raise exception using
      errcode = '23514',
      message = 'La compra no corresponde al proveedor de la obligación.';
  end if;

  select * into accounting_flag
  from public.accounting_feature_flags
  where key = 'supplier_payment_draft_v2'
  for share;

  if accounting_flag.key is null
    or accounting_flag.state <> 'enabled'
    or accounting_flag.cutover_at is null
  then
    raise exception using
      errcode = '55000',
      message = 'La contabilizacion V2 de pagos a proveedor no esta habilitada.';
  end if;

  effective_at :=
    effective_date::timestamp at time zone 'America/Tegucigalpa';
  accounting_occurred_at :=
    public.supplier_payment_accounting_occurred_at(
      effective_at,
      recorded_at,
      accounting_flag.cutover_at
    );

  if accounting_occurred_at is null then
    raise exception using
      errcode = '22023',
      message = 'La fecha efectiva no pertenece al contrato contable vigente.';
  end if;

  accounting_date :=
    (accounting_occurred_at at time zone 'America/Tegucigalpa')::date;

  if public.is_date_in_closed_accounting_period(accounting_date) then
    raise exception using
      errcode = '55000',
      message = 'La fecha contable pertenece a un periodo cerrado.';
  end if;

  for input_row in
    select * from pg_temp.supplier_multi_payment_input_v1
    order by accounts_payable_id
  loop
    recognition :=
      public.resolve_accounts_payable_accounting_recognition_v1(
        input_row.accounts_payable_id,
        accounting_date,
        null
      );

    if not coalesce((recognition->>'recognized')::boolean, false)
      or recognition->>'recognition_origin'
        not in ('direct_event', 'opening_balance_control')
      or nullif(recognition->>'journal_entry_id', '') is null
      or nullif(recognition->>'journal_date', '') is null
    then
      raise exception using
        errcode = '55000',
        message = 'Una cuenta por pagar no tiene reconocimiento contable valido: '
          || coalesce(recognition->>'reason_code', 'recognition_missing');
    end if;

    update pg_temp.supplier_multi_payment_input_v1
    set recognition_origin = recognition->>'recognition_origin',
        recognition_journal_entry_id =
          (recognition->>'journal_entry_id')::uuid,
        opening_balance_batch_id =
          nullif(recognition->>'opening_balance_batch_id', '')::uuid,
        recognition_date =
          (recognition->>'journal_date')::date
    where accounts_payable_id = input_row.accounts_payable_id;
  end loop;

  perform entry.id
  from public.journal_entries entry
  where entry.id in (
    select input.recognition_journal_entry_id
    from pg_temp.supplier_multi_payment_input_v1 input
  )
  order by entry.id
  for share;

  perform batch.id
  from public.accounting_opening_balance_batches batch
  where batch.id in (
    select input.opening_balance_batch_id
    from pg_temp.supplier_multi_payment_input_v1 input
    where input.opening_balance_batch_id is not null
  )
  order by batch.id
  for share;

  for input_row in
    select * from pg_temp.supplier_multi_payment_input_v1
    order by accounts_payable_id
  loop
    repeated_recognition :=
      public.resolve_accounts_payable_accounting_recognition_v1(
        input_row.accounts_payable_id,
        accounting_date,
        null
      );

    if not coalesce(
        (repeated_recognition->>'recognized')::boolean,
        false
      )
      or repeated_recognition->>'recognition_origin'
        is distinct from input_row.recognition_origin
      or (repeated_recognition->>'journal_entry_id')::uuid
        is distinct from input_row.recognition_journal_entry_id
      or (repeated_recognition->>'journal_date')::date
        is distinct from input_row.recognition_date
      or nullif(
        repeated_recognition->>'opening_balance_batch_id',
        ''
      )::uuid is distinct from input_row.opening_balance_batch_id
    then
      raise exception using
        errcode = '40001',
        message = 'El reconocimiento contable cambio durante el registro.';
    end if;
  end loop;

  if exists (
    select 1
    from pg_temp.supplier_multi_payment_input_v1 input
    where input.recognition_date > accounting_date
  ) then
    raise exception using
      errcode = '22023',
      message = 'La fecha del pago es anterior al reconocimiento de una obligación.';
  end if;

  mapping_key :=
    public.supplier_payment_mapping_key_v1(clean_method);
  payable_account_id := public.resolve_accounting_mapping_v2(
    'default_account',
    'accounts_payable',
    accounting_date
  );
  financial_account_id := public.resolve_accounting_mapping_v2(
    'payment_method',
    mapping_key,
    accounting_date
  );

  if payable_account_id is null or financial_account_id is null then
    raise exception using
      errcode = '55000',
      message = 'Falta un mapping contable activo para el pago.';
  end if;

  perform mapping.id
  from public.accounting_mappings mapping
  where (
      mapping.mapping_type = 'default_account'
      and mapping.source_key = 'accounts_payable'
      and mapping.account_id = payable_account_id
    )
    or (
      mapping.mapping_type = 'payment_method'
      and mapping.source_key = mapping_key
      and mapping.account_id = financial_account_id
    )
  order by mapping.id
  for share;

  perform account.id
  from public.accounting_accounts account
  where account.id in (payable_account_id, financial_account_id)
    and account.is_active
  order by account.id
  for share;

  if (
    select count(*)
    from public.accounting_accounts account
    where account.id in (payable_account_id, financial_account_id)
      and account.is_active
  ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'Las cuentas contables derivadas no estan activas.';
  end if;

  if not exists (
    select 1
    from public.accounting_accounts account
    where account.id = payable_account_id
      and account.is_active
      and account.code = '2101001'
      and upper(btrim(account.name)) = 'PROVEEDORES LOCALES'
      and account.type = 'liability'
      and account.normal_balance = 'credit'
  ) then
    raise exception using
      errcode = '55000',
      message = 'El mapping de proveedores locales no cumple el contrato contable.';
  end if;

  insert into public.accounting_event_log (
    event_type,
    entity_type,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values (
    'supplier_multi_payment_started',
    'supplier_payments',
    'supplier_payment',
    p_request_key::text,
    jsonb_build_object(
      'supplier_id', p_supplier_id,
      'amount', total,
      'payment_method', clean_method,
      'paid_date', effective_date,
      'application_count', application_count,
      'request_key_suffix', right(p_request_key::text, 8),
      'result', 'started'
    ),
    actor_id
  );

  insert into public.supplier_payments (
    accounts_payable_id,
    supplier_id,
    amount,
    payment_method,
    payment_method_v2,
    status,
    paid_at,
    notes,
    created_by,
    idempotency_key,
    request_fingerprint,
    allocation_mode,
    currency,
    reference,
    payment_account_id,
    receipt_public_id,
    created_at
  )
  values (
    null,
    p_supplier_id,
    total,
    clean_method,
    clean_method,
    'draft',
    effective_at,
    clean_notes,
    actor_id,
    idempotency_value,
    fingerprint,
    'applications_v1',
    'HNL',
    clean_reference,
    financial_account_id,
    clean_receipt,
    recorded_at
  )
  returning * into saved;

  insert into public.supplier_payment_applications (
    supplier_payment_id,
    accounts_payable_id,
    supplier_invoice_id,
    applied_amount,
    currency,
    balance_before,
    balance_after,
    status_before,
    status_after,
    recognition_origin,
    recognition_journal_entry_id,
    opening_balance_batch_id,
    recognition_date,
    status
  )
  select
    saved.id,
    input.accounts_payable_id,
    input.supplier_invoice_id,
    input.applied_amount,
    'HNL',
    input.balance_before,
    input.balance_before - input.applied_amount,
    input.status_before,
    case
      when input.balance_before - input.applied_amount = 0 then 'paid'
      else 'partial'
    end,
    input.recognition_origin,
    input.recognition_journal_entry_id,
    input.opening_balance_batch_id,
    input.recognition_date,
    'applied'
  from pg_temp.supplier_multi_payment_input_v1 input
  order by input.accounts_payable_id;

  update public.accounts_payable payable
  set paid_amount = payable.paid_amount + input.applied_amount,
      status = case
        when payable.balance - input.applied_amount = 0 then 'paid'
        else 'partial'
      end,
      updated_at = now()
  from pg_temp.supplier_multi_payment_input_v1 input
  where payable.id = input.accounts_payable_id;

  update public.supplier_invoices invoice
  set status = case
        when exists (
          select 1
          from public.accounts_payable payable
          where payable.supplier_invoice_id = invoice.id
            and payable.status <> 'cancelled'
            and payable.balance > 0
        ) then 'posted_to_ap'
        else 'paid'
      end,
      updated_at = now()
  where invoice.id in (
    select input.supplier_invoice_id
    from pg_temp.supplier_multi_payment_input_v1 input
    where input.supplier_invoice_id is not null
  )
    and invoice.status <> 'cancelled';

  update public.supplier_payments
  set status = 'paid',
      updated_at = now()
  where id = saved.id
  returning * into saved;

  select box.id into ensured_outbox_id
  from public.accounting_outbox_v2 box
  where box.source_type = 'supplier_payment'
    and box.source_id = saved.id
    and box.event_purpose = 'supplier_payment'
    and box.posting_version = 'v2';

  if ensured_outbox_id is null then
    raise exception using
      errcode = '55000',
      message = 'No se pudo crear la outbox contable unica del pago.';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'application_id', application.id,
      'accounts_payable_id', application.accounts_payable_id,
      'applied_amount', application.applied_amount,
      'balance_before', application.balance_before,
      'balance_after', application.balance_after,
      'status_after', application.status_after
    )
    order by application.accounts_payable_id
  )
  into result_applications
  from public.supplier_payment_applications application
  where application.supplier_payment_id = saved.id;

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
    actor_id,
    actor_role,
    'supplier_payments',
    saved.id,
    'supplier_payments.multi_pay_v1',
    jsonb_build_object(
      'supplier_id', p_supplier_id,
      'balances_before', (
        select jsonb_object_agg(
          input.accounts_payable_id::text,
          input.balance_before
        )
        from pg_temp.supplier_multi_payment_input_v1 input
      )
    ),
    jsonb_build_object(
      'payment_id', saved.id,
      'supplier_id', p_supplier_id,
      'amount', total,
      'payment_method', clean_method,
      'paid_date', effective_date,
      'application_count', application_count,
      'balances_after', (
        select jsonb_object_agg(
          input.accounts_payable_id::text,
          input.balance_before - input.applied_amount
        )
        from pg_temp.supplier_multi_payment_input_v1 input
      ),
      'outbox_id', ensured_outbox_id,
      'allocation_mode', 'applications_v1'
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
    'supplier_multi_payment_completed',
    'supplier_payments',
    saved.id,
    'supplier_payment',
    saved.id::text,
    jsonb_build_object(
      'payment_id', saved.id,
      'supplier_id', p_supplier_id,
      'amount', total,
      'payment_method', clean_method,
      'paid_date', effective_date,
      'application_count', application_count,
      'request_key_suffix', right(p_request_key::text, 8),
      'outbox_id', ensured_outbox_id,
      'result', 'completed'
    ),
    actor_id
  );

  return jsonb_build_object(
    'status', saved.status,
    'replayed', false,
    'payment_id', saved.id,
    'supplier_id', saved.supplier_id,
    'payment_total', saved.amount,
    'application_count', application_count,
    'applications', result_applications,
    'outbox_id', ensured_outbox_id,
    'accounting_status', 'queued',
    'accounting_date', accounting_date
  );
end;
$$;

revoke all on function public.register_supplier_multi_payment_v1(
  uuid, uuid, text, date, text, jsonb, text, text
) from public, anon;
grant execute on function public.register_supplier_multi_payment_v1(
  uuid, uuid, text, date, text, jsonb, text, text
) to authenticated, service_role;


alter function public.process_accounting_outbox_v2(uuid, text, boolean)
  rename to process_accounting_outbox_v016;

create or replace function public.process_supplier_multi_payment_outbox_v1(
  target_outbox_id uuid,
  worker_token text,
  force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  clean_worker text :=
    nullif(left(btrim(coalesce(worker_token, '')), 120), '');
  box public.accounting_outbox_v2%rowtype;
  flag public.accounting_feature_flags%rowtype;
  payment public.supplier_payments%rowtype;
  event public.financial_events%rowtype;
  application record;
  recognition jsonb;
  draft_actor uuid;
  effective_date date;
  payable_account_id uuid;
  payment_account_id uuid;
  mapping_key text;
  application_count integer;
  application_total numeric(12, 2);
  application_ids jsonb;
  payable_ids jsonb;
  applied_amounts jsonb;
  recognition_origins jsonb;
  opening_balance_batch_ids jsonb;
  canonical_lines jsonb;
  normalized_lines jsonb;
  entry_id uuid;
  existing_entry_id uuid;
begin
  if clean_worker is null then
    raise exception using
      errcode = '22023',
      message = 'El worker requiere un identificador.';
  end if;
  if not service_call and (
    caller_id is null
    or public.current_actor_role()
      not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  ) then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para procesar la outbox contable.';
  end if;

  select * into box
  from public.accounting_outbox_v2
  where id = target_outbox_id
  for update skip locked;

  if box.id is null then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', target_outbox_id,
      'reason', 'already_processing'
    );
  end if;
  if box.status = 'completed' then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'event_id', box.financial_event_id,
      'journal_entry_id', box.journal_entry_id,
      'reason', 'already_completed'
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

  if flag.key is null
    or flag.state <> 'enabled'
    or flag.cutover_at is null
    or box.occurred_at < flag.cutover_at
  then
    update public.accounting_outbox_v2
    set status = 'failed',
        last_error_code = 'feature_not_enabled',
        last_error_message =
          'El modulo no esta habilitado para esta fecha de corte.',
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
    select 1 from public.users
    where id = draft_actor and active = true
  ) then
    raise exception 'missing_automation_actor';
  end if;
  if box.topic <> 'payables.supplier_payment'
    or box.source_type <> 'supplier_payment'
    or box.event_purpose <> 'supplier_payment'
    or box.scenario <> 'multi_application_v1'
  then
    raise exception 'unsupported_multi_payment_outbox_contract';
  end if;

  select * into payment
  from public.supplier_payments
  where id = box.source_id
  for update;

  if payment.id is null then
    raise exception 'supplier_payment_missing';
  end if;
  if payment.status = 'voided' then
    update public.accounting_outbox_v2
    set status = 'cancelled', cancelled_at = now(),
        lease_until = null, locked_by = null,
        last_error_code = 'source_cancelled',
        last_error_message = 'El pago a proveedor fue anulado.'
    where id = box.id;
    return jsonb_build_object(
      'ok', true, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', 'cancelled', 'reason', 'source_cancelled'
    );
  end if;
  if payment.status <> 'paid'
    or payment.allocation_mode <> 'applications_v1'
    or payment.accounts_payable_id is not null
    or payment.currency <> 'HNL'
    or payment.payment_method_v2
      not in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
    or payment.payment_account_id is null
    or payment.amount <= 0
  then
    raise exception 'supplier_multi_payment_data_invalid';
  end if;

  perform item.id
  from public.supplier_payment_applications item
  where item.supplier_payment_id = payment.id
    and item.status = 'applied'
  order by item.id
  for update;

  select
    count(*),
    coalesce(sum(item.applied_amount), 0),
    jsonb_agg(item.id order by item.accounts_payable_id),
    jsonb_agg(item.accounts_payable_id order by item.accounts_payable_id),
    jsonb_agg(item.applied_amount order by item.accounts_payable_id),
    jsonb_agg(item.recognition_origin order by item.accounts_payable_id),
    jsonb_agg(
      item.opening_balance_batch_id order by item.accounts_payable_id
    )
  into
    application_count,
    application_total,
    application_ids,
    payable_ids,
    applied_amounts,
    recognition_origins,
    opening_balance_batch_ids
  from public.supplier_payment_applications item
  where item.supplier_payment_id = payment.id
    and item.status = 'applied';

  if application_count < 1 or application_total <> payment.amount then
    raise exception 'supplier_multi_payment_allocation_mismatch';
  end if;

  perform payable.id
  from public.accounts_payable payable
  join public.supplier_payment_applications item
    on item.accounts_payable_id = payable.id
  where item.supplier_payment_id = payment.id
    and item.status = 'applied'
  order by payable.id
  for share of payable;

  if (
    select count(*)
    from public.accounts_payable payable
    join public.supplier_payment_applications item
      on item.accounts_payable_id = payable.id
    where item.supplier_payment_id = payment.id
      and item.status = 'applied'
      and payable.supplier_id = payment.supplier_id
      and payable.currency = payment.currency
      and payable.status <> 'cancelled'
      and payable.paid_amount >= item.applied_amount
  ) <> application_count then
    raise exception 'supplier_multi_payment_payable_state_invalid';
  end if;

  effective_date :=
    (box.occurred_at at time zone 'America/Tegucigalpa')::date;
  if public.is_date_in_closed_accounting_period(effective_date) then
    raise exception 'period_closed';
  end if;

  for application in
    select item.*
    from public.supplier_payment_applications item
    where item.supplier_payment_id = payment.id
      and item.status = 'applied'
    order by item.accounts_payable_id
  loop
    recognition :=
      public.resolve_accounts_payable_accounting_recognition_v1(
        application.accounts_payable_id,
        effective_date,
        null
      );
    if not coalesce((recognition->>'recognized')::boolean, false)
      or recognition->>'recognition_origin'
        is distinct from application.recognition_origin
      or (recognition->>'journal_entry_id')::uuid
        is distinct from application.recognition_journal_entry_id
      or (recognition->>'journal_date')::date
        is distinct from application.recognition_date
      or nullif(
        recognition->>'opening_balance_batch_id',
        ''
      )::uuid is distinct from application.opening_balance_batch_id
      or application.recognition_date > effective_date
    then
      raise exception 'supplier_multi_payment_recognition_invalid';
    end if;
  end loop;

  mapping_key :=
    public.supplier_payment_mapping_key_v1(payment.payment_method_v2);
  payable_account_id := public.resolve_accounting_mapping_v2(
    'default_account', 'accounts_payable', effective_date
  );
  payment_account_id := public.resolve_accounting_mapping_v2(
    'payment_method', mapping_key, effective_date
  );
  if payable_account_id is null
    or payment_account_id is null
    or payment_account_id <> payment.payment_account_id
  then
    raise exception 'supplier_multi_payment_mapping_invalid';
  end if;

  perform mapping.id
  from public.accounting_mappings mapping
  where (
      mapping.mapping_type = 'default_account'
      and mapping.source_key = 'accounts_payable'
      and mapping.account_id = payable_account_id
    )
    or (
      mapping.mapping_type = 'payment_method'
      and mapping.source_key = mapping_key
      and mapping.account_id = payment_account_id
    )
  order by mapping.id
  for share;

  perform account.id
  from public.accounting_accounts account
  where account.id in (payable_account_id, payment_account_id)
    and account.is_active
  order by account.id
  for share;

  if not exists (
    select 1
    from public.accounting_accounts account
    where account.id = payable_account_id
      and account.code = '2101001'
      and account.name = 'PROVEEDORES LOCALES'
      and account.type = 'liability'
      and account.normal_balance = 'credit'
      and account.is_active
  ) then
    raise exception 'supplier_payable_control_account_invalid';
  end if;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  )
  values (
    'supplier_payment', payment.id::text, 'supplier_payment', 'v2',
    'ready', box.occurred_at,
    jsonb_build_object(
      'event_type', 'supplier_payment',
      'payment_id', payment.id,
      'supplier_id', payment.supplier_id,
      'application_count', application_count,
      'application_ids', application_ids,
      'accounts_payable_ids', payable_ids,
      'applied_amounts', applied_amounts,
      'recognition_origins', recognition_origins,
      'opening_balance_batch_ids', opening_balance_batch_ids,
      'allocation_mode', 'applications_v1',
      'scenario', 'multi_application_v1',
      'payment_method', payment.payment_method_v2,
      'amount', payment.amount,
      'currency', payment.currency,
      'effective_date', effective_date,
      'outbox_id', box.id,
      'feature_key', box.feature_key,
      'cutover_at', box.cutover_at,
      'posting_version', 'v2',
      'manual_publication_required', true
    ),
    '[]'::jsonb,
    draft_actor
  )
  on conflict (
    source_type, source_id, event_purpose, posting_version
  )
  do update set
    status = case
      when public.financial_events.journal_entry_id is null
        and public.financial_events.status not in ('posted', 'reversed')
        then 'ready'
      else public.financial_events.status
    end,
    source_snapshot = case
      when public.financial_events.status not in ('posted', 'reversed')
        then excluded.source_snapshot
      else public.financial_events.source_snapshot
    end,
    validation_errors = case
      when public.financial_events.journal_entry_id is null
        then '[]'::jsonb
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
      'journal_entry_id', event.journal_entry_id,
      'reason', 'existing_draft_reused'
    );
  end if;

  select entry.id into existing_entry_id
  from public.journal_entries entry
  where entry.source_type = 'financial_event'
    and entry.source_id = event.id::text
  limit 1;
  if existing_entry_id is not null then
    update public.financial_events
    set status = 'draft_created',
        journal_entry_id = existing_entry_id,
        validation_errors = '[]'::jsonb,
        updated_at = now()
    where id = event.id;
    update public.accounting_outbox_v2
    set status = 'completed',
        financial_event_id = event.id,
        journal_entry_id = existing_entry_id,
        duplicate_avoided = true,
        processed_at = now(),
        lease_until = null,
        locked_by = null
    where id = box.id;
    return jsonb_build_object(
      'ok', true, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', 'completed', 'event_id', event.id,
      'journal_entry_id', existing_entry_id,
      'reason', 'existing_draft_reused'
    );
  end if;

  canonical_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', payable_account_id,
      'debit', payment.amount,
      'credit', 0,
      'description',
        'Abono agregado a proveedores ' || left(payment.id::text, 8),
      'vendor_id', payment.supplier_id
    ),
    jsonb_build_object(
      'account_id', payment_account_id,
      'debit', 0,
      'credit', payment.amount,
      'description',
        'Salida unica por pago a proveedor ' || left(payment.id::text, 8),
      'vendor_id', payment.supplier_id
    )
  );
  normalized_lines :=
    public.normalize_journal_draft_lines(canonical_lines);
  if jsonb_array_length(normalized_lines->'lines') <> 2
    or (normalized_lines->>'total_debit')::numeric <> payment.amount
    or (normalized_lines->>'total_credit')::numeric <> payment.amount
  then
    raise exception 'supplier_multi_payment_journal_not_balanced';
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id,
    created_by, updated_by, metadata
  )
  values (
    public.next_journal_entry_number(),
    effective_date,
    'Borrador automatico de pago agregado a proveedor '
      || left(payment.id::text, 8),
    'borrador',
    'financial_event',
    event.id::text,
    draft_actor,
    draft_actor,
    jsonb_build_object(
      'entry_kind', 'automatic',
      'generated_from_source', true,
      'accounting_outbox_v2_id', box.id,
      'feature_key', box.feature_key,
      'posting_version', 'v2',
      'scenario', 'multi_application_v1',
      'payment_id', payment.id,
      'supplier_id', payment.supplier_id,
      'application_count', application_count,
      'application_ids', application_ids,
      'accounts_payable_ids', payable_ids,
      'applied_amounts', applied_amounts,
      'recognition_origins', recognition_origins,
      'opening_balance_batch_ids', opening_balance_batch_ids,
      'allocation_mode', 'applications_v1',
      'manual_publication_required', true
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
    (line->>'account_id')::uuid,
    (line->>'debit')::numeric,
    (line->>'credit')::numeric,
    line->>'description',
    nullif(line->>'customer_id', '')::uuid,
    nullif(line->>'vendor_id', '')::uuid,
    nullif(line->>'product_id', '')::uuid
  from jsonb_array_elements(normalized_lines->'lines') line;

  if (
    select count(*)
    from public.journal_entry_lines line
    where line.journal_entry_id = entry_id
  ) <> 2 then
    raise exception 'supplier_multi_payment_journal_line_count_invalid';
  end if;

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
    event_type, entity_type, entity_id, source_type, source_id,
    metadata, created_by
  )
  values (
    'supplier_multi_payment_accounting_completed',
    'accounting_outbox_v2',
    box.id,
    'supplier_payment',
    payment.id::text,
    jsonb_build_object(
      'payment_id', payment.id,
      'supplier_id', payment.supplier_id,
      'amount', payment.amount,
      'payment_method', payment.payment_method_v2,
      'application_count', application_count,
      'outbox_id', box.id,
      'event_id', event.id,
      'journal_entry_id', entry_id,
      'manual_publication_required', true,
      'result', 'draft_created'
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
          next_attempt_at = now() + interval '15 minutes',
          lease_until = null,
          locked_by = null,
          last_error_code = 'technical_error',
          last_error_message = left(
            regexp_replace(
              coalesce(sqlerrm, 'Fallo tecnico del worker contable.'),
              E'[\n\r\t]+', ' ', 'g'
            ),
            500
          )
      where id = box.id;
      insert into public.accounting_event_log (
        event_type, entity_type, entity_id, source_type, source_id,
        metadata, created_by
      )
      values (
        'supplier_multi_payment_accounting_failed',
        'accounting_outbox_v2',
        box.id,
        'supplier_payment',
        box.source_id::text,
        jsonb_build_object(
          'payment_id', box.source_id,
          'outbox_id', box.id,
          'attempt_count', box.attempt_count,
          'error_code', 'technical_error',
          'result', 'failed'
        ),
        draft_actor
      );
    end if;
    return jsonb_build_object(
      'ok', false,
      'claimed', box.id is not null,
      'outbox_id', coalesce(box.id, target_outbox_id),
      'outbox_status', 'failed',
      'reason', 'technical_error',
      'error', left(
        regexp_replace(
          coalesce(sqlerrm, 'Fallo tecnico del worker contable.'),
          E'[\n\r\t]+', ' ', 'g'
        ),
        500
      )
    );
end;
$$;

revoke all on function
  public.process_supplier_multi_payment_outbox_v1(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function
  public.process_supplier_multi_payment_outbox_v1(uuid, text, boolean)
  to service_role;

create or replace function public.process_accounting_outbox_v2(
  target_outbox_id uuid,
  worker_token text,
  force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  use_multi_worker boolean := false;
begin
  select exists (
    select 1
    from public.accounting_outbox_v2 box
    join public.supplier_payments payment
      on payment.id = box.source_id
    where box.id = target_outbox_id
      and box.source_type = 'supplier_payment'
      and box.event_purpose = 'supplier_payment'
      and box.posting_version = 'v2'
      and box.scenario = 'multi_application_v1'
      and payment.allocation_mode = 'applications_v1'
  )
  into use_multi_worker;

  if use_multi_worker then
    return public.process_supplier_multi_payment_outbox_v1(
      target_outbox_id, worker_token, force_retry
    );
  end if;
  return public.process_accounting_outbox_v016(
    target_outbox_id, worker_token, force_retry
  );
end;
$$;

revoke all on function
  public.process_accounting_outbox_v2(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function
  public.process_accounting_outbox_v2(uuid, text, boolean)
  to service_role;

alter table public.supplier_payments
  drop constraint if exists supplier_payments_applications_header_check,
  add constraint supplier_payments_applications_header_check check (
    allocation_mode <> 'applications_v1'
    or (
      currency = 'HNL'
      and payment_method_v2
        in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
      and payment_account_id is not null
      and (
        payment_method_v2 <> 'bank_transfer'
        or reference is not null
      )
    )
  );

create or replace function public.void_supplier_multi_payment_v1(
  p_payment_id uuid,
  p_request_key uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  clean_reason text := nullif(
    left(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 1000),
    ''
  );
  idempotency_value text;
  fingerprint text;
  payment public.supplier_payments%rowtype;
  box public.accounting_outbox_v2%rowtype;
  compensation_id uuid;
  application_count integer;
  application_total numeric(12, 2);
  application_results jsonb;
begin
  if actor_id is null
    or actor_role
      not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('payables:manage')
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para anular pagos a proveedores.';
  end if;
  if p_payment_id is null or p_request_key is null then
    raise exception using
      errcode = '22023',
      message = 'El pago y la clave de solicitud son obligatorios.';
  end if;

  idempotency_value :=
    'supplier_multi_payment_void:v1:' || p_request_key::text;
  fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'version', 'supplier_multi_payment_void:v1',
          'payment_id', p_payment_id::text,
          'reason', clean_reason
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(idempotency_value, 0)
  );

  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = p_payment_id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2'
  for update;

  select * into payment
  from public.supplier_payments
  where id = p_payment_id
  for update;

  if payment.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'El pago a proveedor no existe.';
  end if;
  if payment.allocation_mode <> 'applications_v1' then
    raise exception using
      errcode = '22023',
      message = 'Esta RPC solo anula pagos multifáctura.';
  end if;

  if payment.status = 'voided' then
    if payment.void_idempotency_key is distinct from idempotency_value
      or payment.void_request_fingerprint is distinct from fingerprint
    then
      raise exception using
        errcode = '23505',
        message = 'El pago ya fue anulado con una solicitud diferente.';
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'application_id', item.id,
          'accounts_payable_id', item.accounts_payable_id,
          'applied_amount', item.applied_amount,
          'status', item.status
        )
        order by item.accounts_payable_id
      ),
      '[]'::jsonb
    )
    into application_results
    from public.supplier_payment_applications item
    where item.supplier_payment_id = payment.id;

    select candidate.id into compensation_id
    from public.accounting_outbox_v2 candidate
    where candidate.source_type = 'supplier_payment'
      and candidate.source_id = payment.id
      and candidate.event_purpose = 'supplier_payment_compensation'
      and candidate.posting_version = 'v2';

    return jsonb_build_object(
      'status', 'voided',
      'replayed', true,
      'payment_id', payment.id,
      'application_count', jsonb_array_length(application_results),
      'applications', application_results,
      'original_outbox_id', box.id,
      'compensation_outbox_id', compensation_id
    );
  end if;

  if payment.status <> 'paid' then
    raise exception using
      errcode = '22023',
      message = 'Solo se pueden anular pagos registrados como pagados.';
  end if;

  perform item.id
  from public.supplier_payment_applications item
  where item.supplier_payment_id = payment.id
    and item.status = 'applied'
  order by item.id
  for update;

  select count(*), coalesce(sum(item.applied_amount), 0)
  into application_count, application_total
  from public.supplier_payment_applications item
  where item.supplier_payment_id = payment.id
    and item.status = 'applied';

  if application_count < 1 or application_total <> payment.amount then
    raise exception using
      errcode = '23514',
      message = 'El pago no conserva una distribucion activa valida.';
  end if;

  perform payable.id
  from public.accounts_payable payable
  join public.supplier_payment_applications item
    on item.accounts_payable_id = payable.id
  where item.supplier_payment_id = payment.id
    and item.status = 'applied'
  order by payable.id
  for update of payable;

  if (
    select count(*)
    from public.accounts_payable payable
    join public.supplier_payment_applications item
      on item.accounts_payable_id = payable.id
    where item.supplier_payment_id = payment.id
      and item.status = 'applied'
      and payable.supplier_id = payment.supplier_id
      and payable.status <> 'cancelled'
      and payable.paid_amount >= item.applied_amount
  ) <> application_count then
    raise exception using
      errcode = '40001',
      message = 'Los saldos cambiaron y el pago no puede anularse de forma segura.';
  end if;

  perform invoice.id
  from public.supplier_invoices invoice
  join public.supplier_payment_applications item
    on item.supplier_invoice_id = invoice.id
  where item.supplier_payment_id = payment.id
    and item.status = 'applied'
  order by invoice.id
  for update of invoice;

  update public.accounts_payable payable
  set paid_amount = payable.paid_amount - item.applied_amount,
      status = case
        when payable.balance + item.applied_amount > 0
          and payable.due_date is not null
          and payable.due_date
            < (now() at time zone 'America/Tegucigalpa')::date
          then 'overdue'
        when payable.paid_amount - item.applied_amount = 0
          then 'pending'
        else 'partial'
      end,
      updated_at = now()
  from public.supplier_payment_applications item
  where item.supplier_payment_id = payment.id
    and item.status = 'applied'
    and payable.id = item.accounts_payable_id;

  update public.supplier_invoices invoice
  set status = case
        when exists (
          select 1
          from public.accounts_payable payable
          where payable.supplier_invoice_id = invoice.id
            and payable.status <> 'cancelled'
            and payable.balance > 0
        ) then 'posted_to_ap'
        else 'paid'
      end,
      updated_at = now()
  where invoice.id in (
    select item.supplier_invoice_id
    from public.supplier_payment_applications item
    where item.supplier_payment_id = payment.id
      and item.status = 'applied'
      and item.supplier_invoice_id is not null
  )
    and invoice.status <> 'cancelled';

  update public.supplier_payment_applications
  set status = 'voided',
      voided_at = now()
  where supplier_payment_id = payment.id
    and status = 'applied';

  update public.supplier_payments
  set status = 'voided',
      voided_by = actor_id,
      voided_at = now(),
      void_idempotency_key = idempotency_value,
      void_request_fingerprint = fingerprint,
      updated_at = now()
  where id = payment.id
  returning * into payment;

  compensation_id := public.cancel_accounting_fact_v2(
    'supplier_payment',
    payment.id,
    'supplier_payment',
    'supplier_payment_compensation',
    actor_id
  );

  select jsonb_agg(
    jsonb_build_object(
      'application_id', item.id,
      'accounts_payable_id', item.accounts_payable_id,
      'applied_amount', item.applied_amount,
      'status', item.status
    )
    order by item.accounts_payable_id
  )
  into application_results
  from public.supplier_payment_applications item
  where item.supplier_payment_id = payment.id;

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action,
    old_data, new_data
  )
  values (
    actor_id,
    actor_role,
    'supplier_payments',
    payment.id,
    'supplier_payments.multi_void_v1',
    jsonb_build_object(
      'status', 'paid',
      'amount', payment.amount,
      'application_count', application_count
    ),
    jsonb_build_object(
      'status', 'voided',
      'amount', payment.amount,
      'application_count', application_count,
      'original_outbox_id', box.id,
      'compensation_outbox_id', compensation_id,
      'reason', clean_reason
    )
  );

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id,
    metadata, created_by
  )
  values (
    'supplier_multi_payment_voided',
    'supplier_payments',
    payment.id,
    'supplier_payment',
    payment.id::text,
    jsonb_build_object(
      'payment_id', payment.id,
      'supplier_id', payment.supplier_id,
      'amount', payment.amount,
      'payment_method', payment.payment_method_v2,
      'application_count', application_count,
      'request_key_suffix', right(p_request_key::text, 8),
      'original_outbox_id', box.id,
      'compensation_outbox_id', compensation_id,
      'result', 'voided'
    ),
    actor_id
  );

  return jsonb_build_object(
    'status', 'voided',
    'replayed', false,
    'payment_id', payment.id,
    'application_count', application_count,
    'applications', application_results,
    'original_outbox_id', box.id,
    'compensation_outbox_id', compensation_id
  );
end;
$$;

revoke all on function
  public.void_supplier_multi_payment_v1(uuid, uuid, text)
  from public, anon;
grant execute on function
  public.void_supplier_multi_payment_v1(uuid, uuid, text)
  to authenticated, service_role;

comment on function public.register_supplier_multi_payment_v1(
  uuid, uuid, text, date, text, jsonb, text, text
) is
  'Atomic HNL supplier payment with 1-200 applications, SHA-256 idempotency, deterministic locks and one V2 outbox.';

comment on function public.void_supplier_multi_payment_v1(
  uuid, uuid, text
) is
  'Idempotent full-payment reversal only. Restores every payable and delegates draft cancellation or published compensation to cancel_accounting_fact_v2.';
