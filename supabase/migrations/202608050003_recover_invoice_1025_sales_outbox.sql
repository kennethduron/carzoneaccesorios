-- Exact, forward-only recovery contract for invoice 000-001-01-00001025.
-- This migration installs the guarded RPC only. It does not requeue or process.

begin;

create table if not exists public.accounting_outbox_recovery_audit (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.accounting_outbox_v2(id) on delete restrict,
  action text not null check (action = 'ACCOUNTING_OUTBOX_EXACT_RECOVERY'),
  reason text not null check (reason = 'AUTHORIZED_SALE_COD_FEE_MAPPING_RECOVERY'),
  previous_status text not null,
  next_status text not null check (next_status = 'queued'),
  previous_attempt_count integer not null,
  mapping_key text not null check (mapping_key = 'revenue:sale_cod_fee'),
  account_code text not null check (account_code = '4101002'),
  before_hash text not null check (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash text not null check (after_hash ~ '^[0-9a-f]{64}$'),
  before_state jsonb not null,
  after_state jsonb not null,
  executed_by name not null default current_user,
  executed_at timestamptz not null default clock_timestamp(),
  unique (outbox_id, action)
);

alter table public.accounting_outbox_recovery_audit enable row level security;
revoke all on public.accounting_outbox_recovery_audit from public, anon, authenticated, service_role;
grant select on public.accounting_outbox_recovery_audit to service_role;

create or replace function public.guard_accounting_outbox_recovery_audit_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception 'ACCOUNTING_OUTBOX_RECOVERY_AUDIT_IMMUTABLE' using errcode = '55000';
end;
$function$;

revoke all on function public.guard_accounting_outbox_recovery_audit_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists accounting_outbox_recovery_audit_append_only
  on public.accounting_outbox_recovery_audit;
create trigger accounting_outbox_recovery_audit_append_only
before update or delete on public.accounting_outbox_recovery_audit
for each row execute function public.guard_accounting_outbox_recovery_audit_v1();

create or replace function public.recover_invoice_1025_sales_outbox_v1()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  target_invoice constant uuid := '959b50af-a759-438e-b614-6837a1053fa7'::uuid;
  target_order constant uuid := '44db4982-e382-4661-b858-e49256d17f56'::uuid;
  target_payment constant uuid := 'b546b045-75eb-4ba7-a66c-b88bd0be55d0'::uuid;
  target_event constant uuid := '2bcd9b7b-b343-44b6-a450-709cfdaab58a'::uuid;
  target_outbox constant uuid := '04fde1d0-b14e-4206-869f-e10203246429'::uuid;
  cogs_event constant uuid := '087f323f-fe9b-44d3-97ce-6c07a36690f9'::uuid;
  cogs_outbox constant uuid := '7ef7d0ef-059c-4113-803c-8404d8cefcfd'::uuid;
  cogs_journal constant uuid := '939ad70f-d748-4724-a0df-cbefae7feb40'::uuid;
  sale_v1 constant uuid := '26c413f2-68df-4a16-818a-155f98394d2f'::uuid;
  cogs_v1 constant uuid := '48398a6a-ed3f-4a89-8786-021beaf1549f'::uuid;
  control_v1 constant uuid := '1c4dbd00-f36b-4d9c-87fb-f20d3ca2be6b'::uuid;
  box public.accounting_outbox_v2%rowtype;
  expected_account_id uuid;
  before_state jsonb;
  after_state jsonb;
  before_hash text;
  after_hash text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('carzone:accounting:invoice-1025:sale-outbox-recovery', 0));

  select * into box from public.accounting_outbox_v2
  where id = target_outbox for update;
  if box.id is null then
    raise exception 'INVOICE_1025_SALE_OUTBOX_NOT_FOUND' using errcode = 'P0002';
  end if;
  if box.status = 'completed' and box.journal_entry_id is not null then
    return jsonb_build_object(
      'ok', true, 'replayed', true, 'outbox_id', box.id,
      'status', box.status, 'journal_entry_id', box.journal_entry_id
    );
  end if;

  select public.resolve_accounting_mapping_v2(
    'revenue', 'sale_cod_fee', date '2026-07-16'
  ) into expected_account_id;
  if expected_account_id is null or not exists (
    select 1 from public.accounting_accounts
    where id = expected_account_id and code = '4101002'
      and name = 'VENTAS POR CONTRAENTREGA'
      and type = 'revenue' and normal_balance = 'credit' and is_active
  ) then
    raise exception 'INVOICE_1025_SALE_COD_FEE_MAPPING_INVALID' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.invoices
    where id = target_invoice and order_id = target_order
      and invoice_number = '000-001-01-00001025'
      and invoice_date = date '2026-07-16' and status = 'emitida'
      and subtotal = 2608.70 and tax = 391.30
      and cash_on_delivery_fee = 2.00 and total = 3002.00
  ) or not exists (
    select 1 from public.orders
    where id = target_order and status = 'entregado'
      and payment_method::text = 'cash'
      and cash_on_delivery_fee = 2.00 and total = 3002.00
  ) or not exists (
    select 1 from public.payments
    where id = target_payment and order_id = target_order
      and payment_method::text = 'cash'
      and payment_status::text = 'approved' and amount = 3002.00
  ) then
    raise exception 'INVOICE_1025_COMMERCIAL_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  if public.is_date_in_closed_accounting_period(date '2026-07-16') then
    raise exception 'INVOICE_1025_ACCOUNTING_PERIOD_CLOSED' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.financial_events
    where id = target_event and posting_version = 'v2'
      and source_type = 'order' and source_id = target_order::text
      and event_purpose = 'sale_recognized'
      and accounting_date = date '2026-07-16'
      and status = 'pending' and journal_entry_id is null
  ) or box.feature_key <> 'sales_draft_v2'
    or box.posting_version <> 'v2'
    or box.source_type <> 'order'
    or box.source_id <> target_order
    or box.event_purpose <> 'sale_recognized'
    or box.financial_event_id <> target_event
    or box.accounting_date <> date '2026-07-16'
    or box.status <> 'pending_mapping'
    or box.attempt_count <> 8
    or box.last_error_code <> 'mapping_missing'
    or box.missing_key <> 'revenue:sale_cod_fee'
    or box.journal_entry_id is not null
  then
    raise exception 'INVOICE_1025_SALE_OUTBOX_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.journal_entries entry
    where entry.source_type = 'financial_event'
      and entry.source_id in (target_event::text, sale_v1::text)
  ) then
    raise exception 'INVOICE_1025_SALE_JOURNAL_ALREADY_EXISTS' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.financial_events
    where id = cogs_event and status = 'posted'
      and accounting_date = date '2026-07-16'
      and journal_entry_id = cogs_journal
  ) or not exists (
    select 1 from public.accounting_outbox_v2
    where id = cogs_outbox and financial_event_id = cogs_event
      and status = 'completed' and journal_entry_id = cogs_journal
  ) or not exists (
    select 1 from public.journal_entries entry
    where entry.id = cogs_journal and entry.status = 'publicada'
      and entry.entry_date = date '2026-07-16'
      and (select coalesce(sum(line.debit), 0) from public.journal_entry_lines line where line.journal_entry_id = entry.id) = 1725.00
      and (select coalesce(sum(line.credit), 0) from public.journal_entry_lines line where line.journal_entry_id = entry.id) = 1725.00
  ) then
    raise exception 'INVOICE_1025_COGS_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.financial_events
    where id = sale_v1 and status = 'skipped' and journal_entry_id is null
      and validation_errors @> '["SUPERSEDED_BY_CANONICAL_V2_EVENT"]'::jsonb
  ) or not exists (
    select 1 from public.financial_events
    where id = cogs_v1 and status = 'skipped' and journal_entry_id is null
      and validation_errors @> '["SUPERSEDED_BY_CANONICAL_V2_EVENT"]'::jsonb
  ) or not exists (
    select 1 from public.financial_events
    where id = control_v1 and status = 'skipped' and journal_entry_id is null
  ) then
    raise exception 'INVOICE_1025_V1_NEUTRALIZATION_PRECONDITION_FAILED' using errcode = '23514';
  end if;

  before_state := to_jsonb(box);
  before_hash := encode(extensions.digest(convert_to(before_state::text, 'UTF8'), 'sha256'), 'hex');

  update public.accounting_outbox_v2
  set status = 'queued',
      next_attempt_at = now(),
      lease_until = null,
      locked_by = null,
      last_error_code = null,
      last_error_message = null,
      missing_key = null
  where id = target_outbox
  returning * into box;

  after_state := to_jsonb(box);
  after_hash := encode(extensions.digest(convert_to(after_state::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.accounting_outbox_recovery_audit (
    outbox_id, action, reason, previous_status, next_status,
    previous_attempt_count, mapping_key, account_code,
    before_hash, after_hash, before_state, after_state
  ) values (
    target_outbox, 'ACCOUNTING_OUTBOX_EXACT_RECOVERY',
    'AUTHORIZED_SALE_COD_FEE_MAPPING_RECOVERY',
    'pending_mapping', 'queued', 8,
    'revenue:sale_cod_fee', '4101002',
    before_hash, after_hash, before_state, after_state
  );

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id,
    metadata, created_by
  ) values (
    'accounting_v2.invoice_1025_recovery_queued',
    'accounting_outbox_v2', target_outbox,
    'order', target_order::text,
    jsonb_build_object(
      'financial_event_id', target_event,
      'mapping', 'revenue:sale_cod_fee',
      'account_code', '4101002',
      'manual_publication_required', true
    ),
    box.actor_id
  );

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'outbox_id', target_outbox, 'status', 'queued',
    'attempt_count', box.attempt_count,
    'mapping', 'revenue:sale_cod_fee', 'account_code', '4101002'
  );
end;
$function$;

revoke all on function public.recover_invoice_1025_sales_outbox_v1()
  from public, anon, authenticated;
grant execute on function public.recover_invoice_1025_sales_outbox_v1()
  to service_role;

comment on function public.recover_invoice_1025_sales_outbox_v1() is
  'Strictly requeues only invoice 1025 sale outbox after verifying the approved COD mapping, V1 neutralization, and intact published COGS.';

commit;
