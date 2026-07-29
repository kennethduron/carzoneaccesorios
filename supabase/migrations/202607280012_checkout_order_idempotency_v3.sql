-- Idempotent checkout v3.
-- This wrapper preserves create_checkout_order_v2 (including the pending
-- commercial_credit payment placeholder) and adds a transaction-scoped
-- request contract. The migration itself creates no orders or commercial data.

create table public.checkout_idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  operation text not null check (operation = 'create_checkout_order_v3'),
  actor_user_id uuid references public.users(id) on delete restrict,
  actor_scope_hash text not null check (actor_scope_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  observed_commercial_version integer,
  observed_context_token_hash text,
  status text not null default 'processing' check (status in ('processing', 'succeeded')),
  order_id uuid unique references public.orders(id) on delete restrict,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'processing' and result is null and order_id is null and completed_at is null)
    or (status = 'succeeded' and result is not null and order_id is not null and completed_at is not null)
  )
);

create index checkout_idempotency_actor_created_idx
  on public.checkout_idempotency_requests(actor_scope_hash, created_at desc);

alter table public.checkout_idempotency_requests enable row level security;

create policy "Technical staff can read checkout idempotency"
  on public.checkout_idempotency_requests for select
  using (
    public.current_actor_role() = 'technical_owner'
    and public.has_permission('technical:tools')
  );

grant select on public.checkout_idempotency_requests to authenticated;
grant select, insert, update on public.checkout_idempotency_requests to service_role;

