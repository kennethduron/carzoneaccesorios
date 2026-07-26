-- Shared, transactional commercial terms for the current order flow and the future POS.
-- This migration is additive: no historical order, invoice, payment or accounting row is rewritten.

alter table public.orders
  add column if not exists requested_invoice_date date,
  add column if not exists shipping_fee_suggested numeric(12, 2),
  add column if not exists commercial_terms_version integer not null default 0,
  add column if not exists delivery_mode text,
  add column if not exists external_delivery_provider text;

alter table public.orders
  drop constraint if exists orders_shipping_fee_suggested_nonnegative,
  add constraint orders_shipping_fee_suggested_nonnegative
    check (shipping_fee_suggested is null or shipping_fee_suggested >= 0),
  drop constraint if exists orders_commercial_terms_version_nonnegative,
  add constraint orders_commercial_terms_version_nonnegative
    check (commercial_terms_version >= 0),
  drop constraint if exists orders_delivery_mode_check,
  add constraint orders_delivery_mode_check
    check (
      delivery_mode is null
      or delivery_mode in ('car_zone', 'external_company', 'store_pickup', 'customer_arranged', 'other')
    ),
  drop constraint if exists orders_external_delivery_provider_length,
  add constraint orders_external_delivery_provider_length
    check (external_delivery_provider is null or char_length(external_delivery_provider) <= 160);

alter table public.invoices
  add column if not exists invoice_date date;

alter table public.financial_events
  add column if not exists accounting_date date;

comment on column public.orders.requested_invoice_date is
  'Date-only commercial invoice date selected before issuance. It never replaces the technical order timestamp.';
comment on column public.orders.shipping_fee_suggested is
  'Canonical calculator delivery suggestion captured at the last commercial-terms save.';
comment on column public.orders.commercial_terms_version is
  'Optimistic concurrency version for adjust_sale_terms_v1.';
comment on column public.invoices.invoice_date is
  'Immutable commercial/fiscal date snapshot. issued_at remains the real technical issuance timestamp.';
comment on column public.financial_events.accounting_date is
  'Commercial accounting date when a source supplies one; legacy consumers fall back to Honduras date of occurred_at.';

-- Keep the role permission document authoritative in the database. Remove first
-- so an accidental legacy grant cannot survive, then grant only to the approved roles.
update public.roles
set permissions = ((permissions - 'sales:set_invoice_date') - 'sales:override_price') - 'sales:override_delivery',
    updated_at = now();

update public.roles
set permissions = (
      select coalesce(jsonb_agg(distinct permission_value), '[]'::jsonb)
      from jsonb_array_elements(
        permissions || '["sales:set_invoice_date","sales:override_price","sales:override_delivery"]'::jsonb
      ) permission_value
    ),
    updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

-- Keep the accountant's already-approved invoice workflow usable in the
-- application permission matrix. These are read/issue capabilities only;
-- none of the commercial override permissions are granted.
update public.roles
set permissions = (
      select coalesce(jsonb_agg(distinct permission_value), '[]'::jsonb)
      from jsonb_array_elements(
        permissions || '["orders:read","invoices:create"]'::jsonb
      ) permission_value
    ),
    updated_at = now()
where name = 'contadora';

drop policy if exists "Invoice staff can read order items" on public.order_items;
create policy "Invoice staff can read order items"
  on public.order_items for select
  using (
    public.has_permission('invoices:create')
    and exists (
      select 1
      from public.orders
      where orders.id = order_items.order_id
    )
  );

-- This table is private transaction context. Unlike a custom GUC, authenticated
-- callers cannot forge it. The price trigger accepts overrides only while the
-- trusted RPC holds a row for the same backend, transaction, actor and order.
create table if not exists public.sale_terms_write_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  actor_id uuid not null,
  order_id uuid not null references public.orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (backend_pid, transaction_id, order_id)
);

revoke all on table public.sale_terms_write_context from public, anon, authenticated;
grant select, insert, delete on table public.sale_terms_write_context to service_role;

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
begin
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

