begin;

create table if not exists public.order_price_feature_flags (
  key text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null,
  constraint order_price_feature_flags_known_key check (
    key in ('order_price_review_v2', 'order_price_confirmation_modal_v1')
  )
);

insert into public.order_price_feature_flags (key, enabled)
values
  ('order_price_review_v2', false),
  ('order_price_confirmation_modal_v1', false)
on conflict (key) do nothing;

alter table public.order_price_feature_flags enable row level security;
revoke all on table public.order_price_feature_flags from public, anon, authenticated;
grant select, insert, update on table public.order_price_feature_flags to service_role;

create table if not exists public.order_price_confirmation_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  actor_id uuid not null references public.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  request_key uuid not null,
  created_at timestamptz not null default now(),
  primary key (backend_pid, transaction_id, actor_id, order_id)
);

alter table public.order_price_confirmation_context enable row level security;
revoke all on table public.order_price_confirmation_context from public, anon, authenticated;
grant select, insert, delete on table public.order_price_confirmation_context to service_role;

create or replace function public.require_order_price_confirmation_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  confirmation_enabled boolean := false;
  confirmation_present boolean := false;
begin
  if new.unit_price is not distinct from old.unit_price
    and new.line_total is not distinct from old.line_total then
    return new;
  end if;

  select coalesce(flags.enabled, false)
  into confirmation_enabled
  from public.order_price_feature_flags flags
  where flags.key = 'order_price_confirmation_modal_v1';

  if not confirmation_enabled then
    return new;
  end if;

  select exists (
    select 1
    from public.order_price_confirmation_context context
    where context.backend_pid = pg_backend_pid()
      and context.transaction_id = txid_current()
      and context.actor_id = auth.uid()
      and context.order_id = new.order_id
  ) into confirmation_present;

  if not confirmation_present then
    raise exception using
      errcode = '42501',
      message = 'ORDER_PRICE_CONFIRMATION_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists require_order_price_confirmation_v1_on_update on public.order_items;
create trigger require_order_price_confirmation_v1_on_update
before update of unit_price, line_total on public.order_items
for each row execute function public.require_order_price_confirmation_v1();

revoke all on function public.require_order_price_confirmation_v1() from public, anon, authenticated;
grant execute on function public.require_order_price_confirmation_v1() to service_role;

