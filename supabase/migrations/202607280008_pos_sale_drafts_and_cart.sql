-- POS Phase 1 / Stage 4: non-economic, recoverable sale drafts.
-- These tables and RPCs cannot create orders, invoices, payments, reservations,
-- inventory movements, financial events, accounting outboxes, or journal entries.

update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || '[
        "pos:drafts:create",
        "pos:drafts:read",
        "pos:drafts:edit_own",
        "pos:drafts:edit_any",
        "pos:drafts:abandon",
        "pos:products:search",
        "pos:price_override"
      ]'::jsonb
    ) as expanded(permission)
  ) deduplicated
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = (
  ((((((coalesce(permissions, '[]'::jsonb)
    - 'pos:drafts:create')
    - 'pos:drafts:read')
    - 'pos:drafts:edit_own')
    - 'pos:drafts:edit_any')
    - 'pos:drafts:abandon')
    - 'pos:products:search')
    - 'pos:price_override'
),
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
      'pos:create_sale',
      'pos:apply_discount',
      'pos:access',
      'pos:customers:search',
      'pos:customers:create',
      'pos:customers:update',
      'customers:read_commercial',
      'customers:read_credit',
      'pos:drafts:create',
      'pos:drafts:read',
      'pos:drafts:edit_own',
      'pos:drafts:edit_any',
      'pos:drafts:abandon',
      'pos:products:search',
      'pos:price_override'
    )
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission(permission_key);
$$;

create table public.pos_sale_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  customer_commercial_version integer not null,
  pricing_mode_snapshot text not null check (pricing_mode_snapshot in ('retail', 'wholesale')),
  status text not null default 'active' check (status in ('active', 'abandoned', 'expired')),
  version bigint not null default 1 check (version > 0),
  delivery_mode text not null default 'store_immediate'
    check (delivery_mode in ('store_immediate', 'home_delivery', 'cash_on_delivery')),
  delivery_address text,
  delivery_notes text,
  internal_notes text,
  shipping_fee numeric(12,2) not null default 0 check (shipping_fee = 0),
  cod_fee numeric(12,2) not null default 0 check (cod_fee = 0),
  other_charge numeric(12,2) not null default 0 check (other_charge = 0),
  merchandise_gross numeric(14,2) not null default 0 check (merchandise_gross >= 0),
  taxable_gross numeric(14,2) not null default 0 check (taxable_gross >= 0),
  exempt_gross numeric(14,2) not null default 0 check (exempt_gross >= 0),
  taxable_base numeric(14,2) not null default 0 check (taxable_base >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  discount_total numeric(14,2) not null default 0 check (discount_total = 0),
  grand_total numeric(14,2) not null default 0 check (grand_total >= 0),
  calculation_version integer not null default 2 check (calculation_version = 2),
  currency text not null default 'HNL' check (currency = 'HNL'),
  validation_status text not null default 'valid' check (validation_status in ('valid', 'warning')),
  validation_messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_messages) = 'array'),
  last_request_key uuid,
  last_saved_by uuid not null references public.users(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  abandoned_at timestamptz,
  constraint pos_sale_drafts_delivery_address_length
    check (delivery_address is null or char_length(delivery_address) <= 500),
  constraint pos_sale_drafts_delivery_notes_length
    check (delivery_notes is null or char_length(delivery_notes) <= 1000),
  constraint pos_sale_drafts_internal_notes_length
    check (internal_notes is null or char_length(internal_notes) <= 1000)
);

create table public.pos_sale_draft_items (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.pos_sale_drafts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  product_sales_version bigint not null,
  sku_snapshot text not null,
  internal_code_snapshot text,
  product_name_snapshot text not null,
  brand_snapshot text not null,
  category_name_snapshot text,
  image_url_snapshot text,
  pricing_source text not null check (pricing_source in ('retail', 'wholesale')),
  base_unit_price numeric(12,2) not null check (base_unit_price >= 0),
  final_unit_price numeric(12,2) not null check (final_unit_price >= 0),
  price_overridden boolean not null default false,
  price_override_reason text,
  price_overridden_by uuid references public.users(id) on delete restrict,
  price_overridden_at timestamptz,
  quantity integer not null check (quantity > 0),
  tax_category_snapshot text not null check (tax_category_snapshot in ('standard', 'exempt')),
  tax_rate_snapshot numeric(8,6) not null check (tax_rate_snapshot >= 0 and tax_rate_snapshot <= 1),
  line_merchandise_gross numeric(14,2) not null check (line_merchandise_gross >= 0),
  line_taxable_base numeric(14,2) not null check (line_taxable_base >= 0),
  line_tax_amount numeric(14,2) not null check (line_tax_amount >= 0),
  line_exempt_amount numeric(14,2) not null check (line_exempt_amount >= 0),
  available_stock_snapshot integer not null check (available_stock_snapshot >= 0),
  stock_observed_at timestamptz not null,
  stock_status text not null check (stock_status in ('available', 'low', 'insufficient')),
  validation_status text not null check (validation_status in ('valid', 'warning', 'blocked')),
  cost_floor_validated boolean not null,
  cost_validation_version integer not null default 1 check (cost_validation_version = 1),
  cost_validated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (draft_id, product_id),
  constraint pos_sale_draft_items_override_evidence check (
    (not price_overridden and price_override_reason is null and price_overridden_by is null and price_overridden_at is null)
    or
    (price_overridden and char_length(trim(price_override_reason)) between 5 and 500
      and price_overridden_by is not null and price_overridden_at is not null)
  )
);

