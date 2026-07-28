-- Prospective sales and COGS routing.
-- Triggers only observe new row transitions after the feature cutover. There
-- is deliberately no historical backfill and invoice issuance is not a sale
-- recognition trigger.

create or replace function public.enqueue_sale_recognition_from_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  old_status text := case
    when tg_op = 'INSERT' then null
    else coalesce(old.payment_status::text, old.status::text)
  end;
  new_status text := coalesce(new.payment_status::text, new.status::text);
  effective_at timestamptz := coalesce(new.paid_at, new.updated_at, now());
  sale_scenario text;
begin
  if new_status not in ('approved', 'confirmed', 'paid')
    or old_status in ('approved', 'confirmed', 'paid')
  then
    return new;
  end if;

  select * into order_row
  from public.orders
  where id = new.order_id
  for share;

  if not found
    or order_row.payment_method::text = 'commercial_credit'
    or order_row.status::text in ('cancelado', 'cancelled')
  then
    return new;
  end if;

  if order_row.payment_timing = 'on_delivery'
    and order_row.status::text not in ('entregado', 'delivered')
  then
    return new;
  end if;

  sale_scenario := case
    when order_row.payment_timing = 'on_delivery' then 'cash_or_cod_after_delivery'
    when order_row.payment_method::text = 'bank_transfer' then 'prepaid_bank_transfer'
    when order_row.payment_method::text = 'card' then 'prepaid_customer_card'
    when order_row.payment_method::text = 'cash' then 'prepaid_cash'
    else 'prepaid_other'
  end;

  perform public.route_accounting_fact_v2(
    'sales_draft_v2',
    'sales.recognized',
    'order',
    order_row.id,
    'sale_recognized',
    sale_scenario,
    effective_at,
    coalesce(new.confirmed_by, auth.uid())
  );

  return new;
end;
$$;

revoke all on function public.enqueue_sale_recognition_from_payment_v2()
  from public, anon, authenticated;

drop trigger if exists payments_enqueue_sale_recognition_v2 on public.payments;
create trigger payments_enqueue_sale_recognition_v2
after insert or update of payment_status, status on public.payments
for each row
execute function public.enqueue_sale_recognition_from_payment_v2();

create or replace function public.enqueue_credit_sale_on_delivery_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_at timestamptz := coalesce(new.updated_at, now());
begin
  if new.payment_method::text <> 'commercial_credit'
    or new.status::text not in ('entregado', 'delivered')
    or old.status::text in ('entregado', 'delivered')
  then
    return new;
  end if;

  perform public.route_accounting_fact_v2(
    'sales_draft_v2',
    'sales.recognized',
    'order',
    new.id,
    'sale_recognized',
    'commercial_credit_on_delivery',
    effective_at,
    auth.uid()
  );

  return new;
end;
$$;

revoke all on function public.enqueue_credit_sale_on_delivery_v2()
  from public, anon, authenticated;

drop trigger if exists orders_enqueue_credit_sale_on_delivery_v2 on public.orders;
create trigger orders_enqueue_credit_sale_on_delivery_v2
after update of status on public.orders
for each row
execute function public.enqueue_credit_sale_on_delivery_v2();

create or replace function public.enqueue_inventory_cogs_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.movement_type::text <> 'sale'
    or new.quantity >= 0
    or new.stock_after >= new.stock_before
    or new.reference_type <> 'orders'
    or new.reference_id is null
  then
    return new;
  end if;

  perform public.route_accounting_fact_v2(
    'cogs_draft_v2',
    'inventory.cogs',
    'inventory_movement',
    new.id,
    'inventory_cogs',
    'physical_sale_movement',
    new.created_at,
    coalesce(new.user_id, auth.uid())
  );

  return new;
end;
$$;

revoke all on function public.enqueue_inventory_cogs_v2()
  from public, anon, authenticated;

drop trigger if exists inventory_movements_enqueue_cogs_v2
  on public.inventory_movements;
create trigger inventory_movements_enqueue_cogs_v2
after insert on public.inventory_movements
for each row
execute function public.enqueue_inventory_cogs_v2();

