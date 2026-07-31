-- Checkout V4 recovery, sanitized observability and retention controls.
-- Prospective only: no existing economic record is changed.

create table public.checkout_observability_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.checkout_requests_v4(id) on delete cascade,
  event_name text not null check (
    event_name in (
      'checkout_request_started',
      'checkout_request_processing',
      'checkout_order_committed',
      'checkout_response_built',
      'checkout_response_recovered',
      'checkout_confirmation_shown',
      'checkout_request_replayed',
      'checkout_request_conflict',
      'checkout_context_unavailable',
      'checkout_session_lost',
      'checkout_price_changed',
      'checkout_stock_changed',
      'checkout_email_queued',
      'checkout_email_failed'
    )
  ),
  request_key_hash text not null check (request_key_hash ~ '^[0-9a-f]{64}$'),
  deployment_id text,
  commit_sha text,
  actor_scope text not null check (actor_scope in ('guest', 'authenticated')),
  user_id_hash text check (user_id_hash is null or user_id_hash ~ '^[0-9a-f]{64}$'),
  customer_id_hash text check (customer_id_hash is null or customer_id_hash ~ '^[0-9a-f]{64}$'),
  expected_tier public.order_price_mode,
  resolved_tier public.order_price_mode,
  commercial_version integer,
  line_count integer check (line_count is null or line_count between 0 and 100),
  total numeric(12,2) check (total is null or total >= 0),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 3600000),
  status text,
  error_code text,
  replay boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  check (deployment_id is null or char_length(deployment_id) <= 160),
  check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,64}$'),
  check (status is null or char_length(status) <= 80),
  check (error_code is null or error_code ~ '^[A-Z0-9_]{3,100}$')
);

create index checkout_observability_request_created_idx
  on public.checkout_observability_events(request_id, created_at desc);
create index checkout_observability_event_created_idx
  on public.checkout_observability_events(event_name, created_at desc);
create unique index checkout_observability_confirmation_once_idx
  on public.checkout_observability_events(request_id, event_name)
  where event_name = 'checkout_confirmation_shown';

alter table public.checkout_observability_events enable row level security;
revoke all on public.checkout_observability_events from public, anon, authenticated;
grant select, insert, update, delete on public.checkout_observability_events to service_role;

create or replace function public.checkout_request_state_observer_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_value text;
begin
  event_value := case
    when tg_op = 'INSERT' then 'checkout_request_started'
    when new.status = 'processing' and old.status is distinct from new.status
      then 'checkout_request_processing'
    when new.status = 'committed' and old.status is distinct from new.status
      then 'checkout_order_committed'
    when new.status = 'conflict' and old.status is distinct from new.status
      then 'checkout_request_conflict'
    when new.error_code = 'CHECKOUT_SESSION_REQUIRED'
      and old.error_code is distinct from new.error_code then 'checkout_session_lost'
    when new.error_code = 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE'
      and old.error_code is distinct from new.error_code then 'checkout_context_unavailable'
    when new.error_code = 'CHECKOUT_PRICE_CHANGED'
      and old.error_code is distinct from new.error_code then 'checkout_price_changed'
    when new.error_code = 'CHECKOUT_STOCK_CHANGED'
      and old.error_code is distinct from new.error_code then 'checkout_stock_changed'
    else null
  end;

  if event_value is not null then
    insert into public.checkout_observability_events(
      request_id,
      event_name,
      request_key_hash,
      actor_scope,
      user_id_hash,
      customer_id_hash,
      expected_tier,
      resolved_tier,
      commercial_version,
      total,
      status,
      error_code,
      replay,
      metadata
    )
    values (
      new.id,
      event_value,
      public.checkout_hash_text_v1(new.request_key::text),
      new.actor_scope,
      case when new.user_id is null then null else public.checkout_hash_text_v1(new.user_id::text) end,
      case when new.customer_id is null then null else public.checkout_hash_text_v1(new.customer_id::text) end,
      new.expected_price_mode,
      new.price_mode,
      new.commercial_version,
      new.total,
      new.status,
      new.error_code,
      false,
      jsonb_build_object('contract', 'checkout-observability:v1')
    );

    if event_value = 'checkout_order_committed' then
      insert into public.checkout_observability_events(
        request_id,
        event_name,
        request_key_hash,
        actor_scope,
        user_id_hash,
        customer_id_hash,
        expected_tier,
        resolved_tier,
        commercial_version,
        total,
        status,
        replay,
        metadata
      )
      values (
        new.id,
        'checkout_email_queued',
        public.checkout_hash_text_v1(new.request_key::text),
        new.actor_scope,
        case when new.user_id is null then null else public.checkout_hash_text_v1(new.user_id::text) end,
        case when new.customer_id is null then null else public.checkout_hash_text_v1(new.customer_id::text) end,
        new.expected_price_mode,
        new.price_mode,
        new.commercial_version,
        new.total,
        new.status,
        false,
        jsonb_build_object('queue', 'email_queue')
      );
    end if;
  end if;

  return new;
