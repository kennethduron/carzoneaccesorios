-- Checkout V4: durable request ledger and direct atomic order creation.
-- This migration is prospective. It does not update an existing order,
-- invoice, customer, reservation, payment, receivable or accounting event.

create table public.checkout_feature_flags (
  key text primary key,
  enabled boolean not null default false,
  version integer not null default 1 check (version > 0),
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((enabled and enabled_at is not null) or (not enabled and enabled_at is null))
);

insert into public.checkout_feature_flags(key, enabled, reason)
values (
  'checkout_order_v4',
  false,
  'Checkout V4 installed disabled for controlled validation and rollout.'
);

alter table public.checkout_feature_flags enable row level security;
revoke all on public.checkout_feature_flags from public, anon, authenticated;
grant select, insert, update, delete on public.checkout_feature_flags to service_role;

create table public.checkout_requests_v4 (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  recovery_token_hash text check (recovery_token_hash is null or recovery_token_hash ~ '^[0-9a-f]{64}$'),
  actor_scope text not null check (actor_scope in ('guest', 'authenticated')),
  user_id uuid references public.users(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete restrict,
  expected_price_mode public.order_price_mode not null,
  commercial_version integer,
  context_token_hash text check (context_token_hash is null or context_token_hash ~ '^[0-9a-f]{64}$'),
  cart_fingerprint text not null check (cart_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'started' check (
    status in (
      'started',
      'processing',
      'committed',
      'failed_retryable',
      'failed_final',
      'conflict',
      'expired'
    )
  ),
  order_id uuid unique references public.orders(id) on delete restrict,
  order_number text,
  tracking_code text,
  price_mode public.order_price_mode,
  total numeric(12,2),
  error_code text,
  started_at timestamptz not null default now(),
  processing_at timestamptz,
  committed_at timestamptz,
  failed_at timestamptz,
  last_checked_at timestamptz,
  confirmation_shown_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checkout_requests_v4_actor_shape check (
    (actor_scope = 'guest' and user_id is null and recovery_token_hash is not null)
    or (actor_scope = 'authenticated' and user_id is not null)
  ),
  constraint checkout_requests_v4_result_shape check (
    (
      status = 'committed'
      and order_id is not null
      and order_number is not null
      and tracking_code is not null
      and price_mode is not null
      and total is not null
      and committed_at is not null
      and error_code is null
    )
    or (
      status <> 'committed'
      and order_id is null
      and order_number is null
      and tracking_code is null
      and price_mode is null
      and total is null
      and committed_at is null
    )
  ),
  constraint checkout_requests_v4_error_shape check (
    (status in ('failed_retryable', 'failed_final', 'conflict', 'expired') and error_code is not null)
    or (status in ('started', 'processing', 'committed') and error_code is null)
  ),
  constraint checkout_requests_v4_expiry check (expires_at > started_at)
);

create index checkout_requests_v4_actor_created_idx
  on public.checkout_requests_v4(actor_scope, user_id, created_at desc);
create index checkout_requests_v4_status_expiry_idx
  on public.checkout_requests_v4(status, expires_at);
create index checkout_requests_v4_request_status_idx
  on public.checkout_requests_v4(request_key, status);

alter table public.checkout_requests_v4 enable row level security;
revoke all on public.checkout_requests_v4 from public, anon, authenticated;
grant select, insert, update, delete on public.checkout_requests_v4 to service_role;

create or replace function public.checkout_sha256_v1(value jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    extensions.digest(convert_to(coalesce(value, 'null'::jsonb)::text, 'UTF8'), 'sha256'),
    'hex'
  );
$$;

create or replace function public.checkout_hash_text_v1(value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    extensions.digest(convert_to(coalesce(value, ''), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

revoke all on function public.checkout_sha256_v1(jsonb) from public, anon, authenticated;
revoke all on function public.checkout_hash_text_v1(text) from public, anon, authenticated;
grant execute on function public.checkout_sha256_v1(jsonb) to service_role;
grant execute on function public.checkout_hash_text_v1(text) to service_role;

create or replace function public.checkout_normalize_items_v4(p_items jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  normalized jsonb;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 100 then
    raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) item(value)
    where jsonb_typeof(item.value) <> 'object'
      or exists (
        select 1
        from jsonb_object_keys(item.value) field_name
        where field_name not in ('product_id', 'variant_id', 'quantity')
      )
      or nullif(item.value->>'product_id', '') is null
      or (item.value->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (
        item.value ? 'variant_id'
        and item.value->>'variant_id' is not null
        and item.value->>'variant_id' <> ''
      )
      or nullif(item.value->>'quantity', '') is null
      or (item.value->>'quantity') !~ '^[0-9]+$'
      or (item.value->>'quantity')::numeric <= 0
      or (item.value->>'quantity')::numeric > 10000
  ) then
    raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'product_id', grouped.product_id,
      'variant_id', null,
      'quantity', grouped.quantity
    )
    order by grouped.product_id
  )
  into normalized
  from (
    select
      (item.value->>'product_id')::uuid as product_id,
      sum((item.value->>'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) item(value)
    group by (item.value->>'product_id')::uuid
  ) grouped;

  if normalized is null or exists (
    select 1
    from jsonb_array_elements(normalized) item(value)
    where (item.value->>'quantity')::integer > 10000
  ) then
    raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
  end if;

  return normalized;
end;
$$;

revoke all on function public.checkout_normalize_items_v4(jsonb) from public, anon, authenticated;
grant execute on function public.checkout_normalize_items_v4(jsonb) to service_role;

create or replace function public.resolve_portal_commercial_context_v2(
  p_guest_intent boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_active boolean := false;
  actor_role text;
  customer_count integer := 0;
  customer_row public.customers%rowtype;
  credit_count integer := 0;
  credit_row public.customer_credit_accounts%rowtype;
  used_credit numeric(12,2) := 0;
  overdue_balance numeric(12,2) := 0;
  available_credit numeric(12,2) := 0;
  credit_usable boolean := false;
  first_purchase_minimum numeric(12,2) := 10000;
  accumulated_wholesale numeric(12,2) := 0;
  effective_mode public.order_price_mode := 'retail';
  context_status text;
  reason_code text;
  context_token text;
begin
  select round(coalesce(cs.first_wholesale_minimum, 10000), 2)
  into first_purchase_minimum
  from public.company_settings cs
  order by cs.created_at
  limit 1;
  if actor_id is null then
    if not coalesce(p_guest_intent, false) then
      return jsonb_build_object(
        'status', 'commercial_context_conflict',
        'actorScope', 'guest',
        'authenticated', false,
        'accountActive', false,
        'linked', false,
        'userId', null,
        'customerId', null,
        'customerActive', false,
        'priceMode', 'retail',
        'firstPurchaseMinimum', first_purchase_minimum,
        'commercialVersion', null,
        'contextToken', null,
        'reasonCode', 'CHECKOUT_SESSION_REQUIRED',
        'serverTimestamp', now()
      );
    end if;

    context_token := public.checkout_hash_text_v1('checkout-commercial-context:v2:guest');
    return jsonb_build_object(
      'status', 'guest',
      'actorScope', 'guest',
      'authenticated', false,
      'accountActive', false,
      'linked', false,
      'userId', null,
      'customerId', null,
      'customerActive', false,
      'priceMode', 'retail',
      'wholesaleStatus', 'none',
      'wholesaleCustomerType', null,
      'firstPurchaseRequired', false,
      'firstPurchaseMinimum', first_purchase_minimum,
      'firstPurchaseCompleted', false,
      'firstPurchaseAccumulated', 0,
      'creditAccountExists', false,
      'creditEnabled', false,
      'creditStatus', null,
      'creditUsable', false,
      'creditLimit', null,
      'creditUsed', null,
      'creditAvailable', null,
      'creditTermsDays', null,
      'commercialVersion', null,
      'contextToken', context_token,
      'reasonCode', null,
      'blockCodes', jsonb_build_array(),
      'warningCodes', jsonb_build_array(),
      'pendingLinkEvidence', false,
      'serverTimestamp', now()
    );
  end if;

  select u.active and au.deleted_at is null, r.name
  into actor_active, actor_role
  from public.users u
  join auth.users au on au.id = u.id
  left join public.roles r on r.id = u.role_id
  where u.id = actor_id;

  if not coalesce(actor_active, false) or actor_role is distinct from 'cliente' then
    return jsonb_build_object(
      'status', 'commercial_context_conflict',
      'actorScope', 'authenticated',
      'authenticated', true,
      'accountActive', false,
      'linked', false,
      'userId', actor_id,
      'customerId', null,
      'customerActive', false,
      'priceMode', 'retail',
      'firstPurchaseMinimum', first_purchase_minimum,
      'commercialVersion', null,
      'contextToken', null,
      'reasonCode', 'CHECKOUT_COMMERCIAL_CONTEXT_CONFLICT',
      'serverTimestamp', now()
    );
  end if;

  select count(*)::integer
  into customer_count
  from public.customers c
  where c.user_id = actor_id;

  if customer_count = 0 then
    return jsonb_build_object(
      'status', 'commercial_context_conflict',
      'actorScope', 'authenticated',
      'authenticated', true,
      'accountActive', true,
      'linked', false,
      'userId', actor_id,
      'customerId', null,
      'customerActive', false,
      'priceMode', 'retail',
      'firstPurchaseMinimum', first_purchase_minimum,
      'commercialVersion', null,
      'contextToken', public.checkout_hash_text_v1(
        'checkout-commercial-context:v2:' || actor_id::text || ':unlinked'
      ),
      'reasonCode', 'CHECKOUT_CUSTOMER_LINK_REQUIRED',
      'serverTimestamp', now()
    );
  elsif customer_count <> 1 then
    return jsonb_build_object(
      'status', 'commercial_context_conflict',
      'actorScope', 'authenticated',
      'authenticated', true,
      'accountActive', true,
      'linked', false,
      'userId', actor_id,
      'customerId', null,
      'customerActive', false,
      'priceMode', 'retail',
      'firstPurchaseMinimum', first_purchase_minimum,
      'commercialVersion', null,
      'contextToken', null,
      'reasonCode', 'CHECKOUT_COMMERCIAL_CONTEXT_CONFLICT',
      'serverTimestamp', now()
    );
  end if;

  select *
  into customer_row
  from public.customers c
  where c.user_id = actor_id;

  if not customer_row.active or customer_row.status <> 'active' then
    reason_code := 'CHECKOUT_COMMERCIAL_CONTEXT_CONFLICT';
    context_status := 'commercial_context_conflict';
  elsif customer_row.is_wholesale
        and customer_row.wholesale_status = 'approved' then
    effective_mode := 'wholesale';
    context_status := 'authenticated_wholesale';
  else
    context_status := 'authenticated_retail';
  end if;

  select count(*)::integer
  into credit_count
  from public.customer_credit_accounts a
  where a.customer_id = customer_row.id;

  if credit_count = 1 then
    select *
    into credit_row
    from public.customer_credit_accounts a
    where a.customer_id = customer_row.id;

    select
      coalesce(sum(r.balance_due) filter (
        where r.status in ('open', 'partial', 'overdue')
      ), 0),
      coalesce(sum(r.balance_due) filter (
        where r.status = 'overdue'
           or (r.status in ('open', 'partial') and r.due_date < current_date)
      ), 0)
    into used_credit, overdue_balance
    from public.accounts_receivable r
    where r.customer_id = customer_row.id;

    available_credit := greatest(round(credit_row.credit_limit - used_credit, 2), 0);
    credit_usable :=
      customer_row.active
      and customer_row.status = 'active'
      and credit_row.is_credit_enabled
      and credit_row.status = 'active';

    if credit_usable then
      context_status := 'authenticated_credit';
    end if;
  elsif credit_count > 1 then
    credit_usable := false;
    reason_code := 'CHECKOUT_COMMERCIAL_CONTEXT_CONFLICT';
    context_status := 'commercial_context_conflict';
  end if;

  select coalesce(sum(o.total), 0)
  into accumulated_wholesale
  from public.orders o
  where o.customer_id = customer_row.id
    and o.price_mode = 'wholesale'
    and o.status::text not in ('cancelado', 'cancelled');

  context_token := public.checkout_sha256_v1(jsonb_build_object(
    'contract', 'checkout-commercial-context:v2',
    'user_id', actor_id,
    'customer_id', customer_row.id,
    'price_mode', effective_mode,
    'commercial_version', customer_row.commercial_version,
    'wholesale_status', customer_row.wholesale_status,
    'credit_status', case when credit_count = 1 then credit_row.status else null end,
    'credit_enabled', case when credit_count = 1 then credit_row.is_credit_enabled else false end,
    'credit_limit', case when credit_count = 1 then credit_row.credit_limit else null end,
    'credit_terms_days', case when credit_count = 1 then credit_row.terms_days else null end
  ));

  return jsonb_build_object(
    'status', context_status,
    'actorScope', 'authenticated',
    'authenticated', true,
    'accountActive', true,
    'linked', true,
    'userId', actor_id,
    'customerId', customer_row.id,
    'customerActive', customer_row.active and customer_row.status = 'active',
    'priceMode', effective_mode,
    'wholesaleStatus', customer_row.wholesale_status,
    'wholesaleCustomerType', customer_row.wholesale_customer_type,
    'firstPurchaseRequired',
      customer_row.wholesale_customer_type = 'new'
      and not customer_row.wholesale_first_purchase_completed,
    'firstPurchaseMinimum', first_purchase_minimum,
    'firstPurchaseCompleted',
      customer_row.wholesale_customer_type = 'existing'
      or customer_row.wholesale_first_purchase_completed,
    'firstPurchaseAccumulated', round(accumulated_wholesale, 2),
    'creditAccountExists', credit_count = 1,
    'creditEnabled', case when credit_count = 1 then credit_row.is_credit_enabled else false end,
    'creditStatus', case when credit_count = 1 then credit_row.status else null end,
    'creditUsable', credit_usable,
    'creditLimit', case when credit_count = 1 then credit_row.credit_limit else null end,
    'creditUsed', case when credit_count = 1 then round(used_credit, 2) else null end,
    'creditAvailable', case when credit_count = 1 then available_credit else null end,
    'creditTermsDays', case when credit_count = 1 then credit_row.terms_days else null end,
    'overdueBalance', case when credit_count = 1 then round(overdue_balance, 2) else null end,
    'commercialVersion', customer_row.commercial_version,
    'contextToken', context_token,
    'reasonCode', reason_code,
    'blockCodes', case
      when reason_code is null then jsonb_build_array()
      else jsonb_build_array(reason_code)
    end,
    'warningCodes', case
      when overdue_balance > 0 then jsonb_build_array('CREDIT_OVERDUE_WARNING')
      else jsonb_build_array()
    end,
    'pendingLinkEvidence', false,
    'serverTimestamp', now()
  );
end;
$$;

revoke all on function public.resolve_portal_commercial_context_v2(boolean) from public;
grant execute on function public.resolve_portal_commercial_context_v2(boolean)
  to anon, authenticated, service_role;

comment on function public.resolve_portal_commercial_context_v2(boolean) is
  'Strict portal commercial authority. A database or linkage failure is never represented as a guest context.';

create or replace function public.resolve_checkout_cart_v4(
  p_cart_items jsonb,
  p_guest_intent boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_items jsonb := public.checkout_normalize_items_v4(p_cart_items);
  context_row jsonb := public.resolve_portal_commercial_context_v2(p_guest_intent);
  effective_mode public.order_price_mode;
  expected_count integer := jsonb_array_length(normalized_items);
  resolved_lines jsonb;
  cart_fingerprint text;
begin
  if context_row->>'status' in ('commercial_context_unavailable', 'commercial_context_conflict') then
    return jsonb_build_object(
      'ok', false,
      'code', coalesce(context_row->>'reasonCode', 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE'),
      'context', context_row
    );
  end if;

  effective_mode := (context_row->>'priceMode')::public.order_price_mode;

  if (
    select count(*)
    from jsonb_array_elements(normalized_items) item(value)
    join public.products p on p.id = (item.value->>'product_id')::uuid
    where p.active and p.status = 'active'
  ) <> expected_count then
    return jsonb_build_object(
      'ok', false,
      'code', 'CHECKOUT_PRODUCT_UNAVAILABLE',
      'context', context_row
    );
  end if;

  if effective_mode = 'wholesale' and exists (
    select 1
    from jsonb_array_elements(normalized_items) item(value)
    join public.products p on p.id = (item.value->>'product_id')::uuid
    where p.wholesale_price <= 0
       or p.wholesale_price >= p.retail_price
  ) then
    return jsonb_build_object(
      'ok', false,
      'code', 'CHECKOUT_WHOLESALE_PRICE_UNAVAILABLE',
      'context', context_row,
      'affectedProducts', (
        select coalesce(jsonb_agg(jsonb_build_object('productId', p.id, 'name', p.name) order by p.id), '[]'::jsonb)
        from jsonb_array_elements(normalized_items) item(value)
        join public.products p on p.id = (item.value->>'product_id')::uuid
        where p.wholesale_price <= 0
           or p.wholesale_price >= p.retail_price
      )
    );
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'productId', p.id,
      'variantId', null,
      'sku', p.sku,
      'name', p.name,
      'quantity', (item.value->>'quantity')::integer,
      'productSalesVersion', p.product_sales_version,
      'availableStock', greatest(p.stock - p.reserved_stock, 0),
      'retailPriceSnapshot', round(p.retail_price, 2),
      'wholesalePriceSnapshot', round(p.wholesale_price, 2),
      'appliedPriceMode', effective_mode,
      'unitPrice', round(
        case when effective_mode = 'wholesale' then p.wholesale_price else p.retail_price end,
        2
      ),
      'lineTotal', round(
        (case when effective_mode = 'wholesale' then p.wholesale_price else p.retail_price end)
        * (item.value->>'quantity')::integer,
        2
      ),
      'wholesaleMinimumQuantity', p.wholesale_min_quantity,
      'taxCategory', p.tax_category
    )
    order by p.id
  )
  into resolved_lines
  from jsonb_array_elements(normalized_items) item(value)
  join public.products p on p.id = (item.value->>'product_id')::uuid;

  cart_fingerprint := public.checkout_sha256_v1(jsonb_build_object(
    'contract', 'checkout-cart:v4',
    'currency', 'HNL',
    'fiscal_calculation_version', 1,
    'actor_scope', context_row->>'actorScope',
    'user_id', context_row->>'userId',
    'customer_id', context_row->>'customerId',
    'price_mode', effective_mode,
    'commercial_version', context_row->>'commercialVersion',
    'context_token', context_row->>'contextToken',
    'lines', resolved_lines
  ));

  return jsonb_build_object(
    'ok', true,
    'code', null,
    'context', context_row,
    'cartFingerprint', cart_fingerprint,
    'lines', resolved_lines,
    'currency', 'HNL',
    'fiscalCalculationVersion', 1,
    'calculatedAt', now(),
    'expiresAt', now() + interval '20 minutes'
  );
end;
$$;

revoke all on function public.resolve_checkout_cart_v4(jsonb, boolean) from public;
grant execute on function public.resolve_checkout_cart_v4(jsonb, boolean)
  to anon, authenticated, service_role;

create or replace function public.checkout_request_fingerprint_v4(
  p_request_key uuid,
  p_actor_scope text,
  p_user_id uuid,
  p_customer_id uuid,
  p_price_mode public.order_price_mode,
  p_commercial_version integer,
  p_context_token text,
  p_cart_fingerprint text,
  p_cart_items jsonb,
  p_customer_data jsonb,
  p_delivery_data jsonb,
  p_payment_method public.payment_method,
  p_payment_timing text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.checkout_sha256_v1(jsonb_build_object(
    'contract', 'create-checkout-order:v4',
    'request_key', p_request_key,
    'actor_scope', p_actor_scope,
    'user_id', p_user_id,
    'customer_id', p_customer_id,
    'price_mode', p_price_mode,
    'commercial_version', p_commercial_version,
    'context_token', p_context_token,
    'cart_fingerprint', p_cart_fingerprint,
    'cart_items', public.checkout_normalize_items_v4(p_cart_items),
    'customer', jsonb_build_object(
      'name', trim(coalesce(p_customer_data->>'name', '')),
      'email', lower(trim(coalesce(p_customer_data->>'email', ''))),
      'phone', regexp_replace(coalesce(p_customer_data->>'phone', ''), '[^0-9+]', '', 'g'),
      'rtn', upper(trim(coalesce(p_customer_data->>'rtn', ''))),
      'email_updates_opt_in', coalesce((p_customer_data->>'email_updates_opt_in')::boolean, false)
    ),
    'delivery', jsonb_build_object(
      'country', trim(coalesce(p_delivery_data->>'country', '')),
      'country_code', upper(trim(coalesce(p_delivery_data->>'country_code', ''))),
      'department', trim(coalesce(p_delivery_data->>'department', '')),
      'city', trim(coalesce(p_delivery_data->>'city', '')),
      'address', trim(regexp_replace(coalesce(p_delivery_data->>'address', ''), '\s+', ' ', 'g')),
      'mode', trim(coalesce(p_delivery_data->>'mode', 'home_delivery'))
    ),
    'payment_method', p_payment_method,
    'payment_timing', p_payment_timing,
    'bank_reference_hash', case
      when nullif(trim(coalesce(p_customer_data->>'bank_reference', '')), '') is null then null
      else public.checkout_hash_text_v1(trim(p_customer_data->>'bank_reference'))
    end,
    'currency', 'HNL',
    'fiscal_calculation_version', 1
  ));
$$;

revoke all on function public.checkout_request_fingerprint_v4(
  uuid, text, uuid, uuid, public.order_price_mode, integer, text, text,
  jsonb, jsonb, jsonb, public.payment_method, text
) from public, anon, authenticated;
grant execute on function public.checkout_request_fingerprint_v4(
  uuid, text, uuid, uuid, public.order_price_mode, integer, text, text,
  jsonb, jsonb, jsonb, public.payment_method, text
) to service_role;

create or replace function public.begin_checkout_request_v1(
  p_request_key uuid,
  p_recovery_token text,
  p_expected_actor_scope text,
  p_expected_context_token text,
  p_expected_commercial_version integer,
  p_cart_fingerprint text,
  p_cart_items jsonb,
  p_customer_data jsonb,
  p_delivery_data jsonb,
  p_payment_method public.payment_method,
  p_payment_timing text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  guest_intent boolean := p_expected_actor_scope = 'guest';
  context_result jsonb;
  actor_scope_value text;
  customer_id_value uuid;
  price_mode_value public.order_price_mode;
  version_value integer;
  context_token_value text;
  fingerprint_value text;
  recovery_hash text;
  saved public.checkout_requests_v4%rowtype;
begin
  if p_request_key is null
     or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid
     or p_expected_actor_scope not in ('guest', 'authenticated')
     or p_cart_fingerprint !~ '^[0-9a-f]{64}$'
     or p_payment_timing not in ('before_delivery', 'on_delivery') then
    raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
  end if;

  if actor_id is null and p_expected_actor_scope = 'authenticated' then
    return jsonb_build_object(
      'ok', false,
      'status', 'failed_final',
      'code', 'CHECKOUT_SESSION_REQUIRED',
      'retryAllowed', true
    );
  elsif actor_id is not null and p_expected_actor_scope <> 'authenticated' then
    return jsonb_build_object(
      'ok', false,
      'status', 'conflict',
      'code', 'CHECKOUT_REQUEST_CONFLICT',
      'retryAllowed', false
    );
  end if;

  context_result := public.resolve_portal_commercial_context_v2(guest_intent);
  if context_result->>'status' in ('commercial_context_unavailable', 'commercial_context_conflict') then
    return jsonb_build_object(
      'ok', false,
      'status', 'failed_final',
      'code', coalesce(context_result->>'reasonCode', 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE'),
      'retryAllowed', context_result->>'reasonCode' in (
        'CHECKOUT_SESSION_REQUIRED',
        'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE'
      )
    );
  end if;

  actor_scope_value := context_result->>'actorScope';
  customer_id_value := nullif(context_result->>'customerId', '')::uuid;
  price_mode_value := (context_result->>'priceMode')::public.order_price_mode;
  version_value := nullif(context_result->>'commercialVersion', '')::integer;
  context_token_value := context_result->>'contextToken';

  if context_token_value is distinct from nullif(trim(coalesce(p_expected_context_token, '')), '')
     or version_value is distinct from p_expected_commercial_version then
    return jsonb_build_object(
      'ok', false,
      'status', 'failed_retryable',
      'code', 'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED',
      'retryAllowed', true
    );
  end if;

  if actor_scope_value = 'guest' then
    if char_length(coalesce(p_recovery_token, '')) < 32
       or char_length(coalesce(p_recovery_token, '')) > 256 then
      raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
    end if;
    recovery_hash := public.checkout_hash_text_v1(p_recovery_token);
  elsif nullif(p_recovery_token, '') is not null then
    recovery_hash := public.checkout_hash_text_v1(p_recovery_token);
  end if;

  fingerprint_value := public.checkout_request_fingerprint_v4(
    p_request_key,
    actor_scope_value,
    actor_id,
    customer_id_value,
    price_mode_value,
    version_value,
    context_token_value,
    p_cart_fingerprint,
    p_cart_items,
    p_customer_data,
    p_delivery_data,
    p_payment_method,
    p_payment_timing
  );

  insert into public.checkout_requests_v4(
    request_key,
    request_fingerprint,
    recovery_token_hash,
    actor_scope,
    user_id,
    customer_id,
    expected_price_mode,
    commercial_version,
    context_token_hash,
    cart_fingerprint,
    status,
    expires_at
  )
  values (
    p_request_key,
    fingerprint_value,
    recovery_hash,
    actor_scope_value,
    actor_id,
    customer_id_value,
    price_mode_value,
    version_value,
    public.checkout_hash_text_v1(context_token_value),
    p_cart_fingerprint,
    'started',
    now() + interval '24 hours'
  )
  on conflict (request_key) do nothing;

  select *
  into saved
  from public.checkout_requests_v4
  where request_key = p_request_key
  for update;

  if saved.actor_scope <> actor_scope_value
     or saved.user_id is distinct from actor_id
     or saved.request_fingerprint <> fingerprint_value
     or saved.cart_fingerprint <> p_cart_fingerprint then
    if saved.status not in ('committed', 'expired') then
      update public.checkout_requests_v4
      set status = 'conflict',
          error_code = 'CHECKOUT_REQUEST_CONFLICT',
          failed_at = now(),
          updated_at = now()
      where id = saved.id;
    end if;

    return jsonb_build_object(
      'ok', false,
      'status', 'conflict',
      'code', 'CHECKOUT_REQUEST_CONFLICT',
      'retryAllowed', false
    );
  end if;

  if saved.actor_scope = 'guest'
     and saved.recovery_token_hash <> recovery_hash then
    return jsonb_build_object(
      'ok', false,
      'status', 'conflict',
      'code', 'CHECKOUT_REQUEST_CONFLICT',
      'retryAllowed', false
    );
  end if;

  if saved.status = 'committed' then
    return jsonb_build_object(
      'ok', true,
      'status', 'committed',
      'replayed', true,
      'requestFingerprint', saved.request_fingerprint,
      'orderNumber', saved.order_number,
      'trackingCode', saved.tracking_code,
      'priceMode', saved.price_mode,
      'total', saved.total,
      'createdAt', saved.committed_at,
      'retryAllowed', false
    );
  end if;

  if saved.status = 'expired' or saved.expires_at <= now() then
    update public.checkout_requests_v4
    set status = 'expired',
        error_code = 'CHECKOUT_REQUEST_EXPIRED',
        failed_at = coalesce(failed_at, now()),
        updated_at = now()
    where id = saved.id;

    return jsonb_build_object(
      'ok', false,
      'status', 'expired',
      'code', 'CHECKOUT_REQUEST_EXPIRED',
      'retryAllowed', false
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', saved.status,
    'replayed', false,
    'requestFingerprint', saved.request_fingerprint,
    'priceMode', saved.expected_price_mode,
    'retryAllowed', true
  );
end;
$$;

create or replace function public.create_checkout_order_v4(
  p_request_key uuid,
  p_request_fingerprint text,
  p_expected_context_token text,
  p_expected_commercial_version integer,
  p_cart_fingerprint text,
  p_cart_items jsonb,
  p_customer_data jsonb,
  p_delivery_data jsonb,
  p_payment_method public.payment_method,
  p_payment_timing text,
  p_payment_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  request_row public.checkout_requests_v4%rowtype;
  context_result jsonb;
  cart_result jsonb;
  normalized_items jsonb;
  effective_mode public.order_price_mode;
  customer_row public.customers%rowtype;
  customer_id_value uuid;
  guest_lock_key text;
  normalized_name text := trim(coalesce(p_customer_data->>'name', ''));
  normalized_email text := lower(trim(coalesce(p_customer_data->>'email', '')));
  normalized_phone text := regexp_replace(coalesce(p_customer_data->>'phone', ''), '[^0-9+]', '', 'g');
  normalized_rtn text := nullif(upper(trim(coalesce(p_customer_data->>'rtn', ''))), '');
  normalized_address text := trim(regexp_replace(coalesce(p_delivery_data->>'address', ''), '\s+', ' ', 'g'));
  normalized_department text := trim(coalesce(p_delivery_data->>'department', ''));
  normalized_city text := trim(coalesce(p_delivery_data->>'city', ''));
  normalized_payment_timing text;
  normalized_bank_reference text := nullif(trim(coalesce(p_payment_data->>'bank_reference', '')), '');
  product_record record;
  line_record record;
  resolved_lines jsonb;
  settings_row public.company_settings%rowtype;
  financials jsonb;
  merchandise_gross numeric(12,2);
  shipping_amount numeric(12,2);
  fiscal_subtotal numeric(12,2);
  tax_amount numeric(12,2);
  total_amount numeric(12,2);
  reservation_deadline timestamptz;
  new_order_id uuid := gen_random_uuid();
  new_order_number text;
  new_tracking_code text;
  credit_row public.customer_credit_accounts%rowtype;
  credit_count integer := 0;
  open_credit numeric(12,2) := 0;
  receivable_id uuid;
  result_payload jsonb;
  inserted_line public.order_items%rowtype;
begin
  if p_request_key is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_cart_fingerprint !~ '^[0-9a-f]{64}$'
     or p_payment_timing not in ('before_delivery', 'on_delivery')
     or jsonb_typeof(coalesce(p_payment_data, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
  end if;

  if not exists (
    select 1
    from public.checkout_feature_flags
    where key = 'checkout_order_v4' and enabled
  ) then
    raise exception using errcode = '55000', message = 'CHECKOUT_V4_DISABLED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('checkout-v4:' || p_request_key::text, 0));

  select *
  into request_row
  from public.checkout_requests_v4
  where request_key = p_request_key
  for update;

  if request_row.id is null then
    raise exception using errcode = 'P0002', message = 'CHECKOUT_REQUEST_NOT_FOUND';
  end if;

  if request_row.request_fingerprint <> p_request_fingerprint
     or request_row.cart_fingerprint <> p_cart_fingerprint then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_REQUEST_CONFLICT';
  end if;

  if request_row.actor_scope = 'authenticated' then
    if actor_id is null then
      raise exception using errcode = '42501', message = 'CHECKOUT_SESSION_REQUIRED';
    elsif actor_id <> request_row.user_id then
      raise exception using errcode = '42501', message = 'CHECKOUT_REQUEST_FORBIDDEN';
    end if;
  elsif actor_id is not null then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_REQUEST_CONFLICT';
  end if;

  if request_row.status = 'committed' then
    return jsonb_build_object(
      'ok', true,
      'status', 'committed',
      'replayed', true,
      'requestStatus', 'committed',
      'orderNumber', request_row.order_number,
      'trackingCode', request_row.tracking_code,
      'createdAt', request_row.committed_at,
      'priceMode', request_row.price_mode,
      'total', request_row.total,
      'emailStatus', 'queued'
    );
  end if;

  if request_row.status in ('conflict', 'expired', 'failed_final') then
    raise exception using
      errcode = 'PT409',
      message = coalesce(request_row.error_code, 'CHECKOUT_REQUEST_CONFLICT');
  end if;

  if request_row.expires_at <= now() then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_REQUEST_EXPIRED';
  end if;

  update public.checkout_requests_v4
  set status = 'processing',
      processing_at = now(),
      error_code = null,
      failed_at = null,
      updated_at = now()
  where id = request_row.id;

  context_result := public.resolve_portal_commercial_context_v2(request_row.actor_scope = 'guest');
  if context_result->>'status' in ('commercial_context_unavailable', 'commercial_context_conflict') then
    raise exception using
      errcode = 'PT409',
      message = coalesce(context_result->>'reasonCode', 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE');
  end if;

  if context_result->>'actorScope' <> request_row.actor_scope
     or nullif(context_result->>'userId', '')::uuid is distinct from request_row.user_id
     or nullif(context_result->>'customerId', '')::uuid is distinct from request_row.customer_id
     or (context_result->>'priceMode')::public.order_price_mode is distinct from request_row.expected_price_mode
     or nullif(context_result->>'commercialVersion', '')::integer is distinct from p_expected_commercial_version
     or context_result->>'contextToken' is distinct from p_expected_context_token
     or request_row.commercial_version is distinct from p_expected_commercial_version
     or request_row.context_token_hash is distinct from public.checkout_hash_text_v1(p_expected_context_token) then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED';
  end if;

  effective_mode := request_row.expected_price_mode;
  normalized_items := public.checkout_normalize_items_v4(p_cart_items);

  if request_row.actor_scope = 'authenticated' then
    select *
    into customer_row
    from public.customers
    where id = request_row.customer_id
      and user_id = actor_id
    for update;

    if customer_row.id is null
       or not customer_row.active
       or customer_row.status <> 'active'
       or customer_row.commercial_version is distinct from p_expected_commercial_version then
      raise exception using errcode = 'PT409', message = 'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED';
    end if;
    customer_id_value := customer_row.id;
  else
    if normalized_name = ''
       or normalized_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       or normalized_phone = ''
       or normalized_address = '' then
      raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
    end if;

    guest_lock_key := normalized_email || ':' || normalized_phone;
    perform pg_advisory_xact_lock(hashtextextended('checkout-v4-guest:' || guest_lock_key, 0));

    select *
    into customer_row
    from public.customers c
    where c.user_id is null
      and lower(trim(coalesce(c.email, ''))) = normalized_email
      and regexp_replace(coalesce(c.phone, ''), '[^0-9+]', '', 'g') = normalized_phone
      and c.active
      and c.status = 'active'
    order by c.created_at, c.id
    limit 1
    for update;

    if customer_row.id is null then
      insert into public.customers(
        user_id,
        contact_name,
        email,
        phone,
        tax_id,
        address,
        city,
        is_wholesale,
        wholesale_status,
        active,
        status,
        lead_status,
        source,
        notes
      )
      values (
        null,
        normalized_name,
        normalized_email,
        normalized_phone,
        normalized_rtn,
        normalized_address,
        nullif(normalized_city, ''),
        false,
        'none',
        true,
        'active',
        'cliente',
        'checkout_v4_guest',
        '[CHECKOUT_V4_INVITADO] Cliente operativo sin cuenta vinculada'
      )
      returning * into customer_row;
    end if;
    customer_id_value := customer_row.id;
  end if;

  if p_payment_method = 'commercial_credit' then
    if request_row.actor_scope <> 'authenticated' then
      raise exception using errcode = '42501', message = 'CREDIT_NOT_AVAILABLE';
    end if;

    select count(*)::integer
    into credit_count
    from public.customer_credit_accounts a
    where a.customer_id = customer_id_value;

    if credit_count <> 1 then
      raise exception using errcode = '42501', message = 'CREDIT_NOT_AVAILABLE';
    end if;

    select *
    into credit_row
    from public.customer_credit_accounts a
    where a.customer_id = customer_id_value
    for update;

    if not credit_row.is_credit_enabled or credit_row.status <> 'active' then
      raise exception using errcode = '42501', message = 'CREDIT_NOT_AVAILABLE';
    end if;
  end if;

  -- Deterministic product lock order. No price is accepted from the browser.
  for product_record in
    select p.id
    from jsonb_array_elements(normalized_items) item(value)
    join public.products p on p.id = (item.value->>'product_id')::uuid
    order by p.id
    for update of p
  loop
    null;
  end loop;

  cart_result := public.resolve_checkout_cart_v4(
    normalized_items,
    request_row.actor_scope = 'guest'
  );

  if coalesce((cart_result->>'ok')::boolean, false) is not true then
    raise exception using
      errcode = 'PT409',
      message = coalesce(cart_result->>'code', 'CHECKOUT_TEMPORARILY_UNAVAILABLE');
  end if;

  if cart_result->>'cartFingerprint' <> p_cart_fingerprint then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_PRICE_CHANGED';
  end if;

  resolved_lines := cart_result->'lines';

  if exists (
    select 1
    from jsonb_array_elements(resolved_lines) line(value)
    where (line.value->>'quantity')::integer > (line.value->>'availableStock')::integer
  ) then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_STOCK_CHANGED';
  end if;

  if effective_mode = 'wholesale' and exists (
    select 1
    from jsonb_array_elements(resolved_lines) line(value)
    where (line.value->>'quantity')::integer
      < greatest((line.value->>'wholesaleMinimumQuantity')::integer, 1)
  ) then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_WHOLESALE_MINIMUM_QUANTITY';
  end if;

  select *
  into settings_row
  from public.company_settings
  order by created_at
  limit 1;

  if effective_mode = 'wholesale' and not coalesce(settings_row.wholesale_purchases_enabled, true) then
    raise exception using errcode = '55000', message = 'WHOLESALE_NOT_AVAILABLE';
  end if;

  if p_payment_method = 'bank_transfer' and not coalesce(settings_row.allow_bank_transfer, true) then
    raise exception using errcode = '55000', message = 'CHECKOUT_PAYMENT_METHOD_UNAVAILABLE';
  elsif p_payment_method = 'cash' and not coalesce(settings_row.allow_cash_on_delivery, true) then
    raise exception using errcode = '55000', message = 'CHECKOUT_PAYMENT_METHOD_UNAVAILABLE';
  end if;

  normalized_payment_timing := case
    when p_payment_method = 'cash' then 'on_delivery'
    when p_payment_method in ('card', 'commercial_credit') then 'before_delivery'
    when p_payment_timing = 'on_delivery' then 'on_delivery'
    else 'before_delivery'
  end;

  if p_payment_method = 'bank_transfer'
     and normalized_payment_timing = 'before_delivery'
     and normalized_bank_reference is null then
    raise exception using errcode = '22023', message = 'CHECKOUT_BANK_REFERENCE_REQUIRED';
  end if;

  select coalesce(sum((line.value->>'lineTotal')::numeric), 0)
  into merchandise_gross
  from jsonb_array_elements(resolved_lines) line(value);

  shipping_amount := case
    when merchandise_gross >= coalesce(settings_row.free_shipping_threshold, 3000) then 0
    else coalesce(settings_row.standard_shipping_fee, 120)
  end;

  financials := public.calculate_sale_financials_v1(
    (
      select jsonb_agg(jsonb_build_object(
        'quantity', (line.value->>'quantity')::integer,
        'unit_price', (line.value->>'unitPrice')::numeric,
        'discount_amount', 0
      ) order by line.value->>'productId')
      from jsonb_array_elements(resolved_lines) line(value)
    ),
    coalesce(settings_row.tax_rate, 0.15),
    0,
    shipping_amount,
    0,
    0,
    '[]'::jsonb,
    coalesce(settings_row.first_wholesale_minimum, 10000),
    coalesce(settings_row.free_shipping_threshold, 3000),
    coalesce(settings_row.standard_shipping_fee, 120),
    'home_delivery',
    case
      when effective_mode = 'retail' then 'retail'
      when customer_row.wholesale_customer_type = 'existing'
        or customer_row.wholesale_first_purchase_completed then 'wholesale_existing'
      else 'wholesale_candidate'
    end,
    'HNL'
  );

  if effective_mode = 'wholesale'
     and customer_row.wholesale_customer_type = 'new'
     and not customer_row.wholesale_first_purchase_completed
     and coalesce((financials->>'meets_wholesale_minimum')::boolean, false) is not true then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_WHOLESALE_FIRST_MINIMUM';
  end if;

  fiscal_subtotal := (financials->>'fiscal_subtotal')::numeric;
  tax_amount := (financials->>'included_tax_total')::numeric;
  total_amount := (financials->>'total_final')::numeric;
  reservation_deadline := now() + make_interval(
    mins => greatest(coalesce(settings_row.stock_reservation_minutes, 2880), 15)
  );

  if p_payment_method = 'commercial_credit' then
    select coalesce(sum(r.balance_due), 0)
    into open_credit
    from public.accounts_receivable r
    where r.customer_id = customer_id_value
      and r.status in ('open', 'partial', 'overdue');

    if round(open_credit + total_amount, 2) > credit_row.credit_limit then
      raise exception using errcode = 'PT409', message = 'CHECKOUT_CREDIT_LIMIT_EXCEEDED';
    end if;
  end if;

  new_order_number :=
    'CZ-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-'
    || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 6));

  insert into public.orders(
    id,
    order_number,
    user_id,
    customer_id,
    customer_name,
    email,
    phone,
    customer_phone,
    delivery_address,
    delivery_country,
    delivery_country_code,
    delivery_department,
    delivery_city,
    delivery_mode,
    payment_method,
    payment_timing,
    price_mode,
    subtotal,
    tax,
    shipping_total,
    shipping_fee,
    cash_on_delivery_fee,
    small_order_fee,
    discount_total,
    additional_fees,
    total,
    status,
    tracking_status,
    public_tracking_enabled,
    order_reservation_status,
    reservation_expires_at,
    reservation_review_required,
    reservation_review_detected_at,
    email_updates_opt_in,
    email_updates_preference_source,
    email_updates_updated_at,
    fiscal_customer_name,
    fiscal_customer_rtn,
    fiscal_customer_phone,
    fiscal_customer_email,
    fiscal_customer_address,
    source,
    channel,
    calculation_version,
    commercial_terms_version
  )
  values (
    new_order_id,
    new_order_number,
    actor_id,
    customer_id_value,
    normalized_name,
    normalized_email,
    normalized_phone,
    normalized_phone,
    normalized_address,
    'Honduras',
    'HN',
    normalized_department,
    normalized_city,
    'car_zone',
    p_payment_method,
    normalized_payment_timing,
    effective_mode,
    fiscal_subtotal,
    tax_amount,
    shipping_amount,
    shipping_amount,
    0,
    0,
    0,
    '[]'::jsonb,
    total_amount,
    'pending',
    'recibido',
    true,
    'reserved',
    reservation_deadline,
    p_payment_method = 'cash',
    case when p_payment_method = 'cash' then now() else null end,
    coalesce((p_customer_data->>'email_updates_opt_in')::boolean, false),
    'checkout',
    now(),
    coalesce(nullif(trim(customer_row.business_name), ''), normalized_name),
    coalesce(normalized_rtn, customer_row.tax_id),
    normalized_phone,
    normalized_email,
    normalized_address,
    'web',
    'website',
    1,
    0
  )
  returning tracking_code into new_tracking_code;

  for line_record in
    select line.value
    from jsonb_array_elements(resolved_lines) line(value)
    order by line.value->>'productId'
  loop
    insert into public.order_items(
      order_id,
      product_id,
      sku,
      product_name,
      quantity,
      applied_price_mode,
      unit_price,
      line_total,
      retail_price_snapshot,
      wholesale_price_snapshot
    )
    values (
      new_order_id,
      (line_record.value->>'productId')::uuid,
      line_record.value->>'sku',
      line_record.value->>'name',
      (line_record.value->>'quantity')::integer,
      effective_mode,
      (line_record.value->>'unitPrice')::numeric,
      (line_record.value->>'lineTotal')::numeric,
      (line_record.value->>'retailPriceSnapshot')::numeric,
      (line_record.value->>'wholesalePriceSnapshot')::numeric
    )
    returning * into inserted_line;

    if inserted_line.applied_price_mode <> effective_mode
       or inserted_line.unit_price <> (line_record.value->>'unitPrice')::numeric
       or inserted_line.line_total <> (line_record.value->>'lineTotal')::numeric then
      raise exception using errcode = 'PT409', message = 'CHECKOUT_PRICE_CHANGED';
    end if;

    insert into public.inventory_reservations(
      order_id,
      product_id,
      quantity,
      status,
      expires_at
    )
    values (
      new_order_id,
      inserted_line.product_id,
      inserted_line.quantity,
      'reserved',
      reservation_deadline
    );

    update public.products
    set reserved_stock = reserved_stock + inserted_line.quantity,
        updated_at = now()
    where id = inserted_line.product_id
      and stock - reserved_stock >= inserted_line.quantity;

    if not found then
      raise exception using errcode = 'PT409', message = 'CHECKOUT_STOCK_CHANGED';
    end if;
  end loop;

  insert into public.payments(
    order_id,
    customer_id,
    method,
    payment_method,
    status,
    payment_status,
    amount,
    payment_timing,
    reference,
    bank_reference_number,
    provider,
    transfer_receipt_url,
    transfer_receipt_public_id,
    transfer_receipt_resource_type,
    transfer_receipt_delivery_type,
    transfer_receipt_format,
    transfer_receipt_original_filename,
    transfer_receipt_uploaded_at
  )
  values (
    new_order_id,
    customer_id_value,
    p_payment_method,
    p_payment_method,
    'pending',
    'pending',
    total_amount,
    normalized_payment_timing,
    case
      when p_payment_method = 'commercial_credit' then null
      when p_payment_method = 'bank_transfer' then normalized_bank_reference
      else null
    end,
    case when p_payment_method = 'bank_transfer' then normalized_bank_reference else null end,
    case when p_payment_method = 'card' then 'manual_payment_link' else null end,
    null,
    nullif(p_payment_data->>'receipt_public_id', ''),
    nullif(p_payment_data->>'receipt_resource_type', ''),
    nullif(p_payment_data->>'receipt_delivery_type', ''),
    nullif(p_payment_data->>'receipt_format', ''),
    nullif(p_payment_data->>'receipt_original_filename', ''),
    case when nullif(p_payment_data->>'receipt_public_id', '') is not null then now() else null end
  );

  if p_payment_method = 'commercial_credit' then
    insert into public.accounts_receivable(
      customer_id,
      order_id,
      original_amount,
      balance_due,
      due_date,
      status
    )
    values (
      customer_id_value,
      new_order_id,
      total_amount,
      total_amount,
      current_date + credit_row.terms_days,
      'open'
    )
    returning id into receivable_id;
  end if;

  insert into public.email_queue(
    to_email,
    to_name,
    subject,
    template_key,
    payload,
    status,
    scheduled_at,
    related_module,
    related_id,
    priority,
    max_attempts,
    idempotency_key
  )
  values (
    normalized_email,
    normalized_name,
    'Pedido recibido - Car Zone Accesorios',
    'customer.order_received',
    jsonb_build_object(
      'title', 'Hemos recibido tu pedido',
      'message', 'Hemos recibido tu pedido. Nuestro equipo lo revisara pronto.',
      'order_number', new_order_number,
      'customer_name', normalized_name,
      'status', 'Recibido',
      'amount', total_amount,
      'action_path', '/rastreo?codigo=' || new_tracking_code,
      'action_label', 'Rastrear pedido'
    ),
    'pending',
    now(),
    'pedidos',
    new_order_id,
    4,
    4,
    'checkout-v4:customer-order-received:' || new_order_id::text || ':' || public.checkout_hash_text_v1(normalized_email)
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing;

  insert into public.audit_logs(
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    new_data
  )
  values (
    actor_id,
    case when actor_id is null then 'guest' else 'cliente' end,
    'orders',
    new_order_id,
    'checkout_v4.order_committed',
    jsonb_build_object(
      'request_key_hash', public.checkout_hash_text_v1(p_request_key::text),
      'price_mode', effective_mode,
      'commercial_version', p_expected_commercial_version,
      'line_count', jsonb_array_length(resolved_lines),
      'total', total_amount,
      'payment_method', p_payment_method,
      'email_queued', true
    )
  );

  result_payload := jsonb_build_object(
    'ok', true,
    'status', 'committed',
    'replayed', false,
    'requestStatus', 'committed',
    'orderNumber', new_order_number,
    'trackingCode', new_tracking_code,
    'createdAt', now(),
    'priceMode', effective_mode,
    'subtotal', fiscal_subtotal,
    'tax', tax_amount,
    'shipping', shipping_amount,
    'total', total_amount,
    'emailStatus', 'queued'
  );

  update public.checkout_requests_v4
  set status = 'committed',
      order_id = new_order_id,
      order_number = new_order_number,
      tracking_code = new_tracking_code,
      price_mode = effective_mode,
      total = total_amount,
      committed_at = now(),
      error_code = null,
      updated_at = now()
  where id = request_row.id;

  return result_payload;
end;
$$;

create or replace function public.mark_checkout_request_failed_v1(
  p_request_key uuid,
  p_request_fingerprint text,
  p_recovery_token text,
  p_error_code text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  saved public.checkout_requests_v4%rowtype;
  safe_code text := upper(trim(coalesce(p_error_code, 'CHECKOUT_TEMPORARILY_UNAVAILABLE')));
begin
  if safe_code not in (
    'CHECKOUT_SESSION_REQUIRED',
    'CHECKOUT_CUSTOMER_LINK_REQUIRED',
    'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE',
    'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED',
    'CHECKOUT_PRICE_CHANGED',
    'CHECKOUT_STOCK_CHANGED',
    'CHECKOUT_WHOLESALE_PRICE_UNAVAILABLE',
    'CHECKOUT_WHOLESALE_MINIMUM_QUANTITY',
    'CHECKOUT_WHOLESALE_FIRST_MINIMUM',
    'CHECKOUT_REQUEST_CONFLICT',
    'CHECKOUT_REQUEST_EXPIRED',
    'CHECKOUT_CREDIT_LIMIT_EXCEEDED',
    'CHECKOUT_PAYMENT_METHOD_UNAVAILABLE',
    'CHECKOUT_BANK_REFERENCE_REQUIRED',
    'CHECKOUT_PRODUCT_UNAVAILABLE',
    'CHECKOUT_TEMPORARILY_UNAVAILABLE'
  ) then
    safe_code := 'CHECKOUT_TEMPORARILY_UNAVAILABLE';
  end if;

  select *
  into saved
  from public.checkout_requests_v4
  where request_key = p_request_key
  for update;

  if saved.id is null or saved.request_fingerprint <> p_request_fingerprint then
    return jsonb_build_object('ok', false, 'code', 'CHECKOUT_REQUEST_NOT_FOUND');
  end if;

  if saved.actor_scope = 'authenticated' then
    if actor_id is null or actor_id <> saved.user_id then
      return jsonb_build_object('ok', false, 'code', 'CHECKOUT_REQUEST_FORBIDDEN');
    end if;
  elsif saved.recovery_token_hash <> public.checkout_hash_text_v1(coalesce(p_recovery_token, '')) then
    return jsonb_build_object('ok', false, 'code', 'CHECKOUT_REQUEST_FORBIDDEN');
  end if;

  if saved.status = 'committed' then
    return jsonb_build_object(
      'ok', true,
      'status', 'committed',
      'replayed', true,
      'orderNumber', saved.order_number,
      'trackingCode', saved.tracking_code,
      'priceMode', saved.price_mode,
      'total', saved.total,
      'createdAt', saved.committed_at,
      'retryAllowed', false
    );
  end if;

  update public.checkout_requests_v4
  set status = case
        when safe_code = 'CHECKOUT_REQUEST_CONFLICT' then 'conflict'
        when safe_code = 'CHECKOUT_REQUEST_EXPIRED' then 'expired'
        when coalesce(p_retryable, false) then 'failed_retryable'
        else 'failed_final'
      end,
      error_code = safe_code,
      failed_at = now(),
      updated_at = now()
  where id = saved.id;

  return jsonb_build_object(
    'ok', true,
    'status', case
      when safe_code = 'CHECKOUT_REQUEST_CONFLICT' then 'conflict'
      when safe_code = 'CHECKOUT_REQUEST_EXPIRED' then 'expired'
      when coalesce(p_retryable, false) then 'failed_retryable'
      else 'failed_final'
    end,
    'code', safe_code,
    'retryAllowed', coalesce(p_retryable, false)
  );
end;
$$;

create or replace function public.get_checkout_request_status_v1(
  p_request_key uuid,
  p_recovery_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  saved public.checkout_requests_v4%rowtype;
begin
  select *
  into saved
  from public.checkout_requests_v4
  where request_key = p_request_key;

  if saved.id is null then
    return jsonb_build_object(
      'status', 'failed_retryable',
      'code', 'CHECKOUT_REQUEST_NOT_FOUND',
      'retryAllowed', true
    );
  end if;

  if saved.actor_scope = 'authenticated' then
    if actor_id is null or actor_id <> saved.user_id then
      raise exception using errcode = '42501', message = 'CHECKOUT_REQUEST_FORBIDDEN';
    end if;
  elsif saved.recovery_token_hash <> public.checkout_hash_text_v1(coalesce(p_recovery_token, '')) then
    raise exception using errcode = '42501', message = 'CHECKOUT_REQUEST_FORBIDDEN';
  end if;

  if saved.expires_at <= now()
     and saved.status not in ('committed', 'expired') then
    update public.checkout_requests_v4
    set status = 'expired',
        error_code = 'CHECKOUT_REQUEST_EXPIRED',
        failed_at = coalesce(failed_at, now()),
        updated_at = now()
    where id = saved.id;
    saved.status := 'expired';
    saved.error_code := 'CHECKOUT_REQUEST_EXPIRED';
  end if;

  update public.checkout_requests_v4
  set last_checked_at = now(),
      updated_at = now()
  where id = saved.id;

  return jsonb_build_object(
    'status', saved.status,
    'replayed', saved.status = 'committed',
    'orderNumber', case when saved.status = 'committed' then saved.order_number else null end,
    'trackingCode', case when saved.status = 'committed' then saved.tracking_code else null end,
    'createdAt', case when saved.status = 'committed' then saved.committed_at else saved.started_at end,
    'priceMode', case when saved.status = 'committed' then saved.price_mode else saved.expected_price_mode end,
    'total', case when saved.status = 'committed' then saved.total else null end,
    'errorCode', saved.error_code,
    'retryAllowed', saved.status in ('started', 'processing', 'failed_retryable'),
    'expiresAt', saved.expires_at
  );
end;
$$;

create or replace function public.get_checkout_feature_flag_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'key', key,
    'enabled', enabled,
    'version', version,
    'updatedAt', updated_at
  )
  from public.checkout_feature_flags
  where key = 'checkout_order_v4';
$$;

create or replace function public.set_checkout_feature_flag_v1(
  p_enabled boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  role_claim text := current_setting('request.jwt.claim.role', true);
  updated public.checkout_feature_flags%rowtype;
begin
  if role_claim is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'CHECKOUT_FEATURE_FLAG_FORBIDDEN';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) < 10
     or char_length(trim(coalesce(p_reason, ''))) > 500 then
    raise exception using errcode = '22023', message = 'CHECKOUT_FEATURE_FLAG_REASON_INVALID';
  end if;

  update public.checkout_feature_flags
  set enabled = coalesce(p_enabled, false),
      enabled_at = case when coalesce(p_enabled, false) then now() else null end,
      version = version + 1,
      reason = trim(p_reason),
      updated_at = now()
  where key = 'checkout_order_v4'
  returning * into updated;

  insert into public.audit_logs(actor_role, table_name, action, new_data)
  values (
    'service_role',
    'checkout_feature_flags',
    'checkout_v4.feature_flag_changed',
    jsonb_build_object(
      'key', updated.key,
      'enabled', updated.enabled,
      'version', updated.version,
      'reason', updated.reason
    )
  );

  return jsonb_build_object(
    'key', updated.key,
    'enabled', updated.enabled,
    'version', updated.version,
    'updatedAt', updated.updated_at
  );
end;
$$;

revoke all on function public.begin_checkout_request_v1(
  uuid, text, text, text, integer, text, jsonb, jsonb, jsonb,
  public.payment_method, text
) from public;
grant execute on function public.begin_checkout_request_v1(
  uuid, text, text, text, integer, text, jsonb, jsonb, jsonb,
  public.payment_method, text
) to anon, authenticated, service_role;

revoke all on function public.create_checkout_order_v4(
  uuid, text, text, integer, text, jsonb, jsonb, jsonb,
  public.payment_method, text, jsonb
) from public;
grant execute on function public.create_checkout_order_v4(
  uuid, text, text, integer, text, jsonb, jsonb, jsonb,
  public.payment_method, text, jsonb
) to anon, authenticated, service_role;

revoke all on function public.mark_checkout_request_failed_v1(
  uuid, text, text, text, boolean
) from public;
grant execute on function public.mark_checkout_request_failed_v1(
  uuid, text, text, text, boolean
) to anon, authenticated, service_role;

revoke all on function public.get_checkout_request_status_v1(uuid, text) from public;
grant execute on function public.get_checkout_request_status_v1(uuid, text)
  to anon, authenticated, service_role;

revoke all on function public.get_checkout_feature_flag_v1() from public;
grant execute on function public.get_checkout_feature_flag_v1()
  to anon, authenticated, service_role;

revoke all on function public.set_checkout_feature_flag_v1(boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_checkout_feature_flag_v1(boolean, text)
  to service_role;

comment on table public.checkout_requests_v4 is
  'Durable checkout request ledger. It stores hashes and sanitized outcomes, never the raw cart, address, bank reference or recovery secret.';
comment on function public.create_checkout_order_v4(
  uuid, text, text, integer, text, jsonb, jsonb, jsonb,
  public.payment_method, text, jsonb
) is
  'Direct atomic checkout. It derives prices under deterministic locks and never invokes a legacy retail-first checkout wrapper.';
