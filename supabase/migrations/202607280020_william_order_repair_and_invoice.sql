-- General controlled repair contract plus idempotent fiscal issuance.
-- This migration creates no invoice and repairs no order by itself.

-- Store-pickup normalization and durable worker behavior are enabled only
-- after the affected outbox has been held by the containment migration.
create or replace function public.normalize_accounting_delivery_mode_v1(raw_mode text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(btrim(coalesce(raw_mode, '')))
    when '' then 'home_delivery'
    when 'store_pickup' then 'pickup'
    when 'customer_arranged' then 'pickup'
    when 'car_zone' then 'home_delivery'
    when 'external_company' then 'home_delivery'
    when 'store_immediate' then 'store_immediate'
    when 'home_delivery' then 'home_delivery'
    when 'cash_on_delivery' then 'cash_on_delivery'
    when 'shipping' then 'shipping'
    when 'pickup' then 'pickup'
    else lower(btrim(raw_mode))
  end
$$;

revoke all on function public.normalize_accounting_delivery_mode_v1(text)
  from public, anon, authenticated;
grant execute on function public.normalize_accounting_delivery_mode_v1(text)
  to service_role;

alter function public.calculate_sale_financials_v1(
  jsonb, numeric, numeric, numeric, numeric, numeric, jsonb,
  numeric, numeric, numeric, text, text, text
) rename to calculate_sale_financials_pre_incident_v1;

create or replace function public.calculate_sale_financials_v1(
  resolved_lines jsonb,
  included_tax_rate numeric,
  global_discount numeric default 0,
  delivery_charge numeric default 0,
  cash_on_delivery_charge numeric default 0,
  minimum_order_charge numeric default 0,
  additional_charges jsonb default '[]'::jsonb,
  wholesale_minimum numeric default 10000,
  free_delivery_threshold numeric default 3000,
  suggested_delivery_charge numeric default 120,
  delivery_mode text default 'home_delivery',
  customer_type text default 'retail',
  currency_code text default 'HNL'
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.calculate_sale_financials_pre_incident_v1(
    resolved_lines,
    included_tax_rate,
    global_discount,
    delivery_charge,
    cash_on_delivery_charge,
    minimum_order_charge,
    additional_charges,
    wholesale_minimum,
    free_delivery_threshold,
    suggested_delivery_charge,
    public.normalize_accounting_delivery_mode_v1(delivery_mode),
    customer_type,
    currency_code
  )
$$;

revoke all on function public.calculate_sale_financials_v1(
  jsonb, numeric, numeric, numeric, numeric, numeric, jsonb,
  numeric, numeric, numeric, text, text, text
) from public, anon, authenticated;
grant execute on function public.calculate_sale_financials_v1(
  jsonb, numeric, numeric, numeric, numeric, numeric, jsonb,
  numeric, numeric, numeric, text, text, text
) to service_role;

create or replace function public.cash_on_delivery_applies_v1(
  payment_method_value text,
  payment_timing_value text,
  delivery_mode_value text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    public.normalize_accounting_delivery_mode_v1(delivery_mode_value) <> 'pickup'
    and (
      lower(coalesce(payment_method_value, '')) = 'cash'
      or (
        lower(coalesce(payment_method_value, '')) = 'bank_transfer'
        and lower(coalesce(payment_timing_value, '')) = 'on_delivery'
      )
    )
$$;

revoke all on function public.cash_on_delivery_applies_v1(text, text, text)
  from public, anon, authenticated;
grant execute on function public.cash_on_delivery_applies_v1(text, text, text)
  to service_role;

alter function public.process_accounting_outbox_v2(uuid, text, boolean)
  rename to process_accounting_outbox_v018;

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
  result jsonb;
begin
  select attempt_count, processing_hold
  into before_attempt, held
  from public.accounting_outbox_v2
  where id = target_outbox_id;

  if before_attempt is null then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', target_outbox_id,
      'reason', 'not_found'
    );
  end if;
  if held then
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'outbox_id', target_outbox_id,
      'outbox_status', 'held', 'reason', 'processing_hold'
    );
  end if;

  result := public.process_accounting_outbox_v018(
    target_outbox_id, worker_token, force_retry
  );

  if coalesce((result->>'claimed')::boolean, false) then
    select attempt_count into after_attempt
    from public.accounting_outbox_v2
    where id = target_outbox_id
    for update;

    if after_attempt <= before_attempt then
      update public.accounting_outbox_v2
      set attempt_count = before_attempt + 1
      where id = target_outbox_id
      returning attempt_count into after_attempt;
    end if;

    result := result || jsonb_build_object('attempt_count', after_attempt);
  end if;

  return result;
end;
$$;

revoke all on function public.process_accounting_outbox_v2(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.process_accounting_outbox_v2(uuid, text, boolean)
  to service_role;

create table public.checkout_order_commercial_repair_requests (
  request_key uuid primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_snapshot_fingerprint text not null check (expected_snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  result jsonb not null,
  requested_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.checkout_order_commercial_repair_requests enable row level security;

create policy "Technical owner can read commercial repair requests"
  on public.checkout_order_commercial_repair_requests for select
  using (
    public.current_actor_role() = 'technical_owner'
    and public.has_permission('technical:tools')
  );

revoke all on table public.checkout_order_commercial_repair_requests
  from public, anon, authenticated;
grant select on table public.checkout_order_commercial_repair_requests
  to authenticated;
grant select, insert, update, delete on table public.checkout_order_commercial_repair_requests
  to service_role;

create table public.commercial_snapshot_repair_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  order_id uuid not null references public.orders(id) on delete cascade,
  request_key uuid not null,
  created_at timestamptz not null default now(),
  primary key (backend_pid, transaction_id, order_id)
);

revoke all on table public.commercial_snapshot_repair_context
  from public, anon, authenticated;
grant select, insert, delete on table public.commercial_snapshot_repair_context
  to service_role;

create or replace function public.apply_order_item_authorized_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row record;
  effective_mode public.order_price_mode := coalesce(new.applied_price_mode, 'retail'::public.order_price_mode);
  effective_unit_price numeric(12, 2);
  minimum_wholesale_quantity integer := 1;
  trusted_override boolean := false;
  repair_override boolean := false;
begin
  if tg_op = 'UPDATE' then
    select exists (
      select 1
      from public.commercial_snapshot_repair_context context
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.order_id = new.order_id
    )
    into repair_override;

    if repair_override then
      if new.order_id is distinct from old.order_id
        or new.product_id is distinct from old.product_id
        or new.quantity is distinct from old.quantity
        or new.unit_price is distinct from old.unit_price
        or new.line_total is distinct from old.line_total
        or new.retail_price_snapshot is distinct from old.retail_price_snapshot
        or new.wholesale_price_snapshot is distinct from old.wholesale_price_snapshot
        or new.unit_cost_snapshot is distinct from old.unit_cost_snapshot
        or new.total_cost_snapshot is distinct from old.total_cost_snapshot then
        raise exception using
          errcode = '42501',
          message = 'La reparacion comercial solo puede reclasificar el modo de precio.';
      end if;
      return new;
    end if;
  end if;

  if tg_op = 'UPDATE'
    and (
      new.unit_price is distinct from old.unit_price
      or new.line_total is distinct from old.line_total
    ) then
    select exists (
      select 1
      from public.sale_terms_write_context context
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.actor_id = auth.uid()
        and context.order_id = new.order_id
    )
    into trusted_override;

    if not trusted_override then
      raise exception using
        errcode = '42501',
        message = 'Los precios finales solo pueden modificarse mediante la operacion comercial autorizada.';
    end if;

    if new.order_id is distinct from old.order_id
      or new.product_id is distinct from old.product_id
      or new.quantity is distinct from old.quantity
      or new.applied_price_mode is distinct from old.applied_price_mode
      or new.retail_price_snapshot is distinct from old.retail_price_snapshot
      or new.wholesale_price_snapshot is distinct from old.wholesale_price_snapshot
      or new.unit_cost_snapshot is distinct from old.unit_cost_snapshot
      or new.total_cost_snapshot is distinct from old.total_cost_snapshot then
      raise exception using errcode = '42501', message = 'La operacion comercial no puede cambiar cantidad, producto, modo, snapshots ni costo.';
    end if;

    new.unit_price := round(new.unit_price, 2);
    new.line_total := round(new.unit_price * new.quantity, 2);
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.product_id is not distinct from old.product_id
    and new.quantity is not distinct from old.quantity
    and new.applied_price_mode is not distinct from old.applied_price_mode then
    return new;
  end if;

  if new.product_id is null then
    return new;
  end if;

  select
    products.name,
    products.retail_price,
    products.wholesale_price,
    coalesce(products.wholesale_min_quantity, 1) as wholesale_min_quantity
  into product_row
  from public.products
  where products.id = new.product_id;

  if product_row is null then
    return new;
  end if;

  effective_unit_price := public.get_authorized_product_price(
    product_row.retail_price,
    product_row.wholesale_price,
    effective_mode
  );

  if effective_mode = 'wholesale'
    and effective_unit_price <> round(coalesce(product_row.wholesale_price, 0), 2) then
    effective_mode := 'retail';
  end if;

  minimum_wholesale_quantity := greatest(1, coalesce(product_row.wholesale_min_quantity, 1));
  if effective_mode = 'wholesale'
    and minimum_wholesale_quantity > 1
    and coalesce(new.quantity, 0) < minimum_wholesale_quantity then
    raise exception 'Este producto requiere una compra minima de % unidades para precio mayorista.', minimum_wholesale_quantity;
  end if;

  new.applied_price_mode := effective_mode;
  new.unit_price := effective_unit_price;
  new.line_total := round(effective_unit_price * greatest(coalesce(new.quantity, 0), 0), 2);
  new.retail_price_snapshot := round(coalesce(product_row.retail_price, 0), 2);
  new.wholesale_price_snapshot := round(coalesce(product_row.wholesale_price, 0), 2);
  return new;
end;
$$;

create or replace function public.checkout_order_commercial_repair_snapshot_v1(
  p_order_id uuid
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', 'checkout_order_commercial_repair_snapshot:v1',
    'order', (
      select jsonb_build_object(
        'id', o.id,
        'order_number', o.order_number,
        'tracking_code', o.tracking_code,
        'status', o.status,
        'customer_id', o.customer_id,
        'user_id', o.user_id,
        'price_mode', o.price_mode,
        'subtotal', o.subtotal,
        'tax', o.tax,
        'shipping_fee', coalesce(o.shipping_fee, o.shipping_total, 0),
        'cash_on_delivery_fee', coalesce(o.cash_on_delivery_fee, 0),
        'small_order_fee', coalesce(o.small_order_fee, 0),
        'discount_total', coalesce(o.discount_total, 0),
        'total', o.total,
        'payment_method', o.payment_method,
        'payment_timing', o.payment_timing,
        'delivery_mode', o.delivery_mode,
        'calculation_version', o.calculation_version,
        'commercial_terms_version', o.commercial_terms_version,
        'requested_invoice_date', o.requested_invoice_date,
        'customer_name', o.customer_name,
        'fiscal_customer_name', o.fiscal_customer_name,
        'fiscal_customer_rtn', o.fiscal_customer_rtn,
        'fiscal_customer_phone', o.fiscal_customer_phone,
        'fiscal_customer_email', o.fiscal_customer_email,
        'fiscal_customer_address', o.fiscal_customer_address
      )
      from public.orders o
      where o.id = p_order_id
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'product_id', i.product_id,
        'sku', i.sku,
        'quantity', i.quantity,
        'applied_price_mode', i.applied_price_mode,
        'unit_price', i.unit_price,
        'line_total', i.line_total,
        'retail_price_snapshot', i.retail_price_snapshot,
        'wholesale_price_snapshot', i.wholesale_price_snapshot,
        'unit_cost_snapshot', i.unit_cost_snapshot,
        'total_cost_snapshot', i.total_cost_snapshot
      ) order by i.sku, i.id)
      from public.order_items i
      where i.order_id = p_order_id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'customer_id', p.customer_id,
        'method', p.method,
        'payment_method', p.payment_method,
        'status', p.status,
        'payment_status', p.payment_status,
        'amount', p.amount,
        'paid_at', p.paid_at
      ) order by p.created_at, p.id)
      from public.payments p
      where p.order_id = p_order_id
    ), '[]'::jsonb),
    'reservations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'product_id', r.product_id,
        'quantity', r.quantity,
        'status', r.status
      ) order by r.product_id, r.id)
      from public.inventory_reservations r
      where r.order_id = p_order_id
    ), '[]'::jsonb),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'product_id', m.product_id,
        'movement_type', m.movement_type,
        'quantity', m.quantity,
        'stock_before', m.stock_before,
        'stock_after', m.stock_after,
        'reference_type', m.reference_type
      ) order by m.product_id, m.id)
      from public.inventory_movements m
      where m.reference_id = p_order_id
    ), '[]'::jsonb),
    'sale_outboxes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id,
        'status', b.status,
        'attempt_count', b.attempt_count,
        'max_attempts', b.max_attempts,
        'processing_hold', b.processing_hold,
        'hold_reason', b.hold_reason,
        'financial_event_id', b.financial_event_id,
        'journal_entry_id', b.journal_entry_id
      ) order by b.id)
      from public.accounting_outbox_v2 b
      where b.source_type = 'order'
        and b.source_id = p_order_id
        and b.event_purpose = 'sale_recognized'
        and b.posting_version = 'v2'
    ), '[]'::jsonb),
    'sale_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'status', e.status,
        'journal_entry_id', e.journal_entry_id
      ) order by e.id)
      from public.financial_events e
      where e.source_type = 'order'
        and e.source_id = p_order_id::text
        and e.event_purpose = 'sale_recognized'
        and e.posting_version = 'v2'
    ), '[]'::jsonb),
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id,
        'invoice_number', f.invoice_number,
        'status', f.status
      ) order by f.id)
      from public.invoices f
      where f.order_id = p_order_id
    ), '[]'::jsonb),
    'cogs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'movement_id', m.id,
        'outbox_id', b.id,
        'outbox_status', b.status,
        'event_id', e.id,
        'event_status', e.status,
        'journal_entry_id', j.id,
        'entry_number', j.entry_number,
        'entry_status', j.status,
        'posted_at', j.posted_at
      ) order by m.product_id, m.id)
      from public.inventory_movements m
      left join public.accounting_outbox_v2 b
        on b.source_type = 'inventory_movement'
       and b.source_id = m.id
       and b.event_purpose = 'inventory_cogs'
       and b.posting_version = 'v2'
      left join public.financial_events e on e.id = b.financial_event_id
      left join public.journal_entries j on j.id = b.journal_entry_id
      where m.reference_id = p_order_id
        and m.movement_type = 'sale'
    ), '[]'::jsonb)
  )