end;
$$;

create trigger checkout_requests_v4_observe_state
after insert or update of status, error_code
on public.checkout_requests_v4
for each row execute function public.checkout_request_state_observer_v1();

create or replace function public.checkout_v4_observe_email_failure_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.checkout_requests_v4%rowtype;
begin
  if new.status <> 'failed'
     or old.status = 'failed'
     or coalesce(new.idempotency_key, '') not like 'checkout-v4:customer-order-received:%' then
    return new;
  end if;

  select * into saved
  from public.checkout_requests_v4
  where order_id = new.related_id;

  if saved.id is not null then
    insert into public.checkout_observability_events(
      request_id, event_name, request_key_hash, actor_scope,
      user_id_hash, customer_id_hash, expected_tier, resolved_tier,
      commercial_version, total, status, error_code, replay, metadata
    ) values (
      saved.id,
      'checkout_email_failed',
      public.checkout_hash_text_v1(saved.request_key::text),
      saved.actor_scope,
      case when saved.user_id is null then null else public.checkout_hash_text_v1(saved.user_id::text) end,
      case when saved.customer_id is null then null else public.checkout_hash_text_v1(saved.customer_id::text) end,
      saved.expected_price_mode,
      saved.price_mode,
      saved.commercial_version,
      saved.total,
      saved.status,
      'CHECKOUT_EMAIL_FAILED',
      false,
      jsonb_build_object(
        'queue_id_hash', public.checkout_hash_text_v1(new.id::text),
        'attempts', new.attempts,
        'max_attempts', new.max_attempts
      )
    );
  end if;

  return new;
end;
$$;

create trigger email_queue_observe_checkout_v4_failure
after update of status on public.email_queue
for each row execute function public.checkout_v4_observe_email_failure_v1();

