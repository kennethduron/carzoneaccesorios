-- POS Phase 1 / Stage 5: atomic, idempotent sale confirmation.
-- No existing economic row is updated by this migration.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || '["pos:confirm_sale","pos:reprint_documents"]'::jsonb
    ) expanded(permission)
  ) deduplicated
), updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = (coalesce(permissions, '[]'::jsonb) - 'pos:confirm_sale') - 'pos:reprint_documents',
    updated_at = now()
where name in ('contadora', 'vendedor', 'bodega', 'soporte', 'cliente');

create or replace function public.pos_permission_allowed(permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and permission_key in (
      'pos:create_sale', 'pos:apply_discount', 'pos:access',
      'pos:customers:search', 'pos:customers:create', 'pos:customers:update',
      'customers:read_commercial', 'customers:read_credit',
      'pos:drafts:create', 'pos:drafts:read', 'pos:drafts:edit_own',
      'pos:drafts:edit_any', 'pos:drafts:abandon', 'pos:products:search',
      'pos:price_override', 'pos:confirm_sale', 'pos:reprint_documents'
    )
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission(permission_key);
$$;

revoke all on function public.pos_permission_allowed(text) from public, anon;
grant execute on function public.pos_permission_allowed(text) to authenticated;

alter table public.pos_sale_drafts drop constraint if exists pos_sale_drafts_status_check;
alter table public.pos_sale_drafts
  add constraint pos_sale_drafts_status_check
    check (status in ('active', 'confirmed', 'abandoned', 'expired')),
  add column confirmation_request_key uuid,
  add column confirmation_payload_hash text,
  add column confirmed_at timestamptz,
  add column confirmed_by uuid references public.users(id) on delete restrict,
  add column order_id uuid references public.orders(id) on delete restrict,
  add column invoice_id uuid references public.invoices(id) on delete restrict,
  add column payment_id uuid references public.payments(id) on delete restrict,
  add column receivable_id uuid references public.accounts_receivable(id) on delete restrict,
  add column confirmed_invoice_date date,
  add column confirmed_payment_method public.payment_method,
  add column amount_tendered numeric(14,2),
  add column change_due numeric(14,2),
  add column confirmation_result jsonb;

alter table public.pos_sale_drafts
  add constraint pos_sale_drafts_confirmation_hash_check
    check (confirmation_payload_hash is null or confirmation_payload_hash ~ '^[0-9a-f]{64}$'),
  add constraint pos_sale_drafts_confirmation_money_check
    check (
      (amount_tendered is null or amount_tendered >= 0)
      and (change_due is null or change_due >= 0)
    ),
  add constraint pos_sale_drafts_confirmation_result_check
    check (confirmation_result is null or jsonb_typeof(confirmation_result) = 'object'),
  add constraint pos_sale_drafts_confirmation_shape_check
    check (
      (status <> 'confirmed' and order_id is null and invoice_id is null and confirmation_result is null)
      or
      (status = 'confirmed' and confirmation_request_key is not null
        and confirmation_payload_hash is not null and confirmed_at is not null
        and confirmed_by is not null and order_id is not null and invoice_id is not null
        and confirmed_invoice_date is not null and confirmed_payment_method is not null
        and confirmation_result is not null)
    );

create unique index pos_sale_drafts_confirmation_request_key_idx
  on public.pos_sale_drafts(confirmation_request_key)
  where confirmation_request_key is not null;
create unique index pos_sale_drafts_order_id_idx
  on public.pos_sale_drafts(order_id) where order_id is not null;
create unique index pos_sale_drafts_invoice_id_idx
  on public.pos_sale_drafts(invoice_id) where invoice_id is not null;
create unique index pos_sale_drafts_payment_id_idx
  on public.pos_sale_drafts(payment_id) where payment_id is not null;
create unique index pos_sale_drafts_receivable_id_idx
  on public.pos_sale_drafts(receivable_id) where receivable_id is not null;

alter table public.orders
  add column pos_draft_id uuid references public.pos_sale_drafts(id) on delete restrict,
  add column authorized_by uuid references public.users(id) on delete restrict,
  add column confirmed_by uuid references public.users(id) on delete restrict,
  add column authorized_at timestamptz,
  add column confirmed_at timestamptz;

create unique index orders_pos_draft_id_idx
  on public.orders(pos_draft_id) where pos_draft_id is not null;

alter table public.products
  add column tracks_inventory boolean not null default true;

alter table public.pos_sale_draft_items
  add column tracks_inventory_snapshot boolean not null default true;

alter table public.order_items
  add column tax_category_snapshot text,
  add column tax_rate_snapshot numeric(8,6),
  add column taxable_base_snapshot numeric(14,2),
  add column tax_amount_snapshot numeric(14,2),
  add column exempt_amount_snapshot numeric(14,2),
  add column price_override_reason text,
  add column price_overridden_by uuid references public.users(id) on delete restrict,
  add column tracks_inventory_snapshot boolean not null default true;

alter table public.invoice_items
  add column tax_category_snapshot text,
  add column tax_rate_snapshot numeric(8,6),
  add column taxable_base_snapshot numeric(14,2),
  add column tax_amount_snapshot numeric(14,2),
  add column exempt_amount_snapshot numeric(14,2),
  add column unit_cost_snapshot numeric(12,2),
  add column total_cost_snapshot numeric(14,2),
  add column price_override_reason text,
  add column price_overridden_by uuid references public.users(id) on delete restrict,
  add column tracks_inventory_snapshot boolean not null default true;

alter table public.order_items
  add constraint order_items_pos_tax_category_check
    check (tax_category_snapshot is null or tax_category_snapshot in ('standard','exempt')),
  add constraint order_items_pos_tax_rate_check
    check (tax_rate_snapshot is null or tax_rate_snapshot between 0 and 1);

alter table public.invoice_items
  add constraint invoice_items_pos_tax_category_check
    check (tax_category_snapshot is null or tax_category_snapshot in ('standard','exempt')),
  add constraint invoice_items_pos_tax_rate_check
    check (tax_rate_snapshot is null or tax_rate_snapshot between 0 and 1);

comment on column public.invoice_items.tax_category_snapshot is
  'Per-line fiscal category. NULL identifies legacy invoices that use aggregate fiscal totals.';
comment on column public.orders.pos_draft_id is
  'Unique non-economic POS draft that atomically originated this order.';
comment on column public.products.tracks_inventory is
  'False only for explicitly configured services or non-stock sale items.';

create table public.pos_sale_confirmation_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  actor_id uuid not null references public.users(id) on delete restrict,
  draft_id uuid not null references public.pos_sale_drafts(id) on delete cascade,
  request_key uuid not null,
  created_at timestamptz not null default now(),
  primary key (backend_pid, transaction_id, draft_id)
);

