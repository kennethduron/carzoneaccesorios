-- Wholesale approval/direct grant v1.
-- Separates commercial approval from portal-account linking. This migration
-- creates contracts only; it never approves, links, or rewrites a customer.

do $$
begin
  if exists (
    select 1
    from public.customers c
    where
      (c.wholesale_status = 'approved' and (
        not c.is_wholesale
        or not c.active
        or c.status <> 'active'
        or c.wholesale_approved_at is null
      ))
      or (c.is_wholesale and c.wholesale_status <> 'approved')
      or (
        c.wholesale_first_purchase_completed_at is not null
        and not c.wholesale_first_purchase_completed
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'WHOLESALE_HISTORICAL_STATE_AMBIGUOUS';
  end if;
end;
$$;

alter table public.customers
  drop constraint if exists customers_active_wholesale_requires_user_id,
  drop constraint if exists customers_wholesale_requires_email,
  drop constraint if exists customers_wholesale_requires_company_name;

-- A customer created directly in CRM has no request source. Historical rows
-- are preserved exactly; only future rows may keep this evidence nullable.
alter table public.customers
  alter column wholesale_request_source drop default,
  alter column wholesale_request_source drop not null;

alter table public.customers
  drop constraint if exists customers_wholesale_approval_consistency_check,
  drop constraint if exists customers_wholesale_approved_customer_active_check,
  drop constraint if exists customers_wholesale_first_purchase_timestamp_check;

alter table public.customers
  add constraint customers_wholesale_approval_consistency_check
    check (is_wholesale = (wholesale_status = 'approved')) not valid,
  add constraint customers_wholesale_approved_customer_active_check
    check (
      wholesale_status <> 'approved'
      or (
        active
        and status = 'active'
        and wholesale_approved_at is not null
      )
    ) not valid,
  add constraint customers_wholesale_first_purchase_timestamp_check
    check (
      wholesale_first_purchase_completed
      or wholesale_first_purchase_completed_at is null
    ) not valid;

alter table public.customers
  validate constraint customers_wholesale_approval_consistency_check;
alter table public.customers
  validate constraint customers_wholesale_approved_customer_active_check;
alter table public.customers
  validate constraint customers_wholesale_first_purchase_timestamp_check;

comment on constraint customers_wholesale_approval_consistency_check on public.customers is
  'Commercial wholesale approval is authoritative and does not require a linked portal user.';

create table public.wholesale_access_history (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  operation text not null
    check (operation in ('approve_request', 'direct_grant', 'change_type', 'reject', 'suspend', 'reactivate')),
  source text not null
    check (source in ('customer_request', 'admin_direct_grant')),
  previous_status text not null
    check (previous_status in ('none', 'pending', 'approved', 'rejected', 'suspended')),
  new_status text not null
    check (new_status in ('none', 'pending', 'approved', 'rejected', 'suspended')),
  previous_type text not null check (previous_type in ('new', 'existing')),
  new_type text not null check (new_type in ('new', 'existing')),
  had_pending_request boolean not null,
  requested_at timestamptz,
  approved_at timestamptz,
  actor_user_id uuid not null references public.users(id) on delete restrict,
  actor_role text not null check (actor_role in ('technical_owner', 'business_owner', 'admin')),
  reason text,
  previous_commercial_version integer not null check (previous_commercial_version >= 0),
  new_commercial_version integer not null check (new_commercial_version > previous_commercial_version),
  first_purchase_required boolean not null,
  first_purchase_minimum numeric(12, 2) not null check (first_purchase_minimum >= 0),
  request_key uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (request_key),
  unique (customer_id, new_commercial_version)
);

create index wholesale_access_history_customer_created_idx
  on public.wholesale_access_history(customer_id, created_at desc);

alter table public.wholesale_access_history enable row level security;

create policy "Authorized staff can read wholesale access history"
  on public.wholesale_access_history for select
  using (
    public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('wholesale:manage')
  );

grant select on public.wholesale_access_history to authenticated;
grant select, insert on public.wholesale_access_history to service_role;

create or replace function public.prevent_wholesale_history_mutation_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception using errcode = '42501', message = 'WHOLESALE_HISTORY_APPEND_ONLY';
end;
$$;

create trigger prevent_wholesale_history_update_trigger
before update or delete on public.wholesale_access_history
for each row execute function public.prevent_wholesale_history_mutation_v1();

create table public.wholesale_idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.users(id) on delete restrict,
  operation text not null,
  request_key uuid not null unique,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  customer_id uuid not null references public.customers(id) on delete restrict,
  status text not null default 'processing'
    check (status in ('processing', 'succeeded')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'processing' and result is null and completed_at is null)
    or (status = 'succeeded' and result is not null and completed_at is not null)
  )
);

