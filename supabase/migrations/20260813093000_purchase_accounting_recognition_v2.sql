begin;

-- Prospective purchase recognition. This migration deliberately does not scan,
-- enqueue, mutate, or draft any historical purchase/AP fact.
alter table public.accounting_feature_flags
  drop constraint accounting_feature_flags_key_check,
  add constraint accounting_feature_flags_key_check check (
    key in (
      'sales_draft_v2',
      'cogs_draft_v2',
      'supplier_payment_draft_v2',
      'supplier_multi_invoice_payment_v1',
      'purchase_recognition_draft_v2'
    )
  );

insert into public.accounting_feature_flags (
  key, state, cutover_at, version, notes
)
values (
  'purchase_recognition_draft_v2',
  'disabled',
  null,
  'v2',
  'Prospective purchase/AP recognition drafts; no historical scan or backfill.'
)
on conflict (key) do nothing;

alter table public.purchases
  add column accounting_recognition_version text,
  add constraint purchases_accounting_recognition_version_check
    check (accounting_recognition_version is null or accounting_recognition_version = 'v2');

alter table public.accounts_payable
  add column accounting_recognition_version text,
  add constraint accounts_payable_accounting_recognition_version_check
    check (accounting_recognition_version is null or accounting_recognition_version = 'v2');

create index accounts_payable_purchase_recognition_v2_idx
  on public.accounts_payable (purchase_id, id)
  where accounting_recognition_version = 'v2';

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
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:settings')
  then
    raise exception using errcode = '42501', message = 'No tienes permiso para configurar la automatizacion contable.';
  end if;

  if target_key not in (
    'sales_draft_v2',
    'cogs_draft_v2',
    'supplier_payment_draft_v2',
    'supplier_multi_invoice_payment_v1',
    'purchase_recognition_draft_v2'
  ) then
    raise exception using errcode = '22023', message = 'El feature flag contable no es valido.';
  end if;
  if target_state not in ('disabled', 'shadow', 'enabled') then
    raise exception using errcode = '22023', message = 'El estado del feature flag no es valido.';
  end if;
  if target_state <> 'disabled' and target_cutover_at is null then
    raise exception using errcode = '22023', message = 'Shadow y enabled requieren una fecha de corte explicita.';
  end if;
  if target_state = 'enabled' and target_cutover_at < now() then
    raise exception using errcode = '22023', message = 'Enabled requiere una fecha de corte prospectiva.';
  end if;

  update public.accounting_feature_flags
  set state = target_state,
      cutover_at = case when target_state = 'disabled' then null else target_cutover_at end,
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
    event_type, entity_type, source_type, source_id, metadata, created_by
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

revoke all on function public.set_accounting_feature_flag_v2(
  text, text, timestamptz, text
) from public, anon;
grant execute on function public.set_accounting_feature_flag_v2(
  text, text, timestamptz, text
) to authenticated;

create or replace function public.purchase_accounting_scope_v2(
  p_accounts_payable_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.accounts_payable payable
    join public.purchases purchase on purchase.id = payable.purchase_id
    where payable.id = p_accounts_payable_id
      and payable.automation_source = 'purchase_confirmation_v1'
      and payable.accounting_recognition_version = 'v2'
      and purchase.accounting_recognition_version = 'v2'
  );
$$;

revoke all on function public.purchase_accounting_scope_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.purchase_accounting_scope_v2(uuid)
  to service_role;