create or replace function public.guard_order_commercial_terms_write_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('postgres', 'service_role')
    and (
      new.requested_invoice_date is distinct from old.requested_invoice_date
      or new.shipping_fee_suggested is distinct from old.shipping_fee_suggested
      or new.commercial_terms_version is distinct from old.commercial_terms_version
      or new.delivery_mode is distinct from old.delivery_mode
      or new.external_delivery_provider is distinct from old.external_delivery_provider
      or new.subtotal is distinct from old.subtotal
      or new.tax is distinct from old.tax
      or new.shipping_fee is distinct from old.shipping_fee
      or new.shipping_total is distinct from old.shipping_total
      or new.discount_total is distinct from old.discount_total
      or new.total is distinct from old.total
      or new.calculation_version is distinct from old.calculation_version
    ) then
    raise exception using errcode = '42501', message = 'Los terminos monetarios del pedido solo pueden modificarse mediante una operacion autorizada.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_order_commercial_terms_write_v1_on_update on public.orders;
create trigger guard_order_commercial_terms_write_v1_on_update
before update on public.orders
for each row execute function public.guard_order_commercial_terms_write_v1();

create or replace function public.guard_issued_invoice_snapshot_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status::text <> 'draft'
    and (
      new.order_id is distinct from old.order_id
      or new.invoice_number is distinct from old.invoice_number
      or new.rtn is distinct from old.rtn
      or new.cai is distinct from old.cai
      or new.cai_authorization_date is distinct from old.cai_authorization_date
      or new.invoice_date is distinct from old.invoice_date
      or new.issued_at is distinct from old.issued_at
      or new.price_mode is distinct from old.price_mode
      or new.subtotal is distinct from old.subtotal
      or new.tax is distinct from old.tax
      or new.shipping_fee is distinct from old.shipping_fee
      or new.cash_on_delivery_fee is distinct from old.cash_on_delivery_fee
      or new.small_order_fee is distinct from old.small_order_fee
      or new.discount_total is distinct from old.discount_total
      or new.additional_fees is distinct from old.additional_fees
      or new.total is distinct from old.total
      or new.company_rtn is distinct from old.company_rtn
      or new.fiscal_range_start is distinct from old.fiscal_range_start
      or new.fiscal_range_end is distinct from old.fiscal_range_end
      or new.calculation_version is distinct from old.calculation_version
    ) then
    raise exception using errcode = '42501', message = 'El snapshot fiscal de una factura emitida es inmutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_issued_invoice_snapshot_v1_on_update on public.invoices;
create trigger guard_issued_invoice_snapshot_v1_on_update
before update on public.invoices
for each row execute function public.guard_issued_invoice_snapshot_v1();

create or replace function public.guard_issued_invoice_items_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  target_invoice_id uuid := case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
begin
  if exists (
    select 1
    from public.invoices
    where invoices.id = target_invoice_id
      and invoices.status::text <> 'draft'
  ) then
    raise exception using errcode = '42501', message = 'Las lineas de una factura emitida son inmutables.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_issued_invoice_items_v1_on_write on public.invoice_items;
create trigger guard_issued_invoice_items_v1_on_write
before update or delete on public.invoice_items
for each row execute function public.guard_issued_invoice_items_v1();