create or replace function public.create_checkout_order_v3(
  p_request_key uuid,
  p_expected_commercial_version integer,
  p_expected_context_token text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_rtn text,
  p_delivery_address text,
  p_requested_price_mode public.order_price_mode,
  p_requested_payment_method public.payment_method,
  p_bank_reference_number text,
  p_order_items jsonb,
  p_wholesale_code text default null,
  p_wholesale_code_id uuid default null,
  p_transfer_receipt_url text default null,
  p_delivery_country text default 'Honduras',
  p_country_code text default 'HN',
  p_delivery_department text default null,
  p_delivery_city text default null,
  p_requested_payment_timing text default null
)
returns table (
  order_id uuid,
  order_number text,
  tracking_code text,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_scope_hash_value text;
  payload_hash_value text;
  context_record jsonb;
  current_context_token text;
  current_commercial_version integer;
  idempotency_record public.checkout_idempotency_requests%rowtype;
  created_order record;
  response_payload jsonb;
  normalized_email text := lower(trim(coalesce(p_customer_email, '')));
  normalized_phone text := regexp_replace(coalesce(p_customer_phone, ''), '[^0-9+]', '', 'g');
begin
  if p_request_key is null
     or p_order_items is null
     or jsonb_typeof(p_order_items) <> 'array'
     or jsonb_array_length(p_order_items) = 0 then
    raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
  end if;

  if actor_id is not null then
    if not exists (
      select 1
      from public.users u
      join public.roles r on r.id = u.role_id
      join auth.users au on au.id = u.id
      where u.id = actor_id
        and u.active
        and r.name = 'cliente'
        and au.deleted_at is null
    ) then
      raise exception using errcode = '42501', message = 'CHECKOUT_CUSTOMER_CHANGED';
    end if;

    actor_scope_hash_value := encode(
      extensions.digest(convert_to('user:' || actor_id::text, 'UTF8'), 'sha256'),
      'hex'
    );
  else
    if normalized_email = '' or normalized_phone = '' then
      raise exception using errcode = '22023', message = 'CHECKOUT_INVALID_INPUT';
    end if;

    actor_scope_hash_value := encode(
      extensions.digest(
        convert_to('guest:' || normalized_email || ':' || normalized_phone, 'UTF8'),
        'sha256'
      ),
      'hex'
    );
  end if;

  payload_hash_value := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_scope', actor_scope_hash_value,
        'operation', 'create_checkout_order_v3',
        'customer_name', trim(coalesce(p_customer_name, '')),
        'customer_email', normalized_email,
        'customer_phone', normalized_phone,
        'customer_rtn', upper(trim(coalesce(p_customer_rtn, ''))),
        'delivery_address', trim(regexp_replace(coalesce(p_delivery_address, ''), '\s+', ' ', 'g')),
        'delivery_country', trim(coalesce(p_delivery_country, '')),
        'country_code', upper(trim(coalesce(p_country_code, ''))),
        'delivery_department', trim(coalesce(p_delivery_department, '')),
        'delivery_city', trim(coalesce(p_delivery_city, '')),
        'price_mode', p_requested_price_mode,
        'payment_method', p_requested_payment_method,
        'payment_timing', p_requested_payment_timing,
        'bank_reference', trim(coalesce(p_bank_reference_number, '')),
        'order_items', p_order_items,
        'wholesale_code', trim(coalesce(p_wholesale_code, '')),
        'wholesale_code_id', p_wholesale_code_id,
        'transfer_receipt_url', trim(coalesce(p_transfer_receipt_url, '')),
        'context_token', nullif(trim(coalesce(p_expected_context_token, '')), ''),
        'commercial_version', p_expected_commercial_version
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- A committed success wins over later commercial-state changes. This is the
  -- essential retry guarantee for first wholesale or credit orders whose own
  -- side effects can legitimately advance the customer's commercial version.
  select *
  into idempotency_record
  from public.checkout_idempotency_requests
  where request_key = p_request_key
  for update;

  if found then
    if idempotency_record.operation <> 'create_checkout_order_v3'
       or idempotency_record.actor_scope_hash <> actor_scope_hash_value
       or idempotency_record.payload_hash <> payload_hash_value then
      raise exception using errcode = 'PT409', message = 'CHECKOUT_IDEMPOTENCY_CONFLICT';
    end if;

    if idempotency_record.status = 'succeeded' then
      order_id := (idempotency_record.result->>'orderId')::uuid;
      order_number := idempotency_record.result->>'orderNumber';
      tracking_code := idempotency_record.result->>'trackingCode';
      idempotent_replay := true;
      return next;
      return;
    end if;
  end if;
  context_record := public.resolve_portal_commercial_context_v1();
  current_context_token := nullif(context_record->>'contextToken', '');
  current_commercial_version := nullif(context_record->>'commercialVersion', '')::integer;

  if actor_id is not null then
    if coalesce(context_record->>'accountActive', 'false')::boolean is not true then
      raise exception using errcode = '42501', message = 'CHECKOUT_CUSTOMER_CHANGED';
    end if;

    if current_context_token is distinct from nullif(trim(coalesce(p_expected_context_token, '')), '')
       or current_commercial_version is distinct from p_expected_commercial_version then
      raise exception using errcode = 'PT409', message = 'COMMERCIAL_CONTEXT_CHANGED';
    end if;
  elsif p_expected_commercial_version is not null
     or nullif(trim(coalesce(p_expected_context_token, '')), '') is not null then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_CUSTOMER_CHANGED';
  end if;

  if p_requested_price_mode::text <> coalesce(context_record->>'effectivePriceMode', 'retail') then
    raise exception using errcode = 'PT409', message = 'COMMERCIAL_CONTEXT_CHANGED';
  end if;

  if p_requested_payment_method = 'commercial_credit' then
    if actor_id is null
       or coalesce(context_record->>'linked', 'false')::boolean is not true
       or coalesce(context_record->>'customerActive', 'false')::boolean is not true
       or coalesce(context_record->>'creditUsable', 'false')::boolean is not true then
      raise exception using errcode = '42501', message = 'CREDIT_NOT_AVAILABLE';
    end if;
  end if;

  insert into public.checkout_idempotency_requests (
    request_key,
    operation,
    actor_user_id,
    actor_scope_hash,
    payload_hash,
    observed_commercial_version,
    observed_context_token_hash
  )
  values (
    p_request_key,
    'create_checkout_order_v3',
    actor_id,
    actor_scope_hash_value,
    payload_hash_value,
    current_commercial_version,
    case
      when current_context_token is null then null
      else encode(
        extensions.digest(convert_to(current_context_token, 'UTF8'), 'sha256'),
        'hex'
      )
    end
  )
  on conflict (request_key) do nothing;

  select *
  into idempotency_record
  from public.checkout_idempotency_requests
  where request_key = p_request_key
  for update;

  if idempotency_record.operation <> 'create_checkout_order_v3'
     or idempotency_record.actor_scope_hash <> actor_scope_hash_value
     or idempotency_record.payload_hash <> payload_hash_value then
    raise exception using errcode = 'PT409', message = 'CHECKOUT_IDEMPOTENCY_CONFLICT';
  end if;

  if idempotency_record.status = 'succeeded' then
    order_id := (idempotency_record.result->>'orderId')::uuid;
    order_number := idempotency_record.result->>'orderNumber';
    tracking_code := idempotency_record.result->>'trackingCode';
    idempotent_replay := true;
    return next;
    return;
  end if;

  select *
  into created_order
  from public.create_checkout_order_v2(
    p_customer_name,
    p_customer_email,
    p_customer_phone,
    p_customer_rtn,
    p_delivery_address,
    p_requested_price_mode,
    p_requested_payment_method,
    p_bank_reference_number,
    p_order_items,
    p_wholesale_code,
    p_wholesale_code_id,
    p_transfer_receipt_url,
    p_delivery_country,
    p_country_code,
    p_delivery_department,
    p_delivery_city,
    p_requested_payment_timing
  )
  limit 1;

  if created_order.order_id is null then
    raise exception using errcode = 'P0001', message = 'CHECKOUT_INTERNAL_ERROR';
  end if;

  response_payload := jsonb_build_object(
    'orderId', created_order.order_id,
    'orderNumber', created_order.order_number,
    'trackingCode', created_order.tracking_code
  );

  update public.checkout_idempotency_requests
  set status = 'succeeded',
      order_id = created_order.order_id,
      result = response_payload,
      completed_at = now(),
      updated_at = now()
  where request_key = p_request_key;

  order_id := created_order.order_id;
  order_number := created_order.order_number;
  tracking_code := created_order.tracking_code;
  idempotent_replay := false;
  return next;
end;
$$;

revoke all on function public.create_checkout_order_v3(
  uuid, integer, text, text, text, text, text, text,
  public.order_price_mode, public.payment_method, text, jsonb,
  text, uuid, text, text, text, text, text, text
) from public;
grant execute on function public.create_checkout_order_v3(
  uuid, integer, text, text, text, text, text, text,
  public.order_price_mode, public.payment_method, text, jsonb,
  text, uuid, text, text, text, text, text, text
) to anon, authenticated, service_role;

comment on function public.create_checkout_order_v3(
  uuid, integer, text, text, text, text, text, text,
  public.order_price_mode, public.payment_method, text, jsonb,
  text, uuid, text, text, text, text, text, text
) is
  'Idempotent transaction wrapper around checkout v2. Revalidates auth-linked commercial context and preserves existing payment/receivable behavior.';