-- Extend the established V1/V2 supersession boundary to purchase/AP
-- recognition.  The V1 event remains as operational evidence, but durable V2
-- ownership makes it ineligible to acquire a journal even after the feature is
-- disabled later.
create or replace function public.canonical_v2_purpose_for_legacy_v1(
  legacy_purpose text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case legacy_purpose
    when 'sale_revenue' then 'sale_recognized'
    when 'inventory_cogs' then 'inventory_cogs'
    when 'accounts_payable_created' then 'accounts_payable_created'
    else null
  end
$$;

create or replace function public.has_canonical_v2_accounting_chain_v1(
  target_source_type text,
  target_source_id text,
  legacy_purpose text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when public.canonical_v2_purpose_for_legacy_v1(legacy_purpose) is null
      then false
    else (
      target_source_type = 'accounts_payable'
      and legacy_purpose = 'accounts_payable_created'
      and exists (
        select 1
        from public.accounts_payable payable
        join public.purchases purchase on purchase.id = payable.purchase_id
        where payable.id::text = target_source_id
          and payable.automation_source = 'purchase_confirmation_v1'
          and payable.accounting_recognition_version = 'v2'
          and purchase.accounting_recognition_version = 'v2'
      )
    ) or exists (
      select 1
      from public.accounting_outbox_v2 box
      where box.posting_version = 'v2'
        and box.source_type = target_source_type
        and box.source_id::text = target_source_id
        and box.event_purpose = public.canonical_v2_purpose_for_legacy_v1(
          legacy_purpose
        )
        and box.status <> 'cancelled'
    ) or exists (
      select 1
      from public.financial_events event
      where event.posting_version = 'v2'
        and event.source_type = target_source_type
        and event.source_id = target_source_id
        and event.event_purpose = public.canonical_v2_purpose_for_legacy_v1(
          legacy_purpose
        )
        and event.status <> 'reversed'
    )
  end
$$;

revoke all on function public.canonical_v2_purpose_for_legacy_v1(text)
  from public, anon, authenticated;
revoke all on function public.has_canonical_v2_accounting_chain_v1(text, text, text)
  from public, anon, authenticated;
grant execute on function public.canonical_v2_purpose_for_legacy_v1(text)
  to service_role;
grant execute on function public.has_canonical_v2_accounting_chain_v1(text, text, text)
  to service_role;

-- The existing triggers call the helper above. Replacing their predicates adds
-- AP recognition to both the financial-event and journal insertion guards.
create or replace function public.guard_legacy_v1_financial_event_when_v2_exists()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  superseded_reason constant text := 'SUPERSEDED_BY_V2';
begin
  if new.posting_version = 'v1'
    and new.event_purpose in (
      'sale_revenue', 'inventory_cogs', 'accounts_payable_created'
    )
    and public.has_canonical_v2_accounting_chain_v1(
      new.source_type, new.source_id, new.event_purpose
    )
  then
    if new.journal_entry_id is not null
      or new.status in ('draft_created', 'posted', 'reversed')
    then
      raise exception using
        errcode = '23514',
        message = 'SUPERSEDED_BY_V2';
    end if;
    new.status := 'skipped';
    new.journal_entry_id := null;
    if not coalesce(new.validation_errors, '[]'::jsonb)
      @> jsonb_build_array(superseded_reason)
    then
      new.validation_errors := coalesce(new.validation_errors, '[]'::jsonb)
        || jsonb_build_array(superseded_reason);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_legacy_v1_financial_event_when_v2_exists()
  from public, anon, authenticated, service_role;

create or replace function public.guard_legacy_v1_journal_when_v2_exists()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_event public.financial_events%rowtype;
begin
  if new.source_type <> 'financial_event' or new.source_id is null then
    return new;
  end if;
  select * into source_event
  from public.financial_events
  where id::text = new.source_id;
  if source_event.id is not null
    and source_event.posting_version = 'v1'
    and source_event.event_purpose in (
      'sale_revenue', 'inventory_cogs', 'accounts_payable_created'
    )
    and public.has_canonical_v2_accounting_chain_v1(
      source_event.source_type,
      source_event.source_id,
      source_event.event_purpose
    )
  then
    raise exception using
      errcode = '23514',
      message = 'SUPERSEDED_BY_V2';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_legacy_v1_journal_when_v2_exists()
  from public, anon, authenticated, service_role;

-- Harden the canonical manual-draft RPC as well as the table trigger so every
-- current application entry point and alternate authenticated client fails
-- with the same sanitized business state.
alter function public.create_journal_draft_from_financial_event(
  uuid, date, text, jsonb, text, text
) rename to create_journal_draft_from_event_pre_purchase_v2;

revoke all on function public.create_journal_draft_from_event_pre_purchase_v2(
  uuid, date, text, jsonb, text, text
) from public, anon, authenticated, service_role;

create or replace function public.create_journal_draft_from_financial_event(
  financial_event_id uuid,
  entry_date_value date,
  description_value text,
  lines_data jsonb,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_event public.financial_events%rowtype;
begin
  select * into target_event
  from public.financial_events
  where id = financial_event_id
  for update;

  if target_event.id is not null
    and target_event.posting_version = 'v1'
    and target_event.source_type = 'accounts_payable'
    and target_event.event_purpose = 'accounts_payable_created'
    and public.has_canonical_v2_accounting_chain_v1(
      target_event.source_type,
      target_event.source_id,
      target_event.event_purpose
    )
  then
    raise exception using
      errcode = '23514',
      message = 'SUPERSEDED_BY_V2';
  end if;

  return public.create_journal_draft_from_event_pre_purchase_v2(
    financial_event_id,
    entry_date_value,
    description_value,
    lines_data,
    actor_ip,
    actor_user_agent
  );
end;
$$;

revoke all on function public.create_journal_draft_from_financial_event(
  uuid, date, text, jsonb, text, text
) from public, anon;
grant execute on function public.create_journal_draft_from_financial_event(
  uuid, date, text, jsonb, text, text
) to authenticated;

create or replace function public.require_purchase_recognition_outbox_v2(
  p_accounts_payable_id uuid,
  p_expected_outbox_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  box public.accounting_outbox_v2%rowtype;
  expected_key text := 'accounts_payable:' || p_accounts_payable_id::text
    || ':accounts_payable_created:v2';
begin
  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'accounts_payable'
    and candidate.source_id = p_accounts_payable_id
    and candidate.event_purpose = 'accounts_payable_created'
    and candidate.posting_version = 'v2'
  for update;

  if box.id is null then
    return null;
  end if;

  if (p_expected_outbox_id is not null and box.id <> p_expected_outbox_id)
    or box.feature_key <> 'purchase_recognition_draft_v2'
    or box.topic <> 'payables.purchase_recognition'
    or box.scenario <> 'purchase_inventory_v2'
    or box.idempotency_key <> expected_key
  then
    raise exception using
      errcode = 'PT409',
      message = 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT';
  end if;

  return box.id;
end;
$$;

revoke all on function public.require_purchase_recognition_outbox_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.require_purchase_recognition_outbox_v2(uuid, uuid)
  to service_role;

create or replace function public.route_purchase_recognition_accounting_v2(
  p_accounts_payable_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payable public.accounts_payable%rowtype;
  purchase public.purchases%rowtype;
  existing_id uuid;
  result_id uuid;
begin
  if p_accounts_payable_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'purchase_recognition_v2:' || p_accounts_payable_id::text,
      0
    )
  );

  select * into payable
  from public.accounts_payable
  where id = p_accounts_payable_id;

  if payable.id is null
    or not public.purchase_accounting_scope_v2(payable.id)
  then
    return null;
  end if;

  select * into purchase
  from public.purchases
  where id = payable.purchase_id;

  existing_id := public.require_purchase_recognition_outbox_v2(
    payable.id,
    null
  );

  if existing_id is not null then
    update public.accounting_outbox_v2
    set duplicate_avoided = true
    where id = existing_id;
    return existing_id;
  end if;

  if purchase.id is null or purchase.confirmed_at is null then
    return null;
  end if;

  result_id := public.route_accounting_fact_v2(
    'purchase_recognition_draft_v2',
    'payables.purchase_recognition',
    'accounts_payable',
    payable.id,
    'accounts_payable_created',
    'purchase_inventory_v2',
    purchase.confirmed_at,
    coalesce(p_actor_id, payable.created_by, auth.uid())
  );

  if result_id is null then
    return null;
  end if;

  existing_id := public.require_purchase_recognition_outbox_v2(
    payable.id,
    result_id
  );
  if existing_id is null then
    raise exception using
      errcode = '55000',
      message = 'PURCHASE_ACCOUNTING_OBLIGATION_REQUIRED';
  end if;

  update public.accounting_outbox_v2
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'source_type', 'accounts_payable',
        'accounts_payable_id', payable.id,
        'purchase_id', purchase.id,
        'accounting_source_version', 'purchase_recognition_v2',
        'manual_publication_required', true
      )
  where id = result_id;

  insert into public.accounting_event_log (
    event_type, entity_type, entity_id,
    source_type, source_id, metadata, created_by
  )
  values (
    'purchase_recognition_v2_routed',
    'accounting_outbox_v2', result_id,
    'accounts_payable', payable.id::text,
    jsonb_build_object(
      'accounts_payable_id', payable.id,
      'purchase_id', purchase.id,
      'outbox_id', result_id,
      'accounting_source_version', 'purchase_recognition_v2',
      'manual_publication_required', true
    ),
    coalesce(p_actor_id, payable.created_by, auth.uid())
  );

  return result_id;
end;
$$;

revoke all on function public.route_purchase_recognition_accounting_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.route_purchase_recognition_accounting_v2(uuid, uuid)
  to service_role;

create or replace function public.resolve_purchase_recognition_mapping_v2(
  target_mapping_type text,
  target_source_key text,
  effective_date date
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'mapping_id', mapping.id,
    'mapping_type', mapping.mapping_type,
    'source_key', mapping.source_key,
    'account_id', mapping.account_id
  )
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

revoke all on function public.resolve_purchase_recognition_mapping_v2(
  text, text, date
) from public, anon, authenticated;
grant execute on function public.resolve_purchase_recognition_mapping_v2(
  text, text, date
) to service_role;

create or replace function public.calculate_purchase_recognition_v2(
  p_accounts_payable_id uuid,
  p_outbox_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  box public.accounting_outbox_v2%rowtype;
  payable public.accounts_payable%rowtype;
  purchase public.purchases%rowtype;
  invoice public.supplier_invoices%rowtype;
  effective_date date;
  item_count integer := 0;
  unknown_item_count integer := 0;
  item_subtotal numeric(14, 2) := 0;
  item_tax numeric(14, 2) := 0;
  item_discount numeric(14, 2) := 0;
  item_total numeric(14, 2) := 0;
  inventory_mapping jsonb;
  payable_mapping jsonb;
  tax_mapping jsonb;
  shipping_mapping jsonb;
  discount_mapping jsonb;
  missing_keys text[] := array[]::text[];
  canonical_lines jsonb := '[]'::jsonb;
  canonical_snapshot jsonb;
begin
  select * into box
  from public.accounting_outbox_v2
  where id = p_outbox_id;

  if box.id is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'ACCOUNTING_INCOMPLETE',
      'reason', 'purchase_recognition_obligation_missing'
    );
  end if;
  if box.source_type <> 'accounts_payable'
    or box.source_id <> p_accounts_payable_id
    or box.event_purpose <> 'accounts_payable_created'
    or box.posting_version <> 'v2'
    or box.feature_key <> 'purchase_recognition_draft_v2'
    or box.topic <> 'payables.purchase_recognition'
    or box.scenario <> 'purchase_inventory_v2'
    or box.idempotency_key <> 'accounts_payable:'
      || p_accounts_payable_id::text || ':accounts_payable_created:v2'
    or box.cutover_at is null
    or box.occurred_at < box.cutover_at
  then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_FAILED',
      'reason', 'canonical_routing_conflict'
    );
  end if;

  select * into payable
  from public.accounts_payable
  where id = p_accounts_payable_id;
  if payable.id is null
    or not public.purchase_accounting_scope_v2(payable.id)
  then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_FAILED',
      'reason', 'purchase_recognition_scope_missing'
    );
  end if;
  if payable.status = 'cancelled' then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_FAILED',
      'reason', 'source_cancelled'
    );
  end if;
  if upper(btrim(payable.currency)) <> 'HNL' then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_UNSUPPORTED_CURRENCY',
      'reason', 'unsupported_currency'
    );
  end if;

  select * into purchase
  from public.purchases
  where id = payable.purchase_id;
  if purchase.id is null
    or purchase.status not in ('confirmed', 'received', 'returned')
    or purchase.supplier_id <> payable.supplier_id
    or round(purchase.total, 2) <> round(payable.total_amount, 2)
    or upper(btrim(purchase.currency)) <> upper(btrim(payable.currency))
  then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_FAILED',
      'reason', 'purchase_payable_mismatch'
    );
  end if;

  if payable.supplier_invoice_id is not null then
    select * into invoice
    from public.supplier_invoices
    where id = payable.supplier_invoice_id;
    if invoice.id is null
      or invoice.purchase_id is distinct from purchase.id
      or invoice.supplier_id <> payable.supplier_id
      or invoice.status = 'cancelled'
      or round(invoice.total, 2) <> round(payable.total_amount, 2)
      or upper(btrim(invoice.currency)) <> upper(btrim(payable.currency))
    then
      return jsonb_build_object(
        'ok', false,
        'error_code', 'PURCHASE_ACCOUNTING_FAILED',
        'reason', 'supplier_invoice_payable_mismatch'
      );
    end if;
  end if;

  -- The business documents, not the outbox or worker clock, remain the date
  -- authority on every generation and equivalence check.  A supplier invoice
  -- linked after the first draft therefore changes the canonical date and the
  -- old chain must be reconciled explicitly.
  effective_date := coalesce(invoice.invoice_date, purchase.purchase_date);
  if effective_date is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_FAILED',
      'reason', 'accounting_date_required'
    );
  end if;
  if box.accounting_date is distinct from effective_date
    or box.accounting_date_source is distinct from
      public.accounting_date_source_v1(
        'accounts_payable', 'accounts_payable_created'
      )
  then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT',
      'reason', 'canonical_accounting_date_mismatch'
    );
  end if;
  if public.is_date_in_closed_accounting_period(effective_date) then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED',
      'reason', 'period_closed'
    );
  end if;

  select
    count(*),
    count(*) filter (where item.product_id is null),
    round(coalesce(sum(item.quantity * item.unit_cost), 0), 2),
    round(coalesce(sum(item.tax_amount), 0), 2),
    round(coalesce(sum(item.discount_amount), 0), 2),
    round(coalesce(sum(item.total_cost), 0), 2)
  into
    item_count, unknown_item_count, item_subtotal,
    item_tax, item_discount, item_total
  from public.purchase_items item
  where item.purchase_id = purchase.id;

  if item_count < 1 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED',
      'reason', 'purchase_items_missing'
    );
  end if;
  if unknown_item_count > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED',
      'reason', 'non_inventory_line_unclassified'
    );
  end if;
  if item_subtotal <> round(purchase.subtotal, 2)
    or item_tax <> round(purchase.tax_amount, 2)
    or item_discount <> round(purchase.discount_amount, 2)
    or item_total + round(purchase.shipping_amount, 2) <> round(purchase.total, 2)
    or round(
      purchase.subtotal + purchase.tax_amount + purchase.shipping_amount
        - purchase.discount_amount,
      2
    ) <> round(purchase.total, 2)
  then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_FAILED',
      'reason', 'purchase_fiscal_breakdown_mismatch'
    );
  end if;

  inventory_mapping := public.resolve_purchase_recognition_mapping_v2(
    'inventory', 'purchase_inventory', effective_date
  );
  payable_mapping := public.resolve_purchase_recognition_mapping_v2(
    'default_account', 'accounts_payable', effective_date
  );
  if purchase.tax_amount > 0 then
    tax_mapping := public.resolve_purchase_recognition_mapping_v2(
      'tax', 'purchase_tax', effective_date
    );
  end if;
  if purchase.shipping_amount > 0 then
    shipping_mapping := public.resolve_purchase_recognition_mapping_v2(
      'shipping', 'purchase_shipping', effective_date
    );
  end if;
  if purchase.discount_amount > 0 then
    discount_mapping := public.resolve_purchase_recognition_mapping_v2(
      'discount', 'purchase_discount', effective_date
    );
  end if;

  if inventory_mapping is null then
    missing_keys := array_append(missing_keys, 'inventory:purchase_inventory');
  end if;
  if payable_mapping is null then
    missing_keys := array_append(missing_keys, 'default_account:accounts_payable');
  end if;
  if purchase.tax_amount > 0 and tax_mapping is null then
    missing_keys := array_append(missing_keys, 'tax:purchase_tax');
  end if;
  if purchase.shipping_amount > 0 and shipping_mapping is null then
    missing_keys := array_append(missing_keys, 'shipping:purchase_shipping');
  end if;
  if purchase.discount_amount > 0 and discount_mapping is null then
    missing_keys := array_append(missing_keys, 'discount:purchase_discount');
  end if;
  if cardinality(missing_keys) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED',
      'reason', 'mapping_missing',
      'missing_keys', to_jsonb(missing_keys)
    );
  end if;

  canonical_lines := jsonb_build_array(jsonb_build_object(
    'account_id', inventory_mapping->>'account_id',
    'debit', round(purchase.subtotal, 2),
    'credit', 0,
    'description', 'Inventario por compra ' || left(purchase.purchase_number, 80),
    'vendor_id', payable.supplier_id
  ));
  if purchase.tax_amount > 0 then
    canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
      'account_id', tax_mapping->>'account_id',
      'debit', round(purchase.tax_amount, 2),
      'credit', 0,
      'description', 'Impuesto recuperable de compra',
      'vendor_id', payable.supplier_id
    ));
  end if;
  if purchase.shipping_amount > 0 then
    canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
      'account_id', shipping_mapping->>'account_id',
      'debit', round(purchase.shipping_amount, 2),
      'credit', 0,
      'description', 'Flete de compra',
      'vendor_id', payable.supplier_id
    ));
  end if;
  if purchase.discount_amount > 0 then
    canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
      'account_id', discount_mapping->>'account_id',
      'debit', 0,
      'credit', round(purchase.discount_amount, 2),
      'description', 'Descuento de compra',
      'vendor_id', payable.supplier_id
    ));
  end if;
  canonical_lines := canonical_lines || jsonb_build_array(jsonb_build_object(
    'account_id', payable_mapping->>'account_id',
    'debit', 0,
    'credit', round(payable.total_amount, 2),
    'description', 'Cuenta por pagar de compra ' || left(purchase.purchase_number, 80),
    'vendor_id', payable.supplier_id
  ));

  canonical_snapshot := jsonb_build_object(
    'snapshot_version', 'purchase_recognition_snapshot_v2',
    'fiscal_snapshot_version', 'purchase_fiscal_v1',
    'event_type', 'accounts_payable_created',
    'posting_purpose', 'PURCHASE_RECOGNITION',
    'posting_version', 'v2',
    'source_version', payable.automation_source,
    'accounting_source_version', 'purchase_recognition_v2',
    'accounts_payable_id', payable.id,
    'purchase_id', purchase.id,
    'supplier_invoice_id', payable.supplier_invoice_id,
    'supplier_id', payable.supplier_id,
    'vendor_id', payable.supplier_id,
    'purchase_number', purchase.purchase_number,
    'invoice_number', invoice.invoice_number,
    'supplier_invoice_date', invoice.invoice_date,
    'document_date', effective_date,
    'accounting_date', effective_date,
    'accounting_date_source', box.accounting_date_source,
    'currency', upper(btrim(payable.currency)),
    'subtotal', round(purchase.subtotal, 2),
    'tax_amount', round(purchase.tax_amount, 2),
    'shipping_amount', round(purchase.shipping_amount, 2),
    'discount_amount', round(purchase.discount_amount, 2),
    'total_amount', round(payable.total_amount, 2),
    'line_classification', 'product_inventory',
    'monetary_precision', 2,
    'outbox_id', box.id,
    'feature_key', box.feature_key,
    'cutover_at', to_char(
      box.cutover_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'scenario', box.scenario,
    'accounting_mapping_snapshot', jsonb_build_object(
      'inventory', inventory_mapping,
      'tax', tax_mapping,
      'shipping', shipping_mapping,
      'discount', discount_mapping,
      'accounts_payable', payable_mapping
    ),
    'manual_publication_required', true
  );

  return jsonb_build_object(
    'ok', true,
    'snapshot', canonical_snapshot,
    'lines', canonical_lines,
    'accounting_date', effective_date,
    'entry_description', left(
      'Reconocimiento de compra ' || purchase.purchase_number,
      500
    )
  );
end;
$$;

revoke all on function public.calculate_purchase_recognition_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.calculate_purchase_recognition_v2(uuid, uuid)
  to service_role;

create or replace function public.purchase_recognition_snapshot_economics_v2(
  source_snapshot jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'snapshot_version', source_snapshot->'snapshot_version',
    'fiscal_snapshot_version', source_snapshot->'fiscal_snapshot_version',
    'event_type', source_snapshot->'event_type',
    'posting_purpose', source_snapshot->'posting_purpose',
    'posting_version', source_snapshot->'posting_version',
    'source_version', source_snapshot->'source_version',
    'accounting_source_version', source_snapshot->'accounting_source_version',
    'accounts_payable_id', source_snapshot->'accounts_payable_id',
    'purchase_id', source_snapshot->'purchase_id',
    'supplier_invoice_id', source_snapshot->'supplier_invoice_id',
    'supplier_id', source_snapshot->'supplier_id',
    'vendor_id', source_snapshot->'vendor_id',
    'purchase_number', source_snapshot->'purchase_number',
    'invoice_number', source_snapshot->'invoice_number',
    'supplier_invoice_date', source_snapshot->'supplier_invoice_date',
    'document_date', source_snapshot->'document_date',
    'accounting_date', source_snapshot->'accounting_date',
    'accounting_date_source', source_snapshot->'accounting_date_source',
    'currency', source_snapshot->'currency',
    'subtotal', source_snapshot->'subtotal',
    'tax_amount', source_snapshot->'tax_amount',
    'shipping_amount', source_snapshot->'shipping_amount',
    'discount_amount', source_snapshot->'discount_amount',
    'total_amount', source_snapshot->'total_amount',
    'line_classification', source_snapshot->'line_classification',
    'monetary_precision', source_snapshot->'monetary_precision',
    'outbox_id', source_snapshot->'outbox_id',
    'feature_key', source_snapshot->'feature_key',
    'cutover_at', source_snapshot->'cutover_at',
    'scenario', source_snapshot->'scenario',
    'accounting_mapping_snapshot', source_snapshot->'accounting_mapping_snapshot',
    'manual_publication_required', source_snapshot->'manual_publication_required'
  )
$$;

revoke all on function public.purchase_recognition_snapshot_economics_v2(jsonb)
  from public, anon, authenticated;
grant execute on function public.purchase_recognition_snapshot_economics_v2(jsonb)
  to service_role;

create or replace function public.purchase_recognition_lines_signature_v2(
  lines_data jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'account_id', item->>'account_id',
      'debit', round(coalesce((item->>'debit')::numeric, 0), 2),
      'credit', round(coalesce((item->>'credit')::numeric, 0), 2),
      'description', item->'description',
      'customer_id', item->'customer_id',
      'vendor_id', item->'vendor_id',
      'product_id', item->'product_id'
    ) order by
      item->>'account_id',
      round(coalesce((item->>'debit')::numeric, 0), 2),
      round(coalesce((item->>'credit')::numeric, 0), 2),
      coalesce(item->>'description', ''),
      coalesce(item->>'customer_id', ''),
      coalesce(item->>'vendor_id', ''),
      coalesce(item->>'product_id', '')
  ), '[]'::jsonb)
  from jsonb_array_elements(lines_data) item
