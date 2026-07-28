-- Harden the single directed historical supplier-payment repair by requiring
-- exact reconciliation to the approved opening-balance control account.
-- This migration is intentionally scoped to CROMOS TORRE FUERTE and does not
-- scan, enqueue, post or otherwise modify historical business operations.

create unique index if not exists journal_entries_supplier_payment_repair_key_uidx
  on public.journal_entries ((metadata->>'repair_idempotency_key'))
  where metadata->>'repair_contract' = 'supplier_payment_9800_opening_balance_v2'
    and metadata ? 'repair_idempotency_key';

create unique index if not exists accounting_event_log_supplier_payment_repair_key_uidx
  on public.accounting_event_log ((metadata->>'repair_idempotency_key'))
  where event_type = 'accounting.directed_repair_supplier_payment_9800'
    and metadata ? 'repair_idempotency_key';

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
  expected_opening_entry_id constant uuid :=
    '5843045f-db47-429c-ad19-f75dc61cdd3e'::uuid;
  expected_opening_line_id constant uuid :=
    'f7389203-9ac0-40b8-9822-edfceb0e38fb'::uuid;
  expected_control_account_id constant uuid :=
    '05847d56-7097-492b-b153-2db33a00b9cd'::uuid;
  expected_card_account_id constant uuid :=
    'a84f16c1-42da-4ed5-bca8-d3b20c5c3733'::uuid;
  expected_supplier_id constant uuid :=
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f'::uuid;
  expected_payable_id constant uuid :=
    '5421d871-4ab4-49f6-a778-99bdbe0f609e'::uuid;
  expected_payment_id constant uuid :=
    'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804'::uuid;
  expected_event_id constant uuid :=
    '6dd1e200-f628-450e-8bfc-f8a6c700b442'::uuid;
  expected_opening_number constant text := 'PC-20260714-621782';
  expected_opening_date constant date := date '2026-07-11';
  expected_entry_date constant date := date '2026-07-12';
  expected_opening_count constant integer := 26;
  expected_supplier_count constant integer := 8;
  expected_opening_total constant numeric(14, 2) := 1589972.61;
  expected_payable_total constant numeric(14, 2) := 73200.00;
  expected_payment_amount constant numeric(14, 2) := 9800.00;
  expected_balance constant numeric(14, 2) := 63400.00;
  expected_opening_hash constant text :=
    '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd';
  repair_version_value constant text := 'opening-balance-exact-v1';
  evidence_type_value constant text :=
    'opening_balance_control_account_reconciliation';
  payment public.supplier_payments%rowtype;
  payable public.accounts_payable%rowtype;
  event public.financial_events%rowtype;
  opening_entry public.journal_entries%rowtype;
  opening_line public.journal_entry_lines%rowtype;
  existing_entry public.journal_entries%rowtype;
  control_account public.accounting_accounts%rowtype;
  card_account public.accounting_accounts%rowtype;
  supplier_name text;
  actor_role text;
  idempotency_key_value text;
  opening_count integer;
  opening_supplier_count integer;
  opening_total numeric(14, 2);
  opening_hash text;
  target_supplier_count integer;
  target_payable_count integer;
  target_payment_count integer;
  target_event_count integer;
  control_line_count integer;
  conflicting_entry_count integer;
  existing_log_count integer;
  normalized_lines jsonb;
  evidence_metadata jsonb;
  entry_id uuid;
  entry_number_value text;
  repair_timestamp timestamptz := now();
  previous_event_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'La reparacion dirigida solo puede ejecutarse desde el servidor.';
  end if;

  select role.name
  into actor_role
  from public.users actor
  join public.roles role on role.id = actor.role_id
  where actor.id = repair_actor_id
    and actor.active = true;

  if actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora') then
    raise exception using
      errcode = '42501',
      message = 'El actor de reparacion no es valido.';
  end if;

  if target_payment_id <> expected_payment_id
    or target_event_id <> expected_event_id
    or obligation_journal_id <> expected_opening_entry_id
  then
    raise exception using
      errcode = '22023',
      message = 'Los identificadores no pertenecen al contrato dirigido aprobado.';
  end if;

  idempotency_key_value := 'supplier_payment_repair:'
    || target_payment_id::text || ':' || target_event_id::text;

  perform pg_advisory_xact_lock(hashtextextended(idempotency_key_value, 0));

  -- Predicate reads alone do not prevent a concurrent insert from changing the
  -- approved population after it has been counted. These short-lived locks make
  -- the evidence snapshot and the write atomic while still allowing readers.
  lock table
    public.accounts_payable,
    public.supplier_payments,
    public.financial_events,
    public.journal_entries,
    public.journal_entry_lines,
    public.accounting_event_log
  in share row exclusive mode;

  select *
  into opening_entry
  from public.journal_entries
  where id = expected_opening_entry_id
  for share;

  if not found
    or opening_entry.id <> obligation_journal_id
    or opening_entry.entry_number <> expected_opening_number
    or opening_entry.entry_date <> expected_opening_date
    or opening_entry.description <> 'BALANCE INICIAL DE ZAFRA'
    or opening_entry.status <> 'publicada'
    or opening_entry.posted_at is null
    or opening_entry.posted_by is null
  then
    raise exception using
      errcode = '22023',
      message = 'La partida inicial aprobada cambio o dejo de estar publicada.';
  end if;

  if (
    select count(*)
    from public.journal_entries
    where id = expected_opening_entry_id
      and entry_number = expected_opening_number
      and entry_date = expected_opening_date
      and description = 'BALANCE INICIAL DE ZAFRA'
  ) <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La partida inicial no es inequivoca.';
  end if;

  select *
  into opening_line
  from public.journal_entry_lines
  where id = expected_opening_line_id
  for share;

  select *
  into control_account
  from public.accounting_accounts
  where id = expected_control_account_id
  for share;

  if opening_line.id is null
    or opening_line.journal_entry_id <> opening_entry.id
    or opening_line.account_id <> expected_control_account_id
    or round(opening_line.debit, 2) <> 0.00
    or round(opening_line.credit, 2) <> expected_opening_total
    or control_account.id is null
    or control_account.code <> '2101001'
    or control_account.name <> 'PROVEEDORES LOCALES'
    or control_account.type <> 'liability'
    or control_account.normal_balance <> 'credit'
    or not control_account.is_active
  then
    raise exception using
      errcode = '22023',
      message = 'La linea de control 2101001 no coincide con la evidencia aprobada.';
  end if;

  select count(*)
  into control_line_count
  from public.journal_entry_lines line
  where line.journal_entry_id = opening_entry.id
    and line.account_id = expected_control_account_id;

  if control_line_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La partida inicial no tiene una unica linea de control 2101001.';
  end if;

  perform 1
  from public.accounts_payable candidate
  where candidate.purchase_id is null
    and candidate.supplier_invoice_id is null
    and candidate.imported_from_batch_id is null
    and candidate.imported_from_row_id is null
    and candidate.created_at < opening_entry.created_at
  order by candidate.id
  for share;

  select
    count(*),
    count(distinct candidate.supplier_id),
    round(coalesce(sum(candidate.total_amount), 0), 2),
    encode(
      extensions.digest(
        convert_to(string_agg(candidate.id::text, ',' order by candidate.id), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  into
    opening_count,
    opening_supplier_count,
    opening_total,
    opening_hash
  from public.accounts_payable candidate
  where candidate.purchase_id is null
    and candidate.supplier_invoice_id is null
    and candidate.imported_from_batch_id is null
    and candidate.imported_from_row_id is null
    and candidate.created_at < opening_entry.created_at;

  if opening_count <> expected_opening_count then
    raise exception using
      errcode = '22023',
      message = 'La cantidad del auxiliar inicial no coincide.';
  end if;
  if opening_supplier_count <> expected_supplier_count then
    raise exception using
      errcode = '22023',
      message = 'La cantidad de proveedores del auxiliar inicial no coincide.';
  end if;
  if opening_total <> expected_opening_total then
    raise exception using
      errcode = '22023',
      message = 'El total del auxiliar inicial no coincide.';
  end if;
  if round(opening_line.credit - opening_line.debit - opening_total, 2) <> 0.00 then
    raise exception using
      errcode = '22023',
      message = 'La conciliacion entre la cuenta control y el auxiliar tiene diferencia.';
  end if;
  if opening_hash <> expected_opening_hash then
    raise exception using
      errcode = '22023',
      message = 'El hash del auxiliar inicial no coincide.';
  end if;

  select count(*)
  into target_supplier_count
  from public.suppliers supplier
  where regexp_replace(upper(btrim(supplier.name)), '[[:space:]]+', ' ', 'g')
    = 'CROMOS TORRE FUERTE';

  if target_supplier_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'CROMOS TORRE FUERTE no es un proveedor inequivoco.';
  end if;

  select name
  into supplier_name
  from public.suppliers
  where id = expected_supplier_id
    and is_active
  for share;

  if regexp_replace(
      upper(btrim(coalesce(supplier_name, ''))),
      '[[:space:]]+',
      ' ',
      'g'
    )
    <> 'CROMOS TORRE FUERTE'
  then
    raise exception using
      errcode = '22023',
      message = 'El proveedor dirigido cambio.';
  end if;

  select count(*)
  into target_payable_count
  from public.accounts_payable candidate
  where candidate.supplier_id = expected_supplier_id
    and round(candidate.total_amount, 2) = expected_payable_total;

  if target_payable_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La obligacion de CROMOS no es unica.';
  end if;

  select *
  into payable
  from public.accounts_payable
  where id = expected_payable_id
  for share;

  if not found
    or payable.supplier_id <> expected_supplier_id
    or round(payable.total_amount, 2) <> expected_payable_total
    or round(payable.paid_amount, 2) <> expected_payment_amount
    or round(payable.balance, 2) <> expected_balance
    or payable.status <> 'partial'
    or upper(btrim(payable.currency)) <> 'HNL'
    or payable.purchase_id is not null
    or payable.supplier_invoice_id is not null
    or payable.imported_from_batch_id is not null
    or payable.imported_from_row_id is not null
    or payable.created_at >= opening_entry.created_at
  then
    raise exception using
      errcode = '22023',
      message = 'La obligacion dirigida cambio o no pertenece al auxiliar inicial.';
  end if;

  select count(*)
  into target_payment_count
  from public.supplier_payments candidate
  where candidate.supplier_id = expected_supplier_id
    and candidate.accounts_payable_id = expected_payable_id
    and round(candidate.amount, 2) = expected_payment_amount;

  if target_payment_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'El pago historico de CROMOS no es unico.';
  end if;

  select *
  into payment
  from public.supplier_payments
  where id = expected_payment_id
  for share;

  if not found
    or payment.id <> target_payment_id
    or payment.accounts_payable_id <> expected_payable_id
    or payment.supplier_id <> expected_supplier_id
    or round(payment.amount, 2) <> expected_payment_amount
    or payment.status <> 'paid'
    or payment.voided_at is not null
    or upper(btrim(coalesce(payment.payment_method, ''))) <> 'TARJETA'
    or (
      payment.payment_method_v2 is not null
      and payment.payment_method_v2 <> 'card_credit'
    )
    or (payment.paid_at at time zone 'America/Tegucigalpa')::date
      <> expected_entry_date
  then
    raise exception using
      errcode = '22023',
      message = 'El pago historico dirigido cambio.';
  end if;

  select count(*)
  into target_event_count
  from public.financial_events candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = expected_payment_id::text;

  if target_event_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'El evento financiero del pago no es unico.';
  end if;

  select *
  into event
  from public.financial_events
  where id = expected_event_id
  for update;

  if not found
    or event.id <> target_event_id
    or event.source_type <> 'supplier_payment'
    or event.source_id <> expected_payment_id::text
    or event.event_purpose <> 'supplier_payment'
    or event.posting_version <> 'v1'
    or event.status not in ('pending', 'draft_created')
  then
    raise exception using
      errcode = '22023',
      message = 'El evento financiero dirigido cambio.';
  end if;

  select *
  into card_account
  from public.accounting_accounts
  where id = expected_card_account_id
  for share;

  if card_account.id is null
    or card_account.code <> '2110001'
    or card_account.name <> 'TARJETA DE CREDITO'
    or card_account.type <> 'liability'
    or card_account.normal_balance <> 'credit'
    or not card_account.is_active
    or public.resolve_accounting_mapping_v2(
      'default_account', 'accounts_payable', expected_entry_date
    ) <> expected_control_account_id
    or public.resolve_accounting_mapping_v2(
      'payment_method', 'supplier_payment_card', expected_entry_date
    ) <> expected_card_account_id
  then
    raise exception using
      errcode = '22023',
      message = 'Las cuentas contables dirigidas no coinciden.';
  end if;

  if public.is_date_in_closed_accounting_period(expected_entry_date) then
    raise exception using
      errcode = '22023',
      message = 'El periodo contable de la reparacion esta cerrado.';
  end if;

  if event.journal_entry_id is not null then
    select *
    into existing_entry
    from public.journal_entries
    where id = event.journal_entry_id
    for share;

    if existing_entry.id is null
      or existing_entry.source_type <> 'financial_event'
      or existing_entry.source_id <> event.id::text
      or existing_entry.status <> 'borrador'
      or existing_entry.posted_at is not null
      or existing_entry.posted_by is not null
      or existing_entry.entry_date <> expected_entry_date
      or existing_entry.metadata->>'repair_contract'
        <> 'supplier_payment_9800_opening_balance_v2'
      or existing_entry.metadata->>'repair_idempotency_key'
        <> idempotency_key_value
      or existing_entry.metadata->>'evidence_type' <> evidence_type_value
      or existing_entry.metadata->>'payment_id' <> payment.id::text
      or existing_entry.metadata->>'payable_id' <> payable.id::text
      or existing_entry.metadata->>'supplier_id' <> expected_supplier_id::text
      or existing_entry.metadata->>'financial_event_id' <> event.id::text
      or coalesce(
        (existing_entry.metadata->>'manual_publication_required')::boolean,
        false
      ) is not true
    then
      raise exception using
        errcode = '23505',
        message = 'El evento esta vinculado a una partida incompatible.';
    end if;

    if event.status <> 'draft_created' then
      raise exception using
        errcode = '23505',
        message = 'El estado del evento idempotente es incompatible.';
    end if;

    if (
      select count(*)
      from public.journal_entry_lines line
      where line.journal_entry_id = existing_entry.id
    ) <> 2
      or not exists (
        select 1
        from public.journal_entry_lines line
        where line.journal_entry_id = existing_entry.id
          and line.account_id = expected_control_account_id
          and round(line.debit, 2) = expected_payment_amount
          and round(line.credit, 2) = 0.00
      )
      or not exists (
        select 1
        from public.journal_entry_lines line
        where line.journal_entry_id = existing_entry.id
          and line.account_id = expected_card_account_id
          and round(line.debit, 2) = 0.00
          and round(line.credit, 2) = expected_payment_amount
      )
    then
      raise exception using
        errcode = '23505',
        message = 'La partida idempotente tiene lineas incompatibles.';
    end if;

    select count(*)
    into existing_log_count
    from public.accounting_event_log log
    where log.event_type = 'accounting.directed_repair_supplier_payment_9800'
      and log.metadata->>'repair_idempotency_key' = idempotency_key_value;

    if existing_log_count <> 1 then
      raise exception using
        errcode = '23505',
        message = 'La evidencia idempotente del log es incompatible.';
    end if;

    return jsonb_build_object(
      'ok', true,
      'status', 'already_repaired',
      'event_id', event.id,
      'journal_entry_id', existing_entry.id,
      'journal_entry_number', existing_entry.entry_number,
      'journal_status', existing_entry.status,
      'entry_date', existing_entry.entry_date,
      'idempotency_key', idempotency_key_value,
      'idempotent_replay', true
    );
  end if;

  if event.status <> 'pending' then
    raise exception using
      errcode = '23505',
      message = 'El evento sin partida no esta pendiente.';
  end if;

  select count(*)
  into conflicting_entry_count
  from public.journal_entries entry
  where (
      entry.source_type = 'financial_event'
      and entry.source_id = event.id::text
    )
    or (
      entry.source_type = 'supplier_payment'
      and entry.source_id = payment.id::text
    )
    or entry.metadata->>'repair_idempotency_key' = idempotency_key_value
    or entry.metadata->>'payment_id' = payment.id::text;

  if conflicting_entry_count <> 0 then
    raise exception using
      errcode = '23505',
      message = 'Ya existe una partida candidata o incompatible para el pago.';
  end if;

  select count(*)
  into existing_log_count
  from public.accounting_event_log log
  where log.event_type = 'accounting.directed_repair_supplier_payment_9800'
    and (
      log.metadata->>'repair_idempotency_key' = idempotency_key_value
      or log.metadata->>'payment_id' = payment.id::text
      or log.metadata->>'financial_event_id' = event.id::text
    );

  if existing_log_count <> 0 then
    raise exception using
      errcode = '23505',
      message = 'Ya existe evidencia de otra reparacion para el pago.';
  end if;

  evidence_metadata := jsonb_build_object(
    'entry_kind', 'directed_repair',
    'repair_contract', 'supplier_payment_9800_opening_balance_v2',
    'repair_idempotency_key', idempotency_key_value,
    'evidence_type', evidence_type_value,
    'opening_balance_journal_entry_id', opening_entry.id,
    'opening_balance_journal_entry_number', opening_entry.entry_number,
    'opening_balance_line_id', opening_line.id,
    'control_account_id', control_account.id,
    'control_account_code', control_account.code,
    'opening_auxiliary_count', opening_count,
    'opening_auxiliary_supplier_count', opening_supplier_count,
    'opening_auxiliary_total', opening_total,
    'opening_balance_control_total', round(opening_line.credit - opening_line.debit, 2),
    'reconciliation_difference', round(
      opening_line.credit - opening_line.debit - opening_total,
      2
    ),
    'opening_auxiliary_hash', opening_hash,
    'supplier_id', expected_supplier_id,
    'payable_id', payable.id,
    'payment_id', payment.id,
    'financial_event_id', event.id,
    'original_payable_amount', expected_payable_total,
    'payment_amount', expected_payment_amount,
    'remaining_balance', expected_balance,
    'payment_method_legacy', 'TARJETA',
    'payment_method_confirmed', 'card_credit',
    'confirmation_source', 'accounting_team',
    'manual_publication_required', true,
    'repaired_by', repair_actor_id,
    'repaired_at', repair_timestamp,
    'repair_version', repair_version_value
  );

  normalized_lines := public.normalize_journal_draft_lines(jsonb_build_array(
    jsonb_build_object(
      'account_id', expected_control_account_id,
      'debit', expected_payment_amount,
      'credit', 0,
      'description', 'Disminucion de cuenta por pagar CROMOS TORRE FUERTE',
      'vendor_id', expected_supplier_id
    ),
    jsonb_build_object(
      'account_id', expected_card_account_id,
      'debit', 0,
      'credit', expected_payment_amount,
      'description', 'Pago con tarjeta de credito CROMOS TORRE FUERTE',
      'vendor_id', expected_supplier_id
    )
  ));

  if round((normalized_lines->>'total_debit')::numeric, 2)
      <> expected_payment_amount
    or round((normalized_lines->>'total_credit')::numeric, 2)
      <> expected_payment_amount
  then
    raise exception using
      errcode = '22023',
      message = 'El borrador dirigido no esta balanceado.';
  end if;

  entry_number_value := public.next_journal_entry_number();
  previous_event_status := event.status;

  insert into public.journal_entries (
    entry_number,
    entry_date,
    description,
    status,
    source_type,
    source_id,
    created_by,
    updated_by,
    metadata
  )
  values (
    entry_number_value,
    expected_entry_date,
    'Borrador dirigido pago CROMOS TORRE FUERTE L 9,800',
    'borrador',
    'financial_event',
    event.id::text,
    repair_actor_id,
    repair_actor_id,
    evidence_metadata
  )
  returning id into entry_id;

  insert into public.journal_entry_lines (
    id,
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
    event_type,
    entity_type,
    entity_id,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values (
    'accounting.directed_repair_supplier_payment_9800',
    'journal_entries',
    entry_id,
    'supplier_payment',
    payment.id::text,
    evidence_metadata || jsonb_build_object(
      'journal_entry_id', entry_id,
      'journal_entry_number', entry_number_value,
      'journal_status', 'borrador',
      'entry_date', expected_entry_date,
      'previous_event_status', previous_event_status,
      'new_event_status', 'draft_created'
    ),
    repair_actor_id
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'repaired',
    'event_id', event.id,
    'journal_entry_id', entry_id,
    'journal_entry_number', entry_number_value,
    'journal_status', 'borrador',
    'entry_date', expected_entry_date,
    'idempotency_key', idempotency_key_value,
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

comment on function public.repair_existing_supplier_card_payment_v1(
  uuid, uuid, uuid, uuid
) is
  'One-time exact and idempotent repair for the approved CROMOS TORRE FUERTE opening-balance payment evidence. Creates one manual-review draft and never posts it.';
