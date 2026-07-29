-- One-case repair contract for the approved historical supplier payment to
-- EDGAR JOEL LEIVA PAZ. This migration only installs the guarded RPC and its
-- idempotency constraints. The RPC must be invoked separately after a
-- read-only production preflight.
--
-- The RPC reuses the existing payable, payment and V1 financial event. It
-- creates one manual-review journal draft and never creates an outbox, a V2
-- event, another payable or another supplier payment.

create unique index if not exists journal_entries_edgar_payment_repair_key_uidx
  on public.journal_entries ((metadata->>'repair_idempotency_key'))
  where metadata->>'repair_contract'
    = 'edgar_opening_balance_supplier_payment_2500_v1'
    and metadata ? 'repair_idempotency_key';

create unique index if not exists accounting_event_log_edgar_payment_repair_key_uidx
  on public.accounting_event_log ((metadata->>'repair_idempotency_key'))
  where event_type = 'accounting.directed_repair_edgar_supplier_payment_2500'
    and metadata ? 'repair_idempotency_key';

create or replace function public.repair_edgar_opening_balance_supplier_payment_v1(
  target_payment_id uuid,
  target_event_id uuid,
  opening_journal_id uuid,
  repair_actor_id uuid,
  requested_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  expected_supplier_id constant uuid :=
    '97226fc4-4e67-48d1-8108-33a511e5f2e2'::uuid;
  expected_payable_id constant uuid :=
    'a2250e0c-7718-4203-92a1-178429a86018'::uuid;
  expected_payment_id constant uuid :=
    '3b88e1ac-74ae-460e-a399-3d1e0c0189e1'::uuid;
  expected_event_id constant uuid :=
    '1c85a425-8f28-4115-8ea3-d8217e8af897'::uuid;
  expected_original_actor_id constant uuid :=
    'a164cfce-d103-4bfb-a7cf-969b5eb195f3'::uuid;
  expected_opening_entry_id constant uuid :=
    '5843045f-db47-429c-ad19-f75dc61cdd3e'::uuid;
  expected_opening_line_id constant uuid :=
    'f7389203-9ac0-40b8-9822-edfceb0e38fb'::uuid;
  expected_control_account_id constant uuid :=
    '05847d56-7097-492b-b153-2db33a00b9cd'::uuid;
  expected_bank_account_id constant uuid :=
    'f5d451ec-4985-4c07-97a1-6d8e0a0fadf6'::uuid;
  expected_payable_mapping_id constant uuid :=
    '529ab9bd-5b03-424d-9e63-9551d29d68f9'::uuid;
  expected_bank_mapping_id constant uuid :=
    'ae4ccc50-4ad4-40ba-b92e-d2549c51bf0b'::uuid;

  expected_cromos_supplier_id constant uuid :=
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f'::uuid;
  expected_cromos_payable_id constant uuid :=
    '5421d871-4ab4-49f6-a778-99bdbe0f609e'::uuid;
  expected_cromos_payment_id constant uuid :=
    'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804'::uuid;
  expected_cromos_event_id constant uuid :=
    '6dd1e200-f628-450e-8bfc-f8a6c700b442'::uuid;
  expected_cromos_journal_id constant uuid :=
    '4f76ec5b-7371-4765-be42-674f80d4db6b'::uuid;

  expected_opening_number constant text := 'PC-20260714-621782';
  expected_cromos_number constant text := 'PC-20260728-E70E1AA7';
  expected_opening_date constant date := date '2026-07-11';
  expected_entry_date constant date := date '2026-07-13';
  expected_cutover constant timestamptz :=
    '2026-07-28 20:30:00+00'::timestamptz;
  expected_paid_at constant timestamptz :=
    '2026-07-13 06:00:00+00'::timestamptz;
  expected_payment_created_at constant timestamptz :=
    '2026-07-28 21:47:52.583406+00'::timestamptz;
  expected_payable_created_at constant timestamptz :=
    '2026-07-14 15:27:07.733378+00'::timestamptz;
  expected_opening_count constant integer := 26;
  expected_supplier_count constant integer := 8;
  expected_opening_total constant numeric(14, 2) := 1589972.61;
  expected_payable_total constant numeric(14, 2) := 656938.41;
  expected_payment_amount constant numeric(14, 2) := 2500.00;
  expected_remaining_balance constant numeric(14, 2) := 654438.41;
  expected_opening_hash constant text :=
    '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd';
  expected_idempotency_key constant text :=
    'opening_balance_supplier_payment_repair:'
    || '3b88e1ac-74ae-460e-a399-3d1e0c0189e1:'
    || '1c85a425-8f28-4115-8ea3-d8217e8af897:v1';
  repair_contract_value constant text :=
    'edgar_opening_balance_supplier_payment_2500_v1';
  repair_version_value constant text := 'opening-balance-exact-v1';
  repair_event_type_value constant text :=
    'accounting.directed_repair_edgar_supplier_payment_2500';
  evidence_type_value constant text :=
    'opening_balance_control_account_reconciliation';

  supplier public.suppliers%rowtype;
  payable public.accounts_payable%rowtype;
  payment public.supplier_payments%rowtype;
  event public.financial_events%rowtype;
  opening_entry public.journal_entries%rowtype;
  opening_line public.journal_entry_lines%rowtype;
  existing_entry public.journal_entries%rowtype;
  control_account public.accounting_accounts%rowtype;
  bank_account public.accounting_accounts%rowtype;
  payable_mapping public.accounting_mappings%rowtype;
  bank_mapping public.accounting_mappings%rowtype;
  cromos_payable public.accounts_payable%rowtype;
  cromos_payment public.supplier_payments%rowtype;
  cromos_event public.financial_events%rowtype;
  cromos_entry public.journal_entries%rowtype;

  actor_role text;
  original_actor_role text;
  opening_count integer;
  opening_supplier_count integer;
  opening_total numeric(14, 2);
  opening_hash text;
  control_line_count integer;
  target_supplier_count integer;
  target_payable_count integer;
  target_payment_count integer;
  target_event_count integer;
  target_audit_count integer;
  target_outbox_count integer;
  conflicting_entry_count integer;
  conflicting_log_count integer;
  existing_log_count integer;
  cromos_line_count integer;
  reference_length integer;
  reference_hash text;
  validation_errors_hash text;
  normalized_lines jsonb;
  evidence_metadata jsonb;
  entry_id uuid;
  entry_number_value text;
  repair_timestamp timestamptz := clock_timestamp();
  previous_event_status text;
  payable_snapshot jsonb;
  payment_snapshot jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'La reparacion dirigida solo puede ejecutarse desde el servidor.';
  end if;

  if target_payment_id <> expected_payment_id
    or target_event_id <> expected_event_id
    or opening_journal_id <> expected_opening_entry_id
  then
    raise exception using
      errcode = '22023',
      message = 'Los identificadores no pertenecen al contrato dirigido de Edgar.';
  end if;

  if requested_idempotency_key is distinct from expected_idempotency_key then
    raise exception using
      errcode = '23505',
      message = 'La clave de idempotencia no coincide con el contrato aprobado.';
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

  perform pg_advisory_xact_lock(
    hashtextextended(expected_idempotency_key, 0)
  );

  -- Keep the evidence snapshot and the write atomic. The locks are intentionally
  -- scoped to the accounting/AP tables used by this one-case contract.
  lock table
    public.suppliers,
    public.accounts_payable,
    public.supplier_payments,
    public.audit_logs,
    public.financial_events,
    public.accounting_outbox_v2,
    public.accounting_feature_flags,
    public.accounting_accounts,
    public.accounting_mappings,
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
    or opening_entry.id <> opening_journal_id
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
      and status = 'publicada'
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
        convert_to(
          string_agg(candidate.id::text, ',' order by candidate.id),
          'UTF8'
        ),
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
  if opening_hash <> expected_opening_hash then
    raise exception using
      errcode = '22023',
      message = 'El hash del auxiliar inicial no coincide.';
  end if;
  if round(opening_line.credit - opening_line.debit - opening_total, 2) <> 0.00
  then
    raise exception using
      errcode = '22023',
      message = 'La conciliacion entre la cuenta control y el auxiliar tiene diferencia.';
  end if;

  -- CROMOS is read-only reference evidence and must remain exactly repaired.
  if (
    select count(*)
    from public.suppliers candidate
    where candidate.id = expected_cromos_supplier_id
      and candidate.is_active
      and regexp_replace(
        upper(btrim(candidate.name)), '[[:space:]]+', ' ', 'g'
      ) = 'CROMOS TORRE FUERTE'
  ) <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La evidencia protegida de CROMOS cambio.';
  end if;

  select * into cromos_payable
  from public.accounts_payable
  where id = expected_cromos_payable_id
  for share;

  select * into cromos_payment
  from public.supplier_payments
  where id = expected_cromos_payment_id
  for share;

  select * into cromos_event
  from public.financial_events
  where id = expected_cromos_event_id
  for share;

  select * into cromos_entry
  from public.journal_entries
  where id = expected_cromos_journal_id
  for share;

  if cromos_payable.id is null
    or cromos_payable.supplier_id <> expected_cromos_supplier_id
    or round(cromos_payable.total_amount, 2) <> 73200.00
    or round(cromos_payable.paid_amount, 2) <> 9800.00
    or round(cromos_payable.balance, 2) <> 63400.00
    or cromos_payable.status <> 'partial'
    or cromos_payment.id is null
    or cromos_payment.accounts_payable_id <> expected_cromos_payable_id
    or cromos_payment.supplier_id <> expected_cromos_supplier_id
    or round(cromos_payment.amount, 2) <> 9800.00
    or cromos_payment.status <> 'paid'
    or cromos_payment.voided_at is not null
    or cromos_payment.paid_at <> '2026-07-13 00:00:00+00'::timestamptz
    or cromos_event.id is null
    or cromos_event.source_type <> 'supplier_payment'
    or cromos_event.source_id <> expected_cromos_payment_id::text
    or cromos_event.event_purpose <> 'supplier_payment'
    or cromos_event.posting_version <> 'v1'
    or cromos_event.status <> 'posted'
    or cromos_event.journal_entry_id <> expected_cromos_journal_id
    or cromos_entry.id is null
    or cromos_entry.entry_number <> expected_cromos_number
    or cromos_entry.entry_date <> date '2026-07-12'
    or cromos_entry.status <> 'publicada'
    or cromos_entry.source_type <> 'financial_event'
    or cromos_entry.source_id <> expected_cromos_event_id::text
    or cromos_entry.posted_at is null
    or cromos_entry.posted_by is null
  then
    raise exception using
      errcode = '22023',
      message = 'La evidencia protegida de CROMOS cambio.';
  end if;

  select count(*) into cromos_line_count
  from public.journal_entry_lines line
  where line.journal_entry_id = expected_cromos_journal_id;

  if cromos_line_count <> 2
    or not exists (
      select 1
      from public.journal_entry_lines line
      where line.journal_entry_id = expected_cromos_journal_id
        and line.account_id = expected_control_account_id
        and line.vendor_id = expected_cromos_supplier_id
        and round(line.debit, 2) = 9800.00
        and round(line.credit, 2) = 0.00
    )
    or not exists (
      select 1
      from public.journal_entry_lines line
      where line.journal_entry_id = expected_cromos_journal_id
        and line.account_id = 'a84f16c1-42da-4ed5-bca8-d3b20c5c3733'::uuid
        and line.vendor_id = expected_cromos_supplier_id
        and round(line.debit, 2) = 0.00
        and round(line.credit, 2) = 9800.00
    )
    or (
      select count(*)
      from public.accounting_event_log log
      where log.event_type = 'accounting.directed_repair_supplier_payment_9800'
        and log.source_type = 'supplier_payment'
        and log.source_id = expected_cromos_payment_id::text
        and log.entity_id = expected_cromos_journal_id
    ) <> 1
  then
    raise exception using
      errcode = '22023',
      message = 'Las lineas o la auditoria protegida de CROMOS cambiaron.';
  end if;

  select count(*) into target_supplier_count
  from public.suppliers candidate
  where regexp_replace(
    upper(btrim(candidate.name)), '[[:space:]]+', ' ', 'g'
  ) = 'EDGAR JOEL LEIVA PAZ';

  if target_supplier_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'EDGAR JOEL LEIVA PAZ no es un proveedor inequivoco.';
  end if;

  select *
  into supplier
  from public.suppliers
  where id = expected_supplier_id
  for share;

  if not found
    or not supplier.is_active
    or regexp_replace(
      upper(btrim(supplier.name)), '[[:space:]]+', ' ', 'g'
    ) <> 'EDGAR JOEL LEIVA PAZ'
  then
    raise exception using
      errcode = '22023',
      message = 'El proveedor dirigido de Edgar cambio.';
  end if;

  select count(*) into target_payable_count
  from public.accounts_payable candidate
  where candidate.supplier_id = expected_supplier_id
    and round(candidate.total_amount, 2) = expected_payable_total;

  if target_payable_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La obligacion dirigida de Edgar no es unica.';
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
    or round(payable.balance, 2) <> expected_remaining_balance
    or payable.status <> 'partial'
    or upper(btrim(payable.currency)) <> 'HNL'
    or payable.purchase_id is not null
    or payable.supplier_invoice_id is not null
    or payable.imported_from_batch_id is not null
    or payable.imported_from_row_id is not null
    or payable.created_at <> expected_payable_created_at
    or payable.created_at >= opening_entry.created_at
  then
    raise exception using
      errcode = '22023',
      message = 'La obligacion dirigida de Edgar cambio o no pertenece al auxiliar.';
  end if;

  select count(*) into target_payment_count
  from public.supplier_payments candidate
  where candidate.supplier_id = expected_supplier_id
    and candidate.accounts_payable_id = expected_payable_id
    and round(candidate.amount, 2) = expected_payment_amount;

  if target_payment_count <> 1
    or (
      select count(*)
      from public.supplier_payments candidate
      where candidate.supplier_id = expected_supplier_id
        and round(candidate.amount, 2) = expected_payment_amount
        and candidate.paid_at = expected_paid_at
        and candidate.status = 'paid'
    ) <> 1
  then
    raise exception using
      errcode = '22023',
      message = 'El pago historico de Edgar no es unico.';
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
    or lower(btrim(payment.payment_method)) <> 'bank_transfer'
    or payment.payment_method_v2 <> 'bank_transfer'
    or payment.paid_at <> expected_paid_at
    or payment.created_at <> expected_payment_created_at
    or payment.created_by <> expected_original_actor_id
    or payment.idempotency_key is null
    or payment.request_fingerprint is null
    or char_length(payment.request_fingerprint) <> 32
    or payment.notes is null
    or char_length(btrim(payment.notes)) <> 9
    or btrim(payment.notes) !~ '^[0-9]{9}$'
  then
    raise exception using
      errcode = '22023',
      message = 'El pago historico dirigido de Edgar cambio.';
  end if;

  select role.name
  into original_actor_role
  from public.users actor
  join public.roles role on role.id = actor.role_id
  where actor.id = expected_original_actor_id
    and actor.active = true;

  if original_actor_role <> 'contadora' then
    raise exception using
      errcode = '22023',
      message = 'El actor original del pago de Edgar cambio.';
  end if;

  select count(*) into target_audit_count
  from public.audit_logs log
  where log.table_name = 'supplier_payments'
    and log.record_id = expected_payment_id
    and log.action = 'supplier_payments.pay_v2'
    and log.user_id = expected_original_actor_id
    and log.new_data->>'effective_date' = '2026-07-13'
    and (log.new_data->>'amount')::numeric = expected_payment_amount
    and log.new_data->>'payment_method' = 'bank_transfer'
    and log.new_data->'outbox_id' = 'null'::jsonb;

  if target_audit_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'La auditoria original del pago de Edgar cambio.';
  end if;

  select count(*) into target_event_count
  from public.financial_events candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = expected_payment_id::text;

  if target_event_count <> 1 then
    raise exception using
      errcode = '22023',
      message = 'El evento financiero del pago de Edgar no es unico.';
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
    or event.occurred_at <> expected_paid_at
    or event.status not in ('pending', 'draft_created')
  then
    raise exception using
      errcode = '22023',
      message = 'El evento financiero dirigido de Edgar cambio.';
  end if;

  select count(*) into target_outbox_count
  from public.accounting_outbox_v2 box
  where box.source_type = 'supplier_payment'
    and box.source_id = expected_payment_id;

  if target_outbox_count <> 0 then
    raise exception using
      errcode = '23505',
      message = 'Aparecio una outbox V2 para el pago historico de Edgar.';
  end if;

  select *
  into payable_mapping
  from public.accounting_mappings
  where id = expected_payable_mapping_id
  for share;

  select *
  into bank_mapping
  from public.accounting_mappings
  where id = expected_bank_mapping_id
  for share;

  select *
  into bank_account
  from public.accounting_accounts
  where id = expected_bank_account_id
  for share;

  if payable_mapping.id is null
    or payable_mapping.mapping_type <> 'default_account'
    or payable_mapping.source_key <> 'accounts_payable'
    or payable_mapping.account_id <> expected_control_account_id
    or not payable_mapping.is_active
    or bank_mapping.id is null
    or bank_mapping.mapping_type <> 'payment_method'
    or bank_mapping.source_key <> 'supplier_payment_bank'
    or bank_mapping.account_id <> expected_bank_account_id
    or not bank_mapping.is_active
    or bank_account.id is null
    or bank_account.code <> '1101005'
    or bank_account.name <> 'BAC CHEQUES LPS'
    or bank_account.type <> 'asset'
    or bank_account.normal_balance <> 'debit'
    or not bank_account.is_active
    or public.resolve_accounting_mapping_v2(
      'default_account', 'accounts_payable', expected_entry_date
    ) <> expected_control_account_id
    or public.resolve_accounting_mapping_v2(
      'payment_method', 'supplier_payment_bank', expected_entry_date
    ) <> expected_bank_account_id
  then
    raise exception using
      errcode = '22023',
      message = 'Las cuentas o mappings dirigidos de Edgar no coinciden.';
  end if;

  if public.is_date_in_closed_accounting_period(expected_entry_date) then
    raise exception using
      errcode = '22023',
      message = 'El periodo contable de la reparacion de Edgar esta cerrado.';
  end if;

  -- The expected flags/cutover remain read-only evidence of the exclusion.
  if (
    select count(*)
    from public.accounting_feature_flags flag
    where flag.key = 'supplier_payment_draft_v2'
      and flag.state = 'enabled'
      and flag.version = 'v2'
      and flag.cutover_at = expected_cutover
  ) <> 1 then
    raise exception using
      errcode = '22023',
      message = 'El cutover contable V2 cambio.';
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
        <> repair_contract_value
      or existing_entry.metadata->>'repair_idempotency_key'
        <> expected_idempotency_key
      or existing_entry.metadata->>'evidence_type' <> evidence_type_value
      or existing_entry.metadata->>'payment_id' <> payment.id::text
      or existing_entry.metadata->>'payable_id' <> payable.id::text
      or existing_entry.metadata->>'supplier_id' <> supplier.id::text
      or existing_entry.metadata->>'financial_event_id' <> event.id::text
      or coalesce(
        (existing_entry.metadata->>'manual_publication_required')::boolean,
        false
      ) is not true
    then
      raise exception using
        errcode = '23505',
        message = 'El evento de Edgar esta vinculado a una partida incompatible.';
    end if;

    if event.status <> 'draft_created' then
      raise exception using
        errcode = '23505',
        message = 'El estado idempotente del evento de Edgar es incompatible.';
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
          and line.vendor_id = expected_supplier_id
          and round(line.debit, 2) = expected_payment_amount
          and round(line.credit, 2) = 0.00
      )
      or not exists (
        select 1
        from public.journal_entry_lines line
        where line.journal_entry_id = existing_entry.id
          and line.account_id = expected_bank_account_id
          and line.vendor_id = expected_supplier_id
          and round(line.debit, 2) = 0.00
          and round(line.credit, 2) = expected_payment_amount
      )
    then
      raise exception using
        errcode = '23505',
        message = 'La partida idempotente de Edgar tiene lineas incompatibles.';
    end if;

    select count(*) into existing_log_count
    from public.accounting_event_log log
    where log.event_type = repair_event_type_value
      and log.metadata->>'repair_idempotency_key' = expected_idempotency_key
      and log.entity_id = existing_entry.id;

    if existing_log_count <> 1 then
      raise exception using
        errcode = '23505',
        message = 'La evidencia idempotente de Edgar es incompatible.';
    end if;

    return jsonb_build_object(
      'ok', true,
      'status', 'already_repaired',
      'event_id', event.id,
      'journal_entry_id', existing_entry.id,
      'journal_entry_number', existing_entry.entry_number,
      'journal_status', existing_entry.status,
      'entry_date', existing_entry.entry_date,
      'idempotency_key', expected_idempotency_key,
      'idempotent_replay', true
    );
  end if;

  if event.status <> 'pending' then
    raise exception using
      errcode = '23505',
      message = 'El evento de Edgar sin partida no esta pendiente.';
  end if;

  select count(*) into conflicting_entry_count
  from public.journal_entries entry
  where (
      entry.source_type = 'financial_event'
      and entry.source_id = event.id::text
    )
    or (
      entry.source_type = 'supplier_payment'
      and entry.source_id = payment.id::text
    )
    or entry.metadata->>'repair_idempotency_key' = expected_idempotency_key
    or entry.metadata->>'payment_id' = payment.id::text
    or entry.metadata->>'financial_event_id' = event.id::text;

  if conflicting_entry_count <> 0 then
    raise exception using
      errcode = '23505',
      message = 'Ya existe una partida candidata o incompatible para Edgar.';
  end if;

  select count(*) into conflicting_log_count
  from public.accounting_event_log log
  where (
      log.event_type = repair_event_type_value
      or log.source_type = 'supplier_payment'
    )
    and (
      log.metadata->>'repair_idempotency_key' = expected_idempotency_key
      or log.metadata->>'payment_id' = payment.id::text
      or log.metadata->>'financial_event_id' = event.id::text
      or (
        log.source_type = 'supplier_payment'
        and log.source_id = payment.id::text
      )
    );

  if conflicting_log_count <> 0 then
    raise exception using
      errcode = '23505',
      message = 'Ya existe evidencia de otra reparacion para Edgar.';
  end if;

  reference_length := char_length(btrim(payment.notes));
  reference_hash := encode(
    extensions.digest(convert_to(btrim(payment.notes), 'UTF8'), 'sha256'),
    'hex'
  );
  validation_errors_hash := encode(
    extensions.digest(
      convert_to(event.validation_errors::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  payable_snapshot := jsonb_build_object(
    'id', payable.id,
    'supplier_id', payable.supplier_id,
    'total_amount', payable.total_amount,
    'paid_amount', payable.paid_amount,
    'balance', payable.balance,
    'status', payable.status,
    'currency', payable.currency,
    'due_date', payable.due_date,
    'purchase_id', payable.purchase_id,
    'supplier_invoice_id', payable.supplier_invoice_id,
    'imported_from_batch_id', payable.imported_from_batch_id,
    'imported_from_row_id', payable.imported_from_row_id
  );
  payment_snapshot := jsonb_build_object(
    'id', payment.id,
    'accounts_payable_id', payment.accounts_payable_id,
    'supplier_id', payment.supplier_id,
    'amount', payment.amount,
    'payment_method', payment.payment_method,
    'payment_method_v2', payment.payment_method_v2,
    'status', payment.status,
    'paid_at', payment.paid_at,
    'created_at', payment.created_at,
    'idempotency_key', payment.idempotency_key,
    'request_fingerprint', payment.request_fingerprint,
    'voided_at', payment.voided_at
  );

  evidence_metadata := jsonb_build_object(
    'entry_kind', 'directed_repair',
    'currency', 'HNL',
    'repair_contract', repair_contract_value,
    'repair_version', repair_version_value,
    'repair_idempotency_key', expected_idempotency_key,
    'evidence_type', evidence_type_value,
    'repair_scope', 'edgar_historical_opening_balance_payment_only',
    'repair_reason', 'pre_cutover_paid_at_excluded_from_v2_outbox',
    'v2_outbox_created', false,
    'v2_event_created', false,
    'payment_recreated', false,
    'payable_recreated', false,
    'payable_balance_preserved', true,
    'manual_publication_required', true,
    'opening_balance_journal_entry_id', opening_entry.id,
    'opening_balance_journal_entry_number', opening_entry.entry_number,
    'opening_balance_line_id', opening_line.id,
    'opening_auxiliary_count', opening_count,
    'opening_auxiliary_supplier_count', opening_supplier_count,
    'opening_auxiliary_total', opening_total,
    'opening_balance_control_total',
      round(opening_line.credit - opening_line.debit, 2),
    'reconciliation_difference',
      round(opening_line.credit - opening_line.debit - opening_total, 2),
    'opening_auxiliary_hash', opening_hash,
    'supplier_id', supplier.id,
    'payable_id', payable.id,
    'payment_id', payment.id,
    'financial_event_id', event.id,
    'posting_version', event.posting_version,
    'original_payable_amount', expected_payable_total,
    'balance_before_payment', expected_payable_total,
    'payment_amount', expected_payment_amount,
    'remaining_balance', expected_remaining_balance,
    'payment_method', 'bank_transfer',
    'debit_account_id', control_account.id,
    'debit_account_code', control_account.code,
    'credit_account_id', bank_account.id,
    'credit_account_code', bank_account.code,
    'payable_mapping_id', payable_mapping.id,
    'bank_mapping_id', bank_mapping.id,
    'paid_at_original', payment.paid_at,
    'entry_date', expected_entry_date,
    'cutover_at', expected_cutover,
    'payment_reference_evidence', jsonb_build_object(
      'present', true,
      'length', reference_length,
      'sha256', reference_hash,
      'raw_value_stored', false
    ),
    'validation_errors_preserved', true,
    'validation_errors_sha256', validation_errors_hash,
    'original_actor_id', payment.created_by,
    'repaired_by', repair_actor_id,
    'repaired_at', repair_timestamp
  );

  normalized_lines := public.normalize_journal_draft_lines(
    jsonb_build_array(
      jsonb_build_object(
        'account_id', expected_control_account_id,
        'debit', expected_payment_amount,
        'credit', 0,
        'description',
          'Pago historico CxP Edgar Joel Leiva Paz (pago 3b88e1ac / CxP a2250e0c)',
        'vendor_id', expected_supplier_id
      ),
      jsonb_build_object(
        'account_id', expected_bank_account_id,
        'debit', 0,
        'credit', expected_payment_amount,
        'description',
          'Transferencia historica Edgar Joel Leiva Paz (pago 3b88e1ac)',
        'vendor_id', expected_supplier_id
      )
    )
  );

  if round((normalized_lines->>'total_debit')::numeric, 2)
      <> expected_payment_amount
    or round((normalized_lines->>'total_credit')::numeric, 2)
      <> expected_payment_amount
    or round(
      (normalized_lines->>'total_debit')::numeric
      - (normalized_lines->>'total_credit')::numeric,
      2
    ) <> 0.00
  then
    raise exception using
      errcode = '22023',
      message = 'El borrador dirigido de Edgar no esta balanceado.';
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
    'Pago historico de cuenta por pagar - Edgar Joel Leiva Paz',
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
      updated_at = now()
  where id = event.id;

  -- Preserve the original validation_errors verbatim.
  if (
    select validation_errors
    from public.financial_events
    where id = event.id
  ) is distinct from event.validation_errors then
    raise exception using
      errcode = '22023',
      message = 'La reparacion no preservo la validacion historica del evento.';
  end if;

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
    repair_event_type_value,
    'journal_entries',
    entry_id,
    'supplier_payment',
    payment.id::text,
    evidence_metadata || jsonb_build_object(
      'journal_entry_id', entry_id,
      'journal_entry_number', entry_number_value,
      'journal_status', 'borrador',
      'previous_event_status', previous_event_status,
      'new_event_status', 'draft_created'
    ),
    repair_actor_id
  );

  -- Fail the transaction if any forbidden business-state mutation occurred.
  if (
    select jsonb_build_object(
      'id', current_payable.id,
      'supplier_id', current_payable.supplier_id,
      'total_amount', current_payable.total_amount,
      'paid_amount', current_payable.paid_amount,
      'balance', current_payable.balance,
      'status', current_payable.status,
      'currency', current_payable.currency,
      'due_date', current_payable.due_date,
      'purchase_id', current_payable.purchase_id,
      'supplier_invoice_id', current_payable.supplier_invoice_id,
      'imported_from_batch_id', current_payable.imported_from_batch_id,
      'imported_from_row_id', current_payable.imported_from_row_id
    )
    from public.accounts_payable current_payable
    where current_payable.id = expected_payable_id
  ) is distinct from payable_snapshot
    or (
      select jsonb_build_object(
        'id', current_payment.id,
        'accounts_payable_id', current_payment.accounts_payable_id,
        'supplier_id', current_payment.supplier_id,
        'amount', current_payment.amount,
        'payment_method', current_payment.payment_method,
        'payment_method_v2', current_payment.payment_method_v2,
        'status', current_payment.status,
        'paid_at', current_payment.paid_at,
        'created_at', current_payment.created_at,
        'idempotency_key', current_payment.idempotency_key,
        'request_fingerprint', current_payment.request_fingerprint,
        'voided_at', current_payment.voided_at
      )
      from public.supplier_payments current_payment
      where current_payment.id = expected_payment_id
    ) is distinct from payment_snapshot
    or (
      select count(*)
      from public.accounting_outbox_v2 box
      where box.source_type = 'supplier_payment'
        and box.source_id = expected_payment_id
    ) <> 0
    or (
      select count(*)
      from public.financial_events current_event
      where current_event.source_type = 'supplier_payment'
        and current_event.source_id = expected_payment_id::text
    ) <> 1
    or (
      select count(*)
      from public.journal_entries entry
      where entry.source_type = 'financial_event'
        and entry.source_id = expected_event_id::text
    ) <> 1
    or (
      select count(*)
      from public.journal_entry_lines line
      where line.journal_entry_id = entry_id
    ) <> 2
    or (
      select coalesce(sum(line.debit), 0)
      from public.journal_entry_lines line
      where line.journal_entry_id = entry_id
    ) <> expected_payment_amount
    or (
      select coalesce(sum(line.credit), 0)
      from public.journal_entry_lines line
      where line.journal_entry_id = entry_id
    ) <> expected_payment_amount
  then
    raise exception using
      errcode = '22023',
      message = 'La reparacion de Edgar produjo un efecto no autorizado.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'repaired',
    'event_id', event.id,
    'journal_entry_id', entry_id,
    'journal_entry_number', entry_number_value,
    'journal_status', 'borrador',
    'entry_date', expected_entry_date,
    'total_debit', expected_payment_amount,
    'total_credit', expected_payment_amount,
    'difference', 0.00,
    'idempotency_key', expected_idempotency_key,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.repair_edgar_opening_balance_supplier_payment_v1(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.repair_edgar_opening_balance_supplier_payment_v1(
  uuid, uuid, uuid, uuid, text
) to service_role;

comment on function public.repair_edgar_opening_balance_supplier_payment_v1(
  uuid, uuid, uuid, uuid, text
) is
  'One-case exact and idempotent repair for the approved EDGAR JOEL LEIVA PAZ opening-balance payment. Reuses the existing V1 event, creates one manual-review draft, preserves AP/payment state and never posts or enqueues V2.';
