-- Canonical accounting dates for future accounting facts.
-- This migration changes no historical journal entry or financial event.

alter table public.accounting_outbox_v2
  add column if not exists accounting_date date,
  add column if not exists accounting_date_source text;

alter table public.accounting_outbox_v2
  drop constraint if exists accounting_outbox_v2_accounting_date_source_check;
alter table public.accounting_outbox_v2
  add constraint accounting_outbox_v2_accounting_date_source_check check (
    accounting_date_source is null
    or char_length(accounting_date_source) between 3 and 80
  );

comment on column public.accounting_outbox_v2.accounting_date is
  'Explicit canonical accounting date. It is independent from occurred_at, created_at and processing timestamps.';
comment on column public.accounting_outbox_v2.accounting_date_source is
  'Canonical business field that supplied accounting_date.';

create or replace function public.resolve_canonical_accounting_date_v1(
  target_source_type text,
  target_source_id uuid,
  target_event_purpose text
)
returns date
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  resolved_date date;
begin
  if target_source_id is null then
    return null;
  end if;

  case
    when target_source_type = 'order'
      and target_event_purpose in ('sale_recognized', 'sale_revenue')
    then
      select coalesce(
        (
          select invoice.invoice_date
          from public.invoices invoice
          where invoice.order_id = target_source_id
            and invoice.status::text not in ('cancelled', 'cancelada')
          order by invoice.issued_at desc nulls last, invoice.created_at desc, invoice.id
          limit 1
        ),
        orders.requested_invoice_date
      )
      into resolved_date
      from public.orders orders
      where orders.id = target_source_id;

    when target_source_type = 'inventory_movement'
      and target_event_purpose = 'inventory_cogs'
    then
      select coalesce(
        (
          select invoice.invoice_date
          from public.invoices invoice
          where invoice.order_id = orders.id
            and invoice.status::text not in ('cancelled', 'cancelada')
          order by invoice.issued_at desc nulls last, invoice.created_at desc, invoice.id
          limit 1
        ),
        orders.requested_invoice_date
      )
      into resolved_date
      from public.inventory_movements movement
      join public.orders orders
        on orders.id = movement.reference_id
      where movement.id = target_source_id
        and movement.reference_type = 'orders';

    when target_source_type = 'supplier_payment'
      and target_event_purpose = 'supplier_payment'
    then
      select (payment.paid_at at time zone 'America/Tegucigalpa')::date
      into resolved_date
      from public.supplier_payments payment
      where payment.id = target_source_id;

    when target_source_type = 'receivable_payment'
      and target_event_purpose = 'receivable_payment'
    then
      select (payment.received_at at time zone 'America/Tegucigalpa')::date
      into resolved_date
      from public.accounts_receivable_payments payment
      where payment.id = target_source_id;

    when target_source_type = 'invoice'
      and target_event_purpose = 'invoice_issued'
    then
      select invoice.invoice_date
      into resolved_date
      from public.invoices invoice
      where invoice.id = target_source_id;

    when target_source_type = 'supplier_invoice'
      and target_event_purpose = 'supplier_invoice_received'
    then
      select invoice.invoice_date
      into resolved_date
      from public.supplier_invoices invoice
      where invoice.id = target_source_id;

    when target_source_type = 'purchase'
      and target_event_purpose = 'purchase_confirmed'
    then
      select coalesce(
        (
          select invoice.invoice_date
          from public.supplier_invoices invoice
          where invoice.purchase_id = purchase.id
            and invoice.status::text <> 'cancelled'
          order by invoice.created_at desc, invoice.id
          limit 1
        ),
        purchase.purchase_date
      )
      into resolved_date
      from public.purchases purchase
      where purchase.id = target_source_id;

    when target_source_type = 'accounts_payable'
      and target_event_purpose = 'accounts_payable_created'
    then
      select coalesce(invoice.invoice_date, purchase.purchase_date)
      into resolved_date
      from public.accounts_payable payable
      left join public.supplier_invoices invoice
        on invoice.id = payable.supplier_invoice_id
       and invoice.status::text <> 'cancelled'
      left join public.purchases purchase
        on purchase.id = payable.purchase_id
      where payable.id = target_source_id;

    else
      resolved_date := null;
  end case;

  return resolved_date;
end;
$$;