create index wholesale_idempotency_customer_created_idx
  on public.wholesale_idempotency_requests(customer_id, created_at desc);

alter table public.wholesale_idempotency_requests enable row level security;

create policy "Technical staff can read wholesale idempotency"
  on public.wholesale_idempotency_requests for select
  using (
    public.current_actor_role() = 'technical_owner'
    and public.has_permission('technical:tools')
  );

grant select on public.wholesale_idempotency_requests to authenticated;
grant select, insert, update on public.wholesale_idempotency_requests to service_role;

create table public.customer_portal_notifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  notification_type text not null
    check (notification_type in ('wholesale_access.approved')),
  title text not null check (char_length(title) between 1 and 160),
  message text not null check (char_length(message) between 1 and 1000),
  source text not null check (source in ('customer_request', 'admin_direct_grant')),
  wholesale_customer_type text not null check (wholesale_customer_type in ('new', 'existing')),
  wholesale_history_id uuid not null references public.wholesale_access_history(id) on delete restrict,
  status text not null default 'unread' check (status in ('unread', 'read', 'archived')),
  toast_pending boolean not null default true,
  toast_shown_at timestamptz,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wholesale_history_id),
  check (
    (toast_pending and toast_shown_at is null)
    or (not toast_pending and toast_shown_at is not null)
  ),
  check (
    (status = 'unread' and read_at is null)
    or (status in ('read', 'archived') and read_at is not null)
  )
);

create index customer_portal_notifications_customer_created_idx
  on public.customer_portal_notifications(customer_id, created_at desc);

alter table public.customer_portal_notifications enable row level security;

create policy "Customers can read linked portal notifications"
  on public.customer_portal_notifications for select
  using (
    exists (
      select 1
      from public.customers c
      where c.id = customer_portal_notifications.customer_id
        and c.user_id = auth.uid()
        and c.active
        and c.status = 'active'
    )
  );

create policy "Authorized staff can read customer portal notifications"
  on public.customer_portal_notifications for select
  using (
    public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('wholesale:manage')
  );

grant select on public.customer_portal_notifications to authenticated;
grant select, insert, update on public.customer_portal_notifications to service_role;

create or replace function public.mark_customer_portal_notification_toast_shown_v1(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved public.customer_portal_notifications%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'WHOLESALE_UNAUTHORIZED';
  end if;

  update public.customer_portal_notifications n
  set toast_pending = false,
      toast_shown_at = now(),
      updated_at = now()
  where n.id = p_notification_id
    and n.toast_pending
    and exists (
      select 1
      from public.customers c
      where c.id = n.customer_id
        and c.user_id = auth.uid()
        and c.active
        and c.status = 'active'
    )
  returning n.* into saved;

  if saved.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOTIFICATION_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'notification', jsonb_build_object(
      'id', saved.id,
      'title', saved.title,
      'message', saved.message,
      'wholesaleCustomerType', saved.wholesale_customer_type,
      'createdAt', saved.created_at
    )
  );
end;
$$;

