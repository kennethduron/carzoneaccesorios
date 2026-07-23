-- Point of Sale phase 1 foundation only.
-- This migration does not create sales, payments, invoices, receivables,
-- inventory movements, financial events, or journal entries.

alter table public.orders
  add column if not exists source text not null default 'web',
  add column if not exists channel text not null default 'website',
  add column if not exists created_by uuid references public.users(id) on delete restrict,
  add column if not exists seller_id uuid references public.users(id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_source_check'
  ) then
    alter table public.orders
      add constraint orders_source_check
      check (source in ('web', 'pos', 'manual')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_channel_check'
  ) then
    alter table public.orders
      add constraint orders_channel_check
      check (channel in ('website', 'store', 'whatsapp', 'phone', 'other')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_origin_actor_consistency_check'
  ) then
    alter table public.orders
      add constraint orders_origin_actor_consistency_check
      check (
        (source = 'web' and channel = 'website' and created_by is null)
        or (source = 'pos' and channel <> 'website' and created_by is not null)
        or (source = 'manual' and created_by is not null)
      ) not valid;
  end if;
end;
$$;

alter table public.orders validate constraint orders_source_check;
alter table public.orders validate constraint orders_channel_check;
alter table public.orders validate constraint orders_origin_actor_consistency_check;

comment on column public.orders.source is
  'Order origin. web is public checkout, pos is the future internal atomic sale flow, and manual is another authorized internal flow.';
comment on column public.orders.channel is
  'Commercial channel, independent from payment method and delivery mode.';
comment on column public.orders.created_by is
  'Administrative actor that created an internal order. Never replaces orders.user_id, which remains the portal buyer.';
comment on column public.orders.seller_id is
  'Nullable future seller attribution. Phase 1 adds no commission, goal, shift, or salesperson behavior.';

create index if not exists orders_internal_source_created_at_idx
  on public.orders (source, created_at desc)
  where source <> 'web';

create index if not exists orders_internal_channel_created_at_idx
  on public.orders (channel, created_at desc)
  where source <> 'web';

create index if not exists orders_created_by_created_at_idx
  on public.orders (created_by, created_at desc)
  where created_by is not null;

create or replace function public.protect_order_origin_metadata()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (
    new.source is distinct from old.source
    or new.channel is distinct from old.channel
    or new.created_by is distinct from old.created_by
    or new.seller_id is distinct from old.seller_id
  ) and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'La metadata de origen del pedido solo puede cambiar dentro de una operacion interna autorizada.';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_order_origin_metadata_on_update on public.orders;
create trigger protect_order_origin_metadata_on_update
before update of source, channel, created_by, seller_id on public.orders
for each row
execute function public.protect_order_origin_metadata();

comment on function public.protect_order_origin_metadata() is
  'Prevents direct authenticated updates from rewriting order provenance. Security-definer business RPCs must derive created_by from auth.uid().';

-- Permissions remain role JSON entries because that is the current authorization model.
update public.roles
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || '["pos:create_sale", "pos:apply_discount"]'::jsonb
    ) as expanded(permission)
  ) deduplicated
),
updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = (coalesce(permissions, '[]'::jsonb) - 'pos:create_sale') - 'pos:apply_discount',
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
    and permission_key in ('pos:create_sale', 'pos:apply_discount')
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission(permission_key);
$$;

revoke all on function public.pos_permission_allowed(text) from public, anon;
grant execute on function public.pos_permission_allowed(text) to authenticated;

comment on function public.pos_permission_allowed(text) is
  'Database-side POS permission gate. The role allowlist and explicit permission must both pass.';