create index pos_sale_drafts_owner_status_updated_idx
  on public.pos_sale_drafts (owner_user_id, status, updated_at desc);
create index pos_sale_drafts_customer_idx
  on public.pos_sale_drafts (customer_id, updated_at desc);
create index pos_sale_drafts_expiry_idx
  on public.pos_sale_drafts (expires_at) where status = 'active';
create index pos_sale_draft_items_product_idx
  on public.pos_sale_draft_items (product_id);

alter table public.pos_sale_drafts enable row level security;
alter table public.pos_sale_draft_items enable row level security;
revoke all on table public.pos_sale_drafts from public, anon, authenticated;
revoke all on table public.pos_sale_draft_items from public, anon, authenticated;
grant select, insert, update, delete on public.pos_sale_drafts to service_role;
grant select, insert, update, delete on public.pos_sale_draft_items to service_role;

comment on table public.pos_sale_drafts is
  'Non-economic POS preparation state. It is not an order, sale, invoice, payment, receivable, reservation, or accounting event.';
comment on table public.pos_sale_draft_items is
  'Server-resolved POS draft lines with commercial/fiscal snapshots and no inventory reservation or movement.';

create extension if not exists pg_trgm with schema extensions;
create index products_pos_name_trgm_idx on public.products using gin (lower(name) extensions.gin_trgm_ops);
create index products_pos_sku_trgm_idx on public.products using gin (lower(sku) extensions.gin_trgm_ops);
create index products_pos_internal_code_trgm_idx on public.products using gin (lower(internal_code) extensions.gin_trgm_ops);
create index products_pos_brand_trgm_idx on public.products using gin (lower(brand) extensions.gin_trgm_ops);

create or replace function public.get_pos_charge_capabilities_v1()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.pos_permission_allowed('pos:access') then
      jsonb_build_object(
        'shippingFeeEnabled', false,
        'codFeeEnabled', false,
        'externalChargeEnabled', false,
        'otherChargeEnabled', false,
        'disabledReason', 'Los cargos requieren configuracion contable activa.'
      )
    else
      jsonb_build_object(
        'shippingFeeEnabled', exists (
          select 1 from public.accounting_mappings
          where is_active and lower(source_key) = 'sale_shipping_fee'
        ),
        'codFeeEnabled', exists (
          select 1 from public.accounting_mappings
          where is_active and lower(source_key) = 'sale_cod_fee'
        ),
        'externalChargeEnabled', exists (
          select 1 from public.accounting_mappings
          where is_active and lower(source_key) = 'sale_external_charge'
        ),
        'otherChargeEnabled', exists (
          select 1 from public.accounting_mappings
          where is_active and lower(source_key) = 'sale_other_charge'
        ),
        'disabledReason', 'Los importes permanecen bloqueados en Etapa 4.'
      )
  end;
$$;