revoke all on function public.resolve_canonical_accounting_date_v1(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_canonical_accounting_date_v1(text, uuid, text)
  to service_role;

create or replace function public.accounting_date_source_v1(
  target_source_type text,
  target_event_purpose text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when target_source_type = 'order'
      and target_event_purpose in ('sale_recognized', 'sale_revenue')
      then 'invoice.invoice_date_or_order.requested_invoice_date'
    when target_source_type = 'inventory_movement'
      and target_event_purpose = 'inventory_cogs'
      then 'related_sale_accounting_date'
    when target_source_type = 'supplier_payment'
      and target_event_purpose = 'supplier_payment'
      then 'supplier_payments.paid_at'
    when target_source_type = 'receivable_payment'
      and target_event_purpose = 'receivable_payment'
      then 'accounts_receivable_payments.received_at'
    when target_source_type = 'invoice' then 'invoices.invoice_date'
    when target_source_type = 'supplier_invoice' then 'supplier_invoices.invoice_date'
    when target_source_type = 'purchase' then 'supplier_invoice.invoice_date_or_purchase.purchase_date'
    when target_source_type = 'accounts_payable' then 'originating_supplier_document_date'
    else null
  end
$$;

revoke all on function public.accounting_date_source_v1(text, text)
  from public, anon, authenticated;
grant execute on function public.accounting_date_source_v1(text, text)
  to service_role;

-- This legacy-named helper remains a technical cutover/routing timestamp.
-- It is never the accounting date authority after this migration.
create or replace function public.supplier_payment_accounting_occurred_at(
  p_paid_at timestamptz,
  p_created_at timestamptz,
  p_cutover_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_created_at is null or p_cutover_at is null then null
    when p_paid_at is null and p_created_at >= p_cutover_at
      then p_created_at
    when p_paid_at >= p_cutover_at
      then p_paid_at
    when p_paid_at < p_cutover_at and p_created_at >= p_cutover_at
      then p_created_at
    else null
  end
$$;

revoke all on function public.supplier_payment_accounting_occurred_at(
  timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.supplier_payment_accounting_occurred_at(
  timestamptz, timestamptz, timestamptz
) to service_role;

comment on function public.supplier_payment_accounting_occurred_at(
  timestamptz, timestamptz, timestamptz
) is
  'Technical cutover/routing timestamp only. supplier_payments.paid_at is the accounting date authority through resolve_canonical_accounting_date_v1.';

create or replace function public.route_accounting_fact_v2(
  target_feature_key text,
  target_topic text,
  target_source_type text,
  target_source_id uuid,
  target_event_purpose text,
  target_scenario text,
  target_occurred_at timestamptz,
  target_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  flag public.accounting_feature_flags%rowtype;
  result_id uuid;
  stable_key text;
  shadow_status text;
  shadow_code text;
  canonical_date date;
  canonical_source text;
  eligibility_at timestamptz;
  routing_occurred_at timestamptz;
begin
  select * into flag
  from public.accounting_feature_flags
  where key = target_feature_key;

  if not found or flag.state = 'disabled' then
    return null;
  end if;
  if target_source_id is null or target_occurred_at is null then
    return null;
  end if;

  eligibility_at := target_occurred_at;
  if target_source_type = 'order' then
    select coalesce(orders.updated_at, orders.created_at, target_occurred_at)
    into eligibility_at from public.orders orders where orders.id = target_source_id;
  elsif target_source_type = 'inventory_movement' then
    select coalesce(movement.created_at, target_occurred_at)
    into eligibility_at from public.inventory_movements movement where movement.id = target_source_id;
  elsif target_source_type = 'supplier_payment' then
    select coalesce(payment.created_at, target_occurred_at)
    into eligibility_at from public.supplier_payments payment where payment.id = target_source_id;
  end if;
  eligibility_at := coalesce(eligibility_at, target_occurred_at);

  if flag.cutover_at is null or eligibility_at < flag.cutover_at then
    return null;
  end if;

  stable_key := target_source_type || ':' || target_source_id::text
    || ':' || target_event_purpose || ':v2';

  if flag.state = 'shadow' then
    select validation_status, validation_code
    into shadow_status, shadow_code
    from public.validate_accounting_shadow_fact_v2(
      flag.key, target_source_type, target_source_id,
      target_scenario, target_occurred_at
    );
    insert into public.accounting_shadow_observations (
      feature_key, topic, source_type, source_id, event_purpose,
      posting_version, scenario, occurred_at, cutover_at,
      validation_status, validation_code
    ) values (
      flag.key, target_topic, target_source_type, target_source_id,
      target_event_purpose, 'v2', target_scenario, target_occurred_at,
      flag.cutover_at, shadow_status, shadow_code
    )
    on conflict (feature_key, source_type, source_id, event_purpose, posting_version)
    do update set validation_status = excluded.validation_status,
      validation_code = excluded.validation_code
    returning id into result_id;
    return result_id;
  end if;

  canonical_date := public.resolve_canonical_accounting_date_v1(
    target_source_type, target_source_id, target_event_purpose
  );
  canonical_source := public.accounting_date_source_v1(
    target_source_type, target_event_purpose
  );

  if canonical_date is null
    and target_event_purpose not in (
      'sale_recognized', 'sale_revenue', 'inventory_cogs',
      'supplier_payment', 'receivable_payment', 'invoice_issued',
      'supplier_invoice_received', 'purchase_confirmed',
      'accounts_payable_created'
    )
  then
    canonical_date := (target_occurred_at at time zone 'America/Tegucigalpa')::date;
    canonical_source := 'existing_noncanonical_event_contract';
  end if;

  routing_occurred_at := case
    when target_event_purpose in (
      'sale_recognized', 'sale_revenue', 'inventory_cogs',
      'supplier_payment', 'receivable_payment', 'invoice_issued',
      'supplier_invoice_received', 'purchase_confirmed',
      'accounts_payable_created'
    ) then case
      when target_occurred_at >= flag.cutover_at then target_occurred_at
      else eligibility_at
    end
    else target_occurred_at
  end;

  insert into public.accounting_outbox_v2 (
    feature_key, topic, source_type, source_id, event_purpose,
    posting_version, scenario, idempotency_key, occurred_at, cutover_at,
    accounting_date, accounting_date_source,
    status, next_attempt_at, actor_id
  ) values (
    flag.key, target_topic, target_source_type, target_source_id,
    target_event_purpose, 'v2', target_scenario, stable_key,
    routing_occurred_at, flag.cutover_at,
    canonical_date, canonical_source,
    'queued', now(), coalesce(target_actor_id, auth.uid())
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do update set duplicate_avoided = true
  returning id into result_id;

  return result_id;
end;
$$;

revoke all on function public.route_accounting_fact_v2(
  text, text, text, uuid, text, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.route_accounting_fact_v2(
  text, text, text, uuid, text, text, timestamptz, uuid
) to service_role;

create or replace function public.apply_canonical_accounting_date_to_event_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_uuid uuid;
  canonical_date date;
begin
  if new.source_id is null
    or new.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return new;
  end if;
  source_uuid := new.source_id::uuid;
  canonical_date := public.resolve_canonical_accounting_date_v1(
    new.source_type, source_uuid, new.event_purpose
  );
  if canonical_date is not null then
    new.accounting_date := canonical_date;
    new.source_snapshot := coalesce(new.source_snapshot, '{}'::jsonb)
      || jsonb_build_object(
        'accounting_date', canonical_date,
        'accounting_date_source', public.accounting_date_source_v1(
          new.source_type, new.event_purpose
        )
      );
  end if;
  return new;
end;
$$;

revoke all on function public.apply_canonical_accounting_date_to_event_v1()
  from public, anon, authenticated;
drop trigger if exists zz_financial_events_apply_canonical_accounting_date_v1
  on public.financial_events;
create trigger zz_financial_events_apply_canonical_accounting_date_v1
before insert or update of source_type, source_id, event_purpose, source_snapshot
on public.financial_events
for each row execute function public.apply_canonical_accounting_date_to_event_v1();

create or replace function public.apply_canonical_accounting_date_to_journal_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_row public.financial_events%rowtype;
begin
  if new.source_type <> 'financial_event'
    or new.source_id is null
    or new.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return new;
  end if;

  select * into event_row
  from public.financial_events event
  where event.id = new.source_id::uuid;

  if event_row.id is null then
    return new;
  end if;

  if event_row.accounting_date is null
    and event_row.event_purpose in (
      'sale_recognized', 'sale_revenue', 'inventory_cogs',
      'supplier_payment', 'receivable_payment', 'invoice_issued',
      'supplier_invoice_received', 'purchase_confirmed',
      'accounts_payable_created'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'ACCOUNTING_DATE_REQUIRED',
      detail = 'No se pudo determinar la fecha contable del documento. Revise la fecha antes de generar la partida.';
  end if;

  if event_row.accounting_date is not null then
    new.entry_date := event_row.accounting_date;
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'accounting_date', event_row.accounting_date,
        'accounting_date_source', public.accounting_date_source_v1(
          event_row.source_type, event_row.event_purpose
        )
      );
  end if;
  return new;
end;
$$;

revoke all on function public.apply_canonical_accounting_date_to_journal_v1()
  from public, anon, authenticated;
drop trigger if exists zz_journal_entries_apply_canonical_accounting_date_v1
  on public.journal_entries;
create trigger zz_journal_entries_apply_canonical_accounting_date_v1
before insert on public.journal_entries
for each row execute function public.apply_canonical_accounting_date_to_journal_v1();

create or replace function public.enrich_supplier_payment_event_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment public.supplier_payments%rowtype;
  box public.accounting_outbox_v2%rowtype;
begin
  if new.source_type <> 'supplier_payment'
    or new.event_purpose <> 'supplier_payment'
    or new.posting_version <> 'v2'
  then return new; end if;
  select * into payment from public.supplier_payments where id = new.source_id::uuid;
  select * into box from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = payment.id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';
  if payment.id is null or box.id is null then return new; end if;
  new.occurred_at := box.occurred_at;
  new.accounting_date := box.accounting_date;
  new.source_snapshot := coalesce(new.source_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'source_type', 'supplier_payment',
      'supplier_payment_id', payment.id,
      'accounts_payable_id', payment.accounts_payable_id,
      'supplier_id', payment.supplier_id,
      'amount', round(payment.amount, 2),
      'payment_method', payment.payment_method_v2,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_date', box.accounting_date,
      'accounting_date_source', box.accounting_date_source,
      'routing_origin', coalesce(box.metadata->>'routing_origin', 'supplier_payment'),
      'cutover_applied', coalesce((box.metadata->>'cutover_applied')::boolean, false),
      'manual_publication_required', true
    );
  return new;
end;
$$;

revoke all on function public.enrich_supplier_payment_event_v2()
  from public, anon, authenticated;

create or replace function public.enrich_supplier_payment_journal_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event public.financial_events%rowtype;
  payment public.supplier_payments%rowtype;
  box public.accounting_outbox_v2%rowtype;
begin
  if new.source_type <> 'financial_event' then return new; end if;
  select * into event from public.financial_events
  where id = new.source_id::uuid
    and source_type = 'supplier_payment'
    and event_purpose = 'supplier_payment'
    and posting_version = 'v2';
  if event.id is null then return new; end if;
  select * into payment from public.supplier_payments where id = event.source_id::uuid;
  select * into box from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'supplier_payment'
    and candidate.source_id = payment.id
    and candidate.event_purpose = 'supplier_payment'
    and candidate.posting_version = 'v2';
  if payment.id is null or box.id is null then return new; end if;
  if box.accounting_date is null then
    raise exception using errcode = '22023', message = 'ACCOUNTING_DATE_REQUIRED';
  end if;
  new.entry_date := box.accounting_date;
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'source_type', 'supplier_payment',
      'payment_id', payment.id,
      'accounts_payable_id', payment.accounts_payable_id,
      'supplier_id', payment.supplier_id,
      'effective_paid_at', payment.paid_at,
      'recorded_at', payment.created_at,
      'accounting_date', box.accounting_date,
      'accounting_date_source', box.accounting_date_source,
      'routing_origin', coalesce(box.metadata->>'routing_origin', 'supplier_payment'),
      'cutover_applied', coalesce((box.metadata->>'cutover_applied')::boolean, false),
      'manual_publication_required', true
    );
  return new;
end;
$$;

revoke all on function public.enrich_supplier_payment_journal_v2()
  from public, anon, authenticated;

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
  before_attempt integer;
  after_attempt integer;
  held boolean;
  canonical_date date;
  box_row public.accounting_outbox_v2%rowtype;
  result jsonb;
begin
  select * into box_row
  from public.accounting_outbox_v2
  where id = target_outbox_id;
  before_attempt := box_row.attempt_count;
  held := box_row.processing_hold;

  if box_row.id is null then
    return jsonb_build_object('ok', true, 'claimed', false,
      'outbox_id', target_outbox_id, 'reason', 'not_found');
  end if;
  if held then
    return jsonb_build_object('ok', true, 'claimed', false,
      'outbox_id', target_outbox_id, 'outbox_status', 'held',
      'reason', 'processing_hold');
  end if;

  canonical_date := public.resolve_canonical_accounting_date_v1(
    box_row.source_type, box_row.source_id, box_row.event_purpose
  );
  if canonical_date is null
    and box_row.accounting_date is null
    and box_row.event_purpose not in (
      'sale_recognized', 'sale_revenue', 'inventory_cogs',
      'supplier_payment', 'receivable_payment', 'invoice_issued',
      'supplier_invoice_received', 'purchase_confirmed',
      'accounts_payable_created'
    )
  then
    canonical_date := (box_row.occurred_at at time zone 'America/Tegucigalpa')::date;
    update public.accounting_outbox_v2
    set accounting_date = canonical_date,
        accounting_date_source = 'existing_noncanonical_event_contract'
    where id = target_outbox_id and journal_entry_id is null;
    box_row.accounting_date := canonical_date;
  end if;
  if canonical_date is not null
    and box_row.accounting_date is distinct from canonical_date
  then
    update public.accounting_outbox_v2
    set accounting_date = canonical_date,
        accounting_date_source = public.accounting_date_source_v1(
          box_row.source_type, box_row.event_purpose
        )
    where id = target_outbox_id
      and journal_entry_id is null;
    box_row.accounting_date := canonical_date;
  end if;

  if box_row.accounting_date is null then
    update public.accounting_outbox_v2
    set status = 'pending_data',
        attempt_count = least(max_attempts, attempt_count + 1),
        next_attempt_at = now() + interval '15 minutes',
        lease_until = null,
        locked_by = null,
        last_error_code = 'ACCOUNTING_DATE_REQUIRED',
        last_error_message = 'No se pudo determinar la fecha contable del documento. Revise la fecha antes de generar la partida.',
        missing_key = 'accounting_date'
    where id = target_outbox_id;
    insert into public.accounting_event_log (
      event_type, entity_type, entity_id, source_type, source_id,
      metadata, created_by
    ) values (
      'accounting_date_required', 'accounting_outbox_v2', target_outbox_id,
      box_row.source_type, box_row.source_id::text,
      jsonb_build_object('event_purpose', box_row.event_purpose,
        'error_code', 'ACCOUNTING_DATE_REQUIRED'), box_row.actor_id
    );
    return jsonb_build_object('ok', false, 'claimed', true,
      'outbox_id', target_outbox_id, 'outbox_status', 'pending_data',
      'reason', 'accounting_date_required',
      'error_code', 'ACCOUNTING_DATE_REQUIRED');
  end if;

  result := public.process_accounting_outbox_v018(
    target_outbox_id, worker_token, force_retry
  );

  if coalesce((result->>'claimed')::boolean, false) then
    select attempt_count into after_attempt
    from public.accounting_outbox_v2
    where id = target_outbox_id for update;
    if after_attempt <= before_attempt then
      update public.accounting_outbox_v2
      set attempt_count = before_attempt + 1
      where id = target_outbox_id
      returning attempt_count into after_attempt;
    end if;
    result := result || jsonb_build_object('attempt_count', after_attempt);
  end if;

  select * into box_row
  from public.accounting_outbox_v2
  where id = target_outbox_id;
  if box_row.status = 'completed'
    and box_row.event_purpose in (
      'sale_recognized', 'sale_revenue', 'inventory_cogs',
      'supplier_payment', 'receivable_payment', 'invoice_issued',
      'supplier_invoice_received', 'purchase_confirmed',
      'accounts_payable_created'
    ) and (
    not exists (
      select 1 from public.financial_events event
      where event.id = box_row.financial_event_id
        and event.accounting_date = box_row.accounting_date
    )
    or not exists (
      select 1 from public.journal_entries entry
      where entry.id = box_row.journal_entry_id
        and entry.entry_date = box_row.accounting_date
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'ACCOUNTING_DATE_PROPAGATION_MISMATCH';
  end if;
  return result || jsonb_build_object('accounting_date', box_row.accounting_date);
end;
$$;

revoke all on function public.process_accounting_outbox_v2(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.process_accounting_outbox_v2(uuid, text, boolean)
  to service_role;

create or replace function public.reconcile_unpublished_order_accounting_date_v1(
  target_order_id uuid,
  target_accounting_date date,
  change_reason text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_count integer := 0;
  entry_row record;
begin
  if target_accounting_date is null then
    raise exception using errcode = '22023', message = 'ACCOUNTING_DATE_REQUIRED';
  end if;
  if exists (
    select 1
    from public.accounting_outbox_v2 box
    join public.journal_entries entry on entry.id = box.journal_entry_id
    where (
      (box.source_type = 'order' and box.source_id = target_order_id
        and box.event_purpose = 'sale_recognized')
      or (box.source_type = 'inventory_movement'
        and box.event_purpose = 'inventory_cogs'
        and exists (select 1 from public.inventory_movements movement
          where movement.id = box.source_id
            and movement.reference_type = 'orders'
            and movement.reference_id = target_order_id))
    )
      and entry.status <> 'borrador'
      and entry.entry_date is distinct from target_accounting_date
  ) then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNTING_DATE_PUBLISHED_REQUIRES_CONTROLLED_REPAIR';
  end if;

  for entry_row in
    select entry.id, entry.entry_date, event.id as event_id
    from public.accounting_outbox_v2 box
    join public.journal_entries entry on entry.id = box.journal_entry_id
    left join public.financial_events event on event.id = box.financial_event_id
    where (
      (box.source_type = 'order' and box.source_id = target_order_id
        and box.event_purpose = 'sale_recognized')
      or (box.source_type = 'inventory_movement'
        and box.event_purpose = 'inventory_cogs'
        and exists (select 1 from public.inventory_movements movement
          where movement.id = box.source_id
            and movement.reference_type = 'orders'
            and movement.reference_id = target_order_id))
    )
      and entry.status = 'borrador'
      and entry.entry_date is distinct from target_accounting_date
    order by entry.id
  loop
    insert into public.audit_logs (
      user_id, table_name, record_id, action, old_data, new_data, actor_role
    ) values (
      auth.uid(), 'journal_entries', entry_row.id,
      'accounting_draft_date_reconciled',
      jsonb_build_object('entry_date', entry_row.entry_date,
        'financial_event_id', entry_row.event_id),
      jsonb_build_object('entry_date', target_accounting_date,
        'financial_event_id', entry_row.event_id,
        'reason', left(coalesce(change_reason, 'canonical_date_reconciled'), 240)),
      public.current_actor_role()
    );
    changed_count := changed_count + 1;
  end loop;

  update public.accounting_outbox_v2 box
  set accounting_date = target_accounting_date,
      accounting_date_source = case when box.source_type = 'order'
        then 'invoice.invoice_date_or_order.requested_invoice_date'
        else 'related_sale_accounting_date' end,
      metadata = coalesce(box.metadata, '{}'::jsonb)
        || jsonb_build_object('accounting_date', target_accounting_date,
          'accounting_date_reconciled', true)
  where (
    (box.source_type = 'order' and box.source_id = target_order_id
      and box.event_purpose = 'sale_recognized')
    or (box.source_type = 'inventory_movement'
      and box.event_purpose = 'inventory_cogs'
      and exists (select 1 from public.inventory_movements movement
        where movement.id = box.source_id
          and movement.reference_type = 'orders'
          and movement.reference_id = target_order_id))
  ) and (
    box.journal_entry_id is null
    or exists (select 1 from public.journal_entries entry
      where entry.id = box.journal_entry_id and entry.status = 'borrador')
  );

  update public.financial_events event
  set accounting_date = target_accounting_date,
      source_snapshot = coalesce(event.source_snapshot, '{}'::jsonb)
        || jsonb_build_object('accounting_date', target_accounting_date,
          'accounting_date_reconciled', true)
  from public.accounting_outbox_v2 box
  where box.financial_event_id = event.id
    and box.accounting_date = target_accounting_date
    and (
      (box.source_type = 'order' and box.source_id = target_order_id
        and box.event_purpose = 'sale_recognized')
      or (box.source_type = 'inventory_movement'
        and box.event_purpose = 'inventory_cogs'
        and exists (select 1 from public.inventory_movements movement
          where movement.id = box.source_id
            and movement.reference_type = 'orders'
            and movement.reference_id = target_order_id))
    )
    and (box.journal_entry_id is null or exists (
      select 1 from public.journal_entries entry
      where entry.id = box.journal_entry_id and entry.status = 'borrador'
    ));

  update public.journal_entries entry
  set entry_date = target_accounting_date,
      metadata = coalesce(entry.metadata, '{}'::jsonb)
        || jsonb_build_object('accounting_date', target_accounting_date,
          'accounting_date_reconciled', true)
  from public.accounting_outbox_v2 box
  where box.journal_entry_id = entry.id
    and box.accounting_date = target_accounting_date
    and (
      (box.source_type = 'order' and box.source_id = target_order_id
        and box.event_purpose = 'sale_recognized')
      or (box.source_type = 'inventory_movement'
        and box.event_purpose = 'inventory_cogs'
        and exists (select 1 from public.inventory_movements movement
          where movement.id = box.source_id
            and movement.reference_type = 'orders'
            and movement.reference_id = target_order_id))
    )
    and entry.status = 'borrador';

  return changed_count;
end;
$$;

revoke all on function public.reconcile_unpublished_order_accounting_date_v1(uuid, date, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_unpublished_order_accounting_date_v1(uuid, date, text)
  to service_role;

create or replace function public.reconcile_requested_invoice_accounting_date_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.requested_invoice_date is distinct from old.requested_invoice_date then
    perform public.reconcile_unpublished_order_accounting_date_v1(
      new.id, new.requested_invoice_date, 'requested_invoice_date_changed'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_requested_invoice_accounting_date_v1()
  from public, anon, authenticated;
drop trigger if exists orders_reconcile_requested_invoice_accounting_date_v1
  on public.orders;
create trigger orders_reconcile_requested_invoice_accounting_date_v1
after update of requested_invoice_date on public.orders
for each row execute function public.reconcile_requested_invoice_accounting_date_v1();

create or replace function public.validate_invoice_canonical_accounting_date_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_date date;
begin
  if new.invoice_date is null then
    raise exception using errcode = '22023', message = 'ACCOUNTING_DATE_REQUIRED';
  end if;
  if new.order_id is null then return new; end if;
  select orders.requested_invoice_date into requested_date
  from public.orders orders where orders.id = new.order_id;
  if requested_date is null or requested_date is distinct from new.invoice_date then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_MISMATCH';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_invoice_canonical_accounting_date_v1()
  from public, anon, authenticated;
drop trigger if exists invoices_validate_canonical_accounting_date_v1
  on public.invoices;
create trigger invoices_validate_canonical_accounting_date_v1
before insert on public.invoices
for each row execute function public.validate_invoice_canonical_accounting_date_v1();

create or replace function public.reconcile_issued_invoice_accounting_date_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.order_id is not null then
    perform public.reconcile_unpublished_order_accounting_date_v1(
      new.order_id, new.invoice_date, 'invoice_issued_canonical_date'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_issued_invoice_accounting_date_v1()
  from public, anon, authenticated;
drop trigger if exists invoices_reconcile_canonical_accounting_date_v1
  on public.invoices;
create trigger invoices_reconcile_canonical_accounting_date_v1
after insert on public.invoices
for each row execute function public.reconcile_issued_invoice_accounting_date_v1();

-- Producers keep occurred_at as technical/event time. Canonical date is
-- resolved independently by route_accounting_fact_v2.
create or replace function public.enqueue_sale_recognition_from_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  order_row public.orders%rowtype;
  old_status text := case when tg_op = 'INSERT' then null
    else coalesce(old.payment_status::text, old.status::text) end;
  new_status text := coalesce(new.payment_status::text, new.status::text);
  technical_at timestamptz;
  sale_scenario text;
begin
  if new_status not in ('approved', 'confirmed', 'paid')
    or old_status in ('approved', 'confirmed', 'paid') then return new; end if;
  select * into order_row from public.orders where id = new.order_id for share;
  if not found or order_row.payment_method::text = 'commercial_credit'
    or order_row.status::text in ('cancelado', 'cancelled') then return new; end if;
  if order_row.payment_timing = 'on_delivery'
    and order_row.status::text not in ('entregado', 'delivered') then return new; end if;
  technical_at := coalesce(new.updated_at, new.created_at, statement_timestamp());
  sale_scenario := case
    when order_row.payment_timing = 'on_delivery' then 'cash_or_cod_after_delivery'
    when order_row.payment_method::text = 'bank_transfer' then 'prepaid_bank_transfer'
    when order_row.payment_method::text = 'card' then 'prepaid_customer_card'
    when order_row.payment_method::text = 'cash' then 'prepaid_cash'
    else 'prepaid_other' end;
  perform public.route_accounting_fact_v2(
    'sales_draft_v2', 'sales.recognized', 'order', order_row.id,
    'sale_recognized', sale_scenario, technical_at,
    coalesce(new.confirmed_by, auth.uid())
  );
  return new;
end;
$$;

create or replace function public.enqueue_credit_sale_on_delivery_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_method::text <> 'commercial_credit'
    or new.status::text not in ('entregado', 'delivered')
    or old.status::text in ('entregado', 'delivered') then return new; end if;
  perform public.route_accounting_fact_v2(
    'sales_draft_v2', 'sales.recognized', 'order', new.id,
    'sale_recognized', 'commercial_credit_on_delivery',
    coalesce(new.updated_at, new.created_at, statement_timestamp()), auth.uid()
  );
  return new;
end;
$$;

create or replace function public.enqueue_inventory_cogs_v2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.movement_type::text <> 'sale' or new.quantity >= 0
    or new.stock_after >= new.stock_before or new.reference_type <> 'orders'
    or new.reference_id is null then return new; end if;
  perform public.route_accounting_fact_v2(
    'cogs_draft_v2', 'inventory.cogs', 'inventory_movement', new.id,
    'inventory_cogs', 'physical_sale_movement', new.created_at,
    coalesce(new.user_id, auth.uid())
  );
  return new;
end;
$$;

revoke all on function public.enqueue_sale_recognition_from_payment_v2()
  from public, anon, authenticated;
revoke all on function public.enqueue_credit_sale_on_delivery_v2()
  from public, anon, authenticated;
revoke all on function public.enqueue_inventory_cogs_v2()
  from public, anon, authenticated;

-- Keep the established repair eligibility/fingerprint implementation, while
-- exposing the authoritative paid_at date in every read-only preview.
alter function public.supplier_payment_accounting_assessment_v1(uuid)
  rename to supplier_payment_accounting_assessment_v20260803_legacy;

create or replace function public.supplier_payment_accounting_assessment_v1(
  p_payment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result_value jsonb;
  canonical_date date;
  recognition_date date;
begin
  if current_setting(
    'app.accounting_repair_legacy_assessment', true
  ) = 'on' then
    return public.supplier_payment_accounting_assessment_v20260803_legacy(
      p_payment_id
    );
  end if;
  result_value := public.supplier_payment_accounting_assessment_v20260803_legacy(
    p_payment_id
  );
  canonical_date := public.resolve_canonical_accounting_date_v1(
    'supplier_payment', p_payment_id, 'supplier_payment'
  );
  if canonical_date is null then
    return result_value || jsonb_build_object(
      'classification', 'source_invalid',
      'classification_reason', 'accounting_date_required',
      'proposed_journal_date', null,
      'accounting_occurred_at', null
    );
  end if;
  recognition_date := nullif(
    result_value->'payable_recognition'->>'entry_date', ''
  )::date;
  result_value := result_value || jsonb_build_object(
    'proposed_journal_date', canonical_date,
    'accounting_occurred_at',
      (canonical_date::timestamp at time zone 'America/Tegucigalpa')
  );
  if recognition_date is not null and recognition_date > canonical_date then
    result_value := result_value || jsonb_build_object(
      'classification', 'chronology_conflict',
      'classification_reason', 'payment_date_before_payable_recognition'
    );
  end if;
  return result_value;
end;
$$;

revoke all on function public.supplier_payment_accounting_assessment_v1(uuid)
  from public, anon;
grant execute on function public.supplier_payment_accounting_assessment_v1(uuid)
  to authenticated, service_role;

alter function public.repair_late_recorded_supplier_payment_draft_v1(
  text, uuid, text, text
) rename to repair_late_recorded_supplier_payment_draft_v20260803_legacy;

create or replace function public.repair_late_recorded_supplier_payment_draft_v1(
  p_request_key text,
  p_payment_id uuid,
  p_expected_fingerprint text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  preview jsonb;
  result_value jsonb;
begin
  preview := public.supplier_payment_accounting_assessment_v1(p_payment_id);
  if preview->>'classification' = 'chronology_conflict' then
    raise exception using
      errcode = '22023',
      message = 'Las precondiciones canonicas del pago cambiaron.';
  end if;
  perform set_config('app.accounting_repair_legacy_assessment', 'on', true);
  result_value := public.repair_late_recorded_supplier_payment_draft_v20260803_legacy(
    p_request_key, p_payment_id, p_expected_fingerprint, p_reason
  );
  perform set_config('app.accounting_repair_legacy_assessment', 'off', true);
  return result_value || jsonb_build_object(
    'accounting_date', preview->>'proposed_journal_date',
    'accounting_date_source', 'supplier_payments.paid_at'
  );
end;
$$;

revoke all on function public.repair_late_recorded_supplier_payment_draft_v1(
  text, uuid, text, text
) from public, anon;
grant execute on function public.repair_late_recorded_supplier_payment_draft_v1(
  text, uuid, text, text
) to authenticated;
