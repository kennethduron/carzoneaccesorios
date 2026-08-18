-- Full invoice annulment: fiscal cancellation plus an exactly-once commercial reversal.
-- Prospective schema only. This migration does not repair or mutate historical sales.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Keep the fiscal primitive available to trusted database code, but prevent an
-- authenticated API caller from bypassing the full commercial authority.
revoke execute on function public.cancel_fiscal_invoice(uuid, text)
  from public, anon, authenticated;

alter table public.inventory_movements
  add column if not exists reversal_of_movement_id uuid
    references public.inventory_movements(id) on delete restrict;

create unique index if not exists inventory_movements_sale_reversal_once_idx
  on public.inventory_movements(reversal_of_movement_id)
  where reversal_of_movement_id is not null;

alter table public.orders
  add column if not exists commercial_reversed_at timestamptz,
  add column if not exists commercial_reversed_by uuid
    references public.users(id) on delete set null,
  add column if not exists commercial_reversal_reason text,
  add column if not exists commercial_reversal_invoice_id uuid
    references public.invoices(id) on delete restrict;

create unique index if not exists orders_commercial_reversal_invoice_once_idx
  on public.orders(commercial_reversal_invoice_id)
  where commercial_reversal_invoice_id is not null;

create table if not exists public.invoice_commercial_reversals (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references public.invoices(id) on delete restrict,
  order_id uuid not null unique references public.orders(id) on delete restrict,
  mode text not null check (mode in ('operator', 'incident_repair')),
  reason text not null check (char_length(trim(reason)) between 8 and 500),
  actor_id uuid not null references public.users(id) on delete restrict,
  original_movement_ids uuid[] not null,
  reversal_movement_ids uuid[] not null,
  receivable_id uuid references public.accounts_receivable(id) on delete restrict,
  receivable_effect text not null check (
    receivable_effect in ('cancelled_unpaid', 'not_applicable')
  ),
  accounting_effects jsonb not null default '[]'::jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint invoice_commercial_reversal_movements_match check (
    cardinality(original_movement_ids) > 0
    and cardinality(original_movement_ids) = cardinality(reversal_movement_ids)
  )
);

create index if not exists invoice_commercial_reversals_created_idx
  on public.invoice_commercial_reversals(created_at desc);

alter table public.invoice_commercial_reversals enable row level security;
revoke all on public.invoice_commercial_reversals from public, anon, authenticated;
grant select on public.invoice_commercial_reversals to authenticated;
grant select, insert on public.invoice_commercial_reversals to service_role;

drop policy if exists invoice_commercial_reversals_select
  on public.invoice_commercial_reversals;
create policy invoice_commercial_reversals_select
  on public.invoice_commercial_reversals for select
  using (
    public.has_permission('invoices:read')
    or public.has_permission('invoices:manage')
    or public.has_permission('audit:read')
  );

create or replace function public.guard_invoice_commercial_reversal_immutable_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000',
    message = 'INVOICE_COMMERCIAL_REVERSAL_IMMUTABLE';
end;
$$;

revoke all on function public.guard_invoice_commercial_reversal_immutable_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists invoice_commercial_reversals_append_only
  on public.invoice_commercial_reversals;
create trigger invoice_commercial_reversals_append_only
before update or delete on public.invoice_commercial_reversals
for each row execute function public.guard_invoice_commercial_reversal_immutable_v1();