create or replace function public.adjust_sale_terms_v1(
  p_order_id uuid,
  p_requested_invoice_date date,
  p_line_price_overrides jsonb,
  p_requested_shipping_fee numeric,
  p_delivery_mode text default null,
  p_external_delivery_provider text default null,
  p_price_reason text default null,
  p_delivery_reason text default null,
  p_expected_version integer default 0,
  p_idempotency_key uuid default null
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
  today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
  saved_order public.orders%rowtype;
  fiscal_record public.fiscal_settings%rowtype;
  stored_request public.pos_idempotency_requests%rowtype;
  canonical_payload jsonb;
  payload_hash_value text;
  inserted_count integer := 0;
  override_row record;
  resolved_lines jsonb;
  price_changes jsonb := '[]'::jsonb;
  financial_result jsonb;
  configured_tax_rate numeric(5, 4) := 0.15;
  configured_wholesale_minimum numeric(14, 2) := 10000;
  configured_delivery_threshold numeric(14, 2) := 3000;
  configured_suggested_delivery numeric(14, 2) := 120;
  normalized_shipping numeric(12, 2);
  normalized_provider text := nullif(left(trim(coalesce(p_external_delivery_provider, '')), 160), '');
  normalized_price_reason text := nullif(left(trim(coalesce(p_price_reason, '')), 500), '');
  normalized_delivery_reason text := nullif(left(trim(coalesce(p_delivery_reason, '')), 500), '');
  monetary_change boolean := false;
  date_change boolean := false;
  delivery_change boolean := false;
  result_payload jsonb;
begin
  if actor_user_id is null then
    raise exception using errcode = '42501', message = 'Debes iniciar sesion para ajustar los terminos de venta.';
  end if;
  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
    or not (
      public.has_permission('sales:set_invoice_date')
      or public.has_permission('sales:override_price')
      or public.has_permission('sales:override_delivery')
    ) then
    raise exception using errcode = '42501', message = 'No tienes permiso para ajustar terminos comerciales.';
  end if;
  if p_order_id is null or p_idempotency_key is null
    or p_idempotency_key = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'El pedido y la clave de idempotencia son obligatorios.';
  end if;
  if p_requested_invoice_date is null then
    raise exception using errcode = '22023', message = 'Selecciona una fecha de factura valida.';
  end if;
  if p_line_price_overrides is null or jsonb_typeof(p_line_price_overrides) <> 'array' then
    raise exception using errcode = '22023', message = 'Los precios de las lineas no tienen un formato valido.';
  end if;
  if p_requested_shipping_fee is null
    or p_requested_shipping_fee < 0
    or p_requested_shipping_fee <> round(p_requested_shipping_fee, 2) then
    raise exception using errcode = '22023', message = 'Ingresa un cargo de entrega no negativo con un maximo de dos decimales.';
  end if;
  normalized_shipping := round(p_requested_shipping_fee, 2);
  if p_delivery_mode is not null
    and p_delivery_mode not in ('car_zone', 'external_company', 'store_pickup', 'customer_arranged', 'other') then
    raise exception using errcode = '22023', message = 'La modalidad de entrega no es valida.';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'La version comercial esperada no es valida.';
  end if;

  canonical_payload := jsonb_build_object(
    'order_id', p_order_id,
    'requested_invoice_date', p_requested_invoice_date,
    'line_price_overrides', p_line_price_overrides,
    'requested_shipping_fee', normalized_shipping,
    'delivery_mode', p_delivery_mode,
    'external_delivery_provider', normalized_provider,
    'price_reason', normalized_price_reason,
    'delivery_reason', normalized_delivery_reason,
    'expected_version', p_expected_version
  );
  payload_hash_value := encode(extensions.digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.pos_idempotency_requests (
    request_key, operation, actor_id, actor_role, payload_hash, status, lease_expires_at
  )
  values (
    p_idempotency_key, 'adjust_sale_terms_v1', actor_user_id, actor_role_name,
    payload_hash_value, 'processing', now() + interval '5 minutes'
  )
  on conflict (operation, request_key) do nothing;
  get diagnostics inserted_count = row_count;

  select requests.*
  into stored_request
  from public.pos_idempotency_requests requests
  where requests.operation = 'adjust_sale_terms_v1'
    and requests.request_key = p_idempotency_key
  for update;

  if stored_request.actor_id <> actor_user_id then
    raise exception using errcode = '42501', message = 'La clave de idempotencia pertenece a otro actor.';
  end if;
  if stored_request.payload_hash <> payload_hash_value then
    raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue utilizada con datos diferentes.';
  end if;
  if inserted_count = 0 then
    update public.pos_idempotency_requests
    set attempt_count = attempt_count + 1, last_seen_at = now(), updated_at = now()
    where id = stored_request.id;
    if stored_request.status = 'succeeded' then
      return stored_request.result;
    end if;
    if stored_request.status = 'failed' then
      raise exception using errcode = 'P0001', message = coalesce(stored_request.safe_error->>'message', 'La solicitud anterior fallo.');
    end if;
    raise exception using errcode = '55P03', message = 'La misma solicitud continua en procesamiento.';
  end if;

  select orders.*
  into saved_order
  from public.orders
  where orders.id = p_order_id
  for update;
  if saved_order.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el pedido.';
  end if;

  perform order_items.id
  from public.order_items
  where order_items.order_id = p_order_id
  order by order_items.id
  for update;
  perform payments.id
  from public.payments
  where payments.order_id = p_order_id
  order by payments.id
  for update;
  perform receivable.id
  from public.accounts_receivable receivable
  where receivable.order_id = p_order_id
  order by receivable.id
  for update;

  if saved_order.commercial_terms_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Otro usuario modifico estos terminos. Recarga el pedido antes de guardar.';
  end if;
  if saved_order.status::text in ('cancelado', 'cancelled') then
    raise exception using errcode = '22023', message = 'No se pueden modificar terminos de un pedido cancelado.';
  end if;
  if exists (select 1 from public.invoices where order_id = p_order_id) then
    raise exception using errcode = '22023', message = 'Los terminos no pueden modificarse despues de generar la factura.';
  end if;
  if p_requested_invoice_date > today_hn then
    raise exception using errcode = '22023', message = 'La fecha de factura no puede ser futura en Honduras.';
  end if;

  select *
  into fiscal_record
  from public.fiscal_settings
  where id = true
  for share;
  if fiscal_record.id is null
    or fiscal_record.cai_authorization_date is null
    or fiscal_record.emission_deadline is null then
    raise exception using errcode = '22023', message = 'Configura la vigencia fiscal antes de seleccionar la fecha de factura.';
  end if;
  if p_requested_invoice_date < fiscal_record.cai_authorization_date
    or p_requested_invoice_date > fiscal_record.emission_deadline then
    raise exception using errcode = '22023', message = 'La fecha de factura esta fuera de la vigencia fiscal configurada.';
  end if;
  if public.is_date_in_closed_accounting_period(p_requested_invoice_date) then
    raise exception using errcode = '22023', message = 'La fecha de factura pertenece a un periodo contable cerrado.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_line_price_overrides) as requested(order_item_id uuid, final_unit_price numeric)
    group by requested.order_item_id
    having requested.order_item_id is null or count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Cada linea debe aparecer una sola vez en la solicitud.';
  end if;
  if (
    select count(*) from jsonb_to_recordset(p_line_price_overrides) as requested(order_item_id uuid, final_unit_price numeric)
  ) <> (
    select count(*) from public.order_items where order_id = p_order_id
  ) then
    raise exception using errcode = '22023', message = 'La solicitud debe incluir exactamente todas las lineas del pedido.';
  end if;

  for override_row in
    select
      item.id,
      item.quantity,
      item.unit_price,
      item.unit_cost_snapshot,
      item.applied_price_mode,
      item.retail_price_snapshot,
      item.wholesale_price_snapshot,
      requested.final_unit_price,
      case
        when item.applied_price_mode = 'wholesale' then item.wholesale_price_snapshot
        else item.retail_price_snapshot
      end as original_price
    from public.order_items item
    join jsonb_to_recordset(p_line_price_overrides)
      as requested(order_item_id uuid, final_unit_price numeric)
      on requested.order_item_id = item.id
    where item.order_id = p_order_id
    order by item.id
  loop
    if override_row.final_unit_price is null
      or override_row.final_unit_price <= 0
      or override_row.final_unit_price <> round(override_row.final_unit_price, 2) then
      raise exception using errcode = '22023', message = 'Todos los precios finales deben ser positivos y tener un maximo de dos decimales.';
    end if;
    if round(override_row.final_unit_price, 2) <> round(override_row.unit_price, 2) then
      monetary_change := true;
      if override_row.unit_cost_snapshot is null or override_row.unit_cost_snapshot <= 0 then
        raise exception using errcode = '22023', message = 'No se puede ajustar el precio porque este producto no tiene un costo valido registrado.';
      end if;
      if round(override_row.final_unit_price, 2) < round(override_row.unit_cost_snapshot, 2) then
        raise exception using errcode = '22023', message = 'No se puede aplicar este precio porque es inferior al costo registrado del producto.';
      end if;
      price_changes := price_changes || jsonb_build_array(jsonb_build_object(
        'order_item_id', override_row.id,
        'original_authorized_price', override_row.original_price,
        'previous_final_price', override_row.unit_price,
        'final_unit_price', round(override_row.final_unit_price, 2),
        'unit_cost_snapshot', override_row.unit_cost_snapshot,
        'unit_difference', round(override_row.final_unit_price - override_row.original_price, 2),
        'unit_margin', round(override_row.final_unit_price - override_row.unit_cost_snapshot, 2),
        'total_margin', round((override_row.final_unit_price - override_row.unit_cost_snapshot) * override_row.quantity, 2)
      ));
    end if;
  end loop;

  if normalized_shipping <> round(coalesce(saved_order.shipping_fee, saved_order.shipping_total, 0), 2) then
    monetary_change := true;
    delivery_change := true;
  end if;
  if p_delivery_mode is distinct from saved_order.delivery_mode
    or normalized_provider is distinct from saved_order.external_delivery_provider then
    delivery_change := true;
  end if;
  date_change := p_requested_invoice_date is distinct from saved_order.requested_invoice_date;

  if date_change and not public.has_permission('sales:set_invoice_date') then
    raise exception using errcode = '42501', message = 'No tienes permiso para cambiar la fecha seleccionada de factura.';
  end if;
  if jsonb_array_length(price_changes) > 0 and not public.has_permission('sales:override_price') then
    raise exception using errcode = '42501', message = 'No tienes permiso para ajustar precios finales.';
  end if;
  if delivery_change and not public.has_permission('sales:override_delivery') then
    raise exception using errcode = '42501', message = 'No tienes permiso para ajustar la entrega.';
  end if;
  if monetary_change then
    if saved_order.status::text in ('paid', 'entregado', 'delivered') then
      raise exception using errcode = '22023', message = 'Los importes no pueden cambiarse en el estado actual del pedido.';
    end if;
    if saved_order.order_reservation_status in ('released', 'expired', 'canceled', 'confirmed') then
      raise exception using errcode = '22023', message = 'Los importes no pueden cambiarse porque la reserva ya no es editable.';
    end if;
    if saved_order.payment_method::text <> 'commercial_credit'
      and exists (
        select 1 from public.payments
        where order_id = p_order_id
          and coalesce(payment_status::text, status::text) in ('approved', 'confirmed', 'paid')
      ) then
      raise exception using errcode = '22023', message = 'Los importes no pueden cambiarse despues de confirmar el pago.';
    end if;
    if exists (
      select 1 from public.inventory_movements
      where reference_type = 'orders'
        and reference_id = p_order_id
        and movement_type = 'sale'
        and quantity < 0
    ) then
      raise exception using errcode = '22023', message = 'Los importes no pueden cambiarse despues de consumir inventario.';
    end if;
    if exists (
      select 1
      from public.accounts_receivable receivable
      join public.accounts_receivable_payments payment on payment.receivable_id = receivable.id
      where receivable.order_id = p_order_id and payment.voided_at is null
    ) then
      raise exception using errcode = '22023', message = 'Los importes no pueden cambiarse porque la cuenta por cobrar ya tiene abonos.';
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
      raise exception using errcode = '22023', message = 'Los importes no pueden cambiarse porque existe trazabilidad contable irreversible.';
    end if;
  end if;

  insert into public.sale_terms_write_context (backend_pid, transaction_id, actor_id, order_id)
  values (pg_backend_pid(), txid_current(), actor_user_id, p_order_id);

  update public.order_items item
  set unit_price = round(requested.final_unit_price, 2),
      line_total = round(requested.final_unit_price * item.quantity, 2),
      updated_at = now()
  from jsonb_to_recordset(p_line_price_overrides)
    as requested(order_item_id uuid, final_unit_price numeric)
  where item.order_id = p_order_id and item.id = requested.order_item_id;

  delete from public.sale_terms_write_context
  where backend_pid = pg_backend_pid()
    and transaction_id = txid_current()
    and actor_id = actor_user_id
    and order_id = p_order_id;

  select
    coalesce(company_settings.tax_rate, 0.15),
    coalesce(company_settings.first_wholesale_minimum, 10000),
    coalesce(company_settings.free_shipping_threshold, 3000),
    coalesce(company_settings.standard_shipping_fee, 120)
  into configured_tax_rate, configured_wholesale_minimum, configured_delivery_threshold, configured_suggested_delivery
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  select jsonb_agg(jsonb_build_object(
    'quantity', item.quantity,
    'unit_price', item.unit_price,
    'discount_amount', 0
  ) order by item.id)
  into resolved_lines
  from public.order_items item
  where item.order_id = p_order_id;

  financial_result := public.calculate_sale_financials_v1(
    resolved_lines,
    configured_tax_rate,
    coalesce(saved_order.discount_total, 0),
    normalized_shipping,
    coalesce(saved_order.cash_on_delivery_fee, 0),
    coalesce(saved_order.small_order_fee, 0),
    coalesce(saved_order.additional_fees, '[]'::jsonb),
    configured_wholesale_minimum,
    configured_delivery_threshold,
    configured_suggested_delivery,
    case
      when p_delivery_mode in ('store_pickup', 'customer_arranged') then 'pickup'
      when saved_order.payment_timing = 'on_delivery' then 'cash_on_delivery'
      else 'home_delivery'
    end,
    case when saved_order.price_mode = 'wholesale' then 'wholesale' else 'retail' end,
    'HNL'
  );

  update public.orders
  set requested_invoice_date = p_requested_invoice_date,
      shipping_fee_suggested = (financial_result->>'suggested_delivery_charge')::numeric,
      delivery_mode = p_delivery_mode,
      external_delivery_provider = normalized_provider,
      subtotal = (financial_result->>'fiscal_subtotal')::numeric,
      tax = (financial_result->>'included_tax_total')::numeric,
      shipping_fee = (financial_result->>'delivery_charge')::numeric,
      shipping_total = (financial_result->>'delivery_charge')::numeric,
      total = (financial_result->>'total_final')::numeric,
      calculation_version = 1,
      commercial_terms_version = commercial_terms_version + 1,
      updated_at = now()
  where id = p_order_id
  returning commercial_terms_version into p_expected_version;

  update public.payments
  set amount = (financial_result->>'total_final')::numeric, updated_at = now()
  where order_id = p_order_id
    and coalesce(payment_status::text, status::text, 'pending') = 'pending';

  update public.accounts_receivable receivable
  set original_amount = (financial_result->>'total_final')::numeric,
      balance_due = (financial_result->>'total_final')::numeric,
      updated_at = now()
  where receivable.order_id = p_order_id
    and receivable.status in ('open', 'overdue')
    and not exists (
      select 1 from public.accounts_receivable_payments payment
      where payment.receivable_id = receivable.id and payment.voided_at is null
    );

  perform public.write_audit_log(
    'orders',
    p_order_id,
    'sale.commercial_terms.adjusted',
    jsonb_build_object(
      'requested_invoice_date', saved_order.requested_invoice_date,
      'shipping_fee_suggested', saved_order.shipping_fee_suggested,
      'shipping_fee_applied', coalesce(saved_order.shipping_fee, saved_order.shipping_total, 0),
      'delivery_mode', saved_order.delivery_mode,
      'external_delivery_provider', saved_order.external_delivery_provider,
      'commercial_terms_version', saved_order.commercial_terms_version
    ),
    jsonb_build_object(
      'requested_invoice_date', p_requested_invoice_date,
      'shipping_fee_suggested', (financial_result->>'suggested_delivery_charge')::numeric,
      'shipping_fee_applied', normalized_shipping,
      'delivery_mode', p_delivery_mode,
      'external_delivery_provider', normalized_provider,
      'commercial_terms_version', p_expected_version,
      'price_changes', price_changes,
      'price_reason', normalized_price_reason,
      'delivery_reason', normalized_delivery_reason,
      'actor_role', actor_role_name,
      'idempotency_key', p_idempotency_key
    )
  );

  result_payload := jsonb_build_object(
    'order_id', p_order_id,
    'commercial_terms_version', p_expected_version,
    'requested_invoice_date', p_requested_invoice_date,
    'delivery_mode', p_delivery_mode,
    'external_delivery_provider', normalized_provider,
    'financials', financial_result
  );

  update public.pos_idempotency_requests
  set status = 'succeeded',
      result = result_payload,
      safe_error = null,
      completed_at = now(),
      lease_expires_at = null,
      last_seen_at = now(),
      updated_at = now()
  where id = stored_request.id;

  return result_payload;
end;
$$;

revoke all on function public.adjust_sale_terms_v1(
  uuid, date, jsonb, numeric, text, text, text, text, integer, uuid
) from public, anon;
grant execute on function public.adjust_sale_terms_v1(
  uuid, date, jsonb, numeric, text, text, text, text, integer, uuid
) to authenticated, service_role;

-- The fiscal RPC always snapshots invoice_date and never recalculates commercial terms.
create or replace function public.generate_fiscal_invoice_from_order(target_order_id uuid)
returns table (invoice_id uuid, invoice_number text)
language plpgsql
security definer
set search_path = public, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
  fiscal_record public.fiscal_settings%rowtype;
  order_record public.orders%rowtype;
  payment_record record;
  effective_invoice_date date;
  new_invoice_id uuid := gen_random_uuid();
  v_current_invoice_number text;
  v_next_invoice_number text;
  current_number_value numeric;
  range_start_value numeric;
  range_end_value numeric;
  inserted_invoice_item_count integer := 0;
begin
  if not (public.has_permission('invoices:create') or public.has_permission('invoices:manage')) then
    raise exception using errcode = '42501', message = 'No tienes permiso para generar facturas fiscales.';
  end if;
  if target_order_id is null then
    raise exception using errcode = '22023', message = 'Selecciona un pedido para generar la factura.';
  end if;

  select orders.* into order_record
  from public.orders where orders.id = target_order_id for update;
  if order_record.id is null then raise exception 'No se encontro el pedido.'; end if;
  if order_record.status::text not in (
    'confirmed', 'confirmado', 'paid', 'preparacion', 'preparing', 'empacado',
    'enviado', 'shipped', 'en_ruta', 'entregado', 'delivered'
  ) then
    raise exception 'No se puede emitir factura porque el pedido aun no esta confirmado.';
  end if;
  if exists (select 1 from public.invoices where order_id = target_order_id) then
    raise exception 'Error fiscal: este pedido ya tiene factura.';
  end if;

  select payments.id,
         coalesce(payments.payment_status::text, payments.status::text) payment_status,
         payments.payment_method, payments.bank_reference_number, payments.paid_at
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;
  if payment_record.id is null then raise exception 'No se encontro el registro de pago del pedido.'; end if;
  if order_record.payment_method::text <> 'commercial_credit'
    and payment_record.payment_status not in ('approved', 'confirmed', 'paid') then
    raise exception 'No se puede emitir factura porque el pago aun no ha sido confirmado.';
  end if;

  select * into fiscal_record from public.fiscal_settings where id = true for update;
  if fiscal_record.id is null then raise exception 'Error fiscal: configura los datos fiscales antes de generar facturas.'; end if;
  effective_invoice_date := coalesce(order_record.requested_invoice_date, today_hn);

  if effective_invoice_date > today_hn then raise exception 'La fecha de factura no puede ser futura en Honduras.'; end if;
  if fiscal_record.cai_authorization_date is null then raise exception 'Error fiscal: configura la fecha de autorizacion del CAI.'; end if;
  if fiscal_record.emission_deadline is null then raise exception 'Error fiscal: configura la fecha limite de emision del CAI.'; end if;
  if effective_invoice_date < fiscal_record.cai_authorization_date
    or effective_invoice_date > fiscal_record.emission_deadline then
    raise exception 'La fecha de factura esta fuera de la vigencia fiscal configurada.';
  end if;
  if public.is_date_in_closed_accounting_period(effective_invoice_date) then
    raise exception 'La fecha de factura pertenece a un periodo contable cerrado.';
  end if;
  if fiscal_record.emission_deadline < today_hn then
    raise exception 'Error fiscal: la fecha limite de emision del CAI esta vencida.';
  end if;
  if trim(coalesce(fiscal_record.cai, '')) = '' then
    raise exception 'Error fiscal: configura un CAI autorizado antes de generar facturas.';
  end if;
  if order_record.calculation_version is distinct from 1 then
    raise exception 'El pedido no tiene un snapshot monetario canonico confirmado.';
  end if;
  if not exists (select 1 from public.order_items where order_id = target_order_id) then
    raise exception 'El pedido no tiene productos para facturar.';
  end if;
  if exists (
    select 1 from public.order_items
    where order_id = target_order_id
      and (
        unit_price <= 0
        or (unit_cost_snapshot is not null and unit_cost_snapshot > 0 and unit_price < unit_cost_snapshot)
        or line_total <> round(unit_price * quantity, 2)
      )
  ) then
    raise exception 'Las lineas del pedido no tienen precios, costos o snapshots validos para facturar.';
  end if;

  v_current_invoice_number := trim(coalesce(fiscal_record.current_invoice_number, ''));
  current_number_value := public.fiscal_invoice_number_value(v_current_invoice_number);
  range_start_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_start);
  range_end_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_end);
  if v_current_invoice_number = ''
    or current_number_value is null or range_start_value is null or range_end_value is null then
    raise exception 'Error fiscal: configura el numero actual y el rango autorizado antes de generar facturas.';
  end if;
  if range_start_value > range_end_value then raise exception 'Error fiscal: el rango fiscal configurado no es valido.'; end if;
  if current_number_value < range_start_value or current_number_value > range_end_value then
    raise exception 'Error fiscal: el numero actual esta fuera del rango autorizado.';
  end if;
  if exists (select 1 from public.invoices existing_invoice where existing_invoice.invoice_number = v_current_invoice_number) then
    raise exception 'Error fiscal: el numero de factura % ya existe.', v_current_invoice_number;
  end if;

  insert into public.invoices (
    id, order_id, customer_id, invoice_number, rtn, cai, cai_authorization_date,
    invoice_date, customer_rtn, customer_name, customer_phone, customer_email,
    customer_address, status, price_mode, subtotal, tax, shipping_fee,
    cash_on_delivery_fee, small_order_fee, discount_total, additional_fees,
    total, calculation_version, issued_at, due_at, company_legal_name, company_rtn,
    company_address, company_phone, company_email, company_logo_url,
    fiscal_range_start, fiscal_range_end
  )
  values (
    new_invoice_id, order_record.id, order_record.customer_id, v_current_invoice_number,
    fiscal_record.rtn, fiscal_record.cai, fiscal_record.cai_authorization_date,
    effective_invoice_date, order_record.fiscal_customer_rtn,
    coalesce(order_record.fiscal_customer_name, order_record.customer_name),
    coalesce(order_record.fiscal_customer_phone, order_record.customer_phone, order_record.phone),
    coalesce(order_record.fiscal_customer_email, order_record.email),
    coalesce(order_record.fiscal_customer_address, order_record.delivery_address),
    'emitida', order_record.price_mode, order_record.subtotal, order_record.tax,
    coalesce(order_record.shipping_fee, order_record.shipping_total, 0),
    coalesce(order_record.cash_on_delivery_fee, 0), coalesce(order_record.small_order_fee, 0),
    coalesce(order_record.discount_total, 0), coalesce(order_record.additional_fees, '[]'::jsonb),
    order_record.total, order_record.calculation_version, now(), fiscal_record.emission_deadline,
    fiscal_record.legal_name, fiscal_record.rtn, fiscal_record.fiscal_address,
    fiscal_record.phone, fiscal_record.email, fiscal_record.logo_url,
    fiscal_record.invoice_range_start, fiscal_record.invoice_range_end
  );

  insert into public.invoice_items (
    invoice_id, order_item_id, product_id, sku, product_name, quantity,
    unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot
  )
  select new_invoice_id, id, product_id, sku, product_name, quantity,
         unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot
  from public.order_items where order_id = target_order_id order by id;
  get diagnostics inserted_invoice_item_count = row_count;

  update public.accounts_receivable receivable
  set invoice_id = new_invoice_id, updated_at = now()
  where receivable.order_id = target_order_id and receivable.invoice_id is null;

  v_next_invoice_number := public.increment_fiscal_invoice_number(v_current_invoice_number);
  update public.fiscal_settings
  set current_invoice_number = v_next_invoice_number, updated_at = now()
  where id = true and current_invoice_number = v_current_invoice_number;
  if not found then raise exception 'Error fiscal: el correlativo fiscal cambio antes de finalizar.'; end if;

  perform public.write_audit_log(
    'invoices', new_invoice_id, 'fiscal.invoice.created', null,
    jsonb_build_object(
      'invoice_id', new_invoice_id, 'invoice_number', v_current_invoice_number,
      'order_id', order_record.id, 'order_number', order_record.order_number,
      'invoice_date', effective_invoice_date, 'issued_at', now(),
      'cai_authorization_date', fiscal_record.cai_authorization_date,
      'emission_deadline', fiscal_record.emission_deadline,
      'previous_invoice_number', v_current_invoice_number,
      'next_invoice_number', v_next_invoice_number,
      'subtotal', order_record.subtotal, 'tax', order_record.tax,
      'shipping_fee', coalesce(order_record.shipping_fee, order_record.shipping_total, 0),
      'total', order_record.total, 'item_count', inserted_invoice_item_count
    )
  );

  invoice_id := new_invoice_id;
  invoice_number := v_current_invoice_number;
  return next;
end;
$$;

revoke all on function public.generate_fiscal_invoice_from_order(uuid) from public, anon;
grant execute on function public.generate_fiscal_invoice_from_order(uuid) to authenticated, service_role;

-- Browser roles can read through RLS, but all monetary and fiscal writes now
-- enter through the trusted RPCs. Service maintenance remains available.
revoke update on table public.order_items from authenticated;
revoke insert, update on table public.invoices from authenticated;
revoke insert, update on table public.invoice_items from authenticated;
grant select, insert, update, delete on table public.sale_terms_write_context to service_role;

create index if not exists invoices_invoice_date_idx
  on public.invoices (invoice_date desc)
  where invoice_date is not null;
create index if not exists financial_events_accounting_date_idx
  on public.financial_events (accounting_date desc)
  where accounting_date is not null;