alter table public.pos_sale_confirmation_context enable row level security;
revoke all on table public.pos_sale_confirmation_context from public, anon, authenticated;
grant select, insert, delete on public.pos_sale_confirmation_context to service_role;

create or replace function public.bump_product_sales_version_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.category_id, new.sku, new.internal_code, new.name, new.brand,
    new.short_description, new.retail_price, new.wholesale_price,
    new.wholesale_min_quantity, new.cost_price, new.tax_category,
    new.tracks_inventory, new.status, new.active
  ) is distinct from row(
    old.category_id, old.sku, old.internal_code, old.name, old.brand,
    old.short_description, old.retail_price, old.wholesale_price,
    old.wholesale_min_quantity, old.cost_price, old.tax_category,
    old.tracks_inventory, old.status, old.active
  ) then
    new.product_sales_version := old.product_sales_version + 1;
  else
    new.product_sales_version := old.product_sales_version;
  end if;
  return new;
end;
$$;

create or replace function public.apply_order_item_authorized_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row record;
  order_row public.orders%rowtype;
  effective_mode public.order_price_mode := coalesce(new.applied_price_mode, 'retail'::public.order_price_mode);
  effective_unit_price numeric(12,2);
  minimum_wholesale_quantity integer := 1;
  pos_context_valid boolean := false;
  trusted_override boolean := false;
  repair_override boolean := false;
begin
  if tg_op = 'UPDATE' then
    select exists (
      select 1 from public.commercial_snapshot_repair_context context
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.order_id = new.order_id
    ) into repair_override;
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
        raise exception using errcode = '42501',
          message = 'La reparacion comercial solo puede reclasificar el modo de precio.';
      end if;
      return new;
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.unit_price is distinct from old.unit_price
    or new.line_total is distinct from old.line_total
  ) then
    select exists (
      select 1 from public.sale_terms_write_context context
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.actor_id = auth.uid()
        and context.order_id = new.order_id
    ) into trusted_override;
    if not trusted_override then
      raise exception using errcode = '42501',
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
      raise exception using errcode = '42501',
        message = 'La operacion comercial no puede cambiar cantidad, producto, modo, snapshots ni costo.';
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

  if new.product_id is null then return new; end if;
  select products.name, products.retail_price, products.wholesale_price,
    coalesce(products.wholesale_min_quantity, 1) wholesale_min_quantity
  into product_row from public.products where id = new.product_id;
  if product_row is null then return new; end if;

  if tg_op = 'INSERT' then
    select * into order_row from public.orders where id = new.order_id;
  end if;
  if tg_op = 'INSERT' and order_row.source = 'pos' and order_row.pos_draft_id is not null then
    select exists (
      select 1 from public.pos_sale_confirmation_context context
      where context.backend_pid = pg_backend_pid()
        and context.transaction_id = txid_current()
        and context.actor_id = auth.uid()
        and context.draft_id = order_row.pos_draft_id
    ) into pos_context_valid;
  end if;

  if pos_context_valid then
    if new.unit_price is null or new.unit_price <= 0
      or new.line_total <> round(new.unit_price * greatest(coalesce(new.quantity, 0), 0), 2) then
      raise exception using errcode = '22023', message = 'POS_PRICE_CHANGED';
    end if;
    new.retail_price_snapshot := round(product_row.retail_price, 2);
    new.wholesale_price_snapshot := round(product_row.wholesale_price, 2);
    return new;
  end if;

  effective_unit_price := public.get_authorized_product_price(
    product_row.retail_price, product_row.wholesale_price, effective_mode
  );
  if effective_mode = 'wholesale'
    and effective_unit_price <> round(coalesce(product_row.wholesale_price, 0), 2) then
    effective_mode := 'retail';
  end if;
  minimum_wholesale_quantity := greatest(1, coalesce(product_row.wholesale_min_quantity, 1));
  if effective_mode = 'wholesale' and minimum_wholesale_quantity > 1
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