$$;

create or replace function public.purchase_recognition_entry_signature_v2(
  p_journal_entry_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'account_id', line.account_id::text,
      'debit', round(line.debit, 2),
      'credit', round(line.credit, 2),
      'description', to_jsonb(line.description),
      'customer_id', to_jsonb(line.customer_id),
      'vendor_id', to_jsonb(line.vendor_id),
      'product_id', to_jsonb(line.product_id)
    ) order by
      line.account_id::text,
      round(line.debit, 2),
      round(line.credit, 2),
      coalesce(line.description, ''),
      coalesce(line.customer_id::text, ''),
      coalesce(line.vendor_id::text, ''),
      coalesce(line.product_id::text, '')
  ), '[]'::jsonb)
  from public.journal_entry_lines line
  where line.journal_entry_id = p_journal_entry_id
$$;

revoke all on function public.purchase_recognition_lines_signature_v2(jsonb)
  from public, anon, authenticated;
revoke all on function public.purchase_recognition_entry_signature_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.purchase_recognition_lines_signature_v2(jsonb)
  to service_role;
grant execute on function public.purchase_recognition_entry_signature_v2(uuid)
  to service_role;

create or replace function public.validate_purchase_recognition_chain_v2(
  p_accounts_payable_id uuid,
  p_canonical_snapshot jsonb,
  p_canonical_lines jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  event public.financial_events%rowtype;
  entry public.journal_entries%rowtype;
  box public.accounting_outbox_v2%rowtype;
  linked_entry_count integer := 0;
  line_count integer := 0;
  debit_total numeric(14, 2) := 0;
  credit_total numeric(14, 2) := 0;
  invalid_line_count integer := 0;
begin
  if exists (
    select 1
    from public.financial_events legacy
    where legacy.source_type = 'accounts_payable'
      and legacy.source_id = p_accounts_payable_id::text
      and legacy.event_purpose = 'accounts_payable_created'
      and legacy.posting_version = 'v1'
      and (
        legacy.journal_entry_id is not null
        or legacy.status in ('draft_created', 'posted', 'reversed')
        or exists (
          select 1
          from public.journal_entries legacy_entry
          where legacy_entry.source_type = 'financial_event'
            and legacy_entry.source_id = legacy.id::text
        )
      )
  ) then
    return 'PURCHASE_ACCOUNTING_LEGACY_CONFLICT';
  end if;

  select * into event
  from public.financial_events candidate
  where candidate.source_type = 'accounts_payable'
    and candidate.source_id = p_accounts_payable_id::text
    and candidate.event_purpose = 'accounts_payable_created'
    and candidate.posting_version = 'v2';

  if event.id is null then
    return 'PURCHASE_ACCOUNTING_PENDING';
  end if;
  if public.purchase_recognition_snapshot_economics_v2(event.source_snapshot)
    <> public.purchase_recognition_snapshot_economics_v2(p_canonical_snapshot)
    or event.accounting_date is distinct from
      (p_canonical_snapshot->>'accounting_date')::date
  then
    return 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT';
  end if;

  select count(*), (array_agg(candidate.id order by candidate.id))[1]
  into linked_entry_count, entry.id
  from public.journal_entries candidate
  where candidate.source_type = 'financial_event'
    and candidate.source_id = event.id::text;
  if linked_entry_count > 1 then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;
  if entry.id is null and event.journal_entry_id is not null then
    entry.id := event.journal_entry_id;
  end if;
  if entry.id is null then
    if event.status in ('failed', 'skipped') then
      return 'PURCHASE_ACCOUNTING_FAILED';
    end if;
    if event.status in ('draft_created', 'posted', 'reversed') then
      return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
    end if;
    return 'PURCHASE_ACCOUNTING_PENDING';
  end if;

  select * into entry
  from public.journal_entries
  where id = entry.id;
  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.id = nullif(p_canonical_snapshot->>'outbox_id', '')::uuid;
  if entry.id is null
    or box.id is null
    or (event.journal_entry_id is not null and event.journal_entry_id <> entry.id)
    or (box.financial_event_id is not null and box.financial_event_id <> event.id)
    or (box.journal_entry_id is not null and box.journal_entry_id <> entry.id)
    or entry.source_type <> 'financial_event'
    or entry.source_id <> event.id::text
    or entry.status not in ('borrador', 'publicada')
    or entry.entry_date <> (p_canonical_snapshot->>'accounting_date')::date
    or event.validation_errors <> '[]'::jsonb
    or entry.metadata->>'entry_kind' <> 'automatic'
    or entry.metadata->>'generated_from_source' <> 'true'
    or entry.metadata->>'accounting_outbox_v2_id'
      <> p_canonical_snapshot->>'outbox_id'
    or entry.metadata->>'feature_key' <> 'purchase_recognition_draft_v2'
    or entry.metadata->>'posting_version' <> 'v2'
    or entry.metadata->>'accounting_purpose' <> 'PURCHASE_RECOGNITION'
    or entry.metadata->>'accounting_source_version' <> 'purchase_recognition_v2'
    or entry.metadata->>'scenario' <> 'purchase_inventory_v2'
    or entry.metadata->>'manual_publication_required' <> 'true'
  then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;

  select
    count(*),
    round(coalesce(sum(line.debit), 0), 2),
    round(coalesce(sum(line.credit), 0), 2),
    count(*) filter (
      where (line.debit > 0 and line.credit > 0)
        or (line.debit = 0 and line.credit = 0)
        or line.debit < 0
        or line.credit < 0
    )
  into line_count, debit_total, credit_total, invalid_line_count
  from public.journal_entry_lines line
  where line.journal_entry_id = entry.id;
  if line_count = 0
    or debit_total <> credit_total
    or invalid_line_count > 0
  then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;

  if public.purchase_recognition_entry_signature_v2(entry.id)
    <> public.purchase_recognition_lines_signature_v2(p_canonical_lines)
  then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;
  if event.status in ('failed', 'skipped', 'reversed') then
    return 'PURCHASE_ACCOUNTING_FAILED';
  end if;
  if event.status not in ('draft_created', 'posted') then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;
  return 'PURCHASE_ACCOUNTING_DRAFTED';
exception
  when others then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
end;
$$;

revoke all on function public.validate_purchase_recognition_chain_v2(
  uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.validate_purchase_recognition_chain_v2(
  uuid, jsonb, jsonb
) to service_role;

-- Single semantic integrity gate used by completeness, payment dependencies,
-- multi-invoice dependencies and worker replay.  RETRYABLE means that exact
-- evidence exists under an operational state that may be reconciled by the
-- worker; it is deliberately not healthy and never satisfies a payment gate.
create or replace function public.purchase_recognition_validity_v2(
  p_accounts_payable_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  box public.accounting_outbox_v2%rowtype;
  canonical jsonb;
  chain_state text;
begin
  if not public.purchase_accounting_scope_v2(p_accounts_payable_id) then
    return 'PURCHASE_ACCOUNTING_NOT_REQUIRED';
  end if;

  select * into box
  from public.accounting_outbox_v2 candidate
  where candidate.source_type = 'accounts_payable'
    and candidate.source_id = p_accounts_payable_id
    and candidate.event_purpose = 'accounts_payable_created'
    and candidate.posting_version = 'v2';

  if box.id is null then
    return 'ACCOUNTING_INCOMPLETE';
  end if;

  canonical := public.calculate_purchase_recognition_v2(
    p_accounts_payable_id,
    box.id
  );
  if not coalesce((canonical->>'ok')::boolean, false) then
    return case canonical->>'error_code'
      when 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
        then 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
      when 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
        then 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
      when 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED'
        then 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED'
      when 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED'
        then 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED'
      when 'ACCOUNTING_INCOMPLETE' then 'ACCOUNTING_INCOMPLETE'
      else 'PURCHASE_ACCOUNTING_FAILED'
    end;
  end if;

  chain_state := public.validate_purchase_recognition_chain_v2(
    p_accounts_payable_id,
    canonical->'snapshot',
    canonical->'lines'
  );

  -- Integrity conflicts always have precedence over operational retry state.
  if chain_state = 'PURCHASE_ACCOUNTING_LEGACY_CONFLICT'
    or box.last_error_code = 'PURCHASE_ACCOUNTING_LEGACY_CONFLICT'
  then
    return 'PURCHASE_ACCOUNTING_LEGACY_CONFLICT';
  end if;
  if chain_state = 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
    or box.last_error_code = 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
  then
    return 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT';
  end if;
  if chain_state = 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT'
    or box.last_error_code = 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT'
  then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;

  if box.status = 'pending_mapping'
    or box.last_error_code = 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
  then
    return 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED';
  end if;
  if box.last_error_code = 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED' then
    return 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED';
  end if;
  if box.last_error_code = 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED' then
    return 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED';
  end if;
  if box.last_error_code in (
    'PURCHASE_ACCOUNTING_FAILED',
    'PURCHASE_ACCOUNTING_UNSUPPORTED_CURRENCY',
    'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT'
  ) or box.status in ('failed', 'cancelled')
    or box.cancelled_at is not null
    or chain_state = 'PURCHASE_ACCOUNTING_FAILED'
  then
    return 'PURCHASE_ACCOUNTING_FAILED';
  end if;

  if chain_state = 'PURCHASE_ACCOUNTING_DRAFTED' then
    if box.status = 'completed'
      and box.last_error_code is null
      and box.cancelled_at is null
      and box.financial_event_id is not null
      and box.journal_entry_id is not null
    then
      return 'PURCHASE_ACCOUNTING_DRAFTED';
    end if;
    if box.status in ('queued', 'processing', 'pending_data')
      and box.last_error_code is null
      and box.cancelled_at is null
    then
      return 'PURCHASE_ACCOUNTING_RETRYABLE';
    end if;
    return 'PURCHASE_ACCOUNTING_FAILED';
  end if;

  if box.status = 'completed' then
    return 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;
  if box.status in ('queued', 'processing', 'pending_data') then
    return 'PURCHASE_ACCOUNTING_PENDING';
  end if;

  -- The obligation exists at this point. Any unclassified operational state is
  -- a fail-closed integrity failure; ACCOUNTING_INCOMPLETE is reserved for a
  -- missing required outbox obligation.
  return 'PURCHASE_ACCOUNTING_FAILED';
end;
$$;

revoke all on function public.purchase_recognition_validity_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.purchase_recognition_validity_v2(uuid)
  to service_role;

create or replace function public.purchase_accounting_completeness_v2(
  p_accounts_payable_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  validity_state text;
begin
  validity_state := public.purchase_recognition_validity_v2(
    p_accounts_payable_id
  );
  if validity_state = 'PURCHASE_ACCOUNTING_RETRYABLE' then
    return 'PURCHASE_ACCOUNTING_PENDING';
  end if;
  return validity_state;
end;
$$;

revoke all on function public.purchase_accounting_completeness_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.purchase_accounting_completeness_v2(uuid)
  to service_role;

create or replace function public.supplier_payment_purchase_obligation_v2(
  p_supplier_payment_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  scoped_count integer := 0;
  obligation_count integer := 0;
begin
  with payable_ids as (
    select payment.accounts_payable_id as payable_id
    from public.supplier_payments payment
    where payment.id = p_supplier_payment_id
      and payment.accounts_payable_id is not null
    union
    select application.accounts_payable_id
    from public.supplier_payment_applications application
    where application.supplier_payment_id = p_supplier_payment_id
      and application.status = 'applied'
  ), scoped as (
    select payable_id
    from payable_ids
    where public.purchase_accounting_scope_v2(payable_id)
  )
  select
    count(*),
    count(*) filter (
      where exists (
        select 1
        from public.accounting_outbox_v2 box
        where box.source_type = 'accounts_payable'
          and box.source_id = scoped.payable_id
          and box.event_purpose = 'accounts_payable_created'
          and box.posting_version = 'v2'
          and box.feature_key = 'purchase_recognition_draft_v2'
          and box.topic = 'payables.purchase_recognition'
          and box.scenario = 'purchase_inventory_v2'
          and box.idempotency_key = 'accounts_payable:' || scoped.payable_id::text
            || ':accounts_payable_created:v2'
      )
    )
  into scoped_count, obligation_count
  from scoped;

  if scoped_count = 0 then
    return 'PURCHASE_ACCOUNTING_NOT_REQUIRED';
  end if;
  if scoped_count = obligation_count then
    return 'PURCHASE_ACCOUNTING_OBLIGATION_EXISTS';
  end if;
  return 'ACCOUNTING_INCOMPLETE';
end;
$$;

revoke all on function public.supplier_payment_purchase_obligation_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_purchase_obligation_v2(uuid)
  to service_role;

create or replace function public.supplier_payment_purchase_dependency_v2(
  p_supplier_payment_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  scoped_count integer := 0;
  ready_count integer := 0;
begin
  with payable_ids as (
    select payment.accounts_payable_id as payable_id
    from public.supplier_payments payment
    where payment.id = p_supplier_payment_id
      and payment.accounts_payable_id is not null
    union
    select application.accounts_payable_id
    from public.supplier_payment_applications application
    where application.supplier_payment_id = p_supplier_payment_id
      and application.status = 'applied'
  ), scoped as (
    select payable_id
    from payable_ids
    where public.purchase_accounting_scope_v2(payable_id)
  )
  select
    count(*),
    count(*) filter (
      where public.purchase_recognition_validity_v2(payable_id)
        = 'PURCHASE_ACCOUNTING_DRAFTED'
    )
  into scoped_count, ready_count
  from scoped;

  if scoped_count = 0 then
    return 'PURCHASE_ACCOUNTING_NOT_REQUIRED';
  end if;
  if scoped_count = ready_count then
    return 'PURCHASE_ACCOUNTING_DRAFTED';
  end if;
  return 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING';
end;
$$;

revoke all on function public.supplier_payment_purchase_dependency_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_purchase_dependency_v2(uuid)
  to service_role;

alter function public.route_supplier_payment_accounting_v2(uuid, uuid)
  rename to route_supplier_payment_accounting_v2_pre_purchase_recognition;

revoke all on function public.route_supplier_payment_accounting_v2_pre_purchase_recognition(uuid, uuid)
  from public, anon, authenticated, service_role;

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
  obligation_status text;
  payment public.supplier_payments%rowtype;
  flag public.accounting_feature_flags%rowtype;
  routing_at timestamptz;
  existing_id uuid;
  result_id uuid;
begin
  if p_payment_id is null then
    return null;
  end if;

  obligation_status := public.supplier_payment_purchase_obligation_v2(
    p_payment_id
  );
  if obligation_status = 'ACCOUNTING_INCOMPLETE' then
    return null;
  end if;

  select * into payment
  from public.supplier_payments
  where id = p_payment_id;

  -- New purchase/AP scope is allowed to queue a settlement obligation before
  -- manual publication. Draft creation is still blocked by the worker until
  -- purchase recognition itself has a valid draft. Historical single-payment
  -- and all multi-invoice routing retain their pre-existing implementations.
  if obligation_status = 'PURCHASE_ACCOUNTING_OBLIGATION_EXISTS'
    and coalesce(payment.allocation_mode, 'legacy_single') = 'legacy_single'
  then
    select * into flag
    from public.accounting_feature_flags
    where key = 'supplier_payment_draft_v2';

    if payment.id is null
      or payment.status <> 'paid'
      or flag.key is null
      or flag.state <> 'enabled'
      or flag.cutover_at is null
    then
      return null;
    end if;

    routing_at := public.supplier_payment_accounting_occurred_at(
      payment.paid_at,
      payment.created_at,
      flag.cutover_at
    );
    if routing_at is null then
      return null;
    end if;

    select box.id into existing_id
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
      coalesce(payment.payment_method_v2, 'legacy_method_pending_data'),
      routing_at,
      coalesce(p_actor_id, payment.created_by, auth.uid())
    );

    if result_id is null then
      return null;
    end if;

    update public.accounting_outbox_v2
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'source_type', 'supplier_payment',
          'payment_id', payment.id,
          'accounts_payable_id', payment.accounts_payable_id,
          'effective_paid_at', payment.paid_at,
          'recorded_at', payment.created_at,
          'accounting_occurred_at', routing_at,
          'routing_origin', 'purchase_confirmation_v2',
          'purchase_recognition_dependency', true,
          'manual_publication_required', true
        )
    where id = result_id;

    insert into public.accounting_event_log (
      event_type, entity_type, entity_id,
      source_type, source_id, metadata, created_by
    )
    values (
      case when existing_id is null
        then 'supplier_payment_purchase_dependency_routed'
        else 'supplier_payment_already_accounted'
      end,
      'accounting_outbox_v2', result_id,
      'supplier_payment', payment.id::text,
      jsonb_build_object(
        'payment_id', payment.id,
        'accounts_payable_id', payment.accounts_payable_id,
        'outbox_id', result_id,
        'duplicate_avoided', existing_id is not null,
        'purchase_recognition_dependency', true,
        'manual_publication_required', true
      ),
      coalesce(p_actor_id, payment.created_by, auth.uid())
    );

    return result_id;
  end if;

  return public.route_supplier_payment_accounting_v2_pre_purchase_recognition(
    p_payment_id,
    p_actor_id
  );
end;
$$;

revoke all on function public.route_supplier_payment_accounting_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.route_supplier_payment_accounting_v2(uuid, uuid)
  to service_role;

alter function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) rename to confirm_purchase_with_payable_v1_pre_recognition;

revoke all on function public.confirm_purchase_with_payable_v1_pre_recognition(
  uuid, text, date, numeric, text, date, text, uuid
) from public, anon, authenticated, service_role;

create or replace function public.confirm_purchase_with_payable_v1(
  target_purchase_id uuid,
  p_payment_condition text,
  p_due_date date,
  p_initial_payment_amount numeric,
  p_payment_method text,
  p_payment_date date,
  p_payment_notes text,
  p_request_key uuid
)
returns table (
  purchase_id uuid,
  purchase_status text,
  accounts_payable_id uuid,
  accounts_payable_status text,
  total_amount numeric,
  paid_amount numeric,
  balance numeric,
  due_date date,
  supplier_payment_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  result_row record;
  flag public.accounting_feature_flags%rowtype;
  purchase public.purchases%rowtype;
  outbox_id uuid;
  recognition_scope_activated boolean := false;
begin
  select * into result_row
  from public.confirm_purchase_with_payable_v1_pre_recognition(
    target_purchase_id,
    p_payment_condition,
    p_due_date,
    p_initial_payment_amount,
    p_payment_method,
    p_payment_date,
    p_payment_notes,
    p_request_key
  );

  select * into purchase
  from public.purchases
  where id = result_row.purchase_id
  for update;

  select * into flag
  from public.accounting_feature_flags
  where key = 'purchase_recognition_draft_v2'
  for share;

  if flag.state = 'enabled'
    and flag.cutover_at is not null
    and purchase.confirmed_at >= flag.cutover_at
  then
    update public.purchases
    set accounting_recognition_version = 'v2',
        updated_at = now()
    where id = purchase.id;

    update public.accounts_payable payable_target
    set accounting_recognition_version = 'v2',
        updated_at = now()
    where payable_target.id = result_row.accounts_payable_id
      and payable_target.purchase_id = purchase.id
      and payable_target.automation_source = 'purchase_confirmation_v1';

    if not found then
      raise exception using
        errcode = '55000',
        message = 'PURCHASE_ACCOUNTING_SCOPE_REQUIRED';
    end if;

    if exists (
      select 1
      from public.financial_events legacy
      where legacy.source_type = 'accounts_payable'
        and legacy.source_id = result_row.accounts_payable_id::text
        and legacy.event_purpose = 'accounts_payable_created'
        and legacy.posting_version = 'v1'
        and (
          legacy.journal_entry_id is not null
          or legacy.status in ('draft_created', 'posted', 'reversed')
          or exists (
            select 1
            from public.journal_entries legacy_entry
            where legacy_entry.source_type = 'financial_event'
              and legacy_entry.source_id = legacy.id::text
          )
        )
    ) then
      raise exception using
        errcode = 'PT409',
        message = 'PURCHASE_ACCOUNTING_LEGACY_CONFLICT';
    end if;

    outbox_id := public.route_purchase_recognition_accounting_v2(
      result_row.accounts_payable_id,
      auth.uid()
    );
    if outbox_id is null
      or public.require_purchase_recognition_outbox_v2(
        result_row.accounts_payable_id,
        outbox_id
      ) is null
    then
      raise exception using
        errcode = '55000',
        message = 'PURCHASE_ACCOUNTING_OBLIGATION_REQUIRED';
    end if;

    update public.financial_events legacy
    set status = 'skipped',
        updated_at = now()
    where legacy.source_type = 'accounts_payable'
      and legacy.source_id = result_row.accounts_payable_id::text
      and legacy.event_purpose = 'accounts_payable_created'
      and legacy.posting_version = 'v1'
      and legacy.journal_entry_id is null
      and legacy.status in ('pending', 'ready', 'failed', 'skipped');

    recognition_scope_activated := true;
  end if;

  -- Immediate/partial payments are inserted by the preserved V1 RPC before the
  -- purchase-recognition obligation exists. Route them again now; the wrapper
  -- above is idempotent and only proceeds once the new-scope dependency exists.
  if recognition_scope_activated
    and result_row.supplier_payment_id is not null
  then
    perform public.route_supplier_payment_accounting_v2(
      result_row.supplier_payment_id,
      auth.uid()
    );
  end if;

  purchase_id := result_row.purchase_id;
  purchase_status := result_row.purchase_status;
  accounts_payable_id := result_row.accounts_payable_id;
  accounts_payable_status := result_row.accounts_payable_status;
  total_amount := result_row.total_amount;
  paid_amount := result_row.paid_amount;
  balance := result_row.balance;
  due_date := result_row.due_date;
  supplier_payment_id := result_row.supplier_payment_id;
  replayed := result_row.replayed;
  return next;
end;
$$;

revoke all on function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) from public, anon;
grant execute on function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) to authenticated;

comment on function public.confirm_purchase_with_payable_v1(
  uuid, text, date, numeric, text, date, text, uuid
) is
  'Atomic purchase/AP confirmation. When prospective recognition V2 is enabled after its cutover, the transaction cannot complete without one canonical AP-recognition outbox obligation.';

create or replace function public.process_purchase_recognition_outbox_v2(
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
  clean_worker text := nullif(left(btrim(coalesce(worker_token, '')), 120), '');
  box public.accounting_outbox_v2%rowtype;
  flag public.accounting_feature_flags%rowtype;
  payable public.accounts_payable%rowtype;
  purchase public.purchases%rowtype;
  invoice public.supplier_invoices%rowtype;
  event public.financial_events%rowtype;
  entry public.journal_entries%rowtype;
  draft_actor uuid;
  effective_date date;
  item_count integer := 0;
  unknown_item_count integer := 0;
  item_subtotal numeric(14, 2) := 0;
  item_tax numeric(14, 2) := 0;
  item_discount numeric(14, 2) := 0;
  item_total numeric(14, 2) := 0;
  inventory_account uuid;
  payable_account uuid;
  tax_account uuid;
  shipping_account uuid;
  discount_account uuid;
  missing_keys text[] := array[]::text[];
  reason_code text;
  public_error_code text;
  validation_errors jsonb := '[]'::jsonb;
  canonical_lines jsonb := '[]'::jsonb;
  normalized_lines jsonb;
  entry_id uuid;
  entry_number_value text;
begin
  if clean_worker is null then
    raise exception using errcode = '22023', message = 'ACCOUNTING_WORKER_ID_REQUIRED';
  end if;
  if not service_call and (
    caller_id is null
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  ) then
    raise exception using errcode = '42501', message = 'ACCOUNTING_OUTBOX_FORBIDDEN';
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
  if box.source_type = 'accounts_payable'
    and box.event_purpose = 'accounts_payable_created'
    and box.posting_version = 'v2'
    and (
      box.feature_key <> 'purchase_recognition_draft_v2'
      or box.topic <> 'payables.purchase_recognition'
      or box.scenario <> 'purchase_inventory_v2'
      or box.idempotency_key <> 'accounts_payable:' || box.source_id::text
        || ':accounts_payable_created:v2'
    )
  then
    update public.accounting_outbox_v2
    set status = 'failed',
        lease_until = null,
        locked_by = null,
        last_error_code = 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT',
        last_error_message = 'La obligacion canonica de compra tiene enrutamiento incompatible.'
    where id = box.id;
    return jsonb_build_object(
      'ok', false, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', 'failed', 'reason', 'canonical_conflict',
      'error_code', 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT'
    );
  end if;
  if box.topic <> 'payables.purchase_recognition'
    or box.source_type <> 'accounts_payable'
    or box.event_purpose <> 'accounts_payable_created'
    or box.posting_version <> 'v2'
  then
    return jsonb_build_object(
      'ok', false, 'claimed', false, 'outbox_id', box.id,
      'outbox_status', box.status, 'reason', 'unsupported_purchase_fact'
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

  if flag.key is null
    or flag.state <> 'enabled'
    or flag.cutover_at is null
    or box.occurred_at < flag.cutover_at
  then
    reason_code := 'feature_not_enabled';
    public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
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
  if reason_code is null and (
    draft_actor is null
    or not exists (
      select 1 from public.users where id = draft_actor and active = true
    )
  ) then
    reason_code := 'missing_automation_actor';
    public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
  end if;

  if reason_code is null then
    select * into payable
    from public.accounts_payable
    where id = box.source_id
    for share;

    if payable.id is null then
      reason_code := 'accounts_payable_missing';
      public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
    elsif not public.purchase_accounting_scope_v2(payable.id) then
      reason_code := 'purchase_recognition_scope_missing';
      public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
    elsif payable.status = 'cancelled' then
      update public.accounting_outbox_v2
      set status = 'cancelled',
          cancelled_at = now(),
          lease_until = null,
          locked_by = null,
          last_error_code = 'source_cancelled',
          last_error_message = 'La cuenta por pagar fue cancelada antes del borrador.'
      where id = box.id;
      return jsonb_build_object(
        'ok', true, 'claimed', true, 'outbox_id', box.id,
        'outbox_status', 'cancelled', 'reason', 'source_cancelled'
      );
    elsif upper(btrim(payable.currency)) <> 'HNL' then
      reason_code := 'unsupported_currency';
      public_error_code := 'PURCHASE_ACCOUNTING_UNSUPPORTED_CURRENCY';
    end if;
  end if;

  if reason_code is null then
    select * into purchase
    from public.purchases
    where id = payable.purchase_id
    for share;

    if purchase.id is null
      or purchase.status not in ('confirmed', 'received', 'returned')
      or purchase.supplier_id <> payable.supplier_id
      or round(purchase.total, 2) <> round(payable.total_amount, 2)
      or upper(btrim(purchase.currency)) <> upper(btrim(payable.currency))
    then
      reason_code := 'purchase_payable_mismatch';
      public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
    end if;
  end if;

  if reason_code is null and payable.supplier_invoice_id is not null then
    select * into invoice
    from public.supplier_invoices
    where id = payable.supplier_invoice_id
    for share;

    if invoice.id is null
      or invoice.purchase_id is distinct from purchase.id
      or invoice.supplier_id <> payable.supplier_id
      or invoice.status = 'cancelled'
      or round(invoice.total, 2) <> round(payable.total_amount, 2)
      or upper(btrim(invoice.currency)) <> upper(btrim(payable.currency))
    then
      reason_code := 'supplier_invoice_payable_mismatch';
      public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
    end if;
  end if;

  effective_date := box.accounting_date;
  if reason_code is null and effective_date is null then
    reason_code := 'accounting_date_required';
    public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
  elsif reason_code is null
    and public.is_date_in_closed_accounting_period(effective_date)
  then
    reason_code := 'period_closed';
    public_error_code := 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED';
  end if;

  if reason_code is null then
    select
      count(*),
      count(*) filter (where item.product_id is null),
      round(coalesce(sum(item.quantity * item.unit_cost), 0), 2),
      round(coalesce(sum(item.tax_amount), 0), 2),
      round(coalesce(sum(item.discount_amount), 0), 2),
      round(coalesce(sum(item.total_cost), 0), 2)
    into
      item_count,
      unknown_item_count,
      item_subtotal,
      item_tax,
      item_discount,
      item_total
    from public.purchase_items item
    where item.purchase_id = purchase.id;

    if item_count < 1 then
      reason_code := 'purchase_items_missing';
      public_error_code := 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED';
    elsif unknown_item_count > 0 then
      reason_code := 'non_inventory_line_unclassified';
      public_error_code := 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED';
    elsif item_subtotal <> round(purchase.subtotal, 2)
      or item_tax <> round(purchase.tax_amount, 2)
      or item_discount <> round(purchase.discount_amount, 2)
      or item_total + round(purchase.shipping_amount, 2) <> round(purchase.total, 2)
      or round(
        purchase.subtotal + purchase.tax_amount + purchase.shipping_amount
          - purchase.discount_amount,
        2
      ) <> round(purchase.total, 2)
    then
      reason_code := 'purchase_fiscal_breakdown_mismatch';
      public_error_code := 'PURCHASE_ACCOUNTING_FAILED';
    end if;
  end if;

  if reason_code is null then
    inventory_account := public.resolve_accounting_mapping_v2(
      'inventory', 'purchase_inventory', effective_date
    );
    payable_account := public.resolve_accounting_mapping_v2(
      'default_account', 'accounts_payable', effective_date
    );
    if purchase.tax_amount > 0 then
      tax_account := public.resolve_accounting_mapping_v2(
        'tax', 'purchase_tax', effective_date
      );
    end if;
    if purchase.shipping_amount > 0 then
      shipping_account := public.resolve_accounting_mapping_v2(
        'shipping', 'purchase_shipping', effective_date
      );
    end if;
    if purchase.discount_amount > 0 then
      discount_account := public.resolve_accounting_mapping_v2(
        'discount', 'purchase_discount', effective_date
      );
    end if;

    if inventory_account is null then
      missing_keys := array_append(missing_keys, 'inventory:purchase_inventory');
    end if;
    if payable_account is null then
      missing_keys := array_append(missing_keys, 'default_account:accounts_payable');
    end if;
    if purchase.tax_amount > 0 and tax_account is null then
      missing_keys := array_append(missing_keys, 'tax:purchase_tax');
    end if;
    if purchase.shipping_amount > 0 and shipping_account is null then
      missing_keys := array_append(missing_keys, 'shipping:purchase_shipping');
    end if;
    if purchase.discount_amount > 0 and discount_account is null then
      missing_keys := array_append(missing_keys, 'discount:purchase_discount');
    end if;

    if cardinality(missing_keys) > 0 then
      reason_code := 'mapping_missing';
      public_error_code := 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED';
    end if;
  end if;

  if reason_code is null then
    canonical_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', inventory_account,
        'debit', round(purchase.subtotal, 2),
        'credit', 0,
        'description', 'Inventario por compra ' || left(purchase.purchase_number, 80),
        'vendor_id', payable.supplier_id
      )
    );
    if purchase.tax_amount > 0 then
      canonical_lines := canonical_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', tax_account,
          'debit', round(purchase.tax_amount, 2),
          'credit', 0,
          'description', 'Impuesto recuperable de compra',
          'vendor_id', payable.supplier_id
        )
      );
    end if;
    if purchase.shipping_amount > 0 then
      canonical_lines := canonical_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', shipping_account,
          'debit', round(purchase.shipping_amount, 2),
          'credit', 0,
          'description', 'Flete de compra',
          'vendor_id', payable.supplier_id
        )
      );
    end if;
    if purchase.discount_amount > 0 then
      canonical_lines := canonical_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', discount_account,
          'debit', 0,
          'credit', round(purchase.discount_amount, 2),
          'description', 'Descuento de compra',
          'vendor_id', payable.supplier_id
        )
      );
    end if;
    canonical_lines := canonical_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', payable_account,
        'debit', 0,
        'credit', round(payable.total_amount, 2),
        'description', 'Cuenta por pagar de compra ' || left(purchase.purchase_number, 80),
        'vendor_id', payable.supplier_id
      )
    );
  end if;

  validation_errors := case
    when reason_code is null then '[]'::jsonb
    when cardinality(missing_keys) > 0 then to_jsonb(missing_keys)
    else jsonb_build_array(public_error_code)
  end;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  )
  values (
    'accounts_payable', box.source_id::text,
    'accounts_payable_created', 'v2',
    case when reason_code is null then 'ready' else 'pending' end,
    box.occurred_at,
    jsonb_build_object(
      'event_type', 'accounts_payable_created',
      'accounts_payable_id', payable.id,
      'purchase_id', purchase.id,
      'supplier_invoice_id', payable.supplier_invoice_id,
      'supplier_id', payable.supplier_id,
      'vendor_id', payable.supplier_id,
      'purchase_number', purchase.purchase_number,
      'invoice_number', invoice.invoice_number,
      'document_date', effective_date,
      'accounting_date', effective_date,
      'accounting_date_source', box.accounting_date_source,
      'subtotal', purchase.subtotal,
      'tax_amount', purchase.tax_amount,
      'shipping_amount', purchase.shipping_amount,
      'discount_amount', purchase.discount_amount,
      'total_amount', payable.total_amount,
      'currency', payable.currency,
      'line_classification', case
        when unknown_item_count = 0 and item_count > 0 then 'product_inventory'
        else 'classification_required'
      end,
      'outbox_id', box.id,
      'feature_key', box.feature_key,
      'cutover_at', box.cutover_at,
      'scenario', box.scenario,
      'posting_version', 'v2',
      'accounting_source_version', 'purchase_recognition_v2',
      'manual_publication_required', true
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
    select * into entry
    from public.journal_entries
    where id = event.journal_entry_id;

    if entry.id is not null and entry.status in ('borrador', 'publicada') then
      update public.accounting_outbox_v2
      set status = 'completed',
          financial_event_id = event.id,
          journal_entry_id = entry.id,
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
        'journal_entry_id', entry.id, 'reason', 'existing_draft_reused'
      );
    end if;
  end if;

  select * into entry
  from public.journal_entries
  where source_type = 'financial_event'
    and source_id = event.id::text;

  if entry.id is not null and entry.status in ('borrador', 'publicada') then
    update public.financial_events
    set status = case when entry.status = 'publicada' then 'posted' else 'draft_created' end,
        journal_entry_id = entry.id,
        validation_errors = '[]'::jsonb,
        updated_at = now()
    where id = event.id;
    update public.accounting_outbox_v2
    set status = 'completed',
        financial_event_id = event.id,
        journal_entry_id = entry.id,
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
      'journal_entry_id', entry.id, 'reason', 'existing_draft_reused'
    );
  end if;

  if reason_code is not null then
    update public.accounting_outbox_v2
    set status = case
          when public_error_code = 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
            then 'pending_mapping'
          when public_error_code = 'PURCHASE_ACCOUNTING_FAILED'
            and reason_code in (
              'feature_not_enabled',
              'purchase_recognition_scope_missing',
              'purchase_payable_mismatch',
              'supplier_invoice_payable_mismatch'
            ) then 'failed'
          else 'pending_data'
        end,
        financial_event_id = event.id,
        next_attempt_at = now() + interval '15 minutes',
        lease_until = null,
        locked_by = null,
        last_error_code = public_error_code,
        last_error_message = case public_error_code
          when 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
            then 'Falta configurar uno o mas mapeos contables requeridos.'
          when 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED'
            then 'La fecha canonica pertenece a un periodo contable cerrado.'
          when 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED'
            then 'Una o mas lineas no tienen clasificacion contable segura.'
          when 'PURCHASE_ACCOUNTING_UNSUPPORTED_CURRENCY'
            then 'La moneda no es compatible con reconocimiento de compras V2.'
          else 'El hecho de compra no cumple las precondiciones contables.'
        end,
        missing_key = case
          when cardinality(missing_keys) > 0
            then left(array_to_string(missing_keys, ', '), 240)
          else left(reason_code, 240)
        end
    where id = box.id;

    return jsonb_build_object(
      'ok', true, 'claimed', true, 'outbox_id', box.id,
      'outbox_status', case
        when public_error_code = 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
          then 'pending_mapping'
        when public_error_code = 'PURCHASE_ACCOUNTING_FAILED'
          and reason_code in (
            'feature_not_enabled',
            'purchase_recognition_scope_missing',
            'purchase_payable_mismatch',
            'supplier_invoice_payable_mismatch'
          ) then 'failed'
        else 'pending_data'
      end,
      'event_id', event.id,
      'reason', reason_code,
      'error_code', public_error_code,
      'missing_keys', to_jsonb(missing_keys)
    );
  end if;

  normalized_lines := public.normalize_journal_draft_lines(canonical_lines);
  entry_number_value := public.next_journal_entry_number();

  insert into public.journal_entries (
    entry_number, entry_date, description, status,
    source_type, source_id, created_by, updated_by, metadata
  )
  values (
    entry_number_value,
    effective_date,
    left('Reconocimiento de compra ' || purchase.purchase_number, 500),
    'borrador',
    'financial_event', event.id::text,
    draft_actor, draft_actor,
    jsonb_build_object(
      'entry_kind', 'automatic',
      'generated_from_source', true,
      'accounting_outbox_v2_id', box.id,
      'feature_key', box.feature_key,
      'posting_version', 'v2',
      'accounting_purpose', 'PURCHASE_RECOGNITION',
      'accounting_source_version', 'purchase_recognition_v2',
      'scenario', box.scenario,
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
    event_type, entity_type, entity_id,
    source_type, source_id, metadata, created_by
  )
  values (
    'purchase_recognition_v2_draft_created',
    'accounting_outbox_v2', box.id,
    'accounts_payable', payable.id::text,
    jsonb_build_object(
      'accounts_payable_id', payable.id,
      'purchase_id', purchase.id,
      'outbox_id', box.id,
      'event_id', event.id,
      'journal_entry_id', entry_id,
      'accounting_date', effective_date,
      'manual_publication_required', true
    ),
    draft_actor
  );

  return jsonb_build_object(
    'ok', true, 'claimed', true, 'outbox_id', box.id,
    'outbox_status', 'completed', 'event_id', event.id,
    'event_status', 'draft_created', 'journal_entry_id', entry_id,
    'draft_status', 'borrador', 'reason', null,
    'accounting_date', effective_date
  );
exception
  when others then
    if box.id is not null then
      update public.accounting_outbox_v2
      set status = 'failed',
          next_attempt_at = now() + interval '15 minutes',
          lease_until = null,
          locked_by = null,
          last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
          last_error_message = 'Fallo tecnico sanitizado al generar el borrador de compra.'
      where id = box.id;
    end if;
    return jsonb_build_object(
      'ok', false, 'claimed', box.id is not null,
      'outbox_id', coalesce(box.id, target_outbox_id),
      'outbox_status', 'failed',
      'reason', 'technical_error',
      'error_code', 'PURCHASE_ACCOUNTING_FAILED'
    );
end;
$$;

revoke all on function public.process_purchase_recognition_outbox_v2(
  uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.process_purchase_recognition_outbox_v2(
  uuid, text, boolean
) to service_role;

-- Final worker definition: ownership is durable, and identity is never enough
-- to reuse a chain.  Both the stored snapshot and unordered journal economics
-- must equal the freshly calculated canonical recognition.
create or replace function public.process_purchase_recognition_outbox_v2(
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
  clean_worker text := nullif(left(btrim(coalesce(worker_token, '')), 120), '');
  box public.accounting_outbox_v2%rowtype;
  flag public.accounting_feature_flags%rowtype;
  event public.financial_events%rowtype;
  entry public.journal_entries%rowtype;
  canonical jsonb;
  chain_state text;
  evidence_state text;
  error_code text;
  reason_code text;
  draft_actor uuid;
  normalized_lines jsonb;
  entry_id uuid;
  entry_number_value text;
begin
  if clean_worker is null then
    raise exception using
      errcode = '22023',
      message = 'ACCOUNTING_WORKER_ID_REQUIRED';
  end if;
  if not service_call and (
    caller_id is null
    or public.current_actor_role() not in (
      'technical_owner', 'business_owner', 'admin', 'contadora'
    )
    or not public.has_permission('accounting:manage')
  ) then
    raise exception using
      errcode = '42501',
      message = 'ACCOUNTING_OUTBOX_FORBIDDEN';
  end if;

  select * into box
  from public.accounting_outbox_v2
  where id = target_outbox_id
  for update skip locked;
  if box.id is null then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', target_outbox_id,
      'reason', 'already_processing'
    );
  end if;
  if box.source_type <> 'accounts_payable'
    or box.event_purpose <> 'accounts_payable_created'
    or box.posting_version <> 'v2'
    or box.feature_key <> 'purchase_recognition_draft_v2'
    or box.topic <> 'payables.purchase_recognition'
    or box.scenario <> 'purchase_inventory_v2'
    or box.idempotency_key <> 'accounts_payable:' || box.source_id::text
      || ':accounts_payable_created:v2'
  then
    update public.accounting_outbox_v2
    set status = 'failed',
        lease_until = null,
        locked_by = null,
        last_error_code = 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT',
        last_error_message = 'La obligacion canonica de compra tiene enrutamiento incompatible.'
    where id = box.id;
    return jsonb_build_object(
      'ok', false,
      'claimed', true,
      'outbox_id', box.id,
      'outbox_status', 'failed',
      'reason', 'canonical_routing_conflict',
      'error_code', 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT'
    );
  end if;
  if box.status = 'cancelled' then
    return jsonb_build_object(
      'ok', false,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'reason', 'source_cancelled',
      'error_code', 'PURCHASE_ACCOUNTING_FAILED'
    );
  end if;
  if box.status = 'processing'
    and box.lease_until > now()
    and box.locked_by is distinct from clean_worker
  then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'reason', 'active_lease'
    );
  end if;
  if box.status <> 'completed'
    and box.attempt_count >= box.max_attempts
    and not force_retry
  then
    return jsonb_build_object(
      'ok', false,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'reason', 'max_attempts_reached'
    );
  end if;
  if box.status <> 'completed'
    and box.next_attempt_at > now()
    and not force_retry
  then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'reason', 'retry_not_available',
      'next_attempt_at', box.next_attempt_at
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'purchase_recognition_v2:' || box.source_id::text,
    0
  ));

  -- The current flag controls only new enrollment. This existing outbox plus
  -- durable purchase/AP stamps continues to own the fact after disable.
  canonical := public.calculate_purchase_recognition_v2(box.source_id, box.id);
  if not coalesce((canonical->>'ok')::boolean, false) then
    error_code := coalesce(
      canonical->>'error_code',
      'PURCHASE_ACCOUNTING_FAILED'
    );
    reason_code := coalesce(canonical->>'reason', 'canonical_calculation_failed');
    update public.accounting_outbox_v2
    set status = case error_code
          when 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED' then 'pending_mapping'
          when 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED' then 'pending_data'
          when 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED' then 'pending_data'
          else 'failed'
        end,
        attempt_count = case
          when status = 'completed' then attempt_count
          else attempt_count + 1
        end,
        next_attempt_at = now() + interval '15 minutes',
        lease_until = null,
        locked_by = null,
        last_error_code = error_code,
        last_error_message = case error_code
          when 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED'
            then 'Falta configurar uno o mas mapeos contables requeridos.'
          when 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED'
            then 'La fecha canonica pertenece a un periodo contable cerrado.'
          when 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED'
            then 'Una o mas lineas no tienen clasificacion contable segura.'
          else 'El hecho de compra no cumple las precondiciones contables.'
        end,
        missing_key = left(coalesce(
          array_to_string(array(
            select jsonb_array_elements_text(canonical->'missing_keys')
          ), ', '),
          reason_code
        ), 240)
    where id = box.id;
    return jsonb_build_object(
      'ok', error_code in (
        'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED',
        'PURCHASE_ACCOUNTING_PERIOD_BLOCKED',
        'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED'
      ),
      'claimed', true,
      'outbox_id', box.id,
      'outbox_status', case error_code
        when 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED' then 'pending_mapping'
        when 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED' then 'pending_data'
        when 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED' then 'pending_data'
        else 'failed'
      end,
      'reason', reason_code,
      'error_code', error_code,
      'missing_keys', coalesce(canonical->'missing_keys', '[]'::jsonb)
    );
  end if;

  evidence_state := public.validate_purchase_recognition_chain_v2(
    box.source_id,
    canonical->'snapshot',
    canonical->'lines'
  );
  chain_state := public.purchase_recognition_validity_v2(box.source_id);
  if box.status = 'completed'
    and chain_state = 'PURCHASE_ACCOUNTING_PENDING'
  then
    chain_state := 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT';
  end if;
  if chain_state in (
    'PURCHASE_ACCOUNTING_LEGACY_CONFLICT',
    'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT',
    'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT'
  ) then
    update public.accounting_outbox_v2
    set status = 'failed',
        lease_until = null,
        locked_by = null,
        last_error_code = chain_state,
        last_error_message = case chain_state
          when 'PURCHASE_ACCOUNTING_LEGACY_CONFLICT'
            then 'Existe un borrador V1 competidor y se requiere revision contable.'
          when 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
            then 'El snapshot almacenado difiere del reconocimiento canonico.'
          else 'La partida almacenada difiere del reconocimiento canonico.'
        end,
        missing_key = null
    where id = box.id;
    return jsonb_build_object(
      'ok', false,
      'claimed', true,
      'outbox_id', box.id,
      'outbox_status', 'failed',
      'reason', lower(chain_state),
      'error_code', chain_state
    );
  end if;

  if chain_state in (
    'PURCHASE_ACCOUNTING_DRAFTED',
    'PURCHASE_ACCOUNTING_RETRYABLE'
  ) then
    select * into event
    from public.financial_events candidate
    where candidate.source_type = 'accounts_payable'
      and candidate.source_id = box.source_id::text
      and candidate.event_purpose = 'accounts_payable_created'
      and candidate.posting_version = 'v2';
    select * into entry
    from public.journal_entries candidate
    where candidate.source_type = 'financial_event'
      and candidate.source_id = event.id::text;
    update public.financial_events
    set journal_entry_id = entry.id,
        status = case
          when entry.status = 'publicada' then 'posted'
          else 'draft_created'
        end,
        updated_at = now()
    where id = event.id
      and journal_entry_id is null;
    update public.accounting_outbox_v2
    set status = 'completed',
        financial_event_id = event.id,
        journal_entry_id = entry.id,
        duplicate_avoided = true,
        processed_at = coalesce(processed_at, now()),
        lease_until = null,
        locked_by = null,
        last_error_code = null,
        last_error_message = null,
        missing_key = null
    where id = box.id;
    return jsonb_build_object(
      'ok', true,
      'claimed', box.status <> 'completed',
      'outbox_id', box.id,
      'outbox_status', 'completed',
      'event_id', event.id,
      'journal_entry_id', entry.id,
      'reason', 'existing_exact_chain_reused'
    );
  end if;

  -- A failure-bearing chain with an existing journal is evidence requiring
  -- reconciliation, not an unknown-commit success.  A failed outbox with no
  -- journal remains eligible for the normal explicit retry path below.
  if chain_state = 'PURCHASE_ACCOUNTING_FAILED'
    and evidence_state in (
      'PURCHASE_ACCOUNTING_DRAFTED',
      'PURCHASE_ACCOUNTING_FAILED'
    )
    and exists (
      select 1
      from public.financial_events failed_event
      join public.journal_entries failed_entry
        on failed_entry.source_type = 'financial_event'
       and failed_entry.source_id = failed_event.id::text
      where failed_event.source_type = 'accounts_payable'
        and failed_event.source_id = box.source_id::text
        and failed_event.event_purpose = 'accounts_payable_created'
        and failed_event.posting_version = 'v2'
    )
  then
    return jsonb_build_object(
      'ok', false,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'reason', 'failed_chain_requires_reconciliation',
      'error_code', 'PURCHASE_ACCOUNTING_FAILED'
    );
  end if;

  select * into flag
  from public.accounting_feature_flags
  where key = 'purchase_recognition_draft_v2';
  draft_actor := coalesce(box.actor_id, flag.updated_by);
  if draft_actor is null or not exists (
    select 1 from public.users where id = draft_actor and active = true
  ) then
    update public.accounting_outbox_v2
    set status = 'failed',
        lease_until = null,
        locked_by = null,
        last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
        last_error_message = 'No existe un actor de automatizacion activo.',
        missing_key = 'automation_actor'
    where id = box.id;
    return jsonb_build_object(
      'ok', false,
      'claimed', true,
      'outbox_id', box.id,
      'outbox_status', 'failed',
      'reason', 'missing_automation_actor',
      'error_code', 'PURCHASE_ACCOUNTING_FAILED'
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
  where id = box.id;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, source_snapshot, validation_errors, created_by
  ) values (
    'accounts_payable', box.source_id::text,
    'accounts_payable_created', 'v2', 'ready',
    box.occurred_at, canonical->'snapshot', '[]'::jsonb, draft_actor
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do nothing;

  select * into event
  from public.financial_events candidate
  where candidate.source_type = 'accounts_payable'
    and candidate.source_id = box.source_id::text
    and candidate.event_purpose = 'accounts_payable_created'
    and candidate.posting_version = 'v2'
  for update;

  if event.id is null
    or public.purchase_recognition_snapshot_economics_v2(event.source_snapshot)
      <> public.purchase_recognition_snapshot_economics_v2(canonical->'snapshot')
  then
    raise exception using
      errcode = 'PT409',
      message = 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT';
  end if;

  normalized_lines := public.normalize_journal_draft_lines(canonical->'lines');
  entry_number_value := public.next_journal_entry_number();
  insert into public.journal_entries (
    entry_number, entry_date, description, status,
    source_type, source_id, created_by, updated_by, metadata
  ) values (
    entry_number_value,
    (canonical->>'accounting_date')::date,
    canonical->>'entry_description',
    'borrador',
    'financial_event', event.id::text,
    draft_actor, draft_actor,
    jsonb_build_object(
      'entry_kind', 'automatic',
      'generated_from_source', true,
      'accounting_outbox_v2_id', box.id,
      'feature_key', box.feature_key,
      'posting_version', 'v2',
      'accounting_purpose', 'PURCHASE_RECOGNITION',
      'accounting_source_version', 'purchase_recognition_v2',
      'scenario', box.scenario,
      'manual_publication_required', true
    )
  ) returning id into entry_id;

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

  update public.financial_events legacy
  set status = 'skipped',
      updated_at = now()
  where legacy.source_type = 'accounts_payable'
    and legacy.source_id = box.source_id::text
    and legacy.event_purpose = 'accounts_payable_created'
    and legacy.posting_version = 'v1'
    and legacy.journal_entry_id is null
    and legacy.status in ('pending', 'ready', 'failed', 'skipped');

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
    event_type, entity_type, entity_id,
    source_type, source_id, metadata, created_by
  ) values (
    'purchase_recognition_v2_draft_created',
    'accounting_outbox_v2', box.id,
    'accounts_payable', box.source_id::text,
    jsonb_build_object(
      'accounts_payable_id', box.source_id,
      'outbox_id', box.id,
      'event_id', event.id,
      'journal_entry_id', entry_id,
      'accounting_date', canonical->>'accounting_date',
      'manual_publication_required', true
    ),
    draft_actor
  );

  return jsonb_build_object(
    'ok', true,
    'claimed', true,
    'outbox_id', box.id,
    'outbox_status', 'completed',
    'event_id', event.id,
    'event_status', 'draft_created',
    'journal_entry_id', entry_id,
    'draft_status', 'borrador',
    'reason', null,
    'accounting_date', canonical->>'accounting_date'
  );