create or replace function public.mark_customer_portal_notification_read_v1(
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'WHOLESALE_UNAUTHORIZED';
  end if;

  update public.customer_portal_notifications n
  set status = 'read',
      read_at = coalesce(read_at, now()),
      updated_at = now()
  where n.id = p_notification_id
    and n.status = 'unread'
    and exists (
      select 1
      from public.customers c
      where c.id = n.customer_id
        and c.user_id = auth.uid()
        and c.active
        and c.status = 'active'
    )
  returning n.id into saved_id;

  if saved_id is null then
    if exists (
      select 1
      from public.customer_portal_notifications n
      join public.customers c on c.id = n.customer_id
      where n.id = p_notification_id
        and c.user_id = auth.uid()
        and n.status = 'read'
    ) then
      return jsonb_build_object('ok', true, 'code', 'ALREADY_READ');
    end if;
    return jsonb_build_object('ok', false, 'code', 'NOTIFICATION_NOT_FOUND');
  end if;

  return jsonb_build_object('ok', true, 'code', 'OK');
end;
$$;

revoke all on function public.mark_customer_portal_notification_toast_shown_v1(uuid) from public, anon;
revoke all on function public.mark_customer_portal_notification_read_v1(uuid) from public, anon;
grant execute on function public.mark_customer_portal_notification_toast_shown_v1(uuid) to authenticated;
grant execute on function public.mark_customer_portal_notification_read_v1(uuid) to authenticated;

create or replace function public.grant_customer_wholesale_access_v1(
  p_request_key uuid,
  p_customer_id uuid,
  p_wholesale_customer_type text,
  p_source text,
  p_expected_commercial_version integer,
  p_expected_wholesale_status text,
  p_expected_requested_at timestamptz default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  customer_record public.customers%rowtype;
  saved_customer public.customers%rowtype;
  idempotency_record public.wholesale_idempotency_requests%rowtype;
  history_id uuid;
  notification_id uuid;
  queued_email_id uuid;
  payload_hash text;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  minimum_amount numeric(12, 2);
  operation_name text;
  had_pending boolean;
  approved_timestamp timestamptz := now();
  notification_message text;
  response_payload jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'WHOLESALE_UNAUTHORIZED';
  end if;

  select r.name
  into actor_role_name
  from public.users u
  left join public.roles r on r.id = u.role_id
  where u.id = actor_id and u.active;

  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
     or not public.has_permission('wholesale:manage') then
    raise exception using errcode = '42501', message = 'WHOLESALE_FORBIDDEN';
  end if;

  if p_request_key is null or p_customer_id is null then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_INPUT';
  end if;
  if p_wholesale_customer_type not in ('new', 'existing') then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_TYPE';
  end if;
  if p_source not in ('customer_request', 'admin_direct_grant') then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_SOURCE';
  end if;
  if p_expected_wholesale_status not in ('none', 'pending', 'rejected') then
    raise exception using errcode = '22023', message = 'WHOLESALE_STATUS_CONFLICT';
  end if;
  if p_source = 'admin_direct_grant'
     and (normalized_reason is null or char_length(normalized_reason) < 5 or char_length(normalized_reason) > 500) then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_REASON';
  end if;

  payload_hash := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'customer_id', p_customer_id,
        'wholesale_customer_type', p_wholesale_customer_type,
        'source', p_source,
        'expected_commercial_version', p_expected_commercial_version,
        'expected_wholesale_status', p_expected_wholesale_status,
        'expected_requested_at', p_expected_requested_at,
        'reason', normalized_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  insert into public.wholesale_idempotency_requests (
    actor_user_id, operation, request_key, payload_hash, customer_id
  )
  values (
    actor_id, 'grant_customer_wholesale_access_v1', p_request_key, payload_hash, p_customer_id
  )
  on conflict (request_key) do nothing;

  select *
  into idempotency_record
  from public.wholesale_idempotency_requests
  where request_key = p_request_key
  for update;

  if idempotency_record.actor_user_id <> actor_id
     or idempotency_record.payload_hash <> payload_hash
     or idempotency_record.operation <> 'grant_customer_wholesale_access_v1' then
    raise exception using errcode = 'PT409', message = 'WHOLESALE_IDEMPOTENCY_CONFLICT';
  end if;
  if idempotency_record.status = 'succeeded' then
    return idempotency_record.result || jsonb_build_object('idempotentReplay', true);
  end if;

  select *
  into customer_record
  from public.customers
  where id = p_customer_id
  for update;

  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'WHOLESALE_CUSTOMER_NOT_FOUND';
  end if;
  if not customer_record.active or customer_record.status <> 'active' then
    raise exception using errcode = '22023', message = 'WHOLESALE_CUSTOMER_INACTIVE';
  end if;
  if customer_record.wholesale_status = 'suspended' then
    raise exception using errcode = '22023', message = 'WHOLESALE_CUSTOMER_SUSPENDED';
  end if;
  if customer_record.wholesale_status = 'approved' then
    if customer_record.wholesale_customer_type = p_wholesale_customer_type then
      raise exception using
        errcode = 'PT409',
        message = 'WHOLESALE_ALREADY_APPROVED:' || customer_record.commercial_version::text;
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'WHOLESALE_STATUS_CONFLICT:' || customer_record.commercial_version::text;
  end if;
  if customer_record.commercial_version <> p_expected_commercial_version then
    raise exception using
      errcode = 'PT409',
      message = 'WHOLESALE_VERSION_CONFLICT:' || customer_record.commercial_version::text;
  end if;
  if customer_record.wholesale_status <> p_expected_wholesale_status then
    raise exception using
      errcode = 'PT409',
      message = 'WHOLESALE_STATUS_CONFLICT:' || customer_record.commercial_version::text;
  end if;

  had_pending := customer_record.wholesale_status = 'pending';
  if p_source = 'customer_request' then
    if not had_pending or customer_record.wholesale_requested_at is null then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_STATUS_CONFLICT';
    end if;
    if p_expected_requested_at is null
       or customer_record.wholesale_requested_at <> p_expected_requested_at then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_REQUEST_CHANGED';
    end if;
    operation_name := 'approve_request';
  else
    operation_name := 'direct_grant';
  end if;

  select round(coalesce(cs.first_wholesale_minimum, 10000), 2)
  into minimum_amount
  from public.company_settings cs
  order by cs.created_at
  limit 1;
  minimum_amount := greatest(coalesce(minimum_amount, 10000), 0);

  perform set_config('app.wholesale_system_update', 'on', true);

  update public.customers
  set is_wholesale = true,
      wholesale_status = 'approved',
      wholesale_customer_type = p_wholesale_customer_type,
      wholesale_approved_at = approved_timestamp,
      wholesale_approved_notice_seen = false,
      status = 'active',
      active = true,
      lead_status = 'cliente',
      updated_at = approved_timestamp
  where id = p_customer_id
    and commercial_version = p_expected_commercial_version
  returning * into saved_customer;

  if saved_customer.id is null then
    raise exception using errcode = 'PT409', message = 'WHOLESALE_VERSION_CONFLICT';
  end if;
  if saved_customer.commercial_version <> customer_record.commercial_version + 1 then
    raise exception using errcode = 'P0001', message = 'WHOLESALE_VERSION_INCREMENT_INVALID';
  end if;

  insert into public.wholesale_access_history (
    customer_id, operation, source, previous_status, new_status,
    previous_type, new_type, had_pending_request, requested_at, approved_at,
    actor_user_id, actor_role, reason, previous_commercial_version,
    new_commercial_version, first_purchase_required, first_purchase_minimum,
    request_key, payload_hash, metadata
  )
  values (
    saved_customer.id, operation_name, p_source, customer_record.wholesale_status, 'approved',
    customer_record.wholesale_customer_type, saved_customer.wholesale_customer_type,
    had_pending, customer_record.wholesale_requested_at, saved_customer.wholesale_approved_at,
    actor_id, actor_role_name, normalized_reason, customer_record.commercial_version,
    saved_customer.commercial_version, p_wholesale_customer_type = 'new', minimum_amount,
    p_request_key, payload_hash,
    jsonb_build_object(
      'portal_linked', saved_customer.user_id is not null,
      'request_source_preserved', saved_customer.wholesale_request_source,
      'permission', 'wholesale:manage'
    )
  )
  returning id into history_id;

  update public.crm_followups
  set status = 'completed',
      completed_at = coalesce(completed_at, approved_timestamp),
      updated_at = approved_timestamp
  where customer_id = saved_customer.id
    and interaction_type = 'solicitud_mayorista'
    and status = 'pending';

  insert into public.crm_notes (customer_id, user_id, note_type, note)
  values (
    saved_customer.id,
    actor_id,
    'wholesale_status',
    case
      when operation_name = 'approve_request' then
        'Solicitud aprobada como mayorista ' ||
        case when p_wholesale_customer_type = 'existing' then 'existente.' else 'nuevo.' end
      else
        'Acceso otorgado directamente como mayorista ' ||
        case when p_wholesale_customer_type = 'existing' then 'existente.' else 'nuevo.' end
    end
  );

  notification_message := case
    when p_wholesale_customer_type = 'new' then
      'Tu acceso a precios mayoristas fue aprobado. Para completar la activación comercial, deberás realizar una primera compra mayorista mínima de L ' ||
      to_char(minimum_amount, 'FM999G999G990D00') || '.'
    when saved_customer.user_id is null then
      'Tu acceso comercial mayorista fue aprobado. Cuando tu cuenta del portal quede vinculada, podrás consultar los beneficios disponibles para clientes mayoristas.'
    else
      'Tu cuenta fue aprobada como cliente mayorista existente. Ya puedes consultar los beneficios y precios disponibles para clientes mayoristas.'
  end;

  insert into public.customer_portal_notifications (
    customer_id, notification_type, title, message, source,
    wholesale_customer_type, wholesale_history_id, metadata
  )
  values (
    saved_customer.id,
    'wholesale_access.approved',
    'Tu acceso mayorista fue aprobado',
    notification_message,
    p_source,
    p_wholesale_customer_type,
    history_id,
    jsonb_build_object(
      'first_purchase_minimum', minimum_amount,
      'portal_linked_at_creation', saved_customer.user_id is not null
    )
  )
  returning id into notification_id;

  insert into public.audit_logs (
    table_name, record_id, action, user_id, old_data, new_data
  )
  values (
    'customers',
    saved_customer.id,
    case when operation_name = 'approve_request'
      then 'wholesale_request.approved_' || p_wholesale_customer_type
      else 'wholesale_access.direct_grant_' || p_wholesale_customer_type
    end,
    actor_id,
    jsonb_build_object(
      'is_wholesale', customer_record.is_wholesale,
      'wholesale_status', customer_record.wholesale_status,
      'wholesale_customer_type', customer_record.wholesale_customer_type,
      'commercial_version', customer_record.commercial_version
    ),
    jsonb_build_object(
      'is_wholesale', saved_customer.is_wholesale,
      'wholesale_status', saved_customer.wholesale_status,
      'wholesale_customer_type', saved_customer.wholesale_customer_type,
      'commercial_version', saved_customer.commercial_version,
      'source', p_source,
      'history_id', history_id,
      'notification_id', notification_id,
      'request_key', p_request_key,
      'permission', 'wholesale:manage'
    )
  );

  if p_source = 'customer_request'
     and coalesce(saved_customer.email, '') like '%@%' then
    insert into public.email_queue (
      to_email, to_name, subject, template_key, payload, status,
      scheduled_at, idempotency_key, related_module, related_id, priority
    )
    values (
      lower(trim(saved_customer.email)),
      coalesce(nullif(saved_customer.business_name, ''), nullif(saved_customer.contact_name, ''), 'Cliente'),
      'Tu cuenta mayorista fue aprobada',
      'wholesale.approved',
      jsonb_build_object(
        'title', 'Tu cuenta mayorista fue aprobada',
        'message', notification_message,
        'customer_name', coalesce(nullif(saved_customer.business_name, ''), nullif(saved_customer.contact_name, ''), 'Cliente'),
        'wholesale_customer_type', p_wholesale_customer_type,
        'first_purchase_minimum', minimum_amount,
        'action_label', 'Iniciar sesión',
        'action_path', '/login'
      ),
      'pending',
      now(),
      'wholesale.approved:' || history_id::text,
      'mayoristas',
      history_id,
      4
    )
    on conflict (idempotency_key) where idempotency_key is not null do nothing
    returning id into queued_email_id;
  end if;

  response_payload := jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'customerId', saved_customer.id,
    'wholesaleStatus', saved_customer.wholesale_status,
    'wholesaleCustomerType', saved_customer.wholesale_customer_type,
    'commercialVersion', saved_customer.commercial_version,
    'historyId', history_id,
    'notificationId', notification_id,
    'firstPurchaseRequired', p_wholesale_customer_type = 'new',
    'firstPurchaseMinimum', minimum_amount,
    'portalLinked', saved_customer.user_id is not null,
    'idempotentReplay', false
  );

  update public.wholesale_idempotency_requests
  set status = 'succeeded',
      result = response_payload,
      completed_at = now(),
      updated_at = now()
  where id = idempotency_record.id;

  return response_payload;
end;
$$;

revoke all on function public.grant_customer_wholesale_access_v1(uuid, uuid, text, text, integer, text, timestamptz, text)
  from public, anon;
grant execute on function public.grant_customer_wholesale_access_v1(uuid, uuid, text, text, integer, text, timestamptz, text)
  to authenticated;

create or replace function public.transition_customer_wholesale_access_v1(
  p_request_key uuid,
  p_customer_id uuid,
  p_operation text,
  p_expected_commercial_version integer,
  p_expected_wholesale_status text,
  p_wholesale_customer_type text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  customer_record public.customers%rowtype;
  saved_customer public.customers%rowtype;
  idem public.wholesale_idempotency_requests%rowtype;
  payload_hash text;
  history_id uuid;
  minimum_amount numeric(12,2);
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  target_status text;
  target_type text;
  target_is_wholesale boolean;
  response_payload jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'WHOLESALE_UNAUTHORIZED';
  end if;
  select r.name into actor_role_name
  from public.users u left join public.roles r on r.id = u.role_id
  where u.id = actor_id and u.active;
  if actor_role_name not in ('technical_owner', 'business_owner', 'admin')
     or not public.has_permission('wholesale:manage') then
    raise exception using errcode = '42501', message = 'WHOLESALE_FORBIDDEN';
  end if;
  if p_operation not in ('change_type', 'reject', 'suspend', 'reactivate') then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_OPERATION';
  end if;
  if p_operation = 'change_type' and p_wholesale_customer_type not in ('new', 'existing') then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_TYPE';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'WHOLESALE_INVALID_REASON';
  end if;

  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'customer_id', p_customer_id,
    'operation', p_operation,
    'expected_commercial_version', p_expected_commercial_version,
    'expected_wholesale_status', p_expected_wholesale_status,
    'wholesale_customer_type', p_wholesale_customer_type,
    'reason', normalized_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.wholesale_idempotency_requests (
    actor_user_id, operation, request_key, payload_hash, customer_id
  ) values (
    actor_id, 'transition_customer_wholesale_access_v1:' || p_operation,
    p_request_key, payload_hash, p_customer_id
  ) on conflict (request_key) do nothing;

  select * into idem from public.wholesale_idempotency_requests
  where request_key = p_request_key for update;
  if idem.actor_user_id <> actor_id
     or idem.payload_hash <> payload_hash
     or idem.operation <> 'transition_customer_wholesale_access_v1:' || p_operation then
    raise exception using errcode = 'PT409', message = 'WHOLESALE_IDEMPOTENCY_CONFLICT';
  end if;
  if idem.status = 'succeeded' then
    return idem.result || jsonb_build_object('idempotentReplay', true);
  end if;

  select * into customer_record from public.customers
  where id = p_customer_id for update;
  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'WHOLESALE_CUSTOMER_NOT_FOUND';
  end if;
  if not customer_record.active or customer_record.status <> 'active' then
    raise exception using errcode = '22023', message = 'WHOLESALE_CUSTOMER_INACTIVE';
  end if;
  if customer_record.commercial_version <> p_expected_commercial_version then
    raise exception using errcode = 'PT409',
      message = 'WHOLESALE_VERSION_CONFLICT:' || customer_record.commercial_version::text;
  end if;
  if customer_record.wholesale_status <> p_expected_wholesale_status then
    raise exception using errcode = 'PT409',
      message = 'WHOLESALE_STATUS_CONFLICT:' || customer_record.commercial_version::text;
  end if;

  target_status := customer_record.wholesale_status;
  target_type := customer_record.wholesale_customer_type;
  target_is_wholesale := customer_record.is_wholesale;

  if p_operation = 'reject' then
    if customer_record.wholesale_status <> 'pending' then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_STATUS_CONFLICT';
    end if;
    target_status := 'rejected';
    target_is_wholesale := false;
  elsif p_operation = 'suspend' then
    if customer_record.wholesale_status <> 'approved' then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_STATUS_CONFLICT';
    end if;
    target_status := 'suspended';
    target_is_wholesale := false;
  elsif p_operation = 'reactivate' then
    if customer_record.wholesale_status <> 'suspended' then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_STATUS_CONFLICT';
    end if;
    target_status := 'approved';
    target_is_wholesale := true;
  elsif p_operation = 'change_type' then
    if customer_record.wholesale_status not in ('approved', 'suspended') then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_STATUS_CONFLICT';
    end if;
    if customer_record.wholesale_customer_type = p_wholesale_customer_type then
      raise exception using errcode = 'PT409', message = 'WHOLESALE_STATUS_CONFLICT';
    end if;
    target_type := p_wholesale_customer_type;
  end if;

  select round(coalesce(cs.first_wholesale_minimum, 10000), 2)
  into minimum_amount from public.company_settings cs order by cs.created_at limit 1;
  minimum_amount := greatest(coalesce(minimum_amount, 10000), 0);
  perform set_config('app.wholesale_system_update', 'on', true);

  update public.customers
  set is_wholesale = target_is_wholesale,
      wholesale_status = target_status,
      wholesale_customer_type = target_type,
      wholesale_approved_at = case
        when target_status = 'approved' then coalesce(wholesale_approved_at, now())
        when target_status = 'rejected' then null
        else wholesale_approved_at
      end,
      wholesale_approved_notice_seen = case when target_status = 'approved' then false else true end,
      updated_at = now()
  where id = p_customer_id and commercial_version = p_expected_commercial_version
  returning * into saved_customer;

  if saved_customer.id is null
     or saved_customer.commercial_version <> customer_record.commercial_version + 1 then
    raise exception using errcode = 'PT409', message = 'WHOLESALE_VERSION_CONFLICT';
  end if;

  insert into public.wholesale_access_history (
    customer_id, operation, source, previous_status, new_status, previous_type, new_type,
    had_pending_request, requested_at, approved_at, actor_user_id, actor_role, reason,
    previous_commercial_version, new_commercial_version, first_purchase_required,
    first_purchase_minimum, request_key, payload_hash, metadata
  ) values (
    saved_customer.id, p_operation, case when p_operation = 'reject' then 'customer_request' else 'admin_direct_grant' end,
    customer_record.wholesale_status, saved_customer.wholesale_status,
    customer_record.wholesale_customer_type, saved_customer.wholesale_customer_type,
    customer_record.wholesale_status = 'pending', customer_record.wholesale_requested_at,
    saved_customer.wholesale_approved_at, actor_id, actor_role_name, normalized_reason,
    customer_record.commercial_version, saved_customer.commercial_version,
    saved_customer.wholesale_customer_type = 'new', minimum_amount,
    p_request_key, payload_hash, jsonb_build_object('permission', 'wholesale:manage')
  ) returning id into history_id;

  if p_operation = 'reject' then
    update public.crm_followups
    set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
    where customer_id = saved_customer.id
      and interaction_type = 'solicitud_mayorista'
      and status = 'pending';
  end if;

  insert into public.crm_notes (customer_id, user_id, note_type, note)
  values (
    saved_customer.id, actor_id, 'wholesale_status',
    case p_operation
      when 'reject' then 'Solicitud mayorista rechazada.'
      when 'suspend' then 'Acceso mayorista suspendido.'
      when 'reactivate' then 'Acceso mayorista reactivado.'
      else 'Tipo mayorista cambiado a ' || case when target_type = 'existing' then 'existente.' else 'nuevo.' end
    end
  );

  insert into public.audit_logs (table_name, record_id, action, user_id, old_data, new_data)
  values (
    'customers', saved_customer.id, 'wholesale_access.' || p_operation, actor_id,
    jsonb_build_object(
      'wholesale_status', customer_record.wholesale_status,
      'wholesale_customer_type', customer_record.wholesale_customer_type,
      'commercial_version', customer_record.commercial_version
    ),
    jsonb_build_object(
      'wholesale_status', saved_customer.wholesale_status,
      'wholesale_customer_type', saved_customer.wholesale_customer_type,
      'commercial_version', saved_customer.commercial_version,
      'history_id', history_id,
      'request_key', p_request_key,
      'permission', 'wholesale:manage'
    )
  );

  response_payload := jsonb_build_object(
    'ok', true, 'code', 'OK', 'customerId', saved_customer.id,
    'wholesaleStatus', saved_customer.wholesale_status,
    'wholesaleCustomerType', saved_customer.wholesale_customer_type,
    'commercialVersion', saved_customer.commercial_version,
    'historyId', history_id, 'idempotentReplay', false
  );
  update public.wholesale_idempotency_requests
  set status = 'succeeded', result = response_payload, completed_at = now(), updated_at = now()
  where id = idem.id;
  return response_payload;
end;
$$;

revoke all on function public.transition_customer_wholesale_access_v1(uuid, uuid, text, integer, text, text, text)
  from public, anon;
grant execute on function public.transition_customer_wholesale_access_v1(uuid, uuid, text, integer, text, text, text)
  to authenticated;

comment on table public.wholesale_access_history is
  'Append-only history of authorized wholesale commercial state transitions.';
comment on table public.wholesale_idempotency_requests is
  'Wholesale-specific idempotency ledger; never shared with POS, orders, payments, or accounting.';
comment on table public.customer_portal_notifications is
  'Customer-owned private notifications. Ownership follows customers.id and becomes visible only through an explicit portal link.';
comment on function public.grant_customer_wholesale_access_v1(uuid, uuid, text, text, integer, text, timestamptz, text) is
  'Transactional wholesale request approval/direct grant with CAS, idempotency, history, audit, follow-up resolution, and customer notification.';