-- Canonical fiscal engine extension follows.
create or replace function public.generate_fiscal_invoice_from_order(target_order_id uuid)
returns table (invoice_id uuid, invoice_number text)
language plpgsql
security definer
set search_path = public, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
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
  if not service_call and not (
    public.has_permission('invoices:create') or public.has_permission('invoices:manage')
    or public.pos_permission_allowed('pos:confirm_sale')
  ) then
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
  if payment_record.id is null and order_record.payment_method::text <> 'commercial_credit' then
    raise exception 'No se encontro el registro de pago del pedido.';
  end if;
  if order_record.payment_method::text <> 'commercial_credit'
    and payment_record.payment_status not in ('approved', 'confirmed', 'paid') then
    raise exception 'No se puede emitir factura porque el pago aun no ha sido confirmado.';
  end if;
  if order_record.payment_method::text = 'commercial_credit'
    and not exists (
      select 1 from public.accounts_receivable
      where order_id = target_order_id and status <> 'cancelled'
    ) then
    raise exception 'No se encontro la cuenta por cobrar de la venta a credito.';
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
  if order_record.calculation_version not in (1, 2) then
    raise exception 'El pedido no tiene un snapshot monetario canonico confirmado.';
  end if;
  if not exists (select 1 from public.order_items where order_id = target_order_id) then
    raise exception 'El pedido no tiene productos para facturar.';
  end if;
  if exists (
    select 1 from public.order_items
    where order_id = target_order_id
      and (unit_price <= 0
        or (unit_cost_snapshot is not null and unit_cost_snapshot > 0 and unit_price < unit_cost_snapshot)
        or line_total <> round(unit_price * quantity, 2))
  ) then
    raise exception 'Las lineas del pedido no tienen precios, costos o snapshots validos para facturar.';
  end if;

  v_current_invoice_number := trim(coalesce(fiscal_record.current_invoice_number, ''));
  current_number_value := public.fiscal_invoice_number_value(v_current_invoice_number);
  range_start_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_start);
  range_end_value := public.fiscal_invoice_number_value(fiscal_record.invoice_range_end);
  if v_current_invoice_number = '' or current_number_value is null
    or range_start_value is null or range_end_value is null then
    raise exception 'Error fiscal: configura el numero actual y el rango autorizado antes de generar facturas.';
  end if;
  if range_start_value > range_end_value then raise exception 'Error fiscal: el rango fiscal configurado no es valido.'; end if;
  if current_number_value < range_start_value or current_number_value > range_end_value then
    raise exception 'Error fiscal: el numero actual esta fuera del rango autorizado.';
  end if;
  if exists (
    select 1 from public.invoices existing_invoice
    where existing_invoice.invoice_number = v_current_invoice_number
  ) then
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
  ) values (
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
    unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot,
    tax_category_snapshot, tax_rate_snapshot, taxable_base_snapshot,
    tax_amount_snapshot, exempt_amount_snapshot, unit_cost_snapshot,
    total_cost_snapshot, price_override_reason, price_overridden_by
  )
  select new_invoice_id, id, product_id, sku, product_name, quantity,
    unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot,
    tax_category_snapshot, tax_rate_snapshot, taxable_base_snapshot,
    tax_amount_snapshot, exempt_amount_snapshot, unit_cost_snapshot,
    total_cost_snapshot, price_override_reason, price_overridden_by
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

revoke all on function public.generate_fiscal_invoice_from_order(uuid)
  from public, anon, authenticated;
grant execute on function public.generate_fiscal_invoice_from_order(uuid) to service_role;

