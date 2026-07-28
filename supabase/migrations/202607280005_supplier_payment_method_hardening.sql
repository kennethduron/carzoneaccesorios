-- Close supplier-payment methods for all new writes while retaining readable
-- legacy text on historical rows. Also provides a guarded, idempotent repair
-- RPC for the one confirmed historical credit-card payment.

create or replace function public.require_supplier_payment_method_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_method_v2 is null
    or new.payment_method_v2 not in ('cash', 'bank_transfer', 'card_credit', 'card_debit')
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

revoke all on function public.require_supplier_payment_method_v2()
  from public, anon, authenticated;

drop trigger if exists supplier_payments_require_method_v2
  on public.supplier_payments;
create trigger supplier_payments_require_method_v2
before insert on public.supplier_payments
for each row
execute function public.require_supplier_payment_method_v2();

-- The old free-text RPC is no longer a supported write path. Historical rows
-- remain untouched and readable.
revoke all on function public.register_supplier_payment(
  uuid, numeric, text, timestamptz, text
) from authenticated, service_role;
revoke all on function public.void_supplier_payment(uuid, text)
  from authenticated, service_role;

create or replace function public.supplier_payment_method_label_v2(
  canonical_method text,
  legacy_method text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case canonical_method
    when 'cash' then 'Efectivo'
    when 'bank_transfer' then 'Transferencia bancaria'
    when 'card_credit' then 'Tarjeta de credito'
    when 'card_debit' then 'Tarjeta de debito'
    else coalesce(nullif(btrim(legacy_method), ''), 'Metodo legacy')
  end
$$;

grant execute on function public.supplier_payment_method_label_v2(text, text)
  to authenticated, service_role;

create or replace function public.repair_existing_supplier_card_payment_v1(
  target_payment_id uuid,
  target_event_id uuid,
  obligation_journal_id uuid,
  repair_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  event public.financial_events%rowtype;
  obligation_entry public.journal_entries%rowtype;
  existing_entry public.journal_entries%rowtype;
  supplier_name text;
  actor_role text;
  effective_date date;
  payable_account uuid;
  card_account uuid;
  recognized_liability numeric(14, 2);
  normalized_lines jsonb;
  entry_id uuid;
  entry_number_value text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'La reparacion dirigida solo puede ejecutarse desde el servidor.';
  end if;

  select role.name into actor_role
  from public.users actor
  join public.roles role on role.id = actor.role_id
  where actor.id = repair_actor_id
    and actor.active = true;

  if actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora') then
    raise exception using errcode = '42501', message = 'El actor de reparacion no es valido.';
  end if;

  select * into payment
  from public.supplier_payments
  where id = target_payment_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'El pago dirigido no existe.';
  end if;

  select * into payable
  from public.accounts_payable
  where id = payment.accounts_payable_id
  for share;

  select name into supplier_name
  from public.suppliers
  where id = payment.supplier_id;

  if payment.status <> 'paid'
    or payment.voided_at is not null
    or round(payment.amount, 2) <> 9800.00
    or upper(btrim(coalesce(payment.payment_method, ''))) <> 'TARJETA'
    or payable.id is null
    or payable.supplier_id <> payment.supplier_id
    or round(payable.total_amount, 2) <> 73200.00
    or round(payable.paid_amount, 2) <> 9800.00
    or round(payable.balance, 2) <> 63400.00
    or payable.status <> 'partial'
    or payable.purchase_id is not null
    or payable.supplier_invoice_id is not null
    or upper(btrim(coalesce(supplier_name, ''))) <> 'CROMOS TORRE FUERTE'
  then
    raise exception using errcode = '22023', message = 'Las precondiciones operativas del pago dirigido cambiaron.';
  end if;

  effective_date := (payment.paid_at at time zone 'America/Tegucigalpa')::date;
  if effective_date <> date '2026-07-12' then
    raise exception using errcode = '22023', message = 'La fecha efectiva del pago dirigido no coincide.';
  end if;

  select * into event
  from public.financial_events
  where id = target_event_id
    and source_type = 'supplier_payment'
    and source_id = payment.id::text
    and event_purpose = 'supplier_payment'
    and posting_version = 'v1'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'El evento financiero dirigido no existe o no es unico.';
  end if;

  if event.journal_entry_id is not null then
    select * into existing_entry
    from public.journal_entries
    where id = event.journal_entry_id;
    if existing_entry.id is null then
      raise exception using errcode = '23503', message = 'El evento apunta a una partida inexistente.';
    end if;
    return jsonb_build_object(
      'ok', true,
      'status', 'already_repaired',
      'event_id', event.id,
      'journal_entry_id', existing_entry.id,
      'journal_status', existing_entry.status,
      'idempotent_replay', true
    );
  end if;

  if exists (
    select 1
    from public.journal_entries entry
    where entry.source_type = 'financial_event'
      and entry.source_id = event.id::text
  ) then
    raise exception using errcode = '23505', message = 'Ya existe otra partida vinculada al evento dirigido.';
  end if;

  if obligation_journal_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 'pending_dependency',
      'reason', 'original_liability_not_identified',
      'payment_id', payment.id,
      'event_id', event.id
    );
  end if;

  select * into obligation_entry
  from public.journal_entries
  where id = obligation_journal_id
  for share;

  if not found or obligation_entry.status <> 'publicada' then
    raise exception using errcode = '22023', message = 'La partida de obligacion no esta reconocida en el libro.';
  end if;

  payable_account := public.resolve_accounting_mapping_v2(
    'default_account', 'accounts_payable', effective_date
  );
  card_account := public.resolve_accounting_mapping_v2(
    'payment_method', 'supplier_payment_card', effective_date
  );
  if payable_account is null or card_account is null then
    raise exception using errcode = '22023', message = 'Falta un mapping activo para Proveedores o Tarjeta de credito.';
  end if;

  select round(coalesce(sum(line.credit - line.debit), 0), 2)
  into recognized_liability
  from public.journal_entry_lines line
  where line.journal_entry_id = obligation_entry.id
    and line.account_id = payable_account
    and (line.vendor_id is null or line.vendor_id = payment.supplier_id);

  if recognized_liability < 73200.00 then
    return jsonb_build_object(
      'ok', false,
      'status', 'pending_dependency',
      'reason', 'original_liability_amount_not_recognized',
      'recognized_liability', recognized_liability,
      'payment_id', payment.id,
      'event_id', event.id
    );
  end if;

  if public.is_date_in_closed_accounting_period(date '2026-07-12') then
    raise exception using errcode = '22023', message = 'El periodo contable de la reparacion esta cerrado.';
  end if;

  normalized_lines := public.normalize_journal_draft_lines(jsonb_build_array(
    jsonb_build_object(
      'account_id', payable_account,
      'debit', 9800.00,
      'credit', 0,
      'description', 'Pago dirigido a proveedor ' || left(payment.id::text, 8),
      'vendor_id', payment.supplier_id
    ),
    jsonb_build_object(
      'account_id', card_account,
      'debit', 0,
      'credit', 9800.00,
      'description', 'Tarjeta de credito ' || left(payment.id::text, 8),
      'vendor_id', payment.supplier_id
    )
  ));
  entry_number_value := public.next_journal_entry_number();

  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id,
    created_by, updated_by, metadata
  )
  values (
    entry_number_value,
    date '2026-07-12',
    'Borrador dirigido de pago a proveedor ' || left(payment.id::text, 8),
    'borrador',
    'financial_event',
    event.id::text,
    repair_actor_id,
    repair_actor_id,
    jsonb_build_object(
      'entry_kind', 'directed_repair',
      'repair_contract', 'supplier_payment_9800_credit_card_v1',
      'financial_event_id', event.id,
      'obligation_journal_id', obligation_entry.id,
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

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  )
  values (
    'accounting.directed_repair_supplier_payment_9800',
    'journal_entries',
    entry_id,
    'supplier_payment',
    payment.id::text,
    jsonb_build_object(
      'event_id', event.id,
      'obligation_journal_id', obligation_entry.id,
      'effective_date', date '2026-07-12',
      'amount', 9800.00,
      'journal_status', 'borrador',
      'manual_publication_required', true
    ),
    repair_actor_id
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'repaired',
    'event_id', event.id,
    'journal_entry_id', entry_id,
    'journal_status', 'borrador',
    'entry_date', date '2026-07-12',
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.repair_existing_supplier_card_payment_v1(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.repair_existing_supplier_card_payment_v1(
  uuid, uuid, uuid, uuid
) to service_role;