exception
  when others then
    error_code := case
      when sqlerrm = 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
        then 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
      else 'PURCHASE_ACCOUNTING_FAILED'
    end;
    if box.id is not null then
      update public.accounting_outbox_v2
      set status = 'failed',
          next_attempt_at = now() + interval '15 minutes',
          lease_until = null,
          locked_by = null,
          last_error_code = error_code,
          last_error_message = case error_code
            when 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT'
              then 'El snapshot almacenado difiere del reconocimiento canonico.'
            else 'Fallo tecnico sanitizado al generar el borrador de compra.'
          end
      where id = box.id;
    end if;
    return jsonb_build_object(
      'ok', false,
      'claimed', box.id is not null,
      'outbox_id', coalesce(box.id, target_outbox_id),
      'outbox_status', 'failed',
      'reason', case error_code
        when 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT' then 'snapshot_conflict'
        else 'technical_error'
      end,
      'error_code', error_code
    );
end;
$$;

revoke all on function public.process_purchase_recognition_outbox_v2(
  uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.process_purchase_recognition_outbox_v2(
  uuid, text, boolean
) to service_role;

alter function public.process_accounting_outbox_v2(uuid, text, boolean)
  rename to process_accounting_outbox_v2_pre_purchase_recognition;

revoke all on function public.process_accounting_outbox_v2_pre_purchase_recognition(
  uuid, text, boolean
) from public, anon, authenticated, service_role;

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
  box public.accounting_outbox_v2%rowtype;
  dependency_status text;
  gated_count integer := 0;
begin
  select * into box
  from public.accounting_outbox_v2
  where id = target_outbox_id;

  if box.id is not null
    and box.source_type = 'accounts_payable'
    and box.event_purpose = 'accounts_payable_created'
    and box.posting_version = 'v2'
  then
    return public.process_purchase_recognition_outbox_v2(
      target_outbox_id,
      worker_token,
      force_retry
    );
  end if;

  if box.id is not null
    and box.source_type = 'supplier_payment'
    and box.event_purpose = 'supplier_payment'
    and box.posting_version = 'v2'
    and box.status not in ('completed', 'cancelled')
  then
    dependency_status := public.supplier_payment_purchase_dependency_v2(
      box.source_id
    );
    if dependency_status = 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING' then
      update public.accounting_outbox_v2
      set status = 'pending_data',
          next_attempt_at = now() + interval '15 minutes',
          lease_until = null,
          locked_by = null,
          last_error_code = 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING',
          last_error_message = 'El reconocimiento de compra debe tener un borrador valido antes del borrador de pago.',
          missing_key = 'purchase_recognition_draft'
      where id = box.id
        and not (
          status = 'processing'
          and lease_until > now()
          and locked_by is distinct from nullif(left(btrim(coalesce(worker_token, '')), 120), '')
        );
      get diagnostics gated_count = row_count;
      if gated_count > 0 then
        return jsonb_build_object(
          'ok', true, 'claimed', true, 'outbox_id', box.id,
          'outbox_status', 'pending_data',
          'reason', 'purchase_accounting_dependency_pending',
          'error_code', 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING'
        );
      end if;
    end if;
  end if;

  return public.process_accounting_outbox_v2_pre_purchase_recognition(
    target_outbox_id,
    worker_token,
    force_retry
  );
end;
$$;

revoke all on function public.process_accounting_outbox_v2(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.process_accounting_outbox_v2(uuid, text, boolean)
  to service_role;

comment on function public.purchase_accounting_completeness_v2(uuid) is
  'Read-only deterministic completeness classification for prospectively stamped purchase/AP recognition V2 facts.';
comment on function public.supplier_payment_purchase_dependency_v2(uuid) is
  'Historical APs remain out of scope. New V2 purchase APs require a valid recognition draft before payment draft processing.';

commit;