create or replace function public.record_checkout_browser_event_v1(
  p_request_key uuid,
  p_recovery_token text,
  p_event_name text,
  p_deployment_id text default null,
  p_commit_sha text default null,
  p_duration_ms integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  saved public.checkout_requests_v4%rowtype;
  inserted_id uuid;
begin
  if p_event_name not in (
    'checkout_response_built',
    'checkout_response_recovered',
    'checkout_confirmation_shown',
    'checkout_request_replayed'
  ) then
    raise exception using errcode = '22023', message = 'CHECKOUT_OBSERVABILITY_EVENT_INVALID';
  end if;

  select *
  into saved
  from public.checkout_requests_v4
  where request_key = p_request_key;

  if saved.id is null then
    raise exception using errcode = 'P0002', message = 'CHECKOUT_REQUEST_NOT_FOUND';
  end if;

  if saved.actor_scope = 'authenticated' then
    if actor_id is null or actor_id <> saved.user_id then
      raise exception using errcode = '42501', message = 'CHECKOUT_REQUEST_FORBIDDEN';
    end if;
  elsif saved.recovery_token_hash <> public.checkout_hash_text_v1(coalesce(p_recovery_token, '')) then
    raise exception using errcode = '42501', message = 'CHECKOUT_REQUEST_FORBIDDEN';
  end if;

  if p_event_name in ('checkout_response_built', 'checkout_response_recovered', 'checkout_confirmation_shown')
     and saved.status <> 'committed' then
    raise exception using errcode = '22023', message = 'CHECKOUT_OBSERVABILITY_STATE_INVALID';
  end if;

  insert into public.checkout_observability_events(
    request_id,
    event_name,
    request_key_hash,
    deployment_id,
    commit_sha,
    actor_scope,
    user_id_hash,
    customer_id_hash,
    expected_tier,
    resolved_tier,
    commercial_version,
    total,
    duration_ms,
    status,
    replay,
    metadata
  )
  values (
    saved.id,
    p_event_name,
    public.checkout_hash_text_v1(saved.request_key::text),
    nullif(left(trim(coalesce(p_deployment_id, '')), 160), ''),
    case
      when nullif(lower(trim(coalesce(p_commit_sha, ''))), '') ~ '^[0-9a-f]{7,64}$'
        then lower(trim(p_commit_sha))
      else null
    end,
    saved.actor_scope,
    case when saved.user_id is null then null else public.checkout_hash_text_v1(saved.user_id::text) end,
    case when saved.customer_id is null then null else public.checkout_hash_text_v1(saved.customer_id::text) end,
    saved.expected_price_mode,
    saved.price_mode,
    saved.commercial_version,
    saved.total,
    p_duration_ms,
    saved.status,
    p_event_name in ('checkout_response_recovered', 'checkout_request_replayed'),
    jsonb_build_object('source', 'browser')
  )
  on conflict (request_id, event_name)
    where event_name = 'checkout_confirmation_shown'
  do nothing
  returning id into inserted_id;

  if p_event_name = 'checkout_confirmation_shown' then
    update public.checkout_requests_v4
    set confirmation_shown_at = coalesce(confirmation_shown_at, now()),
        updated_at = now()
    where id = saved.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'recorded', inserted_id is not null,
    'event', p_event_name
  );
end;
$$;

create or replace function public.cleanup_checkout_v4_retention_v1()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  role_claim text := current_setting('request.jwt.claim.role', true);
  expired_count integer := 0;
  deleted_events integer := 0;
  deleted_requests integer := 0;
begin
  if role_claim is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'CHECKOUT_RETENTION_FORBIDDEN';
  end if;

  update public.checkout_requests_v4
  set status = 'expired',
      error_code = 'CHECKOUT_REQUEST_EXPIRED',
      failed_at = coalesce(failed_at, now()),
      updated_at = now()
  where expires_at < now()
    and status in ('started', 'processing', 'failed_retryable');
  get diagnostics expired_count = row_count;

  delete from public.checkout_observability_events
  where created_at < now() - interval '90 days';
  get diagnostics deleted_events = row_count;

  delete from public.checkout_requests_v4
  where created_at < now() - interval '30 days'
    and status in ('failed_final', 'conflict', 'expired')
    and order_id is null;
  get diagnostics deleted_requests = row_count;

  return jsonb_build_object(
    'expired', expired_count,
    'deletedEvents', deleted_events,
    'deletedRequests', deleted_requests
  );
end;
$$;

revoke all on function public.record_checkout_browser_event_v1(
  uuid, text, text, text, text, integer
) from public;
grant execute on function public.record_checkout_browser_event_v1(
  uuid, text, text, text, text, integer
) to anon, authenticated, service_role;

revoke all on function public.cleanup_checkout_v4_retention_v1()
  from public, anon, authenticated;
grant execute on function public.cleanup_checkout_v4_retention_v1()
  to service_role;

comment on table public.checkout_observability_events is
  'Sanitized Checkout V4 telemetry. Request, user and customer identifiers are hashed; PII and raw payloads are forbidden.';