create or replace function public.cancel_sale_invoice_v1(
  p_invoice_id uuid,
  p_reason text,
  p_recovery_mode boolean default false,
  p_recovery_expected jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  invoice_row public.invoices%rowtype;
  order_row public.orders%rowtype;
  product_row public.products%rowtype;
  receivable_row public.accounts_receivable%rowtype;
  movement_row public.inventory_movements%rowtype;
  existing_reversal public.invoice_commercial_reversals%rowtype;
  reversal_id uuid;
  reversal_record_id uuid := gen_random_uuid();
  original_ids uuid[] := array[]::uuid[];
  reversal_ids uuid[] := array[]::uuid[];
  accounting_effects jsonb := '[]'::jsonb;
  receivable_effect text := 'not_applicable';
  result jsonb;
  expected_order_id uuid;
  expected_customer_id uuid;
  expected_product_id uuid;
  expected_movement_id uuid;
  expected_receivable_id uuid;
  expected_quantity integer;
  expected_stock integer;
  expected_receivable_balance numeric(12,2);
  expected_movement_count integer;
  expected_cancellation_reason text;
  expected_order_status text;
  latest_product_movement_id uuid;
  reversal_time timestamptz := now();
begin
  if actor_id is null
    or not public.has_permission('invoices:manage')
    or not public.has_permission('orders:manage')
    or not public.has_permission('inventory:manage')
    or not public.has_permission('credit:manage')
    or not public.has_permission('accounting:manage')
  then
    raise exception using errcode = '42501', message = 'SALE_REVERSAL_PERMISSION_DENIED';
  end if;

  if p_invoice_id is null then
    raise exception using errcode = '22023', message = 'SALE_REVERSAL_INVOICE_REQUIRED';
  end if;
  if normalized_reason is null or char_length(normalized_reason) < 8
    or char_length(normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'SALE_REVERSAL_REASON_INVALID';
  end if;

  select * into invoice_row
  from public.invoices invoice
  where invoice.id = p_invoice_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SALE_REVERSAL_INVOICE_NOT_FOUND';
  end if;

  select * into existing_reversal
  from public.invoice_commercial_reversals reversal
  where reversal.invoice_id = invoice_row.id;
  if found then
    return existing_reversal.result || jsonb_build_object(
      'status', 'ALREADY_REVERSED', 'replayed', true
    );
  end if;

  select * into order_row
  from public.orders orders
  where orders.id = invoice_row.order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SALE_REVERSAL_ORDER_NOT_FOUND';
  end if;

  if order_row.status::text in ('cancelado', 'cancelled')
    or order_row.commercial_reversal_invoice_id is not null then
    raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_ORDER_ALREADY_CANCELLED';
  end if;

  if p_recovery_mode then
    if actor_role not in ('technical_owner', 'business_owner') then
      raise exception using errcode = '42501', message = 'SALE_REVERSAL_RECOVERY_PERMISSION_DENIED';
    end if;
    if p_recovery_expected is null
      or not (p_recovery_expected ?& array[
        'order_id', 'order_status', 'customer_id', 'product_id', 'original_movement_id',
        'original_movement_count', 'quantity', 'current_stock',
        'receivable_id', 'receivable_balance',
        'cancellation_reason'
      ]) then
      raise exception using errcode = '22023', message = 'SALE_REVERSAL_RECOVERY_EXPECTATIONS_REQUIRED';
    end if;
    begin
      expected_order_id := (p_recovery_expected->>'order_id')::uuid;
      expected_order_status := trim(p_recovery_expected->>'order_status');
      expected_customer_id := (p_recovery_expected->>'customer_id')::uuid;
      expected_product_id := (p_recovery_expected->>'product_id')::uuid;
      expected_movement_id := (p_recovery_expected->>'original_movement_id')::uuid;
      expected_receivable_id := (p_recovery_expected->>'receivable_id')::uuid;
      expected_quantity := (p_recovery_expected->>'quantity')::integer;
      expected_movement_count := (p_recovery_expected->>'original_movement_count')::integer;
      expected_stock := (p_recovery_expected->>'current_stock')::integer;
      expected_receivable_balance := round((p_recovery_expected->>'receivable_balance')::numeric, 2);
      expected_cancellation_reason := trim(p_recovery_expected->>'cancellation_reason');
    exception when others then
      raise exception using errcode = '22023', message = 'SALE_REVERSAL_RECOVERY_EXPECTATIONS_INVALID';
    end;

    if invoice_row.status::text not in ('anulada', 'cancelled')
      or invoice_row.order_id is distinct from expected_order_id
      or invoice_row.customer_id is distinct from expected_customer_id
      or trim(coalesce(invoice_row.cancellation_reason, '')) is distinct from expected_cancellation_reason
      or order_row.status::text is distinct from expected_order_status
      or order_row.tracking_status is distinct from expected_order_status
    then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_INVOICE_MISMATCH';
    end if;
  else
    if invoice_row.status::text not in ('emitida', 'issued', 'paid') then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_INVOICE_NOT_ELIGIBLE';
    end if;
  end if;

  -- Lock money state before deciding eligibility. Any paid or partially-paid
  -- sale needs a separate refund contract and is deliberately rejected here.
  perform 1 from public.payments payment
  where payment.order_id = order_row.id
  order by payment.id for update;
  if exists (
    select 1 from public.payments payment
    where payment.order_id = order_row.id
      and coalesce(payment.payment_status::text, payment.status::text, 'pending')
        in ('approved', 'confirmed', 'paid', 'refunded')
  ) then
    raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_REQUIRES_PAYMENT_REFUND';
  end if;

  select * into receivable_row
  from public.accounts_receivable receivable
  where receivable.order_id = order_row.id
  for update;

  if order_row.payment_method::text = 'commercial_credit' then
    if receivable_row.id is null
      or receivable_row.status not in ('open', 'overdue')
      or round(receivable_row.balance_due, 2) <> round(receivable_row.original_amount, 2)
    then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_REQUIRES_RECEIVABLE_REFUND';
    end if;
    perform 1 from public.accounts_receivable_payments ar_payment
    where ar_payment.receivable_id = receivable_row.id
    order by ar_payment.id for update;
    if exists (
      select 1 from public.accounts_receivable_payments ar_payment
      where ar_payment.receivable_id = receivable_row.id
    ) then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_REQUIRES_RECEIVABLE_REFUND';
    end if;
    receivable_effect := 'cancelled_unpaid';
  elsif receivable_row.id is not null then
    raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECEIVABLE_STATE_INVALID';
  end if;

  if exists (
    select 1 from public.inventory_movements movement
    where movement.reference_type = 'orders'
      and movement.reference_id = order_row.id
      and movement.movement_type::text = 'return'
      and movement.quantity > 0
      and movement.reversal_of_movement_id is null
  ) then
    raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_UNLINKED_RETURN_EXISTS';
  end if;

  perform 1
  from public.products product
  where product.id in (
    select movement.product_id
    from public.inventory_movements movement
    where movement.reference_type = 'orders'
      and movement.reference_id = order_row.id
      and movement.movement_type::text = 'sale'
      and movement.quantity < 0
  )
  order by product.id
  for update;

  if not exists (
    select 1 from public.inventory_movements movement
    where movement.reference_type = 'orders'
      and movement.reference_id = order_row.id
      and movement.movement_type::text = 'sale'
      and movement.quantity < 0
  ) then
    raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_ORIGINAL_MOVEMENTS_MISSING';
  end if;

  if exists (
    select 1 from public.inventory_movements movement
    where movement.reference_type = 'orders'
      and movement.reference_id = order_row.id
      and movement.movement_type::text = 'sale'
      and movement.quantity < 0
      and (
        movement.stock_after <> movement.stock_before + movement.quantity
        or movement.reversal_of_movement_id is not null
        or exists (
          select 1 from public.inventory_movements inverse
          where inverse.reversal_of_movement_id = movement.id
        )
      )
  ) then
    raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_MOVEMENT_ALREADY_REVERSED';
  end if;

  if p_recovery_mode then
    if exists (select 1 from public.payments payment where payment.order_id = order_row.id) then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_PAYMENT_FOUND';
    end if;
    if expected_quantity <= 0 or expected_movement_count <= 0
      or (select count(*) from public.inventory_movements movement
          where movement.reference_type = 'orders'
            and movement.reference_id = order_row.id
            and movement.movement_type::text = 'sale'
            and movement.quantity < 0) <> expected_movement_count
      or not exists (
        select 1 from public.inventory_movements movement
        join public.products product on product.id = movement.product_id
        where movement.id = expected_movement_id
          and movement.reference_type = 'orders'
          and movement.reference_id = order_row.id
          and movement.product_id = expected_product_id
          and movement.movement_type::text = 'sale'
          and movement.quantity = -expected_quantity
          and product.stock = expected_stock
      )
    then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_INVENTORY_MISMATCH';
    end if;

    select movement.id into latest_product_movement_id
    from public.inventory_movements movement
    where movement.product_id = expected_product_id
    order by movement.created_at desc, movement.id desc
    limit 1;
    if latest_product_movement_id is distinct from expected_movement_id then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_LATER_MOVEMENT_FOUND';
    end if;
    if receivable_row.id is distinct from expected_receivable_id
      or round(receivable_row.balance_due, 2) <> expected_receivable_balance
      or round(receivable_row.original_amount, 2) <> expected_receivable_balance
    then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_RECEIVABLE_MISMATCH';
    end if;
    if not exists (
      select 1 from public.accounting_outbox_v2 box
      where box.source_type = 'order' and box.source_id = order_row.id
        and box.event_purpose = 'sale_recognized'
    ) or not exists (
      select 1 from public.accounting_outbox_v2 box
      where box.source_type = 'inventory_movement' and box.source_id = expected_movement_id
        and box.event_purpose = 'inventory_cogs'
    ) or exists (
      select 1 from public.accounting_outbox_v2 box
      where (box.source_type = 'order' and box.source_id = order_row.id
          and box.event_purpose = 'sale_compensation')
         or (box.source_type = 'inventory_movement' and box.source_id = expected_movement_id
          and box.event_purpose = 'inventory_cogs_compensation')
    ) then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_ACCOUNTING_MISMATCH';
    end if;
    if exists (
      select 1
      from public.accounting_outbox_v2 box
      join public.journal_entries entry on entry.id = box.journal_entry_id
      where ((box.source_type = 'order' and box.source_id = order_row.id
              and box.event_purpose = 'sale_recognized')
          or (box.source_type = 'inventory_movement' and box.source_id = expected_movement_id
              and box.event_purpose = 'inventory_cogs'))
        and entry.status not in ('borrador', 'publicada')
    ) then
      raise exception using errcode = 'PT409', message = 'SALE_REVERSAL_RECOVERY_ACCOUNTING_MISMATCH';
    end if;
  end if;

  for movement_row in
    select movement.*
    from public.inventory_movements movement
    where movement.reference_type = 'orders'
      and movement.reference_id = order_row.id
      and movement.movement_type::text = 'sale'
      and movement.quantity < 0
    order by movement.product_id, movement.id
    for update
  loop
    select * into strict product_row
    from public.products product
    where product.id = movement_row.product_id
    for update;

    update public.products product
    set stock = product_row.stock + abs(movement_row.quantity),
        updated_at = reversal_time
    where product.id = product_row.id;

    insert into public.inventory_movements (
      product_id, user_id, movement_type, quantity, stock_before, stock_after,
      reference_type, reference_id, order_item_id, notes,
      unit_cost_snapshot, total_cost_snapshot, cost_source, cost_captured_at,
      reserved_before, reserved_after, available_before, available_after,
      effective_date, reversal_of_movement_id
    ) values (
      movement_row.product_id, actor_id, 'return', abs(movement_row.quantity),
      product_row.stock, product_row.stock + abs(movement_row.quantity),
      'orders', order_row.id, movement_row.order_item_id,
      left('Reversion comercial por anulacion de factura: ' || normalized_reason, 500),
      movement_row.unit_cost_snapshot, movement_row.total_cost_snapshot,
      coalesce(movement_row.cost_source, 'original_sale_movement'),
      coalesce(movement_row.cost_captured_at, movement_row.created_at),
      coalesce(product_row.reserved_stock, 0), coalesce(product_row.reserved_stock, 0),
      greatest(product_row.stock - coalesce(product_row.reserved_stock, 0), 0),
      greatest(product_row.stock + abs(movement_row.quantity)
        - coalesce(product_row.reserved_stock, 0), 0),
      (reversal_time at time zone 'America/Tegucigalpa')::date,
      movement_row.id
    ) returning id into reversal_id;

    original_ids := array_append(original_ids, movement_row.id);
    reversal_ids := array_append(reversal_ids, reversal_id);
  end loop;

  if not p_recovery_mode then
    perform public.cancel_fiscal_invoice(invoice_row.id, normalized_reason);
  end if;

  update public.payments payment
  set payment_status = 'rejected', status = 'rejected', rejected_by = actor_id,
      rejection_reason = left(normalized_reason, 500), updated_at = reversal_time
  where payment.order_id = order_row.id
    and coalesce(payment.payment_status::text, payment.status::text, 'pending')
      not in ('approved', 'confirmed', 'paid', 'refunded', 'rejected');

  update public.orders orders
  set status = 'cancelado', tracking_status = 'cancelado',
      reservation_review_required = false,
      reservation_reviewed_at = reversal_time,
      reservation_reviewed_by = actor_id,
      reservation_review_reason = left(normalized_reason, 500),
      commercial_reversed_at = reversal_time,
      commercial_reversed_by = actor_id,
      commercial_reversal_reason = normalized_reason,
      commercial_reversal_invoice_id = invoice_row.id,
      updated_at = reversal_time
  where orders.id = order_row.id;

  if receivable_row.id is not null
    and not exists (
      select 1 from public.accounts_receivable receivable
      where receivable.id = receivable_row.id and receivable.status = 'cancelled'
        and receivable.balance_due = 0
    ) then
    raise exception using errcode = 'P0001', message = 'SALE_REVERSAL_RECEIVABLE_RECONCILIATION_FAILED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'outbox_id', box.id,
    'source_type', box.source_type,
    'source_id', box.source_id,
    'event_purpose', box.event_purpose,
    'status', box.status,
    'journal_entry_id', box.journal_entry_id
  ) order by box.source_type, box.source_id, box.event_purpose), '[]'::jsonb)
  into accounting_effects
  from public.accounting_outbox_v2 box
  where (box.source_type = 'order' and box.source_id = order_row.id)
     or (box.source_type = 'inventory_movement' and box.source_id = any(original_ids));

  result := jsonb_build_object(
    'status', 'REVERSED',
    'replayed', false,
    'reversal_id', reversal_record_id,
    'invoice_id', invoice_row.id,
    'order_id', order_row.id,
    'invoice_status', 'anulada',
    'order_status', 'cancelado',
    'original_movement_ids', to_jsonb(original_ids),
    'reversal_movement_ids', to_jsonb(reversal_ids),
    'receivable_effect', receivable_effect,
    'accounting_effects', accounting_effects
  );

  insert into public.invoice_commercial_reversals (
    id, invoice_id, order_id, mode, reason, actor_id,
    original_movement_ids, reversal_movement_ids,
    receivable_id, receivable_effect, accounting_effects, result, created_at
  ) values (
    reversal_record_id, invoice_row.id, order_row.id,
    case when p_recovery_mode then 'incident_repair' else 'operator' end,
    normalized_reason, actor_id, original_ids, reversal_ids,
    receivable_row.id, receivable_effect, accounting_effects, result, reversal_time
  );

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  ) values (
    actor_id, actor_role, 'invoice_commercial_reversals', reversal_record_id,
    'sale.invoice.full_commercial_reversal',
    jsonb_build_object(
      'invoice_status', invoice_row.status,
      'order_status', order_row.status,
      'receivable_status', receivable_row.status,
      'receivable_balance', receivable_row.balance_due
    ),
    jsonb_build_object(
      'invoice_id', invoice_row.id,
      'order_id', order_row.id,
      'mode', case when p_recovery_mode then 'incident_repair' else 'operator' end,
      'reason', normalized_reason,
      'original_movement_ids', to_jsonb(original_ids),
      'reversal_movement_ids', to_jsonb(reversal_ids),
      'receivable_id', receivable_row.id,
      'receivable_effect', receivable_effect,
      'accounting_effects', accounting_effects,
      'invoice_status', 'anulada',
      'order_status', 'cancelado',
      'reversed_at', reversal_time
    )
  );

  return result;
end;
$$;

revoke all on function public.cancel_sale_invoice_v1(uuid, text, boolean, jsonb)
  from public, anon;
grant execute on function public.cancel_sale_invoice_v1(uuid, text, boolean, jsonb)
  to authenticated;

comment on function public.cancel_sale_invoice_v1(uuid, text, boolean, jsonb) is
  'Exactly-once fiscal and commercial sale reversal. Recovery mode is senior-role-only and fail-closed against exact incident expectations.';

commit;