create table if not exists public.pos_idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null,
  operation text not null,
  actor_id uuid not null references public.users(id) on delete restrict,
  actor_role text not null,
  payload_hash text not null,
  status text not null default 'processing',
  result jsonb,
  safe_error jsonb,
  attempt_count integer not null default 1,
  processing_started_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pos_idempotency_operation_length_check
    check (char_length(trim(operation)) between 1 and 120),
  constraint pos_idempotency_request_key_non_nil_check
    check (request_key <> '00000000-0000-0000-0000-000000000000'::uuid),
  constraint pos_idempotency_actor_role_check
    check (actor_role in ('technical_owner', 'business_owner', 'admin')),
  constraint pos_idempotency_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint pos_idempotency_status_check
    check (status in ('processing', 'succeeded', 'failed')),
  constraint pos_idempotency_result_object_check
    check (result is null or jsonb_typeof(result) = 'object'),
  constraint pos_idempotency_error_object_check
    check (safe_error is null or jsonb_typeof(safe_error) = 'object'),
  constraint pos_idempotency_attempt_count_check
    check (attempt_count > 0),
  constraint pos_idempotency_state_shape_check
    check (
      (
        status = 'processing'
        and result is null
        and safe_error is null
        and completed_at is null
        and lease_expires_at is not null
      )
      or (
        status = 'succeeded'
        and result is not null
        and safe_error is null
        and completed_at is not null
        and lease_expires_at is null
      )
      or (
        status = 'failed'
        and result is null
        and safe_error is not null
        and completed_at is not null
        and lease_expires_at is null
      )
    ),
  constraint pos_idempotency_operation_request_key_key unique (operation, request_key)
);

comment on table public.pos_idempotency_requests is
  'Durable POS request ledger. Store only a SHA-256 payload hash, safe result identifiers, and sanitized errors; never raw customer or payment payloads.';
comment on column public.pos_idempotency_requests.payload_hash is
  'Lowercase hexadecimal SHA-256 of the canonical, server-defined request payload.';
comment on column public.pos_idempotency_requests.lease_expires_at is
  'Operational alarm for processing rows. Expiry never authorizes automatic takeover without verifying side effects.';

create index if not exists pos_idempotency_actor_created_at_idx
  on public.pos_idempotency_requests (actor_id, created_at desc);

create index if not exists pos_idempotency_processing_lease_idx
  on public.pos_idempotency_requests (lease_expires_at)
  where status = 'processing';

alter table public.pos_idempotency_requests enable row level security;

revoke all on table public.pos_idempotency_requests from public, anon, authenticated;
grant select, insert, update on table public.pos_idempotency_requests to service_role;