create or replace function public.preview_order_price_adjustment_v1(
  p_order_id uuid,
  p_requested_invoice_date date,
  p_line_price_overrides jsonb,
  p_requested_shipping_fee numeric,
  p_delivery_mode text default null,
  p_external_delivery_provider text default null,
  p_expected_version integer default 0,
  p_request_key uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  saved_order public.orders%rowtype;
  configured_tax_rate numeric(5, 4) := 0.15;
  configured_wholesale_minimum numeric(14, 2) := 10000;
  configured_delivery_threshold numeric(14, 2) := 3000;
  configured_suggested_delivery numeric(14, 2) := 120;
  previous_lines jsonb;
  next_lines jsonb;
  changed_lines jsonb;
  previous_financials jsonb;
  next_financials jsonb;
  normalized_shipping numeric(12, 2);
  monetary_change boolean := false;
begin
  if actor_user_id is null then
    raise exception using errcode = '42501', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
    or not public.has_permission('sales:override_price') then
    raise exception using errcode = '42501', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if p_order_id is null or p_request_key is null
    or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if p_line_price_overrides is null or jsonb_typeof(p_line_price_overrides) <> 'array' then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if p_requested_shipping_fee is null
    or p_requested_shipping_fee < 0
    or p_requested_shipping_fee <> round(p_requested_shipping_fee, 2) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  normalized_shipping := round(p_requested_shipping_fee, 2);

  select orders.* into saved_order
  from public.orders
  where orders.id = p_order_id;

  if saved_order.id is null then
    raise exception using errcode = 'P0002', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if saved_order.commercial_terms_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'ORDER_PRICE_VERSION_CONFLICT';
  end if;
  if exists (select 1 from public.invoices where order_id = p_order_id) then
    raise exception using errcode = '22023', message = 'ORDER_ALREADY_INVOICED';
  end if;
  if saved_order.status::text in ('paid', 'entregado', 'delivered', 'cancelado', 'cancelled') then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if saved_order.order_reservation_status in ('released', 'expired', 'canceled', 'confirmed') then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if saved_order.payment_method::text <> 'commercial_credit'
    and exists (
      select 1 from public.payments
      where order_id = p_order_id
        and coalesce(payment_status::text, status::text) in ('approved', 'confirmed', 'paid')
    ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if exists (
    select 1 from public.inventory_movements
    where reference_type = 'orders' and reference_id = p_order_id
      and movement_type = 'sale' and quantity < 0
  ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if exists (
    select 1
    from public.accounts_receivable receivable
    join public.accounts_receivable_payments payment on payment.receivable_id = receivable.id
    where receivable.order_id = p_order_id and payment.voided_at is null
  ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if exists (
    select 1 from public.financial_events event
    where event.status in ('draft_created', 'posted', 'reversed')
      and (
        (event.source_type = 'order' and event.source_id = p_order_id::text)
        or event.source_id in (
          select payments.id::text from public.payments where payments.order_id = p_order_id
          union all
          select receivable.id::text from public.accounts_receivable receivable where receivable.order_id = p_order_id
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_line_price_overrides) as requested(order_item_id uuid, final_unit_price numeric)
    group by requested.order_item_id
    having requested.order_item_id is null or count(*) > 1
  ) or (
    select count(*) from jsonb_to_recordset(p_line_price_overrides) as requested(order_item_id uuid, final_unit_price numeric)
  ) <> (
    select count(*) from public.order_items where order_id = p_order_id
  ) or exists (
    select 1
    from jsonb_to_recordset(p_line_price_overrides) as requested(order_item_id uuid, final_unit_price numeric)
    where not exists (
      select 1 from public.order_items item
      where item.order_id = p_order_id and item.id = requested.order_item_id
    )
  ) or exists (
    select 1
    from public.order_items item
    where item.order_id = p_order_id
      and not exists (
        select 1
        from jsonb_to_recordset(p_line_price_overrides) as requested(order_item_id uuid, final_unit_price numeric)
        where requested.order_item_id = item.id
      )
  ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;

  if exists (
    select 1
    from public.order_items item
    join jsonb_to_recordset(p_line_price_overrides)
      as requested(order_item_id uuid, final_unit_price numeric)
      on requested.order_item_id = item.id
    where item.order_id = p_order_id
      and (
        requested.final_unit_price is null
        or requested.final_unit_price <= 0
        or requested.final_unit_price <> round(requested.final_unit_price, 2)
      )
  ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if exists (
    select 1
    from public.order_items item
    join jsonb_to_recordset(p_line_price_overrides)
      as requested(order_item_id uuid, final_unit_price numeric)
      on requested.order_item_id = item.id
    where item.order_id = p_order_id
      and round(requested.final_unit_price, 2) <> round(item.unit_price, 2)
      and (item.unit_cost_snapshot is null or item.unit_cost_snapshot <= 0
        or round(requested.final_unit_price, 2) < round(item.unit_cost_snapshot, 2))
  ) then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_BELOW_COST';
  end if;

  select exists (
    select 1
    from public.order_items item
    join jsonb_to_recordset(p_line_price_overrides)
      as requested(order_item_id uuid, final_unit_price numeric)
      on requested.order_item_id = item.id
    where item.order_id = p_order_id
      and round(requested.final_unit_price, 2) <> round(item.unit_price, 2)
  ) into monetary_change;
  if not monetary_change then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;

  select
    coalesce(settings.tax_rate, 0.15),
    coalesce(settings.first_wholesale_minimum, 10000),
    coalesce(settings.free_shipping_threshold, 3000),
    coalesce(settings.standard_shipping_fee, 120)
  into configured_tax_rate, configured_wholesale_minimum,
    configured_delivery_threshold, configured_suggested_delivery
  from public.company_settings settings
  order by settings.created_at asc
  limit 1;

  select jsonb_agg(jsonb_build_object(
    'quantity', item.quantity,
    'unit_price', item.unit_price,
    'discount_amount', 0
  ) order by item.id)
  into previous_lines
  from public.order_items item
  where item.order_id = p_order_id;

  select
    jsonb_agg(jsonb_build_object(
      'quantity', item.quantity,
      'unit_price', round(requested.final_unit_price, 2),
      'discount_amount', 0
    ) order by item.id),
    jsonb_agg(jsonb_build_object(
      'order_item_id', item.id,
      'product_name', item.product_name,
      'sku', item.sku,
      'quantity', item.quantity,
      'automatic_unit_price', case
        when item.applied_price_mode = 'wholesale' then item.wholesale_price_snapshot
        else item.retail_price_snapshot
      end,
      'previous_unit_price', item.unit_price,
      'final_unit_price', round(requested.final_unit_price, 2),
      'unit_difference', round(requested.final_unit_price - item.unit_price, 2),
      'total_difference', round((requested.final_unit_price - item.unit_price) * item.quantity, 2),
      'unit_cost', item.unit_cost_snapshot,
      'resulting_unit_margin', round(requested.final_unit_price - item.unit_cost_snapshot, 2),
      'above_automatic_price', requested.final_unit_price > case
        when item.applied_price_mode = 'wholesale' then item.wholesale_price_snapshot
        else item.retail_price_snapshot
      end
    ) order by item.id) filter (
      where round(requested.final_unit_price, 2) <> round(item.unit_price, 2)
    )
  into next_lines, changed_lines
  from public.order_items item
  join jsonb_to_recordset(p_line_price_overrides)
    as requested(order_item_id uuid, final_unit_price numeric)
    on requested.order_item_id = item.id
  where item.order_id = p_order_id;

  previous_financials := public.calculate_sale_financials_v1(
    previous_lines, configured_tax_rate, coalesce(saved_order.discount_total, 0),
    coalesce(saved_order.shipping_fee, saved_order.shipping_total, 0),
    coalesce(saved_order.cash_on_delivery_fee, 0), coalesce(saved_order.small_order_fee, 0),
    coalesce(saved_order.additional_fees, '[]'::jsonb), configured_wholesale_minimum,
    configured_delivery_threshold, configured_suggested_delivery,
    case when saved_order.delivery_mode in ('store_pickup', 'customer_arranged') then 'pickup'
      when saved_order.payment_timing = 'on_delivery' then 'cash_on_delivery' else 'home_delivery' end,
    case when saved_order.price_mode = 'wholesale' then 'wholesale' else 'retail' end, 'HNL'
  );
  next_financials := public.calculate_sale_financials_v1(
    next_lines, configured_tax_rate, coalesce(saved_order.discount_total, 0), normalized_shipping,
    coalesce(saved_order.cash_on_delivery_fee, 0), coalesce(saved_order.small_order_fee, 0),
    coalesce(saved_order.additional_fees, '[]'::jsonb), configured_wholesale_minimum,
    configured_delivery_threshold, configured_suggested_delivery,
    case when p_delivery_mode in ('store_pickup', 'customer_arranged') then 'pickup'
      when saved_order.payment_timing = 'on_delivery' then 'cash_on_delivery' else 'home_delivery' end,
    case when saved_order.price_mode = 'wholesale' then 'wholesale' else 'retail' end, 'HNL'
  );

  return jsonb_build_object(
    'order_id', p_order_id,
    'expected_version', p_expected_version,
    'request_key', p_request_key,
    'lines', coalesce(changed_lines, '[]'::jsonb),
    'previous_financials', previous_financials,
    'next_financials', next_financials,
    'order_total_difference', round(
      (next_financials->>'total_final')::numeric - (previous_financials->>'total_final')::numeric,
      2
    )
  );
end;
$$;

revoke all on function public.preview_order_price_adjustment_v1(
  uuid, date, jsonb, numeric, text, text, integer, uuid
) from public, anon;
grant execute on function public.preview_order_price_adjustment_v1(
  uuid, date, jsonb, numeric, text, text, integer, uuid
) to authenticated, service_role;

create or replace function public.confirm_order_price_adjustment_v1(
  p_order_id uuid,
  p_requested_invoice_date date,
  p_line_price_overrides jsonb,
  p_requested_shipping_fee numeric,
  p_delivery_mode text default null,
  p_external_delivery_provider text default null,
  p_delivery_reason text default null,
  p_expected_version integer default 0,
  p_idempotency_key uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  confirmation_enabled boolean := false;
  clean_note text := nullif(trim(coalesce(p_note, '')), '');
  automatic_text text;
  preview_result jsonb;
  adjustment_result jsonb;
  confirmation_exists boolean := false;
  stored_request public.pos_idempotency_requests%rowtype;
  canonical_payload jsonb;
  payload_hash_value text;
begin
  select coalesce(flags.enabled, false)
  into confirmation_enabled
  from public.order_price_feature_flags flags
  where flags.key = 'order_price_confirmation_modal_v1';
  if not confirmation_enabled then
    raise exception using errcode = '55000', message = 'ORDER_PRICE_CONFIRMATION_DISABLED';
  end if;
  if actor_user_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin')
    or not public.has_permission('sales:override_price') then
    raise exception using errcode = '42501', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
  end if;
  if clean_note is not null and (char_length(clean_note) > 300 or clean_note ~ '[<>]') then
    raise exception using errcode = '22023', message = 'ORDER_PRICE_NOTE_INVALID';
  end if;
  automatic_text := case when clean_note is null
    then 'Ajuste manual autorizado'
    else 'Ajuste manual autorizado ' || chr(8212) || ' ' || clean_note
  end;

  canonical_payload := jsonb_build_object(
    'order_id', p_order_id,
    'requested_invoice_date', p_requested_invoice_date,
    'line_price_overrides', p_line_price_overrides,
    'requested_shipping_fee', round(p_requested_shipping_fee, 2),
    'delivery_mode', p_delivery_mode,
    'external_delivery_provider', nullif(left(trim(coalesce(p_external_delivery_provider, '')), 160), ''),
    'price_reason', automatic_text,
    'delivery_reason', nullif(left(trim(coalesce(p_delivery_reason, '')), 500), ''),
    'expected_version', p_expected_version
  );
  payload_hash_value := encode(extensions.digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex');

  select requests.* into stored_request
  from public.pos_idempotency_requests requests
  where requests.operation = 'adjust_sale_terms_v1'
    and requests.request_key = p_idempotency_key;
  if stored_request.id is not null then
    if stored_request.actor_id <> actor_user_id then
      raise exception using errcode = '42501', message = 'ORDER_PRICE_OVERRIDE_NOT_ALLOWED';
    end if;
    if stored_request.payload_hash <> payload_hash_value then
      raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue utilizada con datos diferentes.';
    end if;
    if stored_request.status = 'succeeded' then
      update public.pos_idempotency_requests
      set attempt_count = attempt_count + 1, last_seen_at = now(), updated_at = now()
      where id = stored_request.id;
      return stored_request.result;
    end if;
  end if;

  preview_result := public.preview_order_price_adjustment_v1(
    p_order_id, p_requested_invoice_date, p_line_price_overrides,
    p_requested_shipping_fee, p_delivery_mode, p_external_delivery_provider,
    p_expected_version, p_idempotency_key
  );

  insert into public.order_price_confirmation_context (
    backend_pid, transaction_id, actor_id, order_id, request_key
  ) values (
    pg_backend_pid(), txid_current(), actor_user_id, p_order_id, p_idempotency_key
  ) on conflict (backend_pid, transaction_id, actor_id, order_id)
  do update set request_key = excluded.request_key, created_at = now();

  adjustment_result := public.adjust_sale_terms_v1(
    p_order_id, p_requested_invoice_date, p_line_price_overrides,
    p_requested_shipping_fee, p_delivery_mode, p_external_delivery_provider,
    automatic_text, p_delivery_reason, p_expected_version, p_idempotency_key
  );

  delete from public.order_price_confirmation_context
  where backend_pid = pg_backend_pid()
    and transaction_id = txid_current()
    and actor_id = actor_user_id
    and order_id = p_order_id;

  select exists (
    select 1 from public.audit_logs logs
    where logs.table_name = 'orders'
      and logs.record_id = p_order_id
      and logs.action = 'sale.price_override.confirmed'
      and logs.new_data->>'request_key' = p_idempotency_key::text
  ) into confirmation_exists;

  if not confirmation_exists then
    perform public.write_audit_log(
      'orders', p_order_id, 'sale.price_override.confirmed',
      jsonb_build_object(
        'commercial_terms_version', p_expected_version,
        'financials', preview_result->'previous_financials'
      ),
      jsonb_build_object(
        'commercial_terms_version', (adjustment_result->>'commercial_terms_version')::integer,
        'version_before', p_expected_version,
        'version_after', (adjustment_result->>'commercial_terms_version')::integer,
        'lines', preview_result->'lines',
        'previous_financials', preview_result->'previous_financials',
        'next_financials', preview_result->'next_financials',
        'order_total_difference', preview_result->'order_total_difference',
        'confirmed', true,
        'method', 'confirmation_modal',
        'automatic_text', automatic_text,
        'note', clean_note,
        'actor_role', actor_role_name,
        'request_key', p_idempotency_key
      )
    );
  end if;

  adjustment_result := adjustment_result || jsonb_build_object('confirmation', preview_result);
  update public.pos_idempotency_requests
  set result = adjustment_result, updated_at = now()
  where operation = 'adjust_sale_terms_v1'
    and request_key = p_idempotency_key
    and actor_id = actor_user_id
    and status = 'succeeded';
  return adjustment_result;
end;
$$;

revoke all on function public.confirm_order_price_adjustment_v1(
  uuid, date, jsonb, numeric, text, text, text, integer, uuid, text
) from public, anon;
grant execute on function public.confirm_order_price_adjustment_v1(
  uuid, date, jsonb, numeric, text, text, text, integer, uuid, text
) to authenticated, service_role;

comment on table public.order_price_feature_flags is
  'Rollback-safe switches for order price classification and confirmation. Both default disabled.';
comment on function public.preview_order_price_adjustment_v1(
  uuid, date, jsonb, numeric, text, text, integer, uuid
) is 'Read-only canonical preview for a future order price adjustment.';
comment on function public.confirm_order_price_adjustment_v1(
  uuid, date, jsonb, numeric, text, text, text, integer, uuid, text
) is 'Idempotent confirmed price adjustment with immutable audit evidence.';

commit;