$$;

create or replace function public.checkout_order_commercial_repair_fingerprint_v1(
  p_order_id uuid
)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select encode(
    extensions.digest(
      convert_to(public.checkout_order_commercial_repair_snapshot_v1(p_order_id)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

revoke all on function public.checkout_order_commercial_repair_snapshot_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.checkout_order_commercial_repair_fingerprint_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.checkout_order_commercial_repair_snapshot_v1(uuid)
  to service_role;
grant execute on function public.checkout_order_commercial_repair_fingerprint_v1(uuid)
  to service_role;

create or replace function public.repair_checkout_order_commercial_snapshot_v1(
  p_request_key uuid,
  p_order_id uuid,
  p_expected_order_number text,
  p_expected_tracking_code text,
  p_expected_customer_id uuid,
  p_target_customer_id uuid,
  p_target_user_id uuid,
  p_expected_total numeric,
  p_expected_commercial_version integer,
  p_expected_credit_limit numeric,
  p_expected_credit_terms_days integer,
  p_expected_snapshot_fingerprint text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  clean_reason text := nullif(
    left(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 1000),
    ''
  );
  request_hash text;
  existing_request public.checkout_order_commercial_repair_requests%rowtype;
  order_row public.orders%rowtype;
  target_customer public.customers%rowtype;
  payment_row public.payments%rowtype;
  sale_box public.accounting_outbox_v2%rowtype;
  before_snapshot jsonb;
  after_snapshot jsonb;
  actual_fingerprint text;
  item_count integer;
  movement_count integer;
  reservation_count integer;
  cogs_count integer;
  result_value jsonb;
begin
  if not service_call and (
    actor_id is null
    or public.current_actor_role() <> 'technical_owner'
    or not public.has_permission('technical:tools')
  ) then
    raise exception using errcode = '42501', message = 'Solo el propietario tecnico puede reparar snapshots comerciales.';
  end if;
  if p_request_key is null
    or p_order_id is null
    or p_expected_customer_id is null
    or p_target_customer_id is null
    or p_target_user_id is null
    or p_expected_total is null
    or p_expected_credit_limit is null
    or p_expected_credit_terms_days is null
    or p_expected_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
    or clean_reason is null
    or char_length(clean_reason) < 12 then
    raise exception using errcode = '22023', message = 'Los parametros auditados de reparacion son obligatorios.';
  end if;

  request_hash := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'version', 'repair_checkout_order_commercial_snapshot:v1',
        'order_id', p_order_id,
        'expected_order_number', p_expected_order_number,
        'expected_tracking_code', p_expected_tracking_code,
        'expected_customer_id', p_expected_customer_id,
        'target_customer_id', p_target_customer_id,
        'target_user_id', p_target_user_id,
        'expected_total', round(p_expected_total, 2),
        'expected_commercial_version', p_expected_commercial_version,
        'expected_credit_limit', round(p_expected_credit_limit, 2),
        'expected_credit_terms_days', p_expected_credit_terms_days,
        'expected_snapshot_fingerprint', p_expected_snapshot_fingerprint,
        'reason', clean_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended('checkout-commercial-repair:' || p_request_key::text, 0));

  select * into existing_request
  from public.checkout_order_commercial_repair_requests
  where request_key = p_request_key
  for update;

  if existing_request.request_key is not null then
    if existing_request.order_id is distinct from p_order_id
      or existing_request.request_fingerprint is distinct from request_hash then
      raise exception using errcode = '23505', message = 'La clave de reparacion ya fue usada con otros parametros.';
    end if;
    return existing_request.result || jsonb_build_object('replayed', true);
  end if;

  select * into order_row
  from public.orders
  where id = p_order_id
  for update;
  if order_row.id is null then
    raise exception using errcode = 'P0002', message = 'El pedido no existe.';
  end if;

  perform i.id from public.order_items i
  where i.order_id = p_order_id order by i.id for update;
  perform c.id from public.customers c
  where c.id in (p_expected_customer_id, p_target_customer_id) order by c.id for update;
  perform u.id from public.users u
  where u.id = p_target_user_id for share;
  perform p.id from public.payments p
  where p.order_id = p_order_id order by p.id for update;
  perform r.id from public.inventory_reservations r
  where r.order_id = p_order_id order by r.id for update;
  perform m.id from public.inventory_movements m
  where m.reference_id = p_order_id order by m.id for update;
  perform b.id from public.accounting_outbox_v2 b
  where (b.source_type = 'order' and b.source_id = p_order_id)
     or (b.source_type = 'inventory_movement' and b.source_id in (
       select m.id from public.inventory_movements m where m.reference_id = p_order_id
     ))
  order by b.id for update;
  perform e.id from public.financial_events e
  where (e.source_type = 'order' and e.source_id = p_order_id::text)
     or e.id in (
       select b.financial_event_id
       from public.accounting_outbox_v2 b
       where b.source_type = 'inventory_movement'
         and b.source_id in (
           select m.id from public.inventory_movements m where m.reference_id = p_order_id
         )
     )
  order by e.id for update;
  perform f.id from public.invoices f
  where f.order_id = p_order_id order by f.id for update;
  perform j.id
  from public.journal_entries j
  join public.accounting_outbox_v2 b on b.journal_entry_id = j.id
  where (b.source_type = 'order' and b.source_id = p_order_id)
     or (b.source_type = 'inventory_movement' and b.source_id in (
       select m.id from public.inventory_movements m where m.reference_id = p_order_id
     ))
  order by j.id for update;
  perform l.id
  from public.journal_entry_lines l
  join public.journal_entries j on j.id = l.journal_entry_id
  join public.accounting_outbox_v2 b on b.journal_entry_id = j.id
  where (b.source_type = 'order' and b.source_id = p_order_id)
     or (b.source_type = 'inventory_movement' and b.source_id in (
       select m.id from public.inventory_movements m where m.reference_id = p_order_id
     ))
  order by l.id for update;
  perform settings.id
  from public.fiscal_settings settings
  where settings.id = true
  for share;

  before_snapshot := public.checkout_order_commercial_repair_snapshot_v1(p_order_id);
  actual_fingerprint := public.checkout_order_commercial_repair_fingerprint_v1(p_order_id);

  if actual_fingerprint is distinct from p_expected_snapshot_fingerprint then
    raise exception using errcode = 'PT409', message = 'El snapshot del pedido cambio desde la auditoria.';
  end if;
  if order_row.order_number is distinct from p_expected_order_number
    or order_row.tracking_code is distinct from p_expected_tracking_code
    or order_row.customer_id is distinct from p_expected_customer_id
    or order_row.user_id is not null
    or order_row.price_mode::text <> 'retail'
    or round(order_row.total, 2) <> round(p_expected_total, 2)
    or order_row.commercial_terms_version is distinct from p_expected_commercial_version
    or order_row.status::text not in ('entregado', 'delivered')
    or order_row.calculation_version is distinct from 1 then
    raise exception using errcode = 'PT409', message = 'El pedido ya no coincide con el estado comercial auditado.';
  end if;
  if round(order_row.subtotal + order_row.tax, 2) <> round(order_row.total, 2)
    or coalesce(order_row.shipping_fee, order_row.shipping_total, 0) <> 0
    or coalesce(order_row.cash_on_delivery_fee, 0) <> 0
    or coalesce(order_row.small_order_fee, 0) <> 0
    or coalesce(order_row.discount_total, 0) <> 0 then
    raise exception using errcode = '23514', message = 'Los totales o cargos del pedido no coinciden.';
  end if;
  if exists (select 1 from public.invoices where order_id = p_order_id) then
    raise exception using errcode = '23505', message = 'El pedido ya tiene factura fiscal.';
  end if;

  select * into target_customer from public.customers where id = p_target_customer_id;
  if target_customer.id is null
    or not target_customer.active
    or target_customer.status <> 'active'
    or target_customer.user_id is distinct from p_target_user_id
    or not target_customer.is_wholesale
    or target_customer.wholesale_status <> 'approved'
    or not exists (
      select 1 from public.users u
      where u.id = p_target_user_id and u.active
    ) then
    raise exception using errcode = '23514', message = 'El cliente canonico o su cuenta portal no son validos.';
  end if;
  if not exists (
    select 1 from public.customer_credit_accounts credit
    where credit.customer_id = p_target_customer_id
      and credit.is_credit_enabled
      and credit.status = 'active'
      and round(credit.credit_limit, 2) = round(p_expected_credit_limit, 2)
      and credit.terms_days = p_expected_credit_terms_days
  ) then
    raise exception using errcode = '23514', message = 'La cuenta de credito canonica cambio desde la auditoria.';
  end if;

  if (select count(*) from public.payments where order_id = p_order_id) <> 1 then
    raise exception using errcode = '23514', message = 'El pedido no tiene un unico pago.';
  end if;
  select * into payment_row from public.payments where order_id = p_order_id;
  if coalesce(payment_row.payment_status::text, payment_row.status::text) not in ('approved', 'confirmed', 'paid')
    or round(payment_row.amount, 2) <> round(order_row.total, 2)
    or coalesce(payment_row.payment_method::text, payment_row.method::text) <> 'cash' then
    raise exception using errcode = '23514', message = 'El pago ya no coincide con la auditoria.';
  end if;

  select count(*) into item_count from public.order_items where order_id = p_order_id;
  if item_count < 1
    or (select round(sum(i.line_total), 2) from public.order_items i where i.order_id = p_order_id) <> round(order_row.total, 2)
    or exists (
      select 1 from public.order_items i
      where i.order_id = p_order_id
        and (
          i.applied_price_mode::text <> 'retail'
          or i.quantity <= 0
          or i.unit_price <= 0
          or i.line_total <> round(i.unit_price * i.quantity, 2)
        )
    ) then
    raise exception using errcode = '23514', message = 'Las lineas comerciales ya no coinciden con el snapshot auditado.';
  end if;

  select count(*) into reservation_count
  from public.inventory_reservations where order_id = p_order_id;
  select count(*) into movement_count
  from public.inventory_movements
  where reference_id = p_order_id and movement_type = 'sale';
  if reservation_count <> item_count
    or movement_count <> item_count
    or exists (
      select 1
      from public.order_items i
      left join public.inventory_reservations r
        on r.order_id = i.order_id and r.product_id = i.product_id
       and r.quantity = i.quantity and r.status = 'confirmed'
      left join public.inventory_movements m
        on m.reference_id = i.order_id and m.product_id = i.product_id
       and m.movement_type = 'sale' and m.quantity = -i.quantity
       and m.stock_after = m.stock_before - i.quantity
      where i.order_id = p_order_id and (r.id is null or m.id is null)
    )
    or exists (
      select 1 from public.inventory_movements m
      where m.reference_id = p_order_id and m.movement_type <> 'sale'
    ) then
    raise exception using errcode = '23514', message = 'Inventario o reservas cambiaron desde la auditoria.';
  end if;

  select count(*) into cogs_count
  from public.inventory_movements m
  join public.accounting_outbox_v2 b
    on b.source_type = 'inventory_movement'
   and b.source_id = m.id
   and b.event_purpose = 'inventory_cogs'
   and b.posting_version = 'v2'
   and b.status = 'completed'
  join public.financial_events e
    on e.id = b.financial_event_id
   and e.journal_entry_id = b.journal_entry_id
  join public.journal_entries j
    on j.id = b.journal_entry_id
   and j.status = 'borrador'
   and j.posted_at is null
  where m.reference_id = p_order_id and m.movement_type = 'sale';

  if cogs_count <> item_count
    or exists (
      select 1
      from public.inventory_movements m
      join public.accounting_outbox_v2 b
        on b.source_type = 'inventory_movement'
       and b.source_id = m.id
       and b.event_purpose = 'inventory_cogs'
      join public.journal_entry_lines l on l.journal_entry_id = b.journal_entry_id
      where m.reference_id = p_order_id
      group by b.journal_entry_id
      having sum(l.debit) <> sum(l.credit)
    ) then
    raise exception using errcode = '23514', message = 'Los COGS ya no son dos borradores balanceados equivalentes a las salidas.';
  end if;

  if (
    select count(*) from public.accounting_outbox_v2 b
    where b.source_type = 'order'
      and b.source_id = p_order_id
      and b.event_purpose = 'sale_recognized'
      and b.posting_version = 'v2'
  ) <> 1 then
    raise exception using errcode = '23514', message = 'El pedido no conserva una unica outbox de venta.';
  end if;
  select * into sale_box
  from public.accounting_outbox_v2 b
  where b.source_type = 'order'
    and b.source_id = p_order_id
    and b.event_purpose = 'sale_recognized'
    and b.posting_version = 'v2';
  if not sale_box.processing_hold
    or sale_box.status = 'completed'
    or sale_box.financial_event_id is not null
    or sale_box.journal_entry_id is not null
    or exists (
      select 1 from public.financial_events e
      where e.source_type = 'order'
        and e.source_id = p_order_id::text
        and e.event_purpose = 'sale_recognized'
    ) then
    raise exception using errcode = '23514', message = 'La outbox de venta no esta retenida sin reconocimiento previo.';
  end if;

  insert into public.commercial_snapshot_repair_context(
    backend_pid, transaction_id, order_id, request_key
  )
  values (pg_backend_pid(), txid_current(), p_order_id, p_request_key);

  update public.orders
  set customer_id = p_target_customer_id,
      user_id = p_target_user_id,
      price_mode = 'wholesale',
      customer_name = target_customer.contact_name,
      fiscal_customer_name = coalesce(
        nullif(btrim(target_customer.business_name), ''),
        target_customer.contact_name
      ),
      fiscal_customer_rtn = nullif(
        regexp_replace(coalesce(target_customer.tax_id, ''), '[\s-]', '', 'g'),
        ''
      ),
      fiscal_customer_phone = nullif(btrim(target_customer.phone), ''),
      fiscal_customer_email = lower(nullif(btrim(target_customer.email), '')),
      fiscal_customer_address = coalesce(
        nullif(btrim(target_customer.address), ''),
        nullif(btrim(target_customer.city), ''),
        order_row.fiscal_customer_address,
        order_row.delivery_address
      ),
      updated_at = now()
  where id = p_order_id;

  update public.order_items
  set applied_price_mode = 'wholesale',
      updated_at = now()
  where order_id = p_order_id;

  update public.payments
  set customer_id = p_target_customer_id,
      updated_at = now()
  where order_id = p_order_id;

  delete from public.commercial_snapshot_repair_context
  where backend_pid = pg_backend_pid()
    and transaction_id = txid_current()
    and order_id = p_order_id;

  if (select round(sum(i.line_total), 2) from public.order_items i where i.order_id = p_order_id) <> round(p_expected_total, 2)
    or exists (
      select 1 from public.order_items i
      where i.order_id = p_order_id
        and (
          i.applied_price_mode::text <> 'wholesale'
          or i.line_total <> round(i.unit_price * i.quantity, 2)
        )
    ) then
    raise exception using errcode = '23514', message = 'La reclasificacion intento alterar los importes autorizados.';
  end if;

  after_snapshot := public.checkout_order_commercial_repair_snapshot_v1(p_order_id);
  result_value := jsonb_build_object(
    'status', 'repaired',
    'replayed', false,
    'order_id', p_order_id,
    'order_number', p_expected_order_number,
    'previous_customer_id', p_expected_customer_id,
    'customer_id', p_target_customer_id,
    'user_id', p_target_user_id,
    'previous_price_mode', 'retail',
    'price_mode', 'wholesale',
    'total', round(p_expected_total, 2),
    'sale_outbox_id', sale_box.id,
    'sale_outbox_held', true,
    'before_fingerprint', actual_fingerprint,
    'after_fingerprint', public.checkout_order_commercial_repair_fingerprint_v1(p_order_id)
  );

  insert into public.checkout_order_commercial_repair_requests(
    request_key, order_id, request_fingerprint,
    expected_snapshot_fingerprint, before_snapshot, after_snapshot,
    result, requested_by
  )
  values (
    p_request_key, p_order_id, request_hash,
    p_expected_snapshot_fingerprint, before_snapshot, after_snapshot,
    result_value, actor_id
  );

  perform public.write_audit_log(
    'orders',
    p_order_id,
    'checkout.order.commercial_snapshot_repaired',
    jsonb_build_object(
      'customer_id', p_expected_customer_id,
      'user_id', null,
      'price_mode', 'retail',
      'total', round(p_expected_total, 2),
      'fiscal_customer_name', order_row.fiscal_customer_name,
      'fiscal_customer_rtn', order_row.fiscal_customer_rtn,
      'fiscal_customer_phone', order_row.fiscal_customer_phone,
      'fiscal_customer_email', order_row.fiscal_customer_email,
      'fiscal_customer_address', order_row.fiscal_customer_address
    ),
    jsonb_build_object(
      'customer_id', p_target_customer_id,
      'user_id', p_target_user_id,
      'price_mode', 'wholesale',
      'total', round(p_expected_total, 2),
      'fiscal_customer_name', coalesce(nullif(btrim(target_customer.business_name), ''), target_customer.contact_name),
      'fiscal_customer_rtn', nullif(regexp_replace(coalesce(target_customer.tax_id, ''), '[\s-]', '', 'g'), ''),
      'fiscal_customer_phone', nullif(btrim(target_customer.phone), ''),
      'fiscal_customer_email', lower(nullif(btrim(target_customer.email), '')),
      'fiscal_customer_address', coalesce(nullif(btrim(target_customer.address), ''), nullif(btrim(target_customer.city), ''), order_row.fiscal_customer_address, order_row.delivery_address),
      'request_key', p_request_key,
      'reason', clean_reason,
      'note', 'Pedido creado como invitado despues de fallos autenticados. Importes mayoristas definidos por business_owner y conciliados. Reclasificacion y vinculacion reparadas de forma controlada.'
    )
  );

  return result_value;
end;
$$;

revoke all on function public.repair_checkout_order_commercial_snapshot_v1(
  uuid, uuid, text, text, uuid, uuid, uuid, numeric, integer, numeric, integer, text, text
) from public, anon, authenticated;
grant execute on function public.repair_checkout_order_commercial_snapshot_v1(
  uuid, uuid, text, text, uuid, uuid, uuid, numeric, integer, numeric, integer, text, text
) to authenticated, service_role;

create table public.fiscal_invoice_requests_v2 (
  request_key uuid primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  invoice_number text not null,
  result jsonb not null,
  requested_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index fiscal_invoice_requests_v2_order_idx
  on public.fiscal_invoice_requests_v2(order_id, created_at);

alter table public.fiscal_invoice_requests_v2 enable row level security;
create policy "Invoice staff can read fiscal request results"
  on public.fiscal_invoice_requests_v2 for select
  using (
    public.has_permission('invoices:create')
    or public.has_permission('invoices:manage')
  );

revoke all on table public.fiscal_invoice_requests_v2
  from public, anon, authenticated;
grant select on table public.fiscal_invoice_requests_v2 to authenticated;
grant select, insert, update, delete on table public.fiscal_invoice_requests_v2 to service_role;

create or replace function public.generate_fiscal_invoice_from_order_v2(
  p_request_key uuid,
  p_order_id uuid
)
returns table (
  status text,
  replayed boolean,
  invoice_id uuid,
  invoice_number text,
  order_id uuid,
  total numeric,
  fiscal_date date,
  accounting_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  request_hash text;
  request_row public.fiscal_invoice_requests_v2%rowtype;
  order_row public.orders%rowtype;
  existing_invoice public.invoices%rowtype;
  generated record;
  result_value jsonb;
begin
  if not service_call and (
    actor_id is null
    or not (
      public.has_permission('invoices:create')
      or public.has_permission('invoices:manage')
    )
  ) then
    raise exception using errcode = '42501', message = 'No tienes permiso para generar facturas fiscales.';
  end if;
  if p_request_key is null or p_order_id is null then
    raise exception using errcode = '22023', message = 'La clave de solicitud y el pedido son obligatorios.';
  end if;

  request_hash := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'version', 'generate_fiscal_invoice_from_order:v2',
        'order_id', p_order_id
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended('fiscal-invoice-v2:' || p_request_key::text, 0));

  select * into request_row
  from public.fiscal_invoice_requests_v2
  where request_key = p_request_key
  for update;

  if request_row.request_key is not null then
    if request_row.order_id is distinct from p_order_id
      or request_row.request_fingerprint is distinct from request_hash then
      raise exception using errcode = '23505', message = 'La clave fiscal ya fue usada con otro pedido.';
    end if;
    return query select
      request_row.result->>'status',
      true,
      request_row.invoice_id,
      request_row.invoice_number,
      request_row.order_id,
      (request_row.result->>'total')::numeric,
      (request_row.result->>'fiscal_date')::date,
      request_row.result->>'accounting_status';
    return;
  end if;

  select * into order_row
  from public.orders
  where id = p_order_id
  for update;
  if order_row.id is null then
    raise exception using errcode = 'P0002', message = 'El pedido no existe.';
  end if;

  select * into existing_invoice
  from public.invoices
  where invoices.order_id = p_order_id
  order by created_at
  limit 1
  for update;

  if existing_invoice.id is null then
    if public.cash_on_delivery_applies_v1(
      order_row.payment_method::text,
      order_row.payment_timing,
      order_row.delivery_mode
    ) and coalesce(order_row.cash_on_delivery_fee, 0) <= 0 then
      raise exception using
        errcode = '23514',
        message = 'Debes confirmar el cargo contra entrega antes de emitir la factura.';
    end if;

    select * into generated
    from public.generate_fiscal_invoice_from_order(p_order_id);
    select * into existing_invoice
    from public.invoices
    where id = generated.invoice_id;
  end if;

  if existing_invoice.id is null then
    raise exception using errcode = 'P0001', message = 'No se pudo confirmar la factura fiscal.';
  end if;

  result_value := jsonb_build_object(
    'status', 'issued',
    'replayed', false,
    'invoice_id', existing_invoice.id,
    'invoice_number', existing_invoice.invoice_number,
    'order_id', p_order_id,
    'total', existing_invoice.total,
    'fiscal_date', existing_invoice.invoice_date,
    'accounting_status', 'sale_recognition_draft_only'
  );

  insert into public.fiscal_invoice_requests_v2(
    request_key, order_id, request_fingerprint,
    invoice_id, invoice_number, result, requested_by
  )
  values (
    p_request_key, p_order_id, request_hash,
    existing_invoice.id, existing_invoice.invoice_number,
    result_value, actor_id
  );

  return query select
    'issued'::text,
    false,
    existing_invoice.id,
    existing_invoice.invoice_number,
    p_order_id,
    existing_invoice.total,
    existing_invoice.invoice_date,
    'sale_recognition_draft_only'::text;
end;
$$;

revoke all on function public.generate_fiscal_invoice_from_order_v2(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.generate_fiscal_invoice_from_order_v2(uuid, uuid)
  to authenticated, service_role;

revoke all on function public.generate_fiscal_invoice_from_order(uuid)
  from authenticated;
grant execute on function public.generate_fiscal_invoice_from_order(uuid)
  to service_role;