create or replace function public.apply_order_sale_inventory(
  target_order_id uuid,
  actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_order public.orders%rowtype;
  item_record record;
  product_record public.products%rowtype;
  existing_sale_movements integer := 0;
  tracked_item_count integer := 0;
  stock_update_count integer := 0;
  reservation_count integer := 0;
begin
  if target_order_id is null then
    raise exception using errcode = '22023', message = 'El pedido es obligatorio para descontar inventario.';
  end if;
  select * into target_order from public.orders where id = target_order_id for update;
  if target_order.id is null then raise exception 'No se encontro el pedido para descontar inventario.'; end if;

  select count(*) into reservation_count
  from public.inventory_reservations where order_id = target_order_id;
  if reservation_count > 0 then
    if not exists (
      select 1 from public.inventory_reservations
      where order_id = target_order_id and status = 'reserved'
    ) then
      if exists (
        select 1 from public.inventory_reservations
        where order_id = target_order_id and status = 'confirmed'
      ) then return; end if;
      raise exception 'La reserva de inventario ya no esta activa.';
    end if;
    perform public.confirm_order_reservation(target_order_id, actor_user_id);
    return;
  end if;

  select count(*) into existing_sale_movements
  from public.inventory_movements
  where reference_type = 'orders' and reference_id = target_order_id
    and movement_type = 'sale';
  if existing_sale_movements > 0 then return; end if;

  select count(*) into tracked_item_count
  from public.order_items
  where order_id = target_order_id and tracks_inventory_snapshot;
  if tracked_item_count = 0 then return; end if;
  if exists (
    select 1 from public.order_items
    where order_id = target_order_id and tracks_inventory_snapshot and product_id is null
  ) then raise exception 'El pedido tiene productos sin referencia de inventario.'; end if;

  for item_record in
    select product_id, sum(quantity)::integer quantity,
      (array_agg(id order by id))[1] order_item_id
    from public.order_items
    where order_id = target_order_id and tracks_inventory_snapshot
    group by product_id order by product_id
  loop
    select * into product_record from public.products
    where id = item_record.product_id for update;
    if product_record.id is null or not product_record.tracks_inventory then
      raise exception using errcode = 'PT409', message = 'POS_PRODUCT_INVENTORY_CHANGED';
    end if;
    if item_record.quantity <= 0
      or item_record.quantity > (product_record.stock - coalesce(product_record.reserved_stock, 0)) then
      raise exception using errcode = 'PT409', message = 'POS_INSUFFICIENT_STOCK';
    end if;
    update public.products
    set stock = product_record.stock - item_record.quantity, updated_at = now()
    where id = product_record.id
      and stock - coalesce(reserved_stock, 0) >= item_record.quantity;
    get diagnostics stock_update_count = row_count;
    if stock_update_count <> 1 then
      raise exception using errcode = 'PT409', message = 'POS_INSUFFICIENT_STOCK';
    end if;
    insert into public.inventory_movements (
      product_id, user_id, movement_type, quantity, stock_before, stock_after,
      reference_type, reference_id, order_item_id, notes
    ) values (
      product_record.id, actor_user_id, 'sale', -item_record.quantity,
      product_record.stock, product_record.stock - item_record.quantity,
      'orders', target_order_id, item_record.order_item_id,
      'Salida atomica por venta POS confirmada'
    );
  end loop;
end;
$$;

revoke all on function public.apply_order_sale_inventory(uuid, uuid) from public, anon;
grant execute on function public.apply_order_sale_inventory(uuid, uuid) to authenticated, service_role;

create or replace function public.enqueue_sale_recognition_from_payment_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  old_status text := case when tg_op = 'INSERT' then null
    else coalesce(old.payment_status::text, old.status::text) end;
  new_status text := coalesce(new.payment_status::text, new.status::text);
  effective_at timestamptz;
  sale_scenario text;
begin
  if new_status not in ('approved','confirmed','paid')
    or old_status in ('approved','confirmed','paid') then return new; end if;
  select * into order_row from public.orders where id = new.order_id for share;
  if not found or order_row.payment_method::text = 'commercial_credit'
    or order_row.status::text in ('cancelado','cancelled') then return new; end if;
  if order_row.payment_timing = 'on_delivery'
    and order_row.status::text not in ('entregado','delivered') then return new; end if;
  effective_at := case
    when order_row.source = 'pos' and order_row.requested_invoice_date is not null
      then order_row.requested_invoice_date::timestamp at time zone 'America/Tegucigalpa'
    else coalesce(new.paid_at, new.updated_at, now())
  end;
  sale_scenario := case
    when order_row.payment_timing = 'on_delivery' then 'cash_or_cod_after_delivery'
    when order_row.payment_method::text = 'bank_transfer' then 'prepaid_bank_transfer'
    when order_row.payment_method::text = 'card' then 'prepaid_customer_card'
    when order_row.payment_method::text = 'cash' then 'prepaid_cash'
    else 'prepaid_other'
  end;
  perform public.route_accounting_fact_v2(
    'sales_draft_v2', 'sales.recognized', 'order', order_row.id,
    'sale_recognized', sale_scenario, effective_at,
    coalesce(new.confirmed_by, auth.uid())
  );
  return new;
end;
$$;

create or replace function public.enqueue_inventory_cogs_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_at timestamptz := new.created_at;
  order_row public.orders%rowtype;
begin
  if new.movement_type::text <> 'sale' or new.quantity >= 0
    or new.stock_after >= new.stock_before or new.reference_type <> 'orders'
    or new.reference_id is null then return new; end if;
  select * into order_row from public.orders where id = new.reference_id;
  if order_row.source = 'pos' and order_row.requested_invoice_date is not null then
    effective_at := order_row.requested_invoice_date::timestamp at time zone 'America/Tegucigalpa';
  end if;
  perform public.route_accounting_fact_v2(
    'cogs_draft_v2', 'inventory.cogs', 'inventory_movement', new.id,
    'inventory_cogs', 'physical_sale_movement', effective_at,
    coalesce(new.user_id, auth.uid())
  );
  return new;
end;
$$;

create or replace function public.capture_pos_draft_inventory_contract_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select products.tracks_inventory
  into new.tracks_inventory_snapshot
  from public.products where products.id = new.product_id;
  new.tracks_inventory_snapshot := coalesce(new.tracks_inventory_snapshot, true);
  return new;
end;
$$;

revoke all on function public.capture_pos_draft_inventory_contract_v1()
  from public, anon, authenticated;
create trigger pos_sale_draft_items_capture_inventory_contract
before insert or update of product_id on public.pos_sale_draft_items
for each row execute function public.capture_pos_draft_inventory_contract_v1();

create or replace function public.confirm_pos_sale_v1(
  p_draft_id uuid,
  p_request_key uuid,
  p_expected_draft_version bigint,
  p_invoice_date date,
  p_payment_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  draft_record public.pos_sale_drafts%rowtype;
  existing_request public.pos_sale_drafts%rowtype;
  customer_record public.customers%rowtype;
  credit_record public.customer_credit_accounts%rowtype;
  pricing_record record;
  product_record public.products%rowtype;
  line_record public.pos_sale_draft_items%rowtype;
  fiscal_result record;
  payment_method_value public.payment_method;
  payment_reference text;
  transfer_verified boolean := false;
  amount_tendered_value numeric(14,2);
  change_due_value numeric(14,2);
  open_credit numeric(14,2) := 0;
  tax_rate numeric := 0.15;
  base_price numeric(12,2);
  calculation_lines jsonb;
  calculated jsonb;
  payload_hash text;
  result jsonb;
  new_order_id uuid := gen_random_uuid();
  new_payment_id uuid;
  new_receivable_id uuid;
  new_order_number text;
  effective_accounting_at timestamptz;
  today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
  accounting_status_value text := 'not_routed';
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  actor_role := public.current_actor_role();
  if actor_role not in ('technical_owner','business_owner','admin')
    or not public.pos_permission_allowed('pos:confirm_sale') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  if p_draft_id is null or p_request_key is null or p_expected_draft_version is null
    or p_invoice_date is null or p_payment_payload is null
    or jsonb_typeof(p_payment_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'POS_CONFIRMATION_INVALID';
  end if;
  if p_invoice_date > today_hn then
    raise exception using errcode = '22023', message = 'POS_FISCAL_DATE_INVALID';
  end if;

  payload_hash := encode(digest(convert_to(jsonb_build_object(
    'draft_id', p_draft_id,
    'expected_draft_version', p_expected_draft_version,
    'invoice_date', p_invoice_date,
    'payment', p_payment_payload
  )::text, 'UTF8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended('pos:draft:' || p_draft_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('pos:request:' || p_request_key::text, 0));
  select * into draft_record from public.pos_sale_drafts where id = p_draft_id for update;
  if draft_record.id is null then
    raise exception using errcode = 'P0002', message = 'POS_DRAFT_NOT_FOUND';
  end if;
  if draft_record.status = 'confirmed' then
    if draft_record.confirmation_payload_hash = payload_hash then
      return draft_record.confirmation_result || jsonb_build_object('replayed', true);
    end if;
    if draft_record.confirmation_request_key = p_request_key then
      raise exception using errcode = 'PT409', message = 'POS_REQUEST_KEY_CONFLICT';
    end if;
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_ALREADY_CONFIRMED';
  end if;
  if draft_record.status = 'abandoned' then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CANCELLED';
  end if;
  if draft_record.status <> 'active' or draft_record.expires_at <= now() then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_EXPIRED';
  end if;
  if draft_record.version <> p_expected_draft_version then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CHANGED';
  end if;
  if draft_record.owner_user_id <> actor_id
    and not public.pos_permission_allowed('pos:drafts:edit_any') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  select * into existing_request from public.pos_sale_drafts
  where confirmation_request_key = p_request_key and id <> p_draft_id;
  if existing_request.id is not null then
    raise exception using errcode = 'PT409', message = 'POS_REQUEST_KEY_CONFLICT';
  end if;

  select * into customer_record from public.customers
  where id = draft_record.customer_id for update;
  if customer_record.id is null or not customer_record.active
    or customer_record.status <> 'active' or customer_record.merged_into_customer_id is not null then
    raise exception using errcode = 'PT409', message = 'POS_CUSTOMER_INVALID';
  end if;
  if customer_record.commercial_version <> draft_record.customer_commercial_version then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CHANGED';
  end if;
  select * into pricing_record
  from public.resolve_customer_pricing_mode_v1(customer_record.id);
  if pricing_record.pricing_mode is distinct from draft_record.pricing_mode_snapshot
    or pricing_record.commercial_version is distinct from draft_record.customer_commercial_version then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_CHANGED';
  end if;

  if not exists (select 1 from public.pos_sale_draft_items where draft_id = p_draft_id) then
    raise exception using errcode = '22023', message = 'POS_DRAFT_EMPTY';
  end if;
  perform products.id
  from public.products products
  join public.pos_sale_draft_items items on items.product_id = products.id
  where items.draft_id = p_draft_id
  order by products.id for update of products;

  select coalesce(settings.tax_rate, 0.15) into tax_rate
  from public.company_settings settings order by settings.created_at limit 1;
  if tax_rate is null or tax_rate < 0 or tax_rate > 1 then
    raise exception using errcode = '22023', message = 'POS_TAX_CONFIGURATION_INVALID';
  end if;

  calculation_lines := '[]'::jsonb;
  for line_record in
    select * from public.pos_sale_draft_items
    where draft_id = p_draft_id order by product_id
  loop
    select * into product_record from public.products where id = line_record.product_id;
    if product_record.id is null or not product_record.active or product_record.status <> 'active' then
      raise exception using errcode = 'PT409', message = 'POS_PRODUCT_INACTIVE';
    end if;
    if product_record.product_sales_version <> line_record.product_sales_version
      or product_record.tax_category <> line_record.tax_category_snapshot
      or product_record.tracks_inventory <> line_record.tracks_inventory_snapshot then
      raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
    end if;
    base_price := case
      when pricing_record.pricing_mode = 'wholesale'
        and line_record.quantity >= product_record.wholesale_min_quantity
        then round(product_record.wholesale_price, 2)
      else round(product_record.retail_price, 2)
    end;
    if line_record.base_unit_price <> base_price then
      raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
    end if;
    if line_record.price_overridden then
      if line_record.price_overridden_by is null
        or nullif(trim(line_record.price_override_reason), '') is null
        or char_length(trim(line_record.price_override_reason)) not between 5 and 500
        or product_record.cost_price <= 0
        or line_record.final_unit_price < product_record.cost_price then
        raise exception using errcode = '42501', message = 'POS_MANUAL_PRICE_DENIED';
      end if;
    elsif line_record.final_unit_price <> base_price then
      raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
    end if;
    if product_record.tracks_inventory
      and line_record.quantity > product_record.stock - coalesce(product_record.reserved_stock, 0) then
      raise exception using errcode = 'PT409', message = 'POS_INSUFFICIENT_STOCK';
    end if;
    calculation_lines := calculation_lines || jsonb_build_array(jsonb_build_object(
      'product_id', product_record.id,
      'quantity', line_record.quantity,
      'unit_price', line_record.final_unit_price,
      'tax_category', product_record.tax_category
    ));
  end loop;

  calculated := public.calculate_pos_draft_financials_v2(
    calculation_lines, tax_rate, 0, 0, 0, 'HNL'
  );
  if (calculated->>'merchandise_total')::numeric <> draft_record.merchandise_gross
    or (calculated->>'taxable_gross')::numeric <> draft_record.taxable_gross
    or (calculated->>'exempt_total')::numeric <> draft_record.exempt_gross
    or (calculated->>'taxable_base')::numeric <> draft_record.taxable_base
    or (calculated->>'tax_total')::numeric <> draft_record.tax_amount
    or (calculated->>'total')::numeric <> draft_record.grand_total then
    raise exception using errcode = 'PT409', message = 'POS_PRICE_CHANGED';
  end if;
  if draft_record.grand_total <= 0 then
    raise exception using errcode = '22023', message = 'POS_CONFIRMATION_INVALID';
  end if;

  begin
    payment_method_value := nullif(trim(p_payment_payload->>'method'), '')::public.payment_method;
  exception when others then
    raise exception using errcode = '22023', message = 'POS_PAYMENT_METHOD_INVALID';
  end;
  if payment_method_value::text not in ('cash','bank_transfer','card','commercial_credit') then
    raise exception using errcode = '22023', message = 'POS_PAYMENT_METHOD_INVALID';
  end if;
  payment_reference := nullif(trim(coalesce(p_payment_payload->>'reference', '')), '');
  if payment_reference is not null and char_length(payment_reference) > 200 then
    raise exception using errcode = '22023', message = 'POS_PAYMENT_REFERENCE_INVALID';
  end if;
  transfer_verified := coalesce((p_payment_payload->>'verified')::boolean, false);
  effective_accounting_at := p_invoice_date::timestamp at time zone 'America/Tegucigalpa';

  if payment_method_value = 'cash' then
    begin
      amount_tendered_value := round((p_payment_payload->>'amount_tendered')::numeric, 2);
    exception when others then
      raise exception using errcode = '22023', message = 'POS_AMOUNT_TENDERED_INSUFFICIENT';
    end;
    if amount_tendered_value < draft_record.grand_total
      or amount_tendered_value > 999999999999.99 then
      raise exception using errcode = '22023', message = 'POS_AMOUNT_TENDERED_INSUFFICIENT';
    end if;
    change_due_value := round(amount_tendered_value - draft_record.grand_total, 2);
  elsif payment_method_value = 'bank_transfer' then
    if not transfer_verified or payment_reference is null then
      raise exception using errcode = '22023', message = 'POS_TRANSFER_REFERENCE_REQUIRED';
    end if;
  elsif payment_method_value = 'card' then
    if not transfer_verified or public.resolve_accounting_mapping_v2(
      'payment_method', 'card', p_invoice_date
    ) is null then
      raise exception using errcode = '22023', message = 'POS_CARD_CONFIGURATION_INVALID';
    end if;
  else
    select * into credit_record from public.customer_credit_accounts
    where customer_id = customer_record.id for update;
    if credit_record.id is null or not credit_record.is_credit_enabled then
      raise exception using errcode = '22023', message = 'POS_CREDIT_DISABLED';
    end if;
    if credit_record.status <> 'active' then
      raise exception using errcode = '22023', message = 'POS_CREDIT_SUSPENDED';
    end if;
    perform receivable.id from public.accounts_receivable receivable
    where receivable.customer_id = customer_record.id
      and receivable.status in ('open','partial','overdue')
    order by receivable.id for update;
    select coalesce(sum(balance_due), 0) into open_credit
    from public.accounts_receivable
    where customer_id = customer_record.id and status in ('open','partial','overdue');
    if round(open_credit + draft_record.grand_total, 2) > credit_record.credit_limit then
      raise exception using errcode = 'PT409', message = 'POS_CREDIT_INSUFFICIENT';
    end if;
  end if;

  insert into public.pos_sale_confirmation_context (
    backend_pid, transaction_id, actor_id, draft_id, request_key
  ) values (pg_backend_pid(), txid_current(), actor_id, p_draft_id, p_request_key);

  new_order_number := 'CZ-POS-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')
    || '-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 6));
  insert into public.orders (
    id, order_number, user_id, customer_id, customer_name, email, phone,
    customer_phone, delivery_address, delivery_country, delivery_country_code,
    delivery_mode, payment_method, payment_timing, price_mode, subtotal, tax,
    shipping_total, shipping_fee, cash_on_delivery_fee, small_order_fee,
    discount_total, additional_fees, total, status, tracking_status,
    public_tracking_enabled, order_reservation_status, email_updates_opt_in,
    email_updates_preference_source, email_updates_updated_at,
    fiscal_customer_name, fiscal_customer_rtn, fiscal_customer_phone,
    fiscal_customer_email, fiscal_customer_address, source, channel, created_by,
    calculation_version, requested_invoice_date, commercial_terms_version,
    pos_draft_id, authorized_by, confirmed_by, authorized_at, confirmed_at
  ) values (
    new_order_id, new_order_number, customer_record.user_id, customer_record.id,
    coalesce(nullif(trim(customer_record.business_name), ''), customer_record.contact_name),
    customer_record.email, coalesce(nullif(trim(customer_record.phone), ''), 'N/D'),
    coalesce(nullif(trim(customer_record.phone), ''), 'N/D'),
    coalesce(nullif(trim(draft_record.delivery_address), ''),
      nullif(trim(customer_record.address), ''), 'Retiro en tienda'),
    'Honduras', 'HN', 'store_pickup', payment_method_value, 'before_delivery',
    draft_record.pricing_mode_snapshot::public.order_price_mode,
    round(draft_record.taxable_base + draft_record.exempt_gross, 2),
    draft_record.tax_amount, 0, 0, 0, 0, 0, '[]'::jsonb,
    draft_record.grand_total, 'confirmado', 'confirmado', false, 'not_required',
    false, 'admin', now(),
    coalesce(nullif(trim(customer_record.business_name), ''), customer_record.contact_name),
    customer_record.tax_id, customer_record.phone, customer_record.email,
    customer_record.address, 'pos', 'store', actor_id, 2, p_invoice_date,
    customer_record.commercial_version, p_draft_id, actor_id, actor_id, now(), now()
  );

  insert into public.order_items (
    order_id, product_id, sku, product_name, quantity, applied_price_mode,
    unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot,
    unit_cost_snapshot, total_cost_snapshot, cost_source, cost_captured_at,
    tax_category_snapshot, tax_rate_snapshot, taxable_base_snapshot,
    tax_amount_snapshot, exempt_amount_snapshot, price_override_reason,
    price_overridden_by, tracks_inventory_snapshot
  )
  select new_order_id, item.product_id, item.sku_snapshot, item.product_name_snapshot,
    item.quantity, item.pricing_source::public.order_price_mode,
    item.final_unit_price, item.line_merchandise_gross,
    product.retail_price, product.wholesale_price, product.cost_price,
    round(product.cost_price * item.quantity, 2), 'product_cost_price_at_pos_confirmation', now(),
    item.tax_category_snapshot, item.tax_rate_snapshot, item.line_taxable_base,
    item.line_tax_amount, item.line_exempt_amount, item.price_override_reason,
    item.price_overridden_by, item.tracks_inventory_snapshot
  from public.pos_sale_draft_items item
  join public.products product on product.id = item.product_id
  where item.draft_id = p_draft_id order by item.product_id;

  if payment_method_value = 'commercial_credit' then
    insert into public.accounts_receivable (
      customer_id, order_id, original_amount, balance_due, due_date, status
    ) values (
      customer_record.id, new_order_id, draft_record.grand_total,
      draft_record.grand_total, p_invoice_date + credit_record.terms_days, 'open'
    ) returning id into new_receivable_id;
    perform public.apply_order_sale_inventory(new_order_id, actor_id);
    perform public.route_accounting_fact_v2(
      'sales_draft_v2', 'sales.recognized', 'order', new_order_id,
      'sale_recognized', 'commercial_credit_on_delivery',
      effective_accounting_at, actor_id
    );
  else
    new_payment_id := gen_random_uuid();
    insert into public.payments (
      id, order_id, customer_id, method, payment_method, status, payment_status,
      amount, payment_timing, reference, bank_reference_number, provider,
      paid_at, confirmed_by
    ) values (
      new_payment_id, new_order_id, customer_record.id, payment_method_value,
      payment_method_value, 'approved', 'approved', draft_record.grand_total,
      'before_delivery', payment_reference,
      case when payment_method_value = 'bank_transfer' then payment_reference else null end,
      'pos_manual_verified', effective_accounting_at, actor_id
    );
  end if;

  select * into fiscal_result
  from public.generate_fiscal_invoice_from_order(new_order_id);

  select coalesce(string_agg(distinct status, ',' order by status), 'not_routed')
  into accounting_status_value
  from public.accounting_outbox_v2
  where (source_type = 'order' and source_id = new_order_id)
     or (source_type = 'inventory_movement' and source_id in (
       select id from public.inventory_movements
       where reference_type = 'orders' and reference_id = new_order_id
     ));

  result := jsonb_build_object(
    'status', 'confirmed', 'replayed', false,
    'draft_id', p_draft_id, 'order_id', new_order_id,
    'order_number', new_order_number, 'invoice_id', fiscal_result.invoice_id,
    'invoice_number', fiscal_result.invoice_number, 'payment_id', new_payment_id,
    'receivable_id', new_receivable_id, 'total', draft_record.grand_total,
    'payment_method', payment_method_value, 'amount_tendered', amount_tendered_value,
    'change_due', change_due_value, 'invoice_date', p_invoice_date,
    'receipt_reference', 'POS-' || new_order_number,
    'accounting_status', accounting_status_value
  );

  update public.pos_sale_drafts
  set status = 'confirmed', version = version + 1,
      confirmation_request_key = p_request_key,
      confirmation_payload_hash = payload_hash,
      confirmed_at = now(), confirmed_by = actor_id,
      order_id = new_order_id, invoice_id = fiscal_result.invoice_id,
      payment_id = new_payment_id, receivable_id = new_receivable_id,
      confirmed_invoice_date = p_invoice_date,
      confirmed_payment_method = payment_method_value,
      amount_tendered = amount_tendered_value, change_due = change_due_value,
      confirmation_result = result, updated_at = now(), last_saved_by = actor_id
  where id = p_draft_id and status = 'active';
  if not found then
    raise exception using errcode = 'PT409', message = 'POS_CONFIRMATION_CONFLICT';
  end if;

  perform public.write_audit_log(
    'pos_sale_drafts', p_draft_id, 'pos.sale.confirmed',
    jsonb_build_object('status', draft_record.status, 'version', draft_record.version),
    jsonb_build_object(
      'status', 'confirmed', 'version', draft_record.version + 1,
      'request_key', p_request_key, 'order_id', new_order_id,
      'invoice_id', fiscal_result.invoice_id, 'payment_id', new_payment_id,
      'receivable_id', new_receivable_id, 'payment_method', payment_method_value,
      'invoice_date', p_invoice_date, 'actor_id', actor_id, 'actor_role', actor_role
    )
  );
  delete from public.pos_sale_confirmation_context
  where backend_pid = pg_backend_pid() and transaction_id = txid_current()
    and draft_id = p_draft_id;
  return result;
end;
$$;

revoke all on function public.confirm_pos_sale_v1(uuid, uuid, bigint, date, jsonb)
  from public, anon;
grant execute on function public.confirm_pos_sale_v1(uuid, uuid, bigint, date, jsonb)
  to authenticated, service_role;

create or replace function public.recover_pos_sale_confirmation_v1(p_draft_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  draft_record public.pos_sale_drafts%rowtype;
begin
  if not public.pos_permission_allowed('pos:confirm_sale') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  select * into draft_record from public.pos_sale_drafts where id = p_draft_id;
  if draft_record.id is null then
    raise exception using errcode = 'P0002', message = 'POS_DRAFT_NOT_FOUND';
  end if;
  if draft_record.owner_user_id <> auth.uid()
    and not public.pos_permission_allowed('pos:drafts:edit_any') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  if draft_record.status <> 'confirmed' or draft_record.confirmation_result is null then
    raise exception using errcode = 'PT409', message = 'POS_DRAFT_NOT_CONFIRMED';
  end if;
  return draft_record.confirmation_result || jsonb_build_object('replayed', true);
end;
$$;

revoke all on function public.recover_pos_sale_confirmation_v1(uuid)
  from public, anon;
grant execute on function public.recover_pos_sale_confirmation_v1(uuid)
  to authenticated, service_role;

create or replace function public.save_product_catalog_v2_locked(
  target_product_id uuid,
  product_data jsonb,
  images_data jsonb default null
)
returns table (product_id uuid, removed_asset_ids text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  saved record;
  normalized_tax_category text := lower(trim(coalesce(product_data->>'tax_category', '')));
  normalized_tracks_inventory boolean;
begin
  if normalized_tax_category not in ('standard', 'exempt') then
    raise exception using errcode = '22023',
      message = 'La clasificacion fiscal debe ser standard o exempt.';
  end if;
  begin
    normalized_tracks_inventory := coalesce(
      (product_data->>'tracks_inventory')::boolean, true
    );
  exception when others then
    raise exception using errcode = '22023',
      message = 'El modo de inventario del producto no es valido.';
  end;
  select * into saved
  from public.save_product_catalog_locked(target_product_id, product_data, images_data);
  update public.products
  set tax_category = normalized_tax_category,
      tracks_inventory = normalized_tracks_inventory
  where id = saved.product_id
    and row(tax_category, tracks_inventory)
      is distinct from row(normalized_tax_category, normalized_tracks_inventory);
  product_id := saved.product_id;
  removed_asset_ids := saved.removed_asset_ids;
  return next;
end;
$$;

create or replace function public.get_pos_product_inventory_modes_v1(p_product_ids uuid[])
returns table (product_id uuid, tracks_inventory boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.pos_permission_allowed('pos:products:search') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  if coalesce(array_length(p_product_ids, 1), 0) > 50 then
    raise exception using errcode = '22023', message = 'POS_PRODUCT_QUERY_INVALID';
  end if;
  return query
  select products.id, products.tracks_inventory
  from public.products
  where products.id = any(coalesce(p_product_ids, array[]::uuid[]));
end;
$$;

revoke all on function public.get_pos_product_inventory_modes_v1(uuid[])
  from public, anon;
grant execute on function public.get_pos_product_inventory_modes_v1(uuid[])
  to authenticated, service_role;

create or replace function public.sync_product_state_from_available_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_available integer;
  next_available integer;
  previous_state jsonb;
  next_state jsonb;
  automatic_action text;
begin
  previous_available := case when tg_op = 'INSERT' then null
    else greatest(coalesce(old.stock, 0) - coalesce(old.reserved_stock, 0), 0) end;
  next_available := greatest(coalesce(new.stock, 0) - coalesce(new.reserved_stock, 0), 0);
  previous_state := case when tg_op = 'INSERT' then null else jsonb_build_object(
    'stock', old.stock, 'reserved_stock', old.reserved_stock,
    'available_stock', previous_available, 'active', old.active,
    'status', old.status, 'auto_disabled_by_stock', old.auto_disabled_by_stock
  ) end;

  if not new.tracks_inventory then
    if coalesce(new.auto_disabled_by_stock, false) then
      new.active := true;
      new.status := 'active';
      new.auto_disabled_by_stock := false;
      automatic_action := 'product.auto_reactivated_as_service';
    end if;
  elsif next_available <= 0 then
    if coalesce(new.active, false) or coalesce(new.auto_disabled_by_stock, false) then
      new.active := false;
      new.status := 'inactive';
      new.auto_disabled_by_stock := true;
      if tg_op = 'INSERT' or old.active is distinct from new.active
        or old.auto_disabled_by_stock is distinct from new.auto_disabled_by_stock then
        automatic_action := 'product.auto_deactivated_by_stock';
      end if;
    end if;
  elsif tg_op = 'UPDATE' and coalesce(new.auto_disabled_by_stock, false) then
    new.active := true;
    new.status := 'active';
    new.auto_disabled_by_stock := false;
    automatic_action := 'product.auto_reactivated_by_stock';
  end if;

  if automatic_action is not null then
    next_state := jsonb_build_object(
      'stock', new.stock, 'reserved_stock', new.reserved_stock,
      'available_stock', next_available, 'active', new.active,
      'status', new.status, 'auto_disabled_by_stock', new.auto_disabled_by_stock,
      'tracks_inventory', new.tracks_inventory
    );
    perform public.audit_automatic_product_stock_state(
      new.id, automatic_action, previous_state, next_state
    );
  end if;
  return new;
end;
$$;

commit;