create or replace function public.cancel_accounting_fact_v2(
  target_source_type text,
  target_source_id uuid,
  target_event_purpose text,
  target_compensation_purpose text,
  cancellation_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  box public.accounting_outbox_v2%rowtype;
  entry public.journal_entries%rowtype;
  compensation_id uuid;
  cancellation_time timestamptz := now();
begin
  select * into box
  from public.accounting_outbox_v2
  where source_type = target_source_type
    and source_id = target_source_id
    and event_purpose = target_event_purpose
    and posting_version = 'v2'
  for update;

  if not found then
    return null;
  end if;

  if box.journal_entry_id is null then
    update public.accounting_outbox_v2
    set status = 'cancelled',
        cancelled_at = cancellation_time,
        lease_until = null,
        locked_by = null,
        last_error_code = 'source_cancelled',
        last_error_message = 'El hecho operativo fue anulado antes de crear un borrador.'
    where id = box.id;

    update public.financial_events
    set status = 'skipped',
        validation_errors = jsonb_build_array('source_cancelled'),
        updated_at = now()
    where id = box.financial_event_id
      and journal_entry_id is null
      and status not in ('posted', 'reversed');
    return box.id;
  end if;

  select * into entry
  from public.journal_entries
  where id = box.journal_entry_id
  for update;

  if entry.status = 'borrador' then
    update public.journal_entries
    set status = 'anulada',
        updated_by = coalesce(cancellation_actor, auth.uid(), entry.created_by),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'cancelled_from_accounting_v2', true,
          'cancelled_at', cancellation_time
        )
    where id = entry.id;

    update public.financial_events
    set status = 'skipped',
        validation_errors = jsonb_build_array('source_cancelled_after_draft'),
        updated_at = now()
    where id = box.financial_event_id;

    update public.accounting_outbox_v2
    set status = 'cancelled',
        cancelled_at = cancellation_time,
        lease_until = null,
        locked_by = null,
        last_error_code = 'draft_annulled',
        last_error_message = 'El borrador fue anulado porque el hecho operativo fue cancelado.'
    where id = box.id;
    return box.id;
  end if;

  if entry.status in ('publicada', 'reversada') then
    insert into public.accounting_outbox_v2 (
      feature_key, topic, source_type, source_id, event_purpose,
      posting_version, scenario, idempotency_key, occurred_at, cutover_at,
      status, next_attempt_at, actor_id, compensated_event_id
    )
    values (
      box.feature_key,
      'accounting.compensation',
      box.source_type,
      box.source_id,
      target_compensation_purpose,
      'v2',
      'source_cancelled_after_publication',
      box.source_type || ':' || box.source_id::text || ':' || target_compensation_purpose || ':v2',
      cancellation_time,
      box.cutover_at,
      'queued',
      now(),
      coalesce(cancellation_actor, auth.uid(), box.actor_id),
      box.financial_event_id
    )
    on conflict (source_type, source_id, event_purpose, posting_version)
    do update set duplicate_avoided = true
    returning id into compensation_id;

    return compensation_id;
  end if;

  return box.id;
end;
$$;

revoke all on function public.cancel_accounting_fact_v2(
  text, uuid, text, text, uuid
) from public, anon, authenticated;

create or replace function public.handle_order_cancellation_accounting_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  movement_id uuid;
begin
  if new.status::text not in ('cancelado', 'cancelled')
    or old.status::text in ('cancelado', 'cancelled')
  then
    return new;
  end if;

  perform public.cancel_accounting_fact_v2(
    'order', new.id, 'sale_recognized', 'sale_compensation', auth.uid()
  );

  for movement_id in
    select movement.id
    from public.inventory_movements movement
    where movement.reference_type = 'orders'
      and movement.reference_id = new.id
      and movement.movement_type::text = 'sale'
      and movement.quantity < 0
  loop
    perform public.cancel_accounting_fact_v2(
      'inventory_movement',
      movement_id,
      'inventory_cogs',
      'inventory_cogs_compensation',
      auth.uid()
    );
  end loop;

  return new;
end;
$$;

revoke all on function public.handle_order_cancellation_accounting_v2()
  from public, anon, authenticated;

drop trigger if exists orders_cancel_accounting_v2 on public.orders;
create trigger orders_cancel_accounting_v2
after update of status on public.orders
for each row
execute function public.handle_order_cancellation_accounting_v2();