create or replace function public.search_pos_products_v1(
  p_query text default '',
  p_customer_id uuid default null,
  p_expected_customer_commercial_version integer default null,
  p_category_id uuid default null,
  p_brand text default null,
  p_include_unavailable boolean default true,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  product_id uuid,
  sku text,
  internal_code text,
  product_name text,
  brand text,
  category_id uuid,
  category_name text,
  base_unit_price numeric,
  pricing_source text,
  wholesale_min_quantity integer,
  tax_category text,
  included_tax_rate numeric,
  product_sales_version bigint,
  product_status text,
  active boolean,
  auto_disabled_by_stock boolean,
  available_stock integer,
  low_stock_threshold integer,
  image_url text,
  rank integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_query text := lower(trim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')));
  normalized_brand text := nullif(lower(trim(coalesce(p_brand, ''))), '');
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  pricing record;
  resolved_tax_rate numeric := 0.15;
begin
  if not public.pos_permission_allowed('pos:products:search') then
    raise exception using errcode = '42501', message = 'No tienes permiso para buscar productos del POS.';
  end if;
  if char_length(normalized_query) > 120 then
    raise exception using errcode = '22023', message = 'La busqueda es demasiado larga.';
  end if;
  if p_customer_id is null or p_expected_customer_commercial_version is null then
    raise exception using errcode = '22023', message = 'Selecciona un cliente vigente antes de buscar productos.';
  end if;
  perform 1 from public.customers customer
  where customer.id = p_customer_id and customer.active and customer.status = 'active';
  if not found then
    raise exception using errcode = '22023', message = 'El cliente ya no esta activo.';
  end if;
  select * into pricing from public.resolve_customer_pricing_mode_v1(p_customer_id);
  if pricing.commercial_version <> p_expected_customer_commercial_version then
    raise exception using errcode = 'PT409',
      message = 'Las condiciones comerciales del cliente cambiaron. Recarga el borrador.';
  end if;
  select coalesce(cs.tax_rate, 0.15) into resolved_tax_rate
  from public.company_settings cs order by cs.created_at limit 1;
  resolved_tax_rate := coalesce(resolved_tax_rate, 0.15);

  return query
  with matched as (
    select
      p.id,
      p.sku,
      p.internal_code,
      p.name,
      p.brand,
      p.category_id,
      c.name as category_name,
      case
        when pricing.pricing_mode = 'wholesale' and p.wholesale_min_quantity <= 1
          then p.wholesale_price
        else p.retail_price
      end as base_unit_price,
      case
        when pricing.pricing_mode = 'wholesale' and p.wholesale_min_quantity <= 1
          then 'wholesale'
        else 'retail'
      end as pricing_source,
      p.wholesale_min_quantity,
      p.tax_category,
      case when p.tax_category = 'standard' then resolved_tax_rate else 0 end as included_tax_rate,
      p.product_sales_version,
      p.status::text as product_status,
      p.active,
      p.auto_disabled_by_stock,
      greatest(coalesce(p.available_stock, p.stock - coalesce(p.reserved_stock, 0)), 0) as available_stock,
      p.low_stock_threshold,
      image.public_url as image_url,
      case
        when normalized_query <> '' and lower(p.sku) = normalized_query then 1
        when normalized_query <> '' and lower(coalesce(p.internal_code, '')) = normalized_query then 2
        when normalized_query <> '' and lower(p.name) = normalized_query then 3
        when normalized_query <> '' and lower(p.sku) like normalized_query || '%' then 4
        when normalized_query <> '' and lower(coalesce(p.internal_code, '')) like normalized_query || '%' then 5
        when normalized_query <> '' and lower(p.name) like normalized_query || '%' then 6
        else 10
      end as result_rank
    from public.products p
    left join public.categories c on c.id = p.category_id
    left join lateral (
      select pi.public_url
      from public.product_images pi
      where pi.product_id = p.id
      order by pi.is_primary desc, pi.sort_order asc, pi.created_at asc
      limit 1
    ) image on true
    where (p_include_unavailable or (p.active and p.status = 'active'))
      and (p_category_id is null or p.category_id = p_category_id)
      and (normalized_brand is null or lower(p.brand) = normalized_brand)
      and (
        normalized_query = ''
        or lower(p.sku) like '%' || normalized_query || '%'
        or lower(coalesce(p.internal_code, '')) like '%' || normalized_query || '%'
        or lower(p.name) like '%' || normalized_query || '%'
        or lower(p.brand) like '%' || normalized_query || '%'
        or lower(coalesce(c.name, '')) like '%' || normalized_query || '%'
      )
      and (
        char_length(normalized_query) <> 1
        or lower(p.sku) = normalized_query
        or lower(coalesce(p.internal_code, '')) = normalized_query
      )
  )
  select
    matched.id,
    matched.sku,
    matched.internal_code,
    matched.name,
    matched.brand,
    matched.category_id,
    matched.category_name,
    matched.base_unit_price,
    matched.pricing_source,
    matched.wholesale_min_quantity,
    matched.tax_category,
    matched.included_tax_rate,
    matched.product_sales_version,
    matched.product_status,
    matched.active,
    matched.auto_disabled_by_stock,
    matched.available_stock,
    matched.low_stock_threshold,
    matched.image_url,
    matched.result_rank,
    count(*) over ()
  from matched
  order by matched.result_rank, matched.name, matched.sku
  limit safe_limit offset safe_offset;
end;
$$;

create or replace function public.build_pos_sale_draft_payload_v1(p_draft_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'draftId', d.id,
    'ownerId', d.owner_user_id,
    'customerId', d.customer_id,
    'customerCommercialVersion', d.customer_commercial_version,
    'pricingMode', d.pricing_mode_snapshot,
    'status', d.status,
    'version', d.version,
    'deliveryMode', d.delivery_mode,
    'deliveryAddress', d.delivery_address,
    'deliveryNotes', d.delivery_notes,
    'internalNotes', d.internal_notes,
    'merchandiseGross', d.merchandise_gross,
    'taxableGross', d.taxable_gross,
    'taxableBase', d.taxable_base,
    'exemptGross', d.exempt_gross,
    'taxAmount', d.tax_amount,
    'shippingFee', d.shipping_fee,
    'codFee', d.cod_fee,
    'otherCharge', d.other_charge,
    'grandTotal', d.grand_total,
    'calculationVersion', d.calculation_version,
    'currency', d.currency,
    'validationStatus', d.validation_status,
    'validationMessages', d.validation_messages,
    'expiresAt', d.expires_at,
    'createdAt', d.created_at,
    'updatedAt', d.updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId', i.id,
        'productId', i.product_id,
        'productSalesVersion', i.product_sales_version,
        'sku', i.sku_snapshot,
        'internalCode', i.internal_code_snapshot,
        'productName', i.product_name_snapshot,
        'brand', i.brand_snapshot,
        'categoryName', i.category_name_snapshot,
        'imageUrl', i.image_url_snapshot,
        'pricingSource', i.pricing_source,
        'baseUnitPrice', i.base_unit_price,
        'finalUnitPrice', i.final_unit_price,
        'priceOverridden', i.price_overridden,
        'priceOverrideReason', i.price_override_reason,
        'quantity', i.quantity,
        'taxCategory', i.tax_category_snapshot,
        'includedTaxRate', i.tax_rate_snapshot,
        'lineMerchandiseGross', i.line_merchandise_gross,
        'lineTaxableBase', i.line_taxable_base,
        'lineTaxAmount', i.line_tax_amount,
        'lineExemptAmount', i.line_exempt_amount,
        'availableStock', i.available_stock_snapshot,
        'stockObservedAt', i.stock_observed_at,
        'stockStatus', i.stock_status,
        'validationStatus', i.validation_status,
        'costFloorValidated', i.cost_floor_validated,
        'costValidationVersion', i.cost_validation_version,
        'costValidatedAt', i.cost_validated_at
      ) order by i.created_at, i.id)
      from public.pos_sale_draft_items i
      where i.draft_id = d.id
    ), '[]'::jsonb)
  )
  from public.pos_sale_drafts d
  where d.id = p_draft_id;