create or replace function public.claim_pos_idempotency_v1(
  target_request_key uuid,
  target_operation text,
  target_payload_hash text
)
returns table (
  request_id uuid,
  request_status text,
  acquired boolean,
  replayed boolean,
  stored_result jsonb,
  stored_error jsonb,
  processing_lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  normalized_operation text := lower(trim(coalesce(target_operation, '')));
  normalized_hash text := lower(trim(coalesce(target_payload_hash, '')));
  inserted_count integer := 0;
  stored public.pos_idempotency_requests%rowtype;
begin
  if not public.pos_permission_allowed('pos:create_sale') then
    raise exception using errcode = '42501', message = 'No tienes permiso para iniciar una operacion de Punto de Venta.';
  end if;

  if target_request_key is null
    or target_request_key = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'La clave de idempotencia no es valida.';
  end if;

  if char_length(normalized_operation) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'La operacion idempotente no es valida.';
  end if;

  if normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'La firma de la solicitud no es valida.';
  end if;

  insert into public.pos_idempotency_requests (
    request_key,
    operation,
    actor_id,
    actor_role,
    payload_hash,
    status,
    lease_expires_at
  )
  values (
    target_request_key,
    normalized_operation,
    actor_user_id,
    actor_role_name,
    normalized_hash,
    'processing',
    now() + interval '5 minutes'
  )
  on conflict (operation, request_key) do nothing;

  get diagnostics inserted_count = row_count;

  select requests.*
  into stored
  from public.pos_idempotency_requests requests
  where requests.operation = normalized_operation
    and requests.request_key = target_request_key
  for update;

  if stored.id is null then
    raise exception using errcode = 'P0001', message = 'No se pudo reservar la solicitud idempotente.';
  end if;

  if stored.actor_id <> actor_user_id then
    raise exception using errcode = '42501', message = 'La clave de idempotencia pertenece a otro actor.';
  end if;

  if stored.payload_hash <> normalized_hash then
    raise exception using errcode = '22023', message = 'La clave de idempotencia ya fue utilizada con datos diferentes.';
  end if;

  if inserted_count = 0 then
    update public.pos_idempotency_requests requests
    set attempt_count = requests.attempt_count + 1,
        last_seen_at = now(),
        updated_at = now()
    where requests.id = stored.id
    returning requests.* into stored;
  end if;

  perform public.write_audit_log(
    'pos_idempotency_requests',
    stored.id,
    case
      when inserted_count = 1 then 'pos.idempotency.processing_started'
      when stored.status = 'succeeded' then 'pos.idempotency.result_replayed'
      when stored.status = 'failed' then 'pos.idempotency.failure_replayed'
      else 'pos.idempotency.processing_requeried'
    end,
    null,
    jsonb_build_object(
      'request_key', stored.request_key,
      'operation', stored.operation,
      'status', stored.status,
      'attempt_count', stored.attempt_count
    )
  );

  request_id := stored.id;
  request_status := stored.status;
  acquired := inserted_count = 1;
  replayed := inserted_count = 0;
  stored_result := stored.result;
  stored_error := stored.safe_error;
  processing_lease_expires_at := stored.lease_expires_at;
  return next;
end;
$$;

create or replace function public.complete_pos_idempotency_v1(
  target_request_key uuid,
  target_operation text,
  target_payload_hash text,
  safe_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  normalized_operation text := lower(trim(coalesce(target_operation, '')));
  normalized_hash text := lower(trim(coalesce(target_payload_hash, '')));
  stored public.pos_idempotency_requests%rowtype;
begin
  if not public.pos_permission_allowed('pos:create_sale') then
    raise exception using errcode = '42501', message = 'No tienes permiso para completar una operacion de Punto de Venta.';
  end if;

  if safe_result is null or jsonb_typeof(safe_result) <> 'object' then
    raise exception using errcode = '22023', message = 'El resultado idempotente no es valido.';
  end if;

  select requests.* into stored
  from public.pos_idempotency_requests requests
  where requests.operation = normalized_operation
    and requests.request_key = target_request_key
  for update;

  if stored.id is null or stored.actor_id <> actor_user_id or stored.payload_hash <> normalized_hash then
    raise exception using errcode = '22023', message = 'La solicitud idempotente no coincide con la operacion actual.';
  end if;

  if stored.status = 'failed' then
    raise exception using errcode = '22023', message = 'La solicitud idempotente ya finalizo con error.';
  end if;

  if stored.status = 'succeeded' then
    if stored.result <> safe_result then
      raise exception using errcode = '22023', message = 'El resultado idempotente existente no coincide.';
    end if;
    return stored.result;
  end if;

  update public.pos_idempotency_requests requests
  set status = 'succeeded',
      result = safe_result,
      safe_error = null,
      lease_expires_at = null,
      completed_at = now(),
      last_seen_at = now(),
      updated_at = now()
  where requests.id = stored.id
  returning requests.result into safe_result;

  perform public.write_audit_log(
    'pos_idempotency_requests',
    stored.id,
    'pos.idempotency.succeeded',
    jsonb_build_object('status', stored.status),
    jsonb_build_object('status', 'succeeded', 'request_key', stored.request_key, 'operation', stored.operation)
  );

  return safe_result;
end;
$$;

create or replace function public.fail_pos_idempotency_v1(
  target_request_key uuid,
  target_operation text,
  target_payload_hash text,
  safe_error_code text,
  safe_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  normalized_operation text := lower(trim(coalesce(target_operation, '')));
  normalized_hash text := lower(trim(coalesce(target_payload_hash, '')));
  normalized_error jsonb := jsonb_build_object(
    'code', left(coalesce(nullif(trim(safe_error_code), ''), 'POS_OPERATION_FAILED'), 80),
    'message', left(coalesce(nullif(trim(safe_error_message), ''), 'No se pudo completar la operacion.'), 300)
  );
  stored public.pos_idempotency_requests%rowtype;
begin
  if not public.pos_permission_allowed('pos:create_sale') then
    raise exception using errcode = '42501', message = 'No tienes permiso para cerrar una operacion de Punto de Venta.';
  end if;

  select requests.* into stored
  from public.pos_idempotency_requests requests
  where requests.operation = normalized_operation
    and requests.request_key = target_request_key
  for update;

  if stored.id is null or stored.actor_id <> actor_user_id or stored.payload_hash <> normalized_hash then
    raise exception using errcode = '22023', message = 'La solicitud idempotente no coincide con la operacion actual.';
  end if;

  if stored.status = 'succeeded' then
    raise exception using errcode = '22023', message = 'La solicitud idempotente ya finalizo correctamente.';
  end if;

  if stored.status = 'failed' then
    return stored.safe_error;
  end if;

  update public.pos_idempotency_requests requests
  set status = 'failed',
      result = null,
      safe_error = normalized_error,
      lease_expires_at = null,
      completed_at = now(),
      last_seen_at = now(),
      updated_at = now()
  where requests.id = stored.id;

  perform public.write_audit_log(
    'pos_idempotency_requests',
    stored.id,
    'pos.idempotency.failed',
    jsonb_build_object('status', stored.status),
    jsonb_build_object(
      'status', 'failed',
      'request_key', stored.request_key,
      'operation', stored.operation,
      'error_code', normalized_error->>'code'
    )
  );

  return normalized_error;
end;
$$;

create or replace function public.get_pos_idempotency_status_v1(
  target_request_key uuid,
  target_operation text
)
returns table (
  request_key uuid,
  operation text,
  status text,
  result jsonb,
  safe_error jsonb,
  attempt_count integer,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.pos_permission_allowed('pos:create_sale') then
    raise exception using errcode = '42501', message = 'No tienes permiso para consultar esta operacion de Punto de Venta.';
  end if;

  return query
  select
    requests.request_key,
    requests.operation,
    requests.status,
    requests.result,
    requests.safe_error,
    requests.attempt_count,
    requests.lease_expires_at,
    requests.completed_at,
    requests.created_at,
    requests.updated_at
  from public.pos_idempotency_requests requests
  where requests.actor_id = auth.uid()
    and requests.request_key = target_request_key
    and requests.operation = lower(trim(coalesce(target_operation, '')));
end;
$$;

-- Claim/finalize helpers are deliberately private. The future atomic sale RPC
-- will call them inside its own transaction so a crash rolls back processing.
revoke all on function public.claim_pos_idempotency_v1(uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_pos_idempotency_v1(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_pos_idempotency_v1(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.get_pos_idempotency_status_v1(uuid, text) from public, anon;
grant execute on function public.get_pos_idempotency_status_v1(uuid, text) to authenticated;

comment on function public.claim_pos_idempotency_v1(uuid, text, text) is
  'Private transaction-scoped claim. Same operation/key/payload replays; a different actor or payload is rejected.';
comment on function public.complete_pos_idempotency_v1(uuid, text, text, jsonb) is
  'Private idempotent success finalizer. Result JSON must contain safe identifiers only.';
comment on function public.fail_pos_idempotency_v1(uuid, text, text, text, text) is
  'Private failure finalizer storing only a bounded safe code and message.';
comment on function public.get_pos_idempotency_status_v1(uuid, text) is
  'Authenticated actor-scoped requery for timeout-after-commit recovery.';