$$;

create or replace function public.create_pos_sale_draft_v1(
  p_request_key uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pricing record;
  claim record;
  payload_hash text;
  new_draft_id uuid;
  result jsonb;
begin
  if not public.pos_permission_allowed('pos:drafts:create') then
    raise exception using errcode = '42501', message = 'No tienes permiso para crear borradores POS.';
  end if;
  payload_hash := encode(extensions.digest(convert_to(
    jsonb_build_object('customer_id', p_customer_id)::text, 'UTF8'
  ), 'sha256'), 'hex');
  select * into claim from public.claim_pos_idempotency_v1(
    p_request_key, 'create_pos_sale_draft_v1', payload_hash
  );
  if claim.request_status = 'succeeded' then
    return claim.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim.acquired then
    raise exception using errcode = '55000', message = 'La creacion del borrador todavia esta en proceso.';
  end if;

  perform 1 from public.customers customer
  where customer.id = p_customer_id and customer.active and customer.status = 'active'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'No se encontro un cliente activo.';
  end if;
  select * into pricing from public.resolve_customer_pricing_mode_v1(p_customer_id);

  insert into public.pos_sale_drafts (
    owner_user_id, customer_id, customer_commercial_version, pricing_mode_snapshot,
    last_request_key, last_saved_by
  )
  values (
    auth.uid(), p_customer_id, pricing.commercial_version, pricing.pricing_mode,
    p_request_key, auth.uid()
  )
  returning id into new_draft_id;

  result := public.build_pos_sale_draft_payload_v1(new_draft_id)
    || jsonb_build_object('idempotentReplay', false);
  perform public.write_audit_log(
    'pos_sale_drafts', new_draft_id, 'pos.draft.created', null,
    jsonb_build_object('customer_id', p_customer_id, 'version', 1)
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key, 'create_pos_sale_draft_v1', payload_hash, result
  );
  return result;
end;
$$;

create or replace function public.get_pos_sale_draft_v1(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_record public.pos_sale_drafts%rowtype;
begin
  if not public.pos_permission_allowed('pos:drafts:read') then
    raise exception using errcode = '42501', message = 'No tienes permiso para leer borradores POS.';
  end if;
  select * into draft_record from public.pos_sale_drafts where id = p_draft_id;
  if draft_record.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el borrador.';
  end if;
  if draft_record.owner_user_id <> auth.uid()
    and not public.pos_permission_allowed('pos:drafts:edit_any') then
    raise exception using errcode = '42501', message = 'No tienes permiso para leer este borrador.';
  end if;
  if draft_record.status = 'active' and draft_record.expires_at <= now() then
    update public.pos_sale_drafts
    set status = 'expired', version = version + 1, updated_at = now(),
        last_saved_by = auth.uid()
    where id = p_draft_id and status = 'active' and expires_at <= now();
  end if;
  return public.build_pos_sale_draft_payload_v1(p_draft_id);
end;
$$;

create or replace function public.list_pos_sale_drafts_v1(
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.pos_permission_allowed('pos:drafts:read') then
    raise exception using errcode = '42501', message = 'No tienes permiso para listar borradores POS.';
  end if;
  update public.pos_sale_drafts
  set status = 'expired', version = version + 1, updated_at = now(),
      last_saved_by = auth.uid()
  where status = 'active' and expires_at <= now()
    and (owner_user_id = auth.uid() or public.pos_permission_allowed('pos:drafts:edit_any'));
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'draftId', d.id,
      'customerId', d.customer_id,
      'customerName', coalesce(nullif(c.business_name, ''), c.contact_name),
      'status', d.status,
      'version', d.version,
      'itemCount', (select count(*) from public.pos_sale_draft_items i where i.draft_id = d.id),
      'total', d.grand_total,
      'updatedAt', d.updated_at,
      'expiresAt', d.expires_at
    ) order by d.updated_at desc)
    from (
      select *
      from public.pos_sale_drafts
      where (owner_user_id = auth.uid() or public.pos_permission_allowed('pos:drafts:edit_any'))
        and status = 'active'
      order by updated_at desc
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
      offset least(greatest(coalesce(p_offset, 0), 0), 10000)
    ) d
    join public.customers c on c.id = d.customer_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.save_pos_sale_draft_v1(
  p_request_key uuid,
  p_draft_id uuid,
  p_expected_version bigint,
  p_customer_id uuid,
  p_expected_customer_commercial_version integer,
  p_items jsonb,
  p_delivery_mode text default 'store_immediate',
  p_delivery_address text default null,
  p_delivery_notes text default null,
  p_internal_notes text default null,
  p_delivery_charge numeric default 0,
  p_cash_on_delivery_charge numeric default 0,
  p_other_charges numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_record public.pos_sale_drafts%rowtype;
  customer_record public.customers%rowtype;
  pricing record;
  claim record;
  product_record record;
  input_item record;
  calculated jsonb;
  calculation_lines jsonb := '[]'::jsonb;
  payload_hash text;
  result jsonb;
  base_price numeric(12,2);
  final_price numeric(12,2);
  normalized_reason text;
  tax_rate numeric := 0.15;
  has_warning boolean := false;
  override_used boolean;
  image_url text;
  category_name text;
begin
  if not public.pos_permission_allowed('pos:drafts:edit_own') then
    raise exception using errcode = '42501', message = 'No tienes permiso para editar borradores POS.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception using errcode = '22023', message = 'El carrito no tiene un formato valido.';
  end if;
  if p_delivery_mode not in ('store_immediate', 'home_delivery', 'cash_on_delivery') then
    raise exception using errcode = '22023', message = 'La modalidad de entrega no es valida.';
  end if;
  if coalesce(p_delivery_charge, 0) <> 0
    or coalesce(p_cash_on_delivery_charge, 0) <> 0
    or coalesce(p_other_charges, 0) <> 0 then
    raise exception using errcode = '22023',
      message = 'Los cargos monetarios estan deshabilitados hasta que exista mapping contable.';
  end if;
  if char_length(coalesce(p_delivery_address, '')) > 500
    or char_length(coalesce(p_delivery_notes, '')) > 1000
    or char_length(coalesce(p_internal_notes, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Las notas o direccion exceden el limite permitido.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) value
    group by value->>'productId'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'El carrito contiene productos duplicados.';
  end if;

  -- Authorize the target before attempting CAS so an edit-own capability
  -- cannot be used to probe or lock another actor's draft.
  select * into draft_record from public.pos_sale_drafts where id = p_draft_id;
  if draft_record.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el borrador.';
  end if;
  if draft_record.owner_user_id <> auth.uid()
    and not public.pos_permission_allowed('pos:drafts:edit_any') then
    raise exception using errcode = '42501', message = 'No tienes permiso para editar este borrador.';
  end if;
  if draft_record.status <> 'active' or draft_record.expires_at <= now() then
    raise exception using errcode = '22023', message = 'El borrador ya no esta activo.';
  end if;

  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'draft_id', p_draft_id,
    'expected_version', p_expected_version,
    'customer_id', p_customer_id,
    'expected_customer_commercial_version', p_expected_customer_commercial_version,
    'items', p_items,
    'delivery_mode', p_delivery_mode,
    'delivery_address', nullif(trim(coalesce(p_delivery_address, '')), ''),
    'delivery_notes', nullif(trim(coalesce(p_delivery_notes, '')), ''),
    'internal_notes', nullif(trim(coalesce(p_internal_notes, '')), '')
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim from public.claim_pos_idempotency_v1(
    p_request_key, 'save_pos_sale_draft_v1', payload_hash
  );
  if claim.request_status = 'succeeded' then
    return claim.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim.acquired then
    raise exception using errcode = '55000', message = 'El guardado todavia esta en proceso.';
  end if;

  -- One atomic CAS acquires the row lock and advances the version. Avoid a
  -- SELECT FOR UPDATE followed by UPDATE: a concurrent waiter can otherwise
  -- sit between both lock operations and exhaust the HTTP timeout.
  update public.pos_sale_drafts
  set version = version + 1,
      updated_at = now()
  where id = p_draft_id
    and status = 'active'
    and version = p_expected_version
  returning * into draft_record;
  if draft_record.id is null then
    select * into draft_record from public.pos_sale_drafts where id = p_draft_id;
    if draft_record.id is null then
      raise exception using errcode = 'P0002', message = 'No se encontro el borrador.';
    elsif draft_record.status <> 'active' then
      raise exception using errcode = '22023', message = 'El borrador ya no esta activo.';
    else
      raise exception using errcode = 'PT409',
        message = 'El borrador cambio en otra pestana o dispositivo. Recarga antes de guardar.',
        detail = jsonb_build_object(
          'currentVersion', draft_record.version,
          'status', draft_record.status,
          'updatedAt', draft_record.updated_at
        )::text;
    end if;
  end if;
  select * into customer_record
  from public.customers
  where id = p_customer_id
  for share;
  if customer_record.id is null or not customer_record.active or customer_record.status <> 'active' then
    raise exception using errcode = '22023', message = 'El cliente ya no esta activo.';
  end if;
  if customer_record.commercial_version <> p_expected_customer_commercial_version then
    raise exception using errcode = 'PT409',
      message = 'Las condiciones comerciales del cliente cambiaron. Recarga el borrador.';
  end if;
  select * into pricing from public.resolve_customer_pricing_mode_v1(p_customer_id);

  select coalesce(cs.tax_rate, 0.15)
  into tax_rate
  from public.company_settings cs
  order by cs.created_at
  limit 1;
  tax_rate := coalesce(tax_rate, 0.15);

  -- Lock products in deterministic UUID order before resolving any line.
  perform p.id
  from public.products p
  join (
    select (value->>'productId')::uuid as product_id
    from jsonb_array_elements(p_items)
  ) requested on requested.product_id = p.id
  order by p.id
  for share;

  create temporary table if not exists pg_temp.pos_resolved_draft_items (
    product_id uuid,
    product_sales_version bigint,
    sku text,
    product_name text,
    brand text,
    category_name text,
    image_url text,
    pricing_mode text,
    base_price numeric(12,2),
    final_price numeric(12,2),
    overridden boolean,
    override_reason text,
    quantity integer,
    tax_category text,
    available_stock integer,
    stock_status text,
    cost_validation_passed boolean
  ) on commit drop;
  truncate pg_temp.pos_resolved_draft_items;

  for input_item in
    select
      value,
      (value->>'productId')::uuid as product_id,
      nullif(value->>'quantity', '')::integer as quantity,
      nullif(value->>'finalUnitPrice', '')::numeric as requested_price,
      nullif(trim(coalesce(value->>'priceOverrideReason', '')), '') as override_reason,
      nullif(value->>'expectedProductSalesVersion', '')::bigint as expected_sales_version
    from jsonb_array_elements(p_items)
    order by (value->>'productId')::uuid
  loop
    select
      p.*,
      c.name as category_name,
      coalesce((
        select pi.public_url from public.product_images pi
        where pi.product_id = p.id
        order by pi.is_primary desc, pi.sort_order, pi.created_at
        limit 1
      ), null) as image_url
    into product_record
    from public.products p
    left join public.categories c on c.id = p.category_id
    where p.id = input_item.product_id;

    if product_record.id is null or not product_record.active or product_record.status <> 'active' then
      raise exception using errcode = '22023', message = 'Uno de los productos ya no esta activo.';
    end if;
    if input_item.quantity is null or input_item.quantity <= 0 or input_item.quantity > 9999 then
      raise exception using errcode = '22023', message = 'La cantidad de un producto no es valida.';
    end if;
    if input_item.expected_sales_version is not null
      and input_item.expected_sales_version <> product_record.product_sales_version then
      raise exception using errcode = 'PT409',
        message = 'Un producto cambio de precio o configuracion. Recarga el carrito.';
    end if;

    base_price := case
      when pricing.pricing_mode = 'wholesale'
        and input_item.quantity >= product_record.wholesale_min_quantity
        then product_record.wholesale_price
      else product_record.retail_price
    end;
    final_price := round(coalesce(input_item.requested_price, base_price), 2);
    override_used := final_price <> base_price;
    normalized_reason := input_item.override_reason;
    if final_price <= 0 then
      raise exception using errcode = '22023', message = 'El precio final debe ser mayor que cero.';
    end if;
    if override_used then
      if not public.pos_permission_allowed('pos:price_override') then
        raise exception using errcode = '42501', message = 'No tienes permiso para cambiar precios.';
      end if;
      if normalized_reason is null or char_length(normalized_reason) not between 5 and 500 then
        raise exception using errcode = '22023', message = 'El motivo del cambio de precio debe tener al menos 5 caracteres.';
      end if;
      if product_record.cost_price is null or product_record.cost_price <= 0 then
        raise exception using errcode = '22023',
          message = 'No se puede cambiar el precio porque falta un costo confiable.';
      end if;
      if final_price < product_record.cost_price then
        raise exception using errcode = '22023', message = 'El precio final no puede quedar por debajo del costo.';
      end if;
    else
      normalized_reason := null;
    end if;

    if input_item.quantity > product_record.available_stock then
      has_warning := true;
    end if;
    if product_record.cost_price is null or product_record.cost_price <= 0 then
      has_warning := true;
    end if;
    insert into pg_temp.pos_resolved_draft_items values (
      product_record.id,
      product_record.product_sales_version,
      product_record.sku,
      product_record.name,
      product_record.brand,
      product_record.category_name,
      product_record.image_url,
      case
        when pricing.pricing_mode = 'wholesale'
          and input_item.quantity >= product_record.wholesale_min_quantity
          then 'wholesale'
        else 'retail'
      end,
      base_price,
      final_price,
      override_used,
      normalized_reason,
      input_item.quantity,
      product_record.tax_category,
      product_record.available_stock,
      case
        when input_item.quantity > product_record.available_stock then 'insufficient'
        when product_record.available_stock <= product_record.low_stock_threshold then 'low'
        else 'available'
      end,
      coalesce(product_record.cost_price > 0 and final_price >= product_record.cost_price, false)
    );
    calculation_lines := calculation_lines || jsonb_build_array(jsonb_build_object(
      'product_id', product_record.id,
      'quantity', input_item.quantity,
      'unit_price', final_price,
      'tax_category', product_record.tax_category
    ));
  end loop;

  calculated := public.calculate_pos_draft_financials_v2(
    calculation_lines, tax_rate, 0, 0, 0, 'HNL'
  );

  delete from public.pos_sale_draft_items where draft_id = p_draft_id;
  insert into public.pos_sale_draft_items (
    draft_id, product_id, product_sales_version, sku_snapshot,
    internal_code_snapshot, product_name_snapshot, brand_snapshot, category_name_snapshot,
    image_url_snapshot, pricing_source, base_unit_price, final_unit_price,
    price_overridden, price_override_reason, price_overridden_by,
    price_overridden_at, quantity, tax_category_snapshot, tax_rate_snapshot,
    line_merchandise_gross, line_taxable_base, line_tax_amount, line_exempt_amount,
    available_stock_snapshot, stock_observed_at, stock_status, validation_status,
    cost_floor_validated, cost_validation_version, cost_validated_at
  )
  select
    p_draft_id,
    r.product_id,
    r.product_sales_version,
    r.sku,
    (select p.internal_code from public.products p where p.id = r.product_id),
    r.product_name,
    r.brand,
    r.category_name,
    r.image_url,
    r.pricing_mode,
    r.base_price,
    r.final_price,
    r.overridden,
    r.override_reason,
    case when r.overridden then auth.uid() else null end,
    case when r.overridden then now() else null end,
    r.quantity,
    r.tax_category,
    case when r.tax_category = 'standard' then tax_rate else 0 end,
    round(r.quantity * r.final_price, 2),
    case when r.tax_category = 'standard' and tax_rate > 0
      then round(round(r.quantity * r.final_price, 2) / (1 + tax_rate), 2)
      else 0 end,
    case when r.tax_category = 'standard' and tax_rate > 0
      then round(r.quantity * r.final_price, 2)
        - round(round(r.quantity * r.final_price, 2) / (1 + tax_rate), 2)
      else 0 end,
    case when r.tax_category = 'exempt' then round(r.quantity * r.final_price, 2) else 0 end,
    r.available_stock,
    now(),
    r.stock_status,
    case when r.stock_status = 'available' and r.cost_validation_passed then 'valid' else 'warning' end,
    r.cost_validation_passed,
    1,
    now()
  from pg_temp.pos_resolved_draft_items r;

  for product_record in
    select i.id, i.product_id, i.base_unit_price, i.final_unit_price,
      i.price_override_reason
    from public.pos_sale_draft_items i
    where i.draft_id = p_draft_id and i.price_overridden
  loop
    perform public.write_audit_log(
      'pos_sale_draft_items', product_record.id, 'pos.price_override', null,
      jsonb_build_object(
        'draft_id', p_draft_id,
        'product_id', product_record.product_id,
        'base_unit_price', product_record.base_unit_price,
        'final_unit_price', product_record.final_unit_price,
        'reason', product_record.price_override_reason,
        'actor_id', auth.uid()
      )
    );
  end loop;

  update public.pos_sale_drafts
  set customer_id = p_customer_id,
      customer_commercial_version = pricing.commercial_version,
      pricing_mode_snapshot = pricing.pricing_mode,
      delivery_mode = p_delivery_mode,
      delivery_address = nullif(trim(coalesce(p_delivery_address, '')), ''),
      delivery_notes = nullif(trim(coalesce(p_delivery_notes, '')), ''),
      internal_notes = nullif(trim(coalesce(p_internal_notes, '')), ''),
      merchandise_gross = (calculated->>'merchandise_total')::numeric,
      taxable_gross = (calculated->>'taxable_gross')::numeric,
      exempt_gross = (calculated->>'exempt_total')::numeric,
      taxable_base = (calculated->>'taxable_base')::numeric,
      tax_amount = (calculated->>'tax_total')::numeric,
      grand_total = (calculated->>'total')::numeric,
      validation_status = case when has_warning then 'warning' else 'valid' end,
      validation_messages = case when has_warning then jsonb_build_array(jsonb_build_object(
        'code', 'DRAFT_REVALIDATION_REQUIRED',
        'message', 'Revisa disponibilidad o validacion de costo antes del cierre.'
      )) else '[]'::jsonb end,
      last_request_key = p_request_key,
      last_saved_by = auth.uid(),
      expires_at = now() + interval '30 days',
      updated_at = now()
  where id = p_draft_id;

  result := public.build_pos_sale_draft_payload_v1(p_draft_id)
    || jsonb_build_object('idempotentReplay', false);
  perform public.write_audit_log(
    'pos_sale_drafts', p_draft_id, 'pos.draft.saved',
    jsonb_build_object('version', p_expected_version),
    jsonb_build_object(
      'version', p_expected_version + 1,
      'customer_id', p_customer_id,
      'item_count', jsonb_array_length(p_items),
      'price_override_count', (select count(*) from pg_temp.pos_resolved_draft_items where overridden),
      'validation_status', case when has_warning then 'warning' else 'valid' end
    )
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key, 'save_pos_sale_draft_v1', payload_hash, result
  );
  return result;
end;
$$;

create or replace function public.abandon_pos_sale_draft_v1(
  p_request_key uuid,
  p_draft_id uuid,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  draft_record public.pos_sale_drafts%rowtype;
  claim record;
  payload_hash text;
  result jsonb;
begin
  if not public.pos_permission_allowed('pos:drafts:abandon') then
    raise exception using errcode = '42501', message = 'No tienes permiso para abandonar borradores POS.';
  end if;
  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'draft_id', p_draft_id, 'expected_version', p_expected_version
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim from public.claim_pos_idempotency_v1(
    p_request_key, 'abandon_pos_sale_draft_v1', payload_hash
  );
  if claim.request_status = 'succeeded' then
    return claim.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim.acquired then
    raise exception using errcode = '55000', message = 'La operacion todavia esta en proceso.';
  end if;
  select * into draft_record from public.pos_sale_drafts where id = p_draft_id for update;
  if draft_record.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el borrador.';
  end if;
  if draft_record.owner_user_id <> auth.uid()
    and not public.pos_permission_allowed('pos:drafts:edit_any') then
    raise exception using errcode = '42501', message = 'No tienes permiso para abandonar este borrador.';
  end if;
  if draft_record.status <> 'active' or draft_record.expires_at <= now() then
    raise exception using errcode = '22023', message = 'El borrador ya no esta activo.';
  end if;
  if draft_record.version <> p_expected_version then
    raise exception using errcode = 'PT409',
      message = 'El borrador cambio. Recarga antes de abandonarlo.',
      detail = jsonb_build_object(
        'currentVersion', draft_record.version,
        'status', draft_record.status,
        'updatedAt', draft_record.updated_at
      )::text;
  end if;
  update public.pos_sale_drafts
  set status = 'abandoned', version = version + 1, abandoned_at = now(),
      updated_at = now(), last_request_key = p_request_key, last_saved_by = auth.uid()
  where id = p_draft_id and status = 'active';
  result := public.build_pos_sale_draft_payload_v1(p_draft_id)
    || jsonb_build_object('idempotentReplay', false);
  perform public.write_audit_log(
    'pos_sale_drafts', p_draft_id, 'pos.draft.abandoned',
    jsonb_build_object('status', draft_record.status, 'version', draft_record.version),
    jsonb_build_object('status', 'abandoned', 'version', draft_record.version + 1)
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key, 'abandon_pos_sale_draft_v1', payload_hash, result
  );
  return result;
end;
$$;

revoke all on function public.get_pos_charge_capabilities_v1() from public, anon;
revoke all on function public.search_pos_products_v1(text, uuid, integer, uuid, text, boolean, integer, integer) from public, anon;
revoke all on function public.build_pos_sale_draft_payload_v1(uuid) from public, anon, authenticated;
revoke all on function public.create_pos_sale_draft_v1(uuid, uuid) from public, anon;
revoke all on function public.get_pos_sale_draft_v1(uuid) from public, anon;
revoke all on function public.list_pos_sale_drafts_v1(integer, integer) from public, anon;
revoke all on function public.save_pos_sale_draft_v1(uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.abandon_pos_sale_draft_v1(uuid, uuid, bigint) from public, anon;

grant execute on function public.get_pos_charge_capabilities_v1() to authenticated;
grant execute on function public.search_pos_products_v1(text, uuid, integer, uuid, text, boolean, integer, integer) to authenticated;
grant execute on function public.create_pos_sale_draft_v1(uuid, uuid) to authenticated;
grant execute on function public.get_pos_sale_draft_v1(uuid) to authenticated;
grant execute on function public.list_pos_sale_drafts_v1(integer, integer) to authenticated;
grant execute on function public.save_pos_sale_draft_v1(uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.abandon_pos_sale_draft_v1(uuid, uuid, bigint) to authenticated;
